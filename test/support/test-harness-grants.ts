import type { ClientBase } from 'pg';

/**
 * TEST HARNESS ONLY — production state per migration 0012 / decision D42.
 *
 * Migration `0012_retire_supabase_app_paths.sql` revokes every privilege of `anon`, `authenticated`
 * and PUBLIC on the `public` tables and functions (the Supabase app paths are retired). The parity
 * suites and many integration files still call the old SQL functions, and read the tables, as
 * `set local role authenticated` (exactly as the old app did) to prove the API behaves like them.
 * So the throwaway test database, and only it, gets back EXACTLY the table, column and function
 * privileges 0012 recorded in `public.api_retired_supabase_access` before revoking them. The
 * publication members and Storage policies are not restored (no test needs them).
 *
 * Run once by `global-setup.ts` on the template database, after the migrations and after the
 * production-state template (`PRODUCTION_TEMPLATE_DATABASE`) was frozen, which therefore keeps the
 * production state for `test/int/production-state.int-spec.ts`. Never used outside the tests.
 */
export const TEST_HARNESS_REGRANT_SQL = `
do $test_harness_regrant$
declare
  r record;
begin
  for r in
    select kind, object_identity, grantee, privilege, is_grantable
      from public.api_retired_supabase_access
     where kind in ('table_grant', 'column_grant', 'function_grant')
     order by kind, object_identity, grantee, privilege
  loop
    execute format(
      case r.kind
        when 'table_grant' then
          'grant %1$s on ' ||
          case when (select relkind from pg_class where oid = r.object_identity::regclass) = 'S'
               then 'sequence ' else 'table ' end || '%2$s to %3$s%4$s'
        when 'column_grant' then 'grant %1$s (%5$s) on table %6$s to %3$s%4$s'
        else 'grant %1$s on routine %2$s to %3$s%4$s'
      end,
      r.privilege,
      r.object_identity,
      case when r.grantee = 'PUBLIC' then 'public' else quote_ident(r.grantee) end,
      case when r.is_grantable then ' with grant option' else '' end,
      regexp_replace(r.object_identity, '^.*\\.', ''),
      regexp_replace(r.object_identity, '\\.[^.]*$', ''));
  end loop;
end
$test_harness_regrant$;`;

export async function applyTestHarnessRegrant(client: ClientBase): Promise<void> {
  await client.query(TEST_HARNESS_REGRANT_SQL);
}
