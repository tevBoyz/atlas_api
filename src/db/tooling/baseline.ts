import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ClientBase } from 'pg';

import {
  computeBaselineChecksums,
  describeDiff,
  diffManifest,
  formatManifest,
  isCleanDiff,
  listSqlFiles,
  MANIFEST_FILE,
  manifestFingerprint,
  parseManifest,
} from './checksums';
import { describeSqlError } from './sql-error';

/**
 * `npm run db:baseline` (API-100-03): applies the 37 Supabase migrations in `db/baseline/`
 * (stored unchanged, spec §6 "Database baseline") to an EMPTY local database, in file-name
 * order, inside one transaction, after verifying the checksum manifest.
 *
 * Re-running is safe: if the same baseline is already applied it does nothing; any other
 * non-empty database is refused (reset it with `docker compose down -v`).
 *
 * The applied baseline is recorded in the local-only schema `atlas_local` (never created in
 * production, where the baseline came from Supabase's own migration history).
 */

export const BASELINE_MARKER_TABLE = 'atlas_local.baseline_applied';

export type Log = (line: string) => void;

export class BaselineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineError';
  }
}

/** Verifies the files against the manifest. Returns the manifest fingerprint. */
export function verifyBaselineFiles(baselineDir: string): string {
  let manifestText: string;
  try {
    manifestText = readFileSync(join(baselineDir, MANIFEST_FILE), 'utf8');
  } catch {
    throw new BaselineError(
      `${MANIFEST_FILE} not found in ${baselineDir}. Run "npm run db:baseline:manifest" once to create it.`,
    );
  }
  const expected = parseManifest(manifestText);
  const actual = computeBaselineChecksums(baselineDir);
  const diff = diffManifest(expected, actual);
  if (!isCleanDiff(diff)) {
    throw new BaselineError(
      `Baseline files do not match ${MANIFEST_FILE} (files under db/baseline/ must stay unchanged):\n` +
        describeDiff(diff),
    );
  }
  return manifestFingerprint(expected);
}

/** Writes the manifest from the current files. Only for a deliberate baseline refresh. */
export function writeBaselineManifest(baselineDir: string): number {
  const entries = computeBaselineChecksums(baselineDir);
  writeFileSync(join(baselineDir, MANIFEST_FILE), formatManifest(entries), 'utf8');
  return entries.length;
}

/** Fingerprint of the applied baseline, or null when no baseline was applied by this tool. */
export async function appliedBaselineFingerprint(client: ClientBase): Promise<string | null> {
  const exists = await client.query<{ present: boolean }>(
    `select to_regclass('${BASELINE_MARKER_TABLE}') is not null as present`,
  );
  if (!exists.rows[0]?.present) return null;
  const row = await client.query<{ fingerprint: string }>(
    `select fingerprint from ${BASELINE_MARKER_TABLE} order by applied_at desc limit 1`,
  );
  return row.rows[0]?.fingerprint ?? null;
}

/** Supabase objects the baseline relies on (they come with the supabase/postgres image). */
const SUPABASE_PREREQUISITES: ReadonlyArray<[string, string]> = [
  ['role anon', `select 1 from pg_roles where rolname = 'anon'`],
  ['role authenticated', `select 1 from pg_roles where rolname = 'authenticated'`],
  ['role service_role', `select 1 from pg_roles where rolname = 'service_role'`],
  ['role supabase_auth_admin', `select 1 from pg_roles where rolname = 'supabase_auth_admin'`],
  ['table auth.users', `select 1 where to_regclass('auth.users') is not null`],
  ['function auth.uid()', `select 1 where to_regprocedure('auth.uid()') is not null`],
  ['function auth.jwt()', `select 1 where to_regprocedure('auth.jwt()') is not null`],
  ['table storage.buckets', `select 1 where to_regclass('storage.buckets') is not null`],
  ['table storage.objects', `select 1 where to_regclass('storage.objects') is not null`],
  [
    'publication supabase_realtime',
    `select 1 from pg_publication where pubname = 'supabase_realtime'`,
  ],
];

async function missingPrerequisites(client: ClientBase): Promise<string[]> {
  const missing: string[] = [];
  for (const [name, sql] of SUPABASE_PREREQUISITES) {
    const result = await client.query(sql);
    if (result.rowCount === 0) missing.push(name);
  }
  return missing;
}

async function publicTableCount(client: ClientBase): Promise<number> {
  const result = await client.query<{ n: number }>(
    `select count(*)::int as n from pg_tables where schemaname = 'public'`,
  );
  return result.rows[0]?.n ?? 0;
}

export type BaselineOutcome = 'applied' | 'already-applied';

export async function applyBaseline(
  client: ClientBase,
  baselineDir: string,
  log: Log,
): Promise<BaselineOutcome> {
  const fingerprint = verifyBaselineFiles(baselineDir);
  const files = listSqlFiles(baselineDir);
  log(`Checksums OK: ${files.length} migrations + tests match ${MANIFEST_FILE}.`);

  const applied = await appliedBaselineFingerprint(client);
  if (applied === fingerprint) {
    log(`Baseline already applied (fingerprint ${fingerprint.slice(0, 12)}). Nothing to do.`);
    return 'already-applied';
  }
  if (applied !== null) {
    throw new BaselineError(
      `This database has a different baseline applied (fingerprint ${applied.slice(0, 12)}, ` +
        `files are ${fingerprint.slice(0, 12)}). Reset the local database: ` +
        `"docker compose down -v" then "docker compose up -d --wait".`,
    );
  }
  const tables = await publicTableCount(client);
  if (tables > 0) {
    throw new BaselineError(
      `Database is not empty (${tables} table(s) in schema public). The baseline only runs on an ` +
        `empty database. Reset it: "docker compose down -v" then "docker compose up -d --wait".`,
    );
  }
  const missing = await missingPrerequisites(client);
  if (missing.length > 0) {
    throw new BaselineError(
      `Supabase objects missing (is this the supabase/postgres image?): ${missing.join(', ')}.`,
    );
  }

  await client.query('begin');
  try {
    for (const [index, file] of files.entries()) {
      const sql = readFileSync(join(baselineDir, file), 'utf8');
      try {
        await client.query(sql);
      } catch (error) {
        throw new BaselineError(`${file} failed: ${describeSqlError(error, sql)}`);
      }
      log(`  [${String(index + 1).padStart(2)}/${files.length}] ${file}`);
    }
    await client.query(`create schema atlas_local`);
    await client.query(
      `comment on schema atlas_local is 'Local development tooling only (API-100-03). Never in production.'`,
    );
    await client.query(
      `create table ${BASELINE_MARKER_TABLE} (
         fingerprint text primary key,
         file_count integer not null,
         applied_at timestamptz not null default now()
       )`,
    );
    await client.query(
      `insert into ${BASELINE_MARKER_TABLE} (fingerprint, file_count) values ($1, $2)`,
      [fingerprint, files.length],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
  log(`Baseline applied: ${files.length} migrations (fingerprint ${fingerprint.slice(0, 12)}).`);
  return 'applied';
}

/** Refuses unless the baseline schema is present (used by migrate, seed and the SQL tests). */
export async function assertBaselinePresent(client: ClientBase): Promise<void> {
  const result = await client.query<{ present: boolean }>(
    `select to_regclass('public.profiles') is not null
        and to_regclass('public.incident_events') is not null as present`,
  );
  if (!result.rows[0]?.present) {
    throw new BaselineError('The baseline schema is not present. Run "npm run db:baseline" first.');
  }
}
