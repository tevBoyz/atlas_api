import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createAuthApp, type SessionBody, signedUpUser } from '../support/auth-api';
import { openTestClient } from '../support/database';
import { emergencyInfoBody, personalInfoBody, preferencesBody } from '../support/profile-api';
import {
  avatarWritePolicies,
  realtimeMembersLeft,
  recloneWorkerDatabase,
  supabasePrivilegesLeft,
} from '../support/retirement-state';
import { PRODUCTION_TEMPLATE_DATABASE } from '../support/stack';

/**
 * Stage 7.6, API-100-62 (D42, migration 0012): the production state of a freshly migrated
 * database, BEFORE the test harness re-grant (`test/support/test-harness-grants.ts`) every other
 * suite gets. This file works on a clone of `PRODUCTION_TEMPLATE_DATABASE`:
 * - no table / column privilege of anon / authenticated / PUBLIC on any `public` relation (AC2);
 * - no EXECUTE of anon / authenticated / PUBLIC on the `public` functions, which still exist (AC1);
 * - incidents / incident_events are not in the `supabase_realtime` publication;
 * - no anon / authenticated write policy on the `avatars` Storage objects; public read kept (AC4);
 * - the old Supabase-style calls are refused, and the API (owner role) works end to end: sign-up,
 *   profile, circle, invite + join, SOS, responder list, mark safe.
 */
describe('stage 7.6: production state after 0012 (D42)', () => {
  let client: Client;

  beforeAll(async () => {
    // Runs after worker-isolation.ts's reset: the worker database becomes the production clone.
    await recloneWorkerDatabase(PRODUCTION_TEMPLATE_DATABASE);
    client = await openTestClient();
  }, 120_000);

  afterAll(async () => {
    await client.end();
  });

  it('this database is fully migrated and has no test harness re-grant', async () => {
    const { rows } = await client.query<{ id: string }>(
      `select id from public.api_schema_migrations where id = '0012_retire_supabase_app_paths'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('anon / authenticated / PUBLIC hold no privilege on public tables, columns or functions', async () => {
    expect(await supabasePrivilegesLeft(client)).toEqual([]);
    const { rows } = await client.query<Record<string, boolean>>(
      `select has_table_privilege('anon', 'public.profiles', 'select') as anon_profiles,
              has_table_privilege('authenticated', 'public.profiles', 'select') as auth_profiles,
              has_table_privilege('authenticated', 'public.incidents', 'select') as auth_incidents,
              has_table_privilege('authenticated', 'public.app_config', 'select') as auth_config,
              has_function_privilege('authenticated', 'public.submit_emergency_alert(text)',
                                     'execute') as auth_submit,
              has_function_privilege('anon', 'public.lookup_circle_invite(text)',
                                     'execute') as anon_lookup,
              has_function_privilege('anon', 'public.set_profiles_updated_at()',
                                     'execute') as public_trigger_fn`,
    );
    expect(rows[0]).toEqual({
      anon_profiles: false,
      auth_profiles: false,
      auth_incidents: false,
      auth_config: false,
      auth_submit: false,
      anon_lookup: false,
      public_trigger_fn: false,
    });
  });

  it('the old SQL functions still exist (dropped in a later release, AC1)', async () => {
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('submit_emergency_alert', 'mark_incident_safe', 'accept_circle_invite',
                            'lookup_circle_invite', 'complete_profile_setup')`,
    );
    expect(rows[0].n).toBe(5);
  });

  it('0012 recorded what it removed (for db/rollback/0012_down.sql)', async () => {
    const { rows } = await client.query<{ kind: string; object_identity: string; grantee: string }>(
      `select kind, object_identity, grantee from public.api_retired_supabase_access
        where kind in ('publication_member', 'storage_policy')
           or (kind = 'function_grant' and object_identity = 'public.submit_emergency_alert(text)')
           or (kind = 'table_grant' and object_identity = 'public.profiles'
               and privilege = 'SELECT')
        order by kind, object_identity, grantee`,
    );
    expect(rows).toEqual([
      {
        kind: 'function_grant',
        object_identity: 'public.submit_emergency_alert(text)',
        grantee: 'authenticated',
      },
      {
        kind: 'publication_member',
        object_identity: 'public.incident_events',
        grantee: 'supabase_realtime',
      },
      {
        kind: 'publication_member',
        object_identity: 'public.incidents',
        grantee: 'supabase_realtime',
      },
      { kind: 'storage_policy', object_identity: 'avatars_delete_own', grantee: 'storage.objects' },
      { kind: 'storage_policy', object_identity: 'avatars_insert_own', grantee: 'storage.objects' },
      { kind: 'storage_policy', object_identity: 'avatars_update_own', grantee: 'storage.objects' },
      { kind: 'table_grant', object_identity: 'public.profiles', grantee: 'anon' },
      { kind: 'table_grant', object_identity: 'public.profiles', grantee: 'authenticated' },
    ]);
  });

  it('the record table is owner only (RLS on, no Supabase privileges)', async () => {
    const { rows } = await client.query<Record<string, boolean>>(
      `select c.relrowsecurity as rls,
              has_table_privilege('anon', c.oid, 'select') as anon,
              has_table_privilege('authenticated', c.oid, 'select') as authenticated
         from pg_class c where c.oid = 'public.api_retired_supabase_access'::regclass`,
    );
    expect(rows[0]).toEqual({ rls: true, anon: false, authenticated: false });
  });

  it('incidents / incident_events are not in supabase_realtime (the publication itself stays)', async () => {
    expect(await realtimeMembersLeft(client)).toEqual([]);
    const { rowCount } = await client.query(
      `select 1 from pg_publication where pubname = 'supabase_realtime'`,
    );
    expect(rowCount).toBe(1);
  });

  it('avatars: no anon / authenticated write policy; public read and the public bucket stay', async () => {
    expect(await avatarWritePolicies(client)).toEqual([]);
    const { rows } = await client.query<{ policyname: string; cmd: string; roles: string }>(
      `select policyname, cmd, roles::text as roles from pg_policies
        where schemaname = 'storage' and tablename = 'objects' order by policyname`,
    );
    expect(rows).toEqual([
      { policyname: 'avatars_select_public', cmd: 'SELECT', roles: '{public}' },
    ]);
    const bucket = await client.query<{ public: boolean }>(
      `select public from storage.buckets where id = 'avatars'`,
    );
    expect(bucket.rows).toEqual([{ public: true }]);
  });

  it.each([
    ['authenticated', `select public.submit_emergency_alert('fire')`],
    ['authenticated', 'select * from public.profiles'],
    ['authenticated', 'select * from public.incidents'],
    ['anon', `select public.lookup_circle_invite('x')`],
    ['anon', 'select * from public.safety_circles'],
  ])('a Supabase-style call as %s is refused: %s', async (role, sql) => {
    await client.query('begin');
    try {
      await client.query(`set local role ${role}`);
      await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback');
    }
  });

  describe('the API (database owner) works end to end on this database', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      ({ app } = await createAuthApp());
    });

    afterAll(async () => {
      await app.close();
    });

    const call = (
      session: SessionBody,
      method: 'GET' | 'PUT' | 'POST',
      url: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${session.access_token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });

    async function completeProfile(session: SessionBody, name: string): Promise<void> {
      const steps = [
        await call(
          session,
          'PUT',
          '/v1/me/profile/personal-info',
          personalInfoBody({ full_name: name }),
        ),
        await call(session, 'PUT', '/v1/me/profile/emergency-info', emergencyInfoBody()),
        await call(session, 'PUT', '/v1/me/profile/preferences', preferencesBody()),
        await call(session, 'POST', '/v1/me/profile/complete'),
      ];
      expect(steps.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    }

    it('sign-up -> profile -> circle -> invite + join -> SOS -> member sees it -> mark safe', async () => {
      const resident = (await signedUpUser(app)).session;
      const member = (await signedUpUser(app)).session;
      await completeProfile(resident, 'Prod Resident');
      await completeProfile(member, 'Prod Member');

      expect((await call(resident, 'GET', '/v1/me/circle')).statusCode).toBe(200);
      const link = await call(resident, 'POST', '/v1/me/circle/invites/link', {});
      expect(link.statusCode).toBe(201);
      const token = link.json<{ invite_token: string }>().invite_token;
      expect((await call(member, 'POST', `/v1/invites/${token}/accept`)).statusCode).toBe(200);

      const sos = await call(
        resident,
        'POST',
        '/v1/incidents',
        { emergency_type: 'fire' },
        { 'idempotency-key': randomUUID() },
      );
      expect(sos.statusCode).toBe(201);
      const incidentId = sos.json<{ id: string }>().id;

      const responder = await call(member, 'GET', '/v1/responder/incidents');
      expect(responder.statusCode).toBe(200);
      expect(responder.json<{ id: string }[]>().map((r) => r.id)).toContain(incidentId);

      const safe = await call(
        resident,
        'POST',
        `/v1/incidents/${incidentId}/mark-safe`,
        undefined,
        {
          'idempotency-key': randomUUID(),
        },
      );
      expect(safe.statusCode).toBe(200);
      const { rows } = await client.query<{ status: string }>(
        'select status from public.incidents where id = $1',
        [incidentId],
      );
      expect(rows).toEqual([{ status: 'resolved' }]);
    });
  });
});
