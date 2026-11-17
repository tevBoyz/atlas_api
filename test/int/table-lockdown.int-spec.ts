import { Client } from 'pg';

import { testDatabaseUrl } from './support/database';

/**
 * API-owned tables in `public` are not reachable by the Supabase API roles (PostgREST): `anon` and
 * `authenticated` have no table privileges and RLS is enabled with no policy (deny). Covers the
 * migration tracking table (runner + `0002_lock_down_api_schema_migrations.sql`) and
 * `idempotency_keys` (`0001`). Requires `npm run db:migrate` on the local database.
 */
const TABLES = ['public.api_schema_migrations', 'public.idempotency_keys'];
const ROLES = ['anon', 'authenticated'];
const PRIVILEGES = ['select', 'insert', 'update', 'delete'];

describe('API-owned tables are locked down for Supabase API roles', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({
      connectionString: testDatabaseUrl(),
      application_name: 'atlas-int-test',
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it.each(TABLES)('%s has RLS enabled with no policies', async (table) => {
    const { rows } = await client.query<{ rls: boolean; policies: number }>(
      `select c.relrowsecurity as rls,
              (select count(*)::int from pg_policies p
                where p.schemaname = n.nspname and p.tablename = c.relname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.oid = $1::regclass`,
      [table],
    );
    expect(rows).toEqual([{ rls: true, policies: 0 }]);
  });

  const cases = TABLES.flatMap((table) =>
    ROLES.flatMap((role) => PRIVILEGES.map((privilege) => [table, role, privilege])),
  );

  it.each(cases)('%s: %s has no %s privilege', async (table, role, privilege) => {
    const exists = await client.query('select 1 from pg_roles where rolname = $1', [role]);
    expect(exists.rowCount).toBe(1);
    const { rows } = await client.query<{ granted: boolean }>(
      'select has_table_privilege($1, $2, $3) as granted',
      [role, table, privilege],
    );
    expect(rows[0].granted).toBe(false);
  });
});
