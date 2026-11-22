-- Rollback of db/migrations/0012_retire_supabase_app_paths.sql (stage 7.6, API-100-62, D42).
--
-- Restores EXACTLY what 0012 revoked, removed or dropped, from the record 0012 kept in
-- `public.api_retired_supabase_access`:
--   - every table, column and function privilege of anon / authenticated / PUBLIC (with its grant
--     option, if it had one);
--   - the `supabase_realtime` publication members (incidents, incident_events) with their column
--     list / row filter, if any;
--   - the dropped `storage.objects` policies of the avatars bucket, statement for statement.
-- Then it drops the record table and removes 0012 from `public.api_schema_migrations`, so the
-- database is as it was before 0012 and `npm run db:migrate` would apply 0012 again.
--
-- Run as the database owner (the role `npm run db:migrate` uses), in one transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/0012_down.sql
-- Safe to run twice: the second run stops at the check below and changes nothing.

begin;

-- The recorded identities are schema-qualified; nothing here depends on a search_path.
set local search_path = pg_catalog;

do $rollback$
declare
  r record;
  v_target text;
begin
  if to_regclass('public.api_retired_supabase_access') is null then
    raise exception '0012_down: public.api_retired_supabase_access does not exist (0012 not applied, or already rolled back)';
  end if;

  -- Storage policies first (their statements are self-contained).
  for r in
    select object_identity, definition from public.api_retired_supabase_access
     where kind = 'storage_policy' order by object_identity
  loop
    if to_regclass('storage.objects') is not null
       and not exists (select 1 from pg_policies p
                        where p.schemaname = 'storage' and p.tablename = 'objects'
                          and p.policyname = r.object_identity) then
      execute r.definition;
    end if;
  end loop;

  -- Publication members.
  for r in
    select object_identity, grantee, definition from public.api_retired_supabase_access
     where kind = 'publication_member' order by object_identity
  loop
    if exists (select 1 from pg_publication where pubname = r.grantee)
       and not exists (select 1 from pg_publication_rel pr
                         join pg_publication pub on pub.oid = pr.prpubid
                        where pub.pubname = r.grantee
                          and pr.prrelid = r.object_identity::regclass) then
      execute format('alter publication %I add table %s', r.grantee, r.definition);
    end if;
  end loop;

  -- Privileges.
  for r in
    select kind, object_identity, grantee, privilege, is_grantable
      from public.api_retired_supabase_access
     where kind in ('table_grant', 'column_grant', 'function_grant')
     order by kind, object_identity, grantee, privilege
  loop
    if r.kind = 'table_grant' then
      v_target := case when (select relkind from pg_class
                              where oid = r.object_identity::regclass) = 'S'
                       then 'sequence ' else 'table ' end || r.object_identity;
      execute format('grant %s on %s to %s%s', r.privilege, v_target,
                     case when r.grantee = 'PUBLIC' then 'public' else quote_ident(r.grantee) end,
                     case when r.is_grantable then ' with grant option' else '' end);
    elsif r.kind = 'column_grant' then
      -- object_identity is `<table>.<quoted column>`; the column is after the last dot.
      execute format('grant %s (%s) on table %s to %s%s', r.privilege,
                     regexp_replace(r.object_identity, '^.*\.', ''),
                     regexp_replace(r.object_identity, '\.[^.]*$', ''),
                     case when r.grantee = 'PUBLIC' then 'public' else quote_ident(r.grantee) end,
                     case when r.is_grantable then ' with grant option' else '' end);
    else
      execute format('grant %s on %s %s to %s%s', r.privilege,
                     case when (select prokind from pg_proc
                                 where oid = r.object_identity::regprocedure) = 'p'
                          then 'procedure' else 'function' end,
                     r.object_identity,
                     case when r.grantee = 'PUBLIC' then 'public' else quote_ident(r.grantee) end,
                     case when r.is_grantable then ' with grant option' else '' end);
    end if;
  end loop;
end
$rollback$;

drop table public.api_retired_supabase_access;
delete from public.api_schema_migrations where id = '0012_retire_supabase_app_paths';

commit;
