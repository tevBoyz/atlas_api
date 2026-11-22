import { Client } from 'pg';

import { adminDatabaseUrl, workerDatabaseName } from './stack';

/**
 * Helpers for the 0012 / D42 suites (stage 7.6): the Supabase app paths are retired.
 */

/** Re-creates THIS worker's database from `template` (instead of the usual test template). */
export async function recloneWorkerDatabase(template: string): Promise<void> {
  const name = workerDatabaseName();
  const admin = new Client({
    connectionString: adminDatabaseUrl(),
    application_name: 'atlas-test-isolation',
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name} template ${template} owner postgres`);
  } finally {
    await admin.end();
  }
}

const SUPABASE_GRANTEE = `(a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))`;
const GRANTEE_NAME = `case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end`;
const NOT_EXTENSION = (catalog: string, oid: string) =>
  `not exists (select 1 from pg_depend d where d.classid = '${catalog}'::regclass
                  and d.objid = ${oid} and d.deptype = 'e')`;

/**
 * Every privilege of anon / authenticated / PUBLIC on a `public` relation, column or function
 * (grantor and grant option included), as text lines.
 */
const SUPABASE_PRIVILEGES_SQL = `
  select format('table %s %s %s by %s%s', c.oid::regclass, ${GRANTEE_NAME}, a.privilege_type,
                pg_get_userbyid(a.grantor), case when a.is_grantable then ' grantable' else '' end)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and ${NOT_EXTENSION('pg_class', 'c.oid')} and ${SUPABASE_GRANTEE}
  union all
  select format('column %s.%I %s %s by %s%s', c.oid::regclass, att.attname, ${GRANTEE_NAME},
                a.privilege_type, pg_get_userbyid(a.grantor),
                case when a.is_grantable then ' grantable' else '' end)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
    cross join lateral aclexplode(att.attacl) a
   where n.nspname = 'public' and ${SUPABASE_GRANTEE}
  union all
  select format('function %s %s %s by %s%s', p.oid::regprocedure, ${GRANTEE_NAME},
                a.privilege_type, pg_get_userbyid(a.grantor),
                case when a.is_grantable then ' grantable' else '' end)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where n.nspname = 'public' and p.prokind in ('f', 'p', 'w')
     and ${NOT_EXTENSION('pg_proc', 'p.oid')} and ${SUPABASE_GRANTEE}`;

/** The members of `supabase_realtime` among incidents / incident_events. */
const REALTIME_MEMBERS_SQL = `
  select format('publication %s %s attrs=%s qual=%s', pub.pubname, pr.prrelid::regclass,
                coalesce(pr.prattrs::text, '-'),
                coalesce(pg_get_expr(pr.prqual, pr.prrelid), '-'))
    from pg_publication_rel pr join pg_publication pub on pub.oid = pr.prpubid
   where pub.pubname = 'supabase_realtime'
     and pr.prrelid in ('public.incidents'::regclass, 'public.incident_events'::regclass)`;

/** Every policy on storage.objects, in full. */
const STORAGE_POLICIES_SQL = `
  select format('policy %s %s %s to %s using %s check %s', p.policyname, p.permissive, p.cmd,
                p.roles::text, coalesce(p.qual, '-'), coalesce(p.with_check, '-'))
    from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'`;

/** Runs `sql` with only pg_catalog on the search_path, so every name comes out schema-qualified. */
async function qualifiedLines(client: Client, sql: string): Promise<string[]> {
  await client.query('begin');
  try {
    await client.query('set local search_path = pg_catalog');
    const { rows } = await client.query<{ line: string }>(sql);
    return rows.map((r) => r.line);
  } finally {
    await client.query('rollback');
  }
}

/**
 * The state 0012 changes and its rollback restores, as sorted text lines: Supabase privileges,
 * publication members, Storage policies, and whether 0012 is recorded / its record table exists.
 */
export async function supabaseAccessSnapshot(client: Client): Promise<string[]> {
  return qualifiedLines(
    client,
    `select line from (
       ${SUPABASE_PRIVILEGES_SQL}
       union all ${REALTIME_MEMBERS_SQL}
       union all ${STORAGE_POLICIES_SQL}
       union all
       select format('migration 0012 recorded=%s',
                     exists (select 1 from public.api_schema_migrations
                              where id = '0012_retire_supabase_app_paths')::text)
       union all
       select format('record table exists=%s',
                     (to_regclass('public.api_retired_supabase_access') is not null)::text)
     ) s(line)
     order by line collate "C"`,
  );
}

/** Privileges of anon / authenticated / PUBLIC still left on public relations and functions. */
export async function supabasePrivilegesLeft(client: Client): Promise<string[]> {
  return qualifiedLines(
    client,
    `select line from (${SUPABASE_PRIVILEGES_SQL}) s(line) order by line collate "C"`,
  );
}

/** incidents / incident_events members of supabase_realtime still left. */
export async function realtimeMembersLeft(client: Client): Promise<string[]> {
  return qualifiedLines(client, REALTIME_MEMBERS_SQL);
}

/** Policies on storage.objects that let anon / authenticated / public write `avatars` objects. */
export async function avatarWritePolicies(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ policyname: string }>(
    `select p.policyname from pg_policies p
      where p.schemaname = 'storage' and p.tablename = 'objects'
        and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
        and p.roles && array['anon', 'authenticated', 'public']::name[]
        and coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') like '%''avatars''%'
      order by 1`,
  );
  return rows.map((r) => r.policyname);
}
