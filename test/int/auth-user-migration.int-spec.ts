import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';

import { migrateUsers } from '../../src/modules/auth/tooling/migrate-users';
import { createAuthApp, DEVICE, errorOf, GOOD_PASSWORD, post } from '../support/auth-api';
import { openTestClient } from '../support/database';
import { adminDatabaseUrl, workerDatabaseName } from '../support/stack';

/**
 * API-100-58: the Supabase Auth → own-tables migration (`npm run auth:migrate-users`): same ids,
 * lower-case email, `+E.164` phone, confirmations, created_at, metadata, identities, bcrypt
 * credentials; idempotent and repeatable; a dry run that writes nothing but reports the same counts
 * and conflicts; bcrypt verified then re-hashed to argon2id at sign-in; no personal data in the report.
 */
describe('user migration from Supabase Auth (API-100-58)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  const ids = {
    full: randomUUID(),
    phoneOnly: randomUUID(),
    phoneTwin: randomUUID(),
    badPhone: randomUUID(),
    anonymous: randomUUID(),
    deleted: randomUUID(),
    google: randomUUID(),
  };
  const sharedPhoneDigits = '447700900771';
  const PASSWORD = GOOD_PASSWORD;

  async function authUser(
    id: string,
    values: {
      email?: string | null;
      phone?: string | null;
      hash?: string | null;
      confirmed?: boolean;
      anonymous?: boolean;
      deleted?: boolean;
      createdAt?: string;
    },
  ) {
    await client.query(
      `insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password,
                               email_confirmed_at, phone_confirmed_at, raw_app_meta_data,
                               raw_user_meta_data, created_at, updated_at, is_anonymous, deleted_at)
       values ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2::text, $3::text,
               $4::text, case when $5::boolean then now() end,
               case when $5::boolean and $3::text is not null then now() end,
               '{}'::jsonb, jsonb_build_object('full_name', 'Migrated Example'),
               coalesce($8::timestamptz, now()), now(), $6::boolean, case when $7::boolean then now() end)`,
      [
        id,
        values.email ?? null,
        values.phone ?? null,
        values.hash ?? null,
        values.confirmed ?? true,
        values.anonymous ?? false,
        values.deleted ?? false,
        values.createdAt ?? null,
      ],
    );
  }

  beforeAll(async () => {
    ({ app } = await createAuthApp());
    client = await openTestClient();
    // GoTrue's auth.identities (not in the local shim): created here, as the admin role.
    const adminUrl = adminDatabaseUrl().replace(/\/template1$/, `/${workerDatabaseName()}`);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create table if not exists auth.identities (
      id uuid primary key default gen_random_uuid(), provider_id text not null, user_id uuid not null,
      identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz,
      created_at timestamptz default now(), updated_at timestamptz default now())`);
    await admin.query('grant all on auth.identities to postgres');
    await admin.end();

    const hash = await bcrypt.hash(PASSWORD, 10);
    await authUser(ids.full, { email: 'Full.Migrated@Example.TEST', phone: '447700900770', hash });
    await authUser(ids.phoneOnly, {
      email: null,
      phone: sharedPhoneDigits,
      hash,
      createdAt: '2026-01-01T00:00:00Z',
    });
    await authUser(ids.phoneTwin, { email: 'twin@example.test', phone: `+${sharedPhoneDigits}` });
    await authUser(ids.badPhone, { email: 'badphone@example.test', phone: '12' });
    await authUser(ids.anonymous, { email: null, anonymous: true });
    await authUser(ids.deleted, { email: 'deleted@example.test', deleted: true });
    await authUser(ids.google, { email: 'google.migrated@example.test', confirmed: true });
    await client.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider)
       values ($1::text, $2::uuid, jsonb_build_object('sub', $1::text, 'email', 'google.migrated@example.test'), 'google'),
              ($2::text, $2, jsonb_build_object('sub', $2::text), 'email')`,
      ['google-sub-123', ids.google],
    );
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const ourIds = () => Object.values(ids);
  async function users() {
    const { rows } = await client.query<{
      id: string;
      email: string | null;
      phone: string | null;
      email_confirmed: boolean;
      metadata: Record<string, unknown>;
    }>(
      `select id::text, email::text, phone, email_confirmed_at is not null as email_confirmed, metadata
         from public.users where id = any($1::uuid[]) order by id`,
      [ourIds()],
    );
    return rows;
  }

  it('AC3: the dry run reports counts and conflicts and writes nothing', async () => {
    const report = await migrateUsers(client, true);
    expect(report).toMatchObject({
      auth_users: 7,
      skipped_anonymous: 1,
      skipped_deleted: 1,
      users_inserted: 5,
      users_already_present: 0,
      credentials_inserted: 2,
      auth_identities_table: true,
      conflicts: {
        missing_email: 1,
        invalid_email: 0,
        duplicate_email: 0,
        invalid_phone: 1,
        duplicate_phone: 1,
      },
    });
    // Numbers and flags only: no email, phone, name or hash.
    expect(JSON.stringify(report)).not.toMatch(/@|\+\d|\$2|Migrated/);
    expect(await users()).toEqual([]);
  });

  it('AC1: copies ids, lower-case email, +E.164 phone, confirmations, metadata, identities, bcrypt', async () => {
    const report = await migrateUsers(client, false);
    expect(report.users_inserted).toBe(5);
    const rows = await users();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual(
      [ids.full, ids.phoneOnly, ids.phoneTwin, ids.badPhone, ids.google].sort(),
    );
    expect(byId[ids.full]).toMatchObject({
      email: 'full.migrated@example.test',
      phone: '+447700900770',
      email_confirmed: true,
      metadata: { full_name: 'Migrated Example' },
    });
    // Rule 44's tie-break: the twin with a usable email gets the shared number.
    expect(byId[ids.phoneTwin].phone).toBe(`+${sharedPhoneDigits}`);
    expect(byId[ids.phoneOnly].phone).toBeNull();
    expect(byId[ids.badPhone].phone).toBeNull();
    const { rows: creds } = await client.query<{ user_id: string; hash_algo: string }>(
      'select user_id::text, hash_algo from public.user_credentials where user_id = any($1::uuid[]) order by 1',
      [ourIds()],
    );
    expect(creds).toEqual(
      [ids.full, ids.phoneOnly].sort().map((user_id) => ({ user_id, hash_algo: 'bcrypt' })),
    );
    const { rows: identities } = await client.query<{ provider: string; provider_subject: string }>(
      `select provider, provider_subject from public.user_identities where user_id = $1 order by provider`,
      [ids.google],
    );
    expect(identities).toEqual([
      { provider: 'email', provider_subject: ids.google },
      { provider: 'google', provider_subject: 'google-sub-123' },
    ]);
  });

  it('AC1: idempotent; a repeat run adds a new confirmation and follows a newer Supabase bcrypt hash', async () => {
    const again = await migrateUsers(client, false);
    expect(again).toMatchObject({
      users_inserted: 0,
      users_already_present: 5,
      confirmations_added: 0,
      credentials_inserted: 0,
      credentials_updated: 0,
      identities_inserted: 0,
    });
    // The twin was moved before confirming the number in the old app; it confirms it afterwards.
    await client.query('update public.users set phone_confirmed_at = null where id = $1', [
      ids.phoneTwin,
    ]);
    await client.query('update auth.users set encrypted_password = $2 where id = $1', [
      ids.phoneOnly,
      await bcrypt.hash(`${PASSWORD}x`, 10),
    ]);
    const third = await migrateUsers(client, false);
    expect(third).toMatchObject({ confirmations_added: 1, credentials_updated: 1 });
  });

  it('AC2: bcrypt is verified at sign-in and re-hashed to argon2id in the same request; kept on re-runs', async () => {
    const res = await post(app, '/v1/auth/login', {
      email: 'full.migrated@example.test',
      password: PASSWORD,
      device: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await client.query<{ hash_algo: string; password_hash: string }>(
      'select hash_algo, password_hash from public.user_credentials where user_id = $1',
      [ids.full],
    );
    expect(rows[0].hash_algo).toBe('argon2id');
    expect(rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
    const { rows: audit } = await client.query<{ detail: unknown }>(
      `select detail from public.audit_log where action = 'auth.login.success' and target_id = $1`,
      [ids.full],
    );
    expect(audit.map((a) => a.detail)).toEqual([
      { method: 'password', identifier: 'email', rehashed: true },
    ]);
    expect(
      (
        await post(app, '/v1/auth/login', {
          email: 'full.migrated@example.test',
          password: PASSWORD,
          device: DEVICE,
        })
      ).statusCode,
    ).toBe(200);
    const wrong = await post(app, '/v1/auth/login', {
      email: 'full.migrated@example.test',
      password: `${PASSWORD}?`,
      device: DEVICE,
    });
    expect(errorOf(wrong).code).toBe('auth:invalid_credentials');
    const rerun = await migrateUsers(client, false);
    expect(rerun.credentials_kept_argon2id).toBeGreaterThanOrEqual(1);
    const { rows: after } = await client.query<{ hash_algo: string }>(
      'select hash_algo from public.user_credentials where user_id = $1',
      [ids.full],
    );
    expect(after[0].hash_algo).toBe('argon2id');
  });

  it('just in time: a Supabase user created after the batch run signs in without a second account', async () => {
    const id = randomUUID();
    await authUser(id, {
      email: 'late.signup@example.test',
      hash: await bcrypt.hash(PASSWORD, 10),
    });
    const res = await post(app, '/v1/auth/login', {
      email: 'late.signup@example.test',
      password: PASSWORD,
      device: DEVICE,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { id: string } }>().user.id).toBe(id);
    const signup = await post(app, '/v1/auth/signup', {
      email: 'late.signup@example.test',
      password: PASSWORD,
      phone: '+447700900779',
      full_name: 'Late',
      device: DEVICE,
    });
    expect(signup.statusCode).toBe(202);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from public.users where email = 'late.signup@example.test'`,
    );
    expect(rows[0].n).toBe(1);
  });
});
