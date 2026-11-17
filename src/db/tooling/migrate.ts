import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ClientBase } from 'pg';

import { assertBaselinePresent, type Log } from './baseline';
import { compareNames } from './checksums';
import { describeSqlError } from './sql-error';

/**
 * `npm run db:migrate` (API-100-03): applies API-owned plain-SQL migrations from `db/migrations/`
 * in number order, each in its own transaction, recording each in
 * `public.api_schema_migrations (id text primary key, applied_at timestamptz)`.
 *
 * File names: `<number>_<snake_case_description>.sql`, e.g. `0001_audit_log.sql`. The id is the
 * file name without `.sql`. Migrations must be additive and backward compatible (AGENTS.md rule 4).
 */

export const MIGRATIONS_TABLE = 'public.api_schema_migrations';

/** Arbitrary constant key for the session advisory lock that serializes concurrent runners. */
export const MIGRATE_LOCK_KEY = 7_100_003;

const MIGRATION_FILE = /^(\d+)_[a-z0-9][a-z0-9_]*\.sql$/;

/** Supabase API roles that reach `public` tables through default privileges (PostgREST). */
export const SUPABASE_API_ROLES = ['anon', 'authenticated'] as const;

/**
 * Creates the tracking table and locks it down like `0001_idempotency_keys.sql`: RLS enabled with
 * no policy, and no privileges for `public` or the Supabase API roles (only those that exist, so
 * plain Postgres without Supabase roles works). The owner (the runner / API role) is unaffected.
 * Idempotent; runs on every `db:migrate`. `0002_lock_down_api_schema_migrations.sql` does the same
 * for databases created before this was added.
 */
export function migrationsTableSql(): string {
  const roles = SUPABASE_API_ROLES.map((r) => `'${r}'`).join(', ');
  return `create table if not exists ${MIGRATIONS_TABLE} (
  id text primary key,
  applied_at timestamptz not null default now()
);
alter table ${MIGRATIONS_TABLE} enable row level security;
revoke all on table ${MIGRATIONS_TABLE} from public;
do $lockdown$
declare
  r text;
begin
  for r in select rolname from pg_roles where rolname in (${roles}) loop
    execute format('revoke all on table ${MIGRATIONS_TABLE} from %I', r);
  end loop;
end
$lockdown$;`;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  id: string;
  file: string;
  number: number;
}

/** Validates names and ordering. Ignores non-SQL files (e.g. README.md). */
export function parseMigrationFiles(names: readonly string[]): MigrationFile[] {
  const files: MigrationFile[] = [];
  const bad: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.sql')) continue;
    const match = MIGRATION_FILE.exec(name);
    if (!match) {
      bad.push(name);
      continue;
    }
    files.push({ id: name.slice(0, -'.sql'.length), file: name, number: Number(match[1]) });
  }
  if (bad.length > 0) {
    throw new MigrationError(
      `Invalid migration file name(s): ${bad.join(', ')}. Use <number>_<snake_case>.sql.`,
    );
  }
  files.sort((a, b) => a.number - b.number || compareNames(a.file, b.file));
  const seen = new Map<number, string>();
  for (const f of files) {
    const other = seen.get(f.number);
    if (other) throw new MigrationError(`Duplicate migration number: ${other} and ${f.file}.`);
    seen.set(f.number, f.file);
  }
  return files;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  /** Ids recorded as applied that no longer have a file (reported, never undone). */
  unknownApplied: string[];
}

export function planMigrations(
  files: readonly MigrationFile[],
  appliedIds: readonly string[],
): MigrationPlan {
  const applied = new Set(appliedIds);
  const known = new Set(files.map((f) => f.id));
  return {
    pending: files.filter((f) => !applied.has(f.id)),
    unknownApplied: appliedIds.filter((id) => !known.has(id)),
  };
}

export function listMigrationFiles(migrationsDir: string): MigrationFile[] {
  let names: string[];
  try {
    names = readdirSync(migrationsDir);
  } catch {
    return [];
  }
  return parseMigrationFiles(names);
}

export async function runMigrations(
  client: ClientBase,
  migrationsDir: string,
  log: Log,
): Promise<string[]> {
  await assertBaselinePresent(client);
  const files = listMigrationFiles(migrationsDir);

  await client.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
  try {
    await client.query(migrationsTableSql());
    const applied = await client.query<{ id: string }>(
      `select id from ${MIGRATIONS_TABLE} order by id`,
    );
    const plan = planMigrations(
      files,
      applied.rows.map((r) => r.id),
    );
    for (const id of plan.unknownApplied) {
      log(`  warning: ${id} is recorded as applied but has no file in db/migrations/.`);
    }
    if (plan.pending.length === 0) {
      log(
        `No pending migrations (${files.length} file(s), ${applied.rowCount ?? 0} recorded in ${MIGRATIONS_TABLE}).`,
      );
      return [];
    }
    for (const migration of plan.pending) {
      const sql = readFileSync(join(migrationsDir, migration.file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(`insert into ${MIGRATIONS_TABLE} (id) values ($1)`, [migration.id]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new MigrationError(`${migration.file} failed: ${describeSqlError(error, sql)}`);
      }
      log(`  applied ${migration.id}`);
    }
    log(`Applied ${plan.pending.length} migration(s).`);
    return plan.pending.map((m) => m.id);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]);
  }
}
