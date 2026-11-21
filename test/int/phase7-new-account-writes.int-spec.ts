import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import bcrypt from 'bcryptjs';
import type { Client } from 'pg';

import {
  authFakePhone,
  createAuthApp,
  GOOD_PASSWORD,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';
import { createCircle, createUser } from '../support/fixtures';
import { emergencyInfoBody, personalInfoBody, preferencesBody } from '../support/profile-api';

/**
 * Stage 7.1a (D36, D37, migration 0010): the foreign keys of `profiles.id`,
 * `safety_circle_members.user_id` and `user_devices.user_id` reference `public.users`, so an account
 * created by API sign-up (no `auth.users` row) completes its profile, gets its circle, invites,
 * joins another circle and registers its device with its OWN access token. Users that exist only
 * in `auth.users` (the old SQL functions' tests, today's app) are moved into `users` by the
 * compatibility trigger before such a write, with the user-migration rules (D34).
 */
describe('stage 7.1a: new API accounts write profiles, circles and devices (D36, D37)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createAuthApp());
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const as = (session: SessionBody) => ({ authorization: `Bearer ${session.access_token}` });

  async function call(
    session: SessionBody,
    method: 'GET' | 'PUT' | 'POST',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method,
      url,
      headers: {
        ...as(session),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  async function completeProfile(session: SessionBody, name: string) {
    expect(
      (
        await call(
          session,
          'PUT',
          '/v1/me/profile/personal-info',
          personalInfoBody({ full_name: name }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call(session, 'PUT', '/v1/me/profile/emergency-info', emergencyInfoBody())).statusCode,
    ).toBe(200);
    expect(
      (await call(session, 'PUT', '/v1/me/profile/preferences', preferencesBody())).statusCode,
    ).toBe(200);
    return call(session, 'POST', '/v1/me/profile/complete');
  }

  it('the three foreign keys reference users, with their names and delete rules kept', async () => {
    const { rows } = await client.query<{ name: string; target: string; on_delete: string }>(
      `select conname as name, confrelid::regclass::text as target, confdeltype as on_delete
         from pg_constraint
        where contype = 'f'
          and conname in ('profiles_id_fkey', 'safety_circle_members_user_id_fkey',
                          'user_devices_user_id_fkey')
        order by conname`,
    );
    expect(rows).toEqual([
      { name: 'profiles_id_fkey', target: 'users', on_delete: 'c' },
      { name: 'safety_circle_members_user_id_fkey', target: 'users', on_delete: 'n' },
      { name: 'user_devices_user_id_fkey', target: 'users', on_delete: 'c' },
    ]);
  });

  it('a new API sign-up (no auth.users row) completes its profile, gets a circle, invites, joins a circle and registers a device', async () => {
    const { session } = await signedUpUser(app);
    const userId = session.user.id;
    const { rows: authRows } = await client.query('select 1 from auth.users where id = $1', [
      userId,
    ]);
    expect(authRows).toHaveLength(0);

    // Profile (personal, emergency, preferences) and setup: the circle and the owner row.
    const completed = await completeProfile(session, 'New Account');
    expect(completed.statusCode).toBe(200);
    expect((await call(session, 'GET', '/v1/me/circle')).statusCode).toBe(200);
    const { rows: owner } = await client.query<{ role: string; status: string }>(
      `select m.role, m.status from public.safety_circle_members m
         join public.safety_circles c on c.id = m.circle_id
        where c.owner_id = $1 and m.user_id = $1`,
      [userId],
    );
    expect(owner).toEqual([{ role: 'owner', status: 'active' }]);

    // A circle write of the owner: an invite link.
    const invite = await call(session, 'POST', '/v1/me/circle/invites/link', {});
    expect(invite.statusCode).toBe(201);

    // Another account's link invite, accepted by the new account: its member row is written.
    const other = await signedUpUser(app);
    expect((await completeProfile(other.session, 'Other Owner')).statusCode).toBe(200);
    const link = await call(other.session, 'POST', '/v1/me/circle/invites/link', {});
    const token = link.json<{ invite_token: string }>().invite_token;
    const accepted = await call(session, 'POST', `/v1/invites/${token}/accept`);
    expect(accepted.statusCode).toBe(200);
    const joined = await call(session, 'GET', '/v1/me/joined-circles');
    expect(joined.statusCode).toBe(200);
    expect(
      joined
        .json<{ role: string; owner_name: string }[]>()
        .map((c) => `${c.role}:${c.owner_name}`)
        .sort(),
    ).toEqual(['member:Other Owner', 'owner:New Account']);

    // Device registration (U1) with the own access token.
    const installation = randomUUID();
    const device = await call(
      session,
      'PUT',
      '/v1/me/devices/current',
      { platform: 'android', app_version: '1.0.0' },
      { 'x-atlas-installation-id': installation },
    );
    expect(device.statusCode).toBe(200);
    const { rows: devices } = await client.query(
      'select 1 from public.user_devices where user_id = $1 and installation_id = $2',
      [userId, installation],
    );
    expect(devices).toHaveLength(1);
  });

  it('deleting the users row cascades to the profile and devices (the delete rules of before)', async () => {
    const { session } = await signedUpUser(app);
    const userId = session.user.id;
    expect(
      (await call(session, 'PUT', '/v1/me/profile/personal-info', personalInfoBody())).statusCode,
    ).toBe(200);
    await call(
      session,
      'PUT',
      '/v1/me/devices/current',
      { platform: 'ios', app_version: '1.0.0' },
      { 'x-atlas-installation-id': randomUUID() },
    );
    await client.query('begin');
    try {
      await client.query('delete from public.users where id = $1', [userId]);
      const { rows } = await client.query<{ profiles: number; devices: number }>(
        `select (select count(*)::int from public.profiles where id = $1) as profiles,
                (select count(*)::int from public.user_devices where user_id = $1) as devices`,
        [userId],
      );
      expect(rows[0]).toEqual({ profiles: 0, devices: 0 });
    } finally {
      await client.query('rollback');
    }
  });

  describe('compatibility trigger (D37)', () => {
    async function authOnlyUser(values: {
      email?: string | null;
      phone?: string | null;
      hash?: string | null;
      deleted?: boolean;
    }): Promise<string> {
      const id = randomUUID();
      await client.query(
        `insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password,
                                 email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                                 created_at, updated_at, deleted_at)
         values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated',
                 $2::text, $3::text, $4::text, now(), '{}'::jsonb,
                 jsonb_build_object('full_name', 'Trigger Example'), now(), now(),
                 case when $5::boolean then now() end)`,
        [
          id,
          values.email ?? null,
          values.phone ?? null,
          values.hash ?? null,
          values.deleted ?? false,
        ],
      );
      return id;
    }

    const insertProfile = (id: string) =>
      client.query(
        `insert into public.profiles (id, full_name, date_of_birth)
         values ($1, 'Trigger Example', date '1990-01-15')`,
        [id],
      );

    it('a profile of an auth.users-only user moves it first (D34 rules: email, +E.164, metadata, bcrypt, identities)', async () => {
      const hash = await bcrypt.hash(GOOD_PASSWORD, 4);
      const digits = authFakePhone().slice(1);
      const id = await authOnlyUser({
        email: ` Trigger.${randomUUID()}@Example.TEST `,
        phone: digits,
        hash,
      });
      expect((await client.query('select 1 from public.users where id = $1', [id])).rowCount).toBe(
        0,
      );
      await insertProfile(id);
      const { rows } = await client.query<{
        email: string;
        phone: string;
        confirmed: boolean;
        name: string;
        algo: string;
        providers: string;
      }>(
        `select u.email::text as email, u.phone, u.email_confirmed_at is not null as confirmed,
                u.metadata ->> 'full_name' as name,
                (select hash_algo from public.user_credentials c where c.user_id = u.id) as algo,
                (select string_agg(provider, ',' order by provider)
                   from public.user_identities i where i.user_id = u.id) as providers
           from public.users u where u.id = $1`,
        [id],
      );
      expect(rows[0]).toMatchObject({
        phone: `+${digits}`,
        confirmed: true,
        name: 'Trigger Example',
        algo: 'bcrypt',
        providers: 'email,phone',
      });
      expect(rows[0].email).toMatch(/^trigger\.[0-9a-f-]+@example\.test$/);
      // The old app user signs in through the API with the bcrypt password (re-hashed).
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.71.1.1' },
        payload: JSON.stringify({
          email: rows[0].email,
          password: GOOD_PASSWORD,
          device: { platform: 'android', app_version: '1.0.0' },
        }),
      });
      expect(login.statusCode).toBe(200);
    });

    it('an email or phone another user holds is left out; a Supabase-deleted user gets a disabled row', async () => {
      const taken = await createUser(client, { phone: true });
      // Upper case and with its `+`: auth.users refuses the exact same text; users compares normalized.
      const id = await authOnlyUser({ email: taken.email.toUpperCase(), phone: taken.phone! });
      await insertProfile(id);
      const deleted = await authOnlyUser({
        email: `deleted-${randomUUID()}@example.test`,
        deleted: true,
      });
      await insertProfile(deleted);
      const { rows } = await client.query<{
        id: string;
        email: string | null;
        phone: string | null;
        disabled: boolean;
      }>(
        `select id::text, email::text, phone, disabled_at is not null as disabled
           from public.users where id = any($1::uuid[])`,
        [[id, deleted]],
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[id]).toEqual({ id, email: null, phone: null, disabled: false });
      expect(byId[deleted].disabled).toBe(true);
    });

    it('member rows and devices of an auth.users-only user move it too; an id in neither table still fails (23503)', async () => {
      const owner = await createUser(client);
      const circle = await createCircle(client, owner);
      const member = await authOnlyUser({ email: `member-${randomUUID()}@example.test` });
      await client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
                                                   invite_token, invite_expires_at)
         values ($1, 'member', 'pending', 'Claimed', $2, $3, now() + interval '7 days')`,
        [circle.id, member, randomUUID().replace(/-/g, '').repeat(2)],
      );
      const device = await authOnlyUser({ email: `device-${randomUUID()}@example.test` });
      await client.query(
        `insert into public.user_devices (user_id, installation_id, platform)
         values ($1, $2, 'android')`,
        [device, randomUUID()],
      );
      const { rows } = await client.query<{ n: number }>(
        'select count(*)::int as n from public.users where id = any($1::uuid[])',
        [[member, device]],
      );
      expect(rows[0].n).toBe(2);

      await client.query('begin');
      try {
        await expect(insertProfile(randomUUID())).rejects.toMatchObject({
          code: '23503',
          constraint: 'profiles_id_fkey',
        });
      } finally {
        await client.query('rollback');
      }
    });

    it('the helper functions are not callable by the app roles', async () => {
      const { rows } = await client.query<{ fn: string; anon: boolean; authenticated: boolean }>(
        `select p.proname as fn,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'api_ensure_user_row%'
          order by 1`,
      );
      expect(rows).toEqual([
        { fn: 'api_ensure_user_row', anon: false, authenticated: false },
        { fn: 'api_ensure_user_row_trigger', anon: false, authenticated: false },
      ]);
    });
  });
});
