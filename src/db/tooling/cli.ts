import { resolve } from 'node:path';

import { Client } from 'pg';

import {
  applyBaseline,
  BaselineError,
  verifyBaselineFiles,
  writeBaselineManifest,
  type Log,
} from './baseline';
import { resolveDatabaseUrl } from './database-url';
import { MigrationError, runMigrations } from './migrate';
import { seedLocalData, SeedError } from './seed';
import { runSqlTests } from './sql-tests';
import {
  ALLOW_REMOTE_FLAG,
  assertSafeTarget,
  formatTarget,
  UnsafeDatabaseTargetError,
} from './target-guard';

/**
 * Entry point of the `db:*` npm scripts (API-100-03). Usage:
 *   tsx src/db/tooling/cli.ts <command> [--allow-remote]
 *
 * Every command that connects first passes DATABASE_URL through the target guard: only
 * localhost / 127.0.0.1 / ::1 unless `--allow-remote` is given. Output names the target as
 * host:port/database only.
 */

const BASELINE_DIR = resolve('db/baseline');
const TESTS_DIR = resolve('db/baseline/tests');
const MIGRATIONS_DIR = resolve('db/migrations');

const log: Log = (line) => process.stdout.write(`${line}\n`);

type DbCommand = (client: Client) => Promise<boolean>;

const DB_COMMANDS: Record<string, DbCommand> = {
  baseline: async (client) => {
    await applyBaseline(client, BASELINE_DIR, log);
    return true;
  },
  migrate: async (client) => {
    await runMigrations(client, MIGRATIONS_DIR, log);
    return true;
  },
  seed: async (client) => {
    await seedLocalData(client, log);
    return true;
  },
  'test-sql': async (client) => {
    const results = await runSqlTests(client, TESTS_DIR, log);
    const failed = results.filter((r) => !r.passed).length;
    log(`SQL tests: ${results.length - failed} passed, ${failed} failed, ${results.length} total.`);
    return failed === 0;
  },
  setup: async (client) => {
    log('== baseline');
    await applyBaseline(client, BASELINE_DIR, log);
    log('== migrate');
    await runMigrations(client, MIGRATIONS_DIR, log);
    log('== seed');
    await seedLocalData(client, log);
    return true;
  },
};

const FILE_COMMANDS: Record<string, () => boolean> = {
  verify: () => {
    verifyBaselineFiles(BASELINE_DIR);
    log('Baseline checksums OK.');
    return true;
  },
  manifest: () => {
    const count = writeBaselineManifest(BASELINE_DIR);
    log(`Wrote db/baseline/checksums.sha256 (${count} files). Review the diff before committing.`);
    return true;
  },
};

const KNOWN_ERRORS = [UnsafeDatabaseTargetError, BaselineError, MigrationError, SeedError];

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.filter((a) => a !== ALLOW_REMOTE_FLAG);
  const allowRemote = args.length !== argv.length;
  const command = args[0] ?? '';
  const unknownFlags = args.slice(1);
  if (unknownFlags.length > 0) {
    log(`Unknown argument(s): ${unknownFlags.join(' ')}`);
    return 2;
  }

  const fileCommand = FILE_COMMANDS[command];
  if (fileCommand) return fileCommand() ? 0 : 1;

  const dbCommand = DB_COMMANDS[command];
  if (!dbCommand) {
    const all = [...Object.keys(DB_COMMANDS), ...Object.keys(FILE_COMMANDS)].join(', ');
    log(`Unknown command "${command}". Commands: ${all}.`);
    return 2;
  }

  const { url, source } = resolveDatabaseUrl();
  const target = assertSafeTarget(url, allowRemote);
  log(`Target: ${formatTarget(target)} (DATABASE_URL from ${source})`);
  if (!target.isLocal) log(`WARNING: ${ALLOW_REMOTE_FLAG} given, running against a remote host.`);

  const client = new Client({ connectionString: url, application_name: `atlas-db-${command}` });
  try {
    await client.connect();
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? ` (${String(error.code)})` : '';
    log(
      `Could not connect to ${formatTarget(target)}${code}. Is the local database running? ` +
        `Try "docker compose up -d --wait".`,
    );
    return 1;
  }
  try {
    return (await dbCommand(client)) ? 0 : 1;
  } finally {
    await client.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (KNOWN_ERRORS.some((type) => error instanceof type)) {
      process.stderr.write(`${(error as Error).message}\n`);
    } else {
      process.stderr.write(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exitCode = 1;
  },
);
