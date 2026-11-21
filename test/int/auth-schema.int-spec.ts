import { randomBytes, randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';

/**
 * API-100-50: the own-auth tables of migration 0008 (spec §11.7). Same ids as Supabase Auth, email
 * citext lower-case and unique, phone `+E.164` and unique, the existing foreign keys untouched
 * (repointed in Phase 7), cascades from `users`, and the check constraints.
 */
describe('auth schema (API-100-50, migration 0008)', () => {
  let client: Client;

  beforeAll(async () => {
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
  });

  /** Runs `sql` in a savepoint; returns the SQLSTATE of the error, or null when it succeeded. */
  async function sqlState(sql: string, values: unknown[] = []): Promise<string | null> {
    await client.query('begin');
    try {
      await client.query(sql, values);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await client.query('rollback');
    }
  }

  it('creates the six tables with RLS enabled', async () => {
    const { rows } = await client.query<{ name: string; rls: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('users', 'user_credentials', 'user_identities', 'device_sessions',
                            'refresh_tokens', 'auth_tokens')
        order by 1`,
    );
    expect(rows).toEqual(
      [
        'auth_tokens',
        'device_sessions',
        'refresh_tokens',
        'user_credentials',
        'user_identities',
        'users',
      ].map((name) => ({ name, rls: true })),
    );
  });

  it('users.email is citext: unique regardless of case, stored lower-case only', async () => {
    const email = `case-${randomUUID()}@example.test`;
    await client.query('insert into public.users (email) values ($1)', [email]);
    expect(
      await sqlState('insert into public.users (email) values ($1)', [email.toUpperCase()]),
    ).toBe('23514'); // not lower-case
    // A second user with the same address is refused by the unique constraint (case-insensitive).
    const { rows } = await client.query<{ found: string }>(
      'select count(*)::text as found from public.users where email = $1',
      [email.toUpperCase()],
    );
    expect(rows[0].found).toBe('1');
    expect(await sqlState('insert into public.users (email) values ($1)', [email])).toBe('23505');
    const { rows: types } = await client.query<{ type: string }>(
      `select tn.nspname || '.' || t.typname as type
         from pg_attribute a
         join pg_type t on t.oid = a.atttypid
         join pg_namespace tn on tn.oid = t.typnamespace
        where a.attrelid = 'public.users'::regclass and a.attname = 'email'`,
    );
    expect(types[0].type).toBe('extensions.citext');
  });

  it('users.phone must be +E.164 and unique; several users may have no email or phone', async () => {
    expect(await sqlState(`insert into public.users (phone) values ('12015550101')`)).toBe('23514');
    expect(await sqlState(`insert into public.users (phone) values ('+0201555010')`)).toBe('23514');
    const phone = `+1201555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await client.query('begin');
    try {
      await client.query('insert into public.users (phone) values ($1)', [phone]);
      await client.query('savepoint s');
      await expect(
        client.query('insert into public.users (phone) values ($1)', [phone]),
      ).rejects.toMatchObject({ code: '23505' });
      await client.query('rollback to savepoint s');
      await client.query(
        'insert into public.users (email, phone) values (null, null), (null, null)',
      );
    } finally {
      await client.query('rollback');
    }
  });

  it('users.id can take an auth.users id; profiles and members still reference auth.users', async () => {
    const authUser = await createUser(client, { profile: true });
    await client.query('insert into public.users (id, email) values ($1, $2)', [
      authUser.id,
      authUser.email,
    ]);
    const { rows } = await client.query<{ conname: string; target: string }>(
      `select conname, confrelid::regclass::text as target from pg_constraint
        where contype = 'f'
          and conname in ('profiles_id_fkey', 'safety_circle_members_user_id_fkey',
                          'user_devices_user_id_fkey')
        order by conname`,
    );
    expect(rows).toEqual([
      { conname: 'profiles_id_fkey', target: 'auth.users' },
      { conname: 'safety_circle_members_user_id_fkey', target: 'auth.users' },
      { conname: 'user_devices_user_id_fkey', target: 'auth.users' },
    ]);
  });

  it('credentials, identities, sessions, refresh tokens and link tokens cascade with the user', async () => {
    await client.query('begin');
    try {
      const {
        rows: [user],
      } = await client.query<{ id: string }>(
        `insert into public.users (email) values ($1) returning id`,
        [`cascade-${randomUUID()}@example.test`],
      );
      await client.query(
        `insert into public.user_credentials (user_id, password_hash, hash_algo)
         values ($1, 'x', 'argon2id')`,
        [user.id],
      );
      await client.query(
        `insert into public.user_identities (user_id, provider, provider_subject)
         values ($1::uuid, 'email', $2::text)`,
        [user.id, user.id],
      );
      const {
        rows: [session],
      } = await client.query<{ id: string }>(
        `insert into public.device_sessions (user_id, auth_method) values ($1, 'password')
         returning id`,
        [user.id],
      );
      await client.query(
        `insert into public.refresh_tokens (session_id, token_hash, family_id, expires_at)
         values ($1, $2, $1, now() + interval '30 days')`,
        [session.id, randomBytes(32)],
      );
      await client.query(
        `insert into public.auth_tokens (user_id, purpose, token_hash, expires_at)
         values ($1, 'email_verify', $2, now() + interval '5 minutes')`,
        [user.id, randomBytes(32)],
      );
      await client.query('delete from public.users where id = $1', [user.id]);
      const { rows } = await client.query<{ n: string }>(
        `select ((select count(*) from public.user_credentials where user_id = $1)
               + (select count(*) from public.user_identities where user_id = $1)
               + (select count(*) from public.device_sessions where user_id = $1)
               + (select count(*) from public.refresh_tokens where session_id = $2)
               + (select count(*) from public.auth_tokens where user_id = $1))::text as n`,
        [user.id, session.id],
      );
      expect(rows[0].n).toBe('0');
    } finally {
      await client.query('rollback');
    }
  });

  it('refuses unknown providers, purposes, algorithms, auth methods and short digests', async () => {
    const id = randomUUID();
    await client.query('insert into public.users (id) values ($1)', [id]);
    expect(
      await sqlState(
        `insert into public.user_credentials (user_id, password_hash, hash_algo) values ($1, 'x', 'md5')`,
        [id],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        `insert into public.user_identities (user_id, provider, provider_subject) values ($1, 'github', 'x')`,
        [id],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        `insert into public.device_sessions (user_id, auth_method) values ($1, 'magic')`,
        [id],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        `insert into public.device_sessions (user_id, auth_method, revoked_at) values ($1, 'password', now())`,
        [id],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        `insert into public.auth_tokens (user_id, purpose, token_hash, expires_at)
         values ($1, 'email_verify', $2, now())`,
        [id, randomBytes(16)],
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        `insert into public.auth_tokens (user_id, purpose, token_hash, expires_at)
         values ($1, 'invite', $2, now())`,
        [id, randomBytes(32)],
      ),
    ).toBe('23514');
  });

  it('is re-runnable: applying 0008 again changes nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('db/migrations/0008_auth_schema.sql', 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
    } finally {
      await client.query('rollback');
    }
  });
});
