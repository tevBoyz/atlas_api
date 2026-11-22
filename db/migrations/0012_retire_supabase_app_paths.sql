-- Phase 7 stage 7.6, API-100-62 (D42): retire the Supabase app paths. The mobile app no longer
-- uses Supabase at all (no SDK, no PostgREST, no RPC, no Realtime since 7.3d-2); the API connects
-- as the database owner and is not affected. This migration closes what is still open:
--
-- 1. Table privileges of `anon`, `authenticated` and PUBLIC on every `public` relation are revoked.
--    Found on the local database (= the staging schema, baseline + 0001-0011), 2026-11-22:
--      anon           profiles, safety_circles, safety_circle_members       ALL (arwdDxtm)
--      authenticated  profiles, safety_circles, safety_circle_members       ALL (arwdDxtm)
--      authenticated  app_config                                            SELECT, MAINTAIN
--      authenticated  incident_deliveries                                   SELECT, UPDATE
--      authenticated  incidents, incident_events                            SELECT
--    (no column-level grants, no PUBLIC table grants, no sequence grants to these roles).
-- 2. EXECUTE of `anon`, `authenticated` and PUBLIC on every `public` function (not owned by an
--    extension) is revoked. Found: 8 functions executable by anon, 40 by authenticated, 5 trigger
--    functions with the default PUBLIC grant (set_*_updated_at, _app_config_set_updated_at). The
--    functions themselves STAY for one release (AC1); a later migration drops them. Triggers keep
--    firing (EXECUTE is checked when a trigger is created, not when it fires); the owner role (the
--    API) and `service_role` keep their EXECUTE. The API's own functions (`api_ensure_user_row*`)
--    were already owner-only.
-- 3. `public.incidents` and `public.incident_events` leave the `supabase_realtime` publication
--    (guarded: only if the publication exists and the table is a member).
-- 4. Storage: the `avatars` write policies for `authenticated` on `storage.objects` are dropped
--    (the API's Storage service key is the only writer, AC4). Found: `avatars_insert_own`,
--    `avatars_update_own`, `avatars_delete_own`. Public read (`avatars_select_public`, the bucket
--    is public) stays: avatar URLs are public URLs.
--
-- Not touched: RLS policies on public tables, the functions themselves, `auth` schema objects (the
-- auth hook function stays; the hook is switched off in the Supabase config), `service_role`
-- grants, the `public` schema USAGE grant, default privileges (new tables keep being revoked by
-- each migration, see db/migrations/README.md).
--
-- Exact rollback: before anything is revoked, removed or dropped, it is recorded in
-- `public.api_retired_supabase_access` (one row per grant / publication member / policy, with the
-- full policy statement). `db/rollback/0012_down.sql` restores exactly those rows and drops the
-- table. The integration suites re-grant the recorded table and function privileges in their
-- throwaway database only (test harness, D42); `test/int/production-state.int-spec.ts` checks the
-- state below on a freshly migrated database before that re-grant.
--
-- The only non-additive change of Epic 100 (story API-100-62). Re-runnable on a fresh database after
-- the baseline. Ends with a self-check: the migration fails (and changes nothing) if any privilege
-- of these roles is left, e.g. one granted by a role other than the owner.

-- Every identity recorded below is fully schema-qualified (regclass / regprocedure text with only
-- pg_catalog on the search_path), so the rollback does not depend on a search_path.
set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- 0. The record of what is retired (owner only, like every API table)
-- ---------------------------------------------------------------------------

create table if not exists public.api_retired_supabase_access (
  kind text not null
    check (kind in ('table_grant', 'column_grant', 'function_grant', 'publication_member',
                    'storage_policy')),
  -- regclass / regprocedure text, `table.column` for a column grant, policy name for a policy.
  object_identity text not null,
  -- role name or PUBLIC; the publication name for a member; the table for a policy.
  grantee text not null,
  -- privilege type (SELECT, EXECUTE, ...); '' for a publication member or policy.
  privilege text not null default '',
  is_grantable boolean not null default false,
  -- `create policy ...` for a policy; the `add table` clause for a publication member.
  definition text,
  recorded_at timestamptz not null default now(),
  primary key (kind, object_identity, grantee, privilege)
);

comment on table public.api_retired_supabase_access is
  'Stage 7.6 (D42, migration 0012): the Supabase grants, publication members and Storage policies 0012 removed, for db/rollback/0012_down.sql. Internal: owner only.';

alter table public.api_retired_supabase_access enable row level security;
revoke all on table public.api_retired_supabase_access from public;
revoke all on table public.api_retired_supabase_access from anon;
revoke all on table public.api_retired_supabase_access from authenticated;

-- ---------------------------------------------------------------------------
-- 1. Record, then revoke, table / column privileges
-- ---------------------------------------------------------------------------

insert into public.api_retired_supabase_access (kind, object_identity, grantee, privilege, is_grantable)
select 'table_grant', c.oid::regclass::text,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
       a.privilege_type, a.is_grantable
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
   and c.relacl is not null
   and c.oid <> 'public.api_retired_supabase_access'::regclass
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
on conflict do nothing;

insert into public.api_retired_supabase_access (kind, object_identity, grantee, privilege, is_grantable)
select 'column_grant', c.oid::regclass::text || '.' || quote_ident(att.attname),
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
       a.privilege_type, a.is_grantable
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
  cross join lateral aclexplode(att.attacl) a
 where n.nspname = 'public'
   and c.relkind in ('r', 'p', 'v', 'm', 'f')
   and att.attacl is not null
   and c.oid <> 'public.api_retired_supabase_access'::regclass
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
on conflict do nothing;

do $revoke_tables$
declare
  r record;
begin
  for r in
    select distinct c.oid::regclass::text as rel, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_class'::regclass and d.objid = c.oid
                          and d.deptype = 'e')
  loop
    -- REVOKE on a table also revokes the column privileges of these roles.
    if r.relkind = 'S' then
      execute format('revoke all on sequence %s from public, anon, authenticated', r.rel);
    else
      execute format('revoke all on table %s from public, anon, authenticated', r.rel);
    end if;
  end loop;
end
$revoke_tables$;

-- ---------------------------------------------------------------------------
-- 2. Record, then revoke, EXECUTE on the public functions (they stay, AC1)
-- ---------------------------------------------------------------------------

insert into public.api_retired_supabase_access (kind, object_identity, grantee, privilege, is_grantable)
select 'function_grant', p.oid::regprocedure::text,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
       a.privilege_type, a.is_grantable
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  -- A NULL proacl is the default: EXECUTE for PUBLIC (and the owner).
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where n.nspname = 'public'
   and p.prokind in ('f', 'p', 'w')
   and not exists (select 1 from pg_depend d
                    where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
on conflict do nothing;

do $revoke_functions$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as fn, p.prokind
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p', 'w')
       and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                          and d.deptype = 'e')
  loop
    execute format('revoke all on %s %s from public, anon, authenticated',
                   case when r.prokind = 'p' then 'procedure' else 'function' end, r.fn);
  end loop;
end
$revoke_functions$;

-- ---------------------------------------------------------------------------
-- 3. Supabase Realtime: incidents / incident_events out of the publication
-- ---------------------------------------------------------------------------

do $publication$
declare
  r record;
  v_clause text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'publication supabase_realtime does not exist: nothing to remove';
    return;
  end if;
  for r in
    select pr.prrelid::regclass::text as rel, pr.prrelid, pr.prattrs, pr.prqual
      from pg_publication_rel pr
      join pg_publication pub on pub.oid = pr.prpubid
     where pub.pubname = 'supabase_realtime'
       and pr.prrelid in ('public.incidents'::regclass, 'public.incident_events'::regclass)
  loop
    -- The `add table` clause as it was: with its column list and row filter, if any.
    v_clause := r.rel;
    if r.prattrs is not null then
      v_clause := v_clause || ' (' || (
        select string_agg(quote_ident(att.attname), ', ' order by k.ord)
          from unnest(r.prattrs::int2[]) with ordinality as k(attnum, ord)
          join pg_attribute att on att.attrelid = r.prrelid and att.attnum = k.attnum) || ')';
    end if;
    if r.prqual is not null then
      v_clause := v_clause || ' where (' || pg_get_expr(r.prqual, r.prrelid) || ')';
    end if;
    insert into public.api_retired_supabase_access (kind, object_identity, grantee, definition)
    values ('publication_member', r.rel, 'supabase_realtime', v_clause)
    on conflict do nothing;
    execute format('alter publication supabase_realtime drop table %s', r.rel);
  end loop;
end
$publication$;

-- ---------------------------------------------------------------------------
-- 4. Storage: drop the direct-write policies on the avatars bucket (AC4)
-- ---------------------------------------------------------------------------

do $storage$
declare
  r record;
  v_sql text;
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects does not exist: no Storage policy to drop';
    return;
  end if;
  for r in
    select p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
      from pg_policies p
     where p.schemaname = 'storage'
       and p.tablename = 'objects'
       and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       and p.roles && array['anon', 'authenticated', 'public']::name[]
       and coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') like '%''avatars''%'
  loop
    v_sql := format('create policy %I on storage.objects as %s for %s to %s',
                    r.policyname, r.permissive, r.cmd,
                    (select string_agg(case when x = 'public' then 'public'
                                            else quote_ident(x) end, ', ')
                       from unnest(r.roles::text[]) as x));
    if r.qual is not null then
      v_sql := v_sql || ' using (' || r.qual || ')';
    end if;
    if r.with_check is not null then
      v_sql := v_sql || ' with check (' || r.with_check || ')';
    end if;
    insert into public.api_retired_supabase_access (kind, object_identity, grantee, definition)
    values ('storage_policy', r.policyname, 'storage.objects', v_sql)
    on conflict do nothing;
    execute format('drop policy %I on storage.objects', r.policyname);
  end loop;
end
$storage$;

-- ---------------------------------------------------------------------------
-- 5. Self-check: nothing of the above is left
-- ---------------------------------------------------------------------------

do $check$
declare
  v_left text;
begin
  select string_agg(item, '; ') into v_left
    from (
      select format('%s %s on %s', case when a.grantee = 0 then 'PUBLIC'
                                        else pg_get_userbyid(a.grantee) end,
                    a.privilege_type, c.oid::regclass) as item
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral aclexplode(c.relacl) a
       where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_class'::regclass and d.objid = c.oid
                            and d.deptype = 'e')
         and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
      union all
      select format('%s EXECUTE on %s', case when a.grantee = 0 then 'PUBLIC'
                                             else pg_get_userbyid(a.grantee) end,
                    p.oid::regprocedure)
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname = 'public' and p.prokind in ('f', 'p', 'w')
         and not exists (select 1 from pg_depend d
                          where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                            and d.deptype = 'e')
         and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
      union all
      select format('publication member %s', pr.prrelid::regclass)
        from pg_publication_rel pr
        join pg_publication pub on pub.oid = pr.prpubid
       where pub.pubname = 'supabase_realtime'
         and pr.prrelid in ('public.incidents'::regclass, 'public.incident_events'::regclass)
    ) left_over;
  if v_left is not null then
    raise exception '0012: Supabase access left after the revoke (granted by another role?): %',
      v_left;
  end if;
end
$check$;
