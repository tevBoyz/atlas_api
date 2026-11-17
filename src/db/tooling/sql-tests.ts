import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { ClientBase } from 'pg';

import { assertBaselinePresent, type Log } from './baseline';
import { listSqlFiles } from './checksums';
import { describeSqlError, isPgServerError } from './sql-error';

/**
 * `npm run db:test:sql` (API-100-03): runs the 7 behavioural SQL tests in `db/baseline/tests/`
 * against the local baselined database.
 *
 * Each test is one DO block that ends by raising `<file-name>_ok` so PostgreSQL rolls its rows
 * back; any other error is a failed assertion. Every file additionally runs inside a transaction
 * that is always rolled back.
 */

export interface SqlTestResult {
  file: string;
  passed: boolean;
  detail: string;
  ms: number;
}

/** The sentinel a passing test raises: its file name without `.sql`, plus `_ok`. */
export function successSentinel(file: string): string {
  return `${basename(file, '.sql')}_ok`;
}

/** A test passes when it raised exactly its own sentinel (optionally followed by a detail). */
export function isSuccessMessage(file: string, message: string): boolean {
  const sentinel = successSentinel(file);
  return message === sentinel || message.startsWith(`${sentinel} `);
}

export async function runSqlTests(
  client: ClientBase,
  testsDir: string,
  log: Log,
): Promise<SqlTestResult[]> {
  await assertBaselinePresent(client);
  const results: SqlTestResult[] = [];
  for (const file of listSqlFiles(testsDir)) {
    const sql = readFileSync(join(testsDir, file), 'utf8');
    const started = Date.now();
    let result: SqlTestResult;
    await client.query('begin');
    try {
      await client.query(sql);
      result = { file, passed: false, detail: 'finished without raising its _ok sentinel', ms: 0 };
    } catch (error) {
      const message = isPgServerError(error) ? error.message : '';
      result = isSuccessMessage(file, message)
        ? { file, passed: true, detail: successSentinel(file), ms: 0 }
        : { file, passed: false, detail: describeSqlError(error, sql), ms: 0 };
    } finally {
      await client.query('rollback');
    }
    result.ms = Date.now() - started;
    log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${file} (${result.ms} ms)`);
    if (!result.passed) log(`        ${result.detail}`);
    results.push(result);
  }
  return results;
}
