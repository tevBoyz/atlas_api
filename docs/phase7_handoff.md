# Phase 7 hand-off (Epic 100 API-100-60 to 62)

Notes for the coordinator and Dawit about Phase 7 database changes. Earlier Phase 7 stages (7.1 to 7.5)
are described in `docs/phase6_handoff.md` section 0 and in the decisions D37 to D41 (epic §18).

## 7.6 Retire the Supabase app paths (API-100-62, D42)

### What changed

Migration `db/migrations/0012_retire_supabase_app_paths.sql` (the only non-additive migration of
Epic 100). The mobile app uses no Supabase path since 7.3d-2; the API connects as the database
owner and is not affected.

| Path | Before (local = staging schema, 2026-11-22) | After 0012 |
|---|---|---|
| Table grants (PostgREST) | `anon`: ALL on `profiles`, `safety_circles`, `safety_circle_members`; `authenticated`: ALL on those three, SELECT + MAINTAIN on `app_config`, SELECT + UPDATE on `incident_deliveries`, SELECT on `incidents`, `incident_events` (54 grants) | none for `anon` / `authenticated` / PUBLIC |
| Function EXECUTE (RPC) | 8 functions for `anon`, 40 for `authenticated`, 5 trigger functions for PUBLIC (53 grants) | none for `anon` / `authenticated` / PUBLIC; the functions still exist (dropped in a later release, AC1) |
| Supabase Realtime | `supabase_realtime` has `public.incidents`, `public.incident_events` | neither (the publication stays) |
| Storage `avatars` | `avatars_select_public` (public read) + `avatars_insert_own`, `avatars_update_own`, `avatars_delete_own` (authenticated writes to own folder) | `avatars_select_public` only; the API's Storage service key is the only writer |

Not touched: RLS policies, functions, the `auth` schema, `service_role` grants, schema USAGE, default
privileges. The Supabase Auth settings (sign-ups off, custom access token hook off, providers off)
are changed in the Supabase project config, not by this migration (staging step 3 of the plan).

0012 first records everything it removes in `public.api_retired_supabase_access` (owner only, RLS on),
then revokes / removes / drops, then self-checks: if any privilege of those roles is left (for
example one granted by another role), it raises and the whole migration is rolled back.

### Apply on staging (needs Dawit's OK at that time)

From `api/`, with the staging connection string in `DATABASE_URL` (never written to a file in the
repo; `api/.env` already holds it):

```sh
npm run db:migrate -- --allow-remote
```

Expected output: `applied 0012_retire_supabase_app_paths`, `Applied 1 migration(s).` If Supabase
refuses `drop policy` on `storage.objects` (the `postgres` role must be allowed to manage those
policies, as it was when the baseline created them), the migration fails as a whole and changes
nothing: report it and stop.

### Read-only checks (before and after)

```sql
-- 1. Privileges of anon / authenticated / PUBLIC on public tables and functions (after: 0 rows).
select 'table' as kind, c.oid::regclass::text as object,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'public' and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
union all
select 'function', p.oid::regprocedure::text,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, a.privilege_type
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where n.nspname = 'public'
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                    and d.objid = p.oid and d.deptype = 'e')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'));
-- Before: 107 rows (54 table, 53 function) on a database built from the baseline + 0001-0011.

-- 2. Realtime members (after: 0 rows; before: incidents, incident_events).
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public';

-- 3. Storage policies (after: only avatars_select_public).
select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects';

-- 4. What 0012 recorded (after: 54 table_grant, 53 function_grant, 2 publication_member, 3 storage_policy).
select kind, count(*) from public.api_retired_supabase_access group by kind order by kind;
```

A Supabase-style call with the anon key (`/rest/v1/profiles`, `/rest/v1/rpc/...`) is now refused
(permission denied); the API keeps working (it is the owner).

### Rollback

`db/rollback/0012_down.sql` restores exactly what 0012 recorded (grants with their grant option,
publication members with any column list / row filter, the three Storage policies statement for
statement), drops the record table and removes 0012 from `api_schema_migrations`. One transaction;
a second run stops at its first check and changes nothing. Tested by
`test/int/rollback-0012.int-spec.ts` (snapshot before 0012 = snapshot after the rollback).

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/0012_down.sql
```

Then re-run the read-only checks: 107 privilege rows, both publication members, four Storage policies,
and `api_retired_supabase_access` gone.

### Tests

- Every suite except the two below runs on a template that, after the migrations, re-grants exactly
  the recorded table / column / function privileges (`test/support/test-harness-grants.ts`, "test
  harness only"), so the parity suites and integration files that call the old SQL functions as
  `authenticated` are unchanged (parity 267/267).
- `test/int/production-state.int-spec.ts` runs on the template frozen before that re-grant: no
  Supabase privileges, no Realtime members, no avatars write policy, Supabase-style calls refused
  (42501), and the API end to end (sign-up, profile, circle, invite + join, SOS, responder list,
  mark safe).
- `test/int/rollback-0012.int-spec.ts` runs on the template frozen before 0012.
