import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import * as schema from '../../../db/schema';
import { resolveDatabaseUrl } from '../../../db/tooling/database-url';
import {
  ALLOW_REMOTE_FLAG,
  assertSafeTarget,
  formatTarget,
  UnsafeDatabaseTargetError,
} from '../../../db/tooling/target-guard';
import type { DatabaseService } from '../../../db/database.service';
import { LegacyUsers, type MigrationReport } from '../legacy-users';

/**
 * `npm run auth:migrate-users [-- --dry-run] [--allow-remote]` (API-100-58): copies Supabase Auth
 * users into the API's own tables (`LegacyUsers.run`) in ONE transaction. Idempotent: a second run
 * inserts nothing. `--dry-run` runs the same statements and rolls back, so its counts and conflicts
 * are exactly what a real run would do. The target guard of the db tooling applies: only
 * localhost / 127.0.0.1 / ::1 unless `--allow-remote` (for the staging dry run Dawit reviews; never
 * production before his approval). Prints counts only: never an email, a phone, a name or a hash.
 */

const DRY_RUN_FLAG = '--dry-run';

class DryRunRollback extends Error {
  constructor(readonly report: MigrationReport) {
    super('dry run: rolled back');
  }
}

function print(report: MigrationReport, dryRun: boolean): void {
  const lines = [
    dryRun ? 'DRY RUN (nothing written)' : 'Applied',
    `auth.users rows:            ${report.auth_users}`,
    `  skipped anonymous:        ${report.skipped_anonymous}`,
    `  skipped deleted:          ${report.skipped_deleted}`,
    `users inserted:             ${report.users_inserted}`,
    `users already present:      ${report.users_already_present}`,
    `confirmations added:        ${report.confirmations_added}`,
    `bcrypt credentials new:     ${report.credentials_inserted}`,
    `bcrypt credentials updated: ${report.credentials_updated}`,
    `argon2id kept (re-hashed):  ${report.credentials_kept_argon2id}`,
    `users without a password:   ${report.without_password}`,
    `identities inserted:        ${report.identities_inserted}`,
    `auth.identities table:      ${report.auth_identities_table ? 'present' : 'absent'}`,
    'conflicts (left out of the copy, counted only):',
    `  missing email:            ${report.conflicts.missing_email}`,
    `  invalid email:            ${report.conflicts.invalid_email}`,
    `  duplicate email:          ${report.conflicts.duplicate_email}`,
    `  invalid phone:            ${report.conflicts.invalid_phone}`,
    `  duplicate phone:          ${report.conflicts.duplicate_phone}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Runs the migration (or a dry run) on a connected client. Exported for the integration test. */
export async function migrateUsers(client: Client, dryRun: boolean): Promise<MigrationReport> {
  const db = drizzle(client, { schema });
  const legacy = new LegacyUsers(undefined as unknown as DatabaseService);
  try {
    return await db.transaction(async (tx) => {
      const report = await legacy.run(tx);
      if (dryRun) throw new DryRunRollback(report);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.report;
    throw error;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const known = new Set([DRY_RUN_FLAG, ALLOW_REMOTE_FLAG]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    process.stderr.write(
      `usage: npm run auth:migrate-users -- [${DRY_RUN_FLAG}] [${ALLOW_REMOTE_FLAG}]\n`,
    );
    return 2;
  }
  const dryRun = argv.includes(DRY_RUN_FLAG);
  const { url, source } = resolveDatabaseUrl();
  const target = assertSafeTarget(url, argv.includes(ALLOW_REMOTE_FLAG));
  process.stdout.write(`Target: ${formatTarget(target)} (DATABASE_URL from ${source})\n`);
  const client = new Client({
    connectionString: url,
    application_name: 'atlas-auth-migrate-users',
  });
  await client.connect();
  try {
    await client.query(`select set_config('TimeZone', 'UTC', false)`);
    print(await migrateUsers(client, dryRun), dryRun);
    return 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message =
        error instanceof UnsafeDatabaseTargetError
          ? error.message
          : `migration failed (${(error as { code?: string }).code ?? 'unknown'})`;
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
