import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Reads the assertions of the SQL behaviour tests (API-100-13 AC5/AC6). An assertion is a
 * `raise exception '<message>'` statement; the closing `raise exception using message = '<name>_ok'`
 * is the success sentinel, not an assertion. The files are frozen by the baseline checksums, so a
 * line number identifies one assertion even when several share a message.
 */
export const SQL_TESTS_DIR = resolve('db/baseline/tests');

export interface SqlAssertion {
  file: string;
  line: number;
  message: string;
}

const RAISE = /\braise\s+exception\s+'((?:[^']|'')*)'/gi;

export function parseSqlAssertions(file: string, sql: string): SqlAssertion[] {
  const assertions: SqlAssertion[] = [];
  sql.split(/\r?\n/).forEach((text, index) => {
    if (text.trimStart().startsWith('--')) return;
    for (const match of text.matchAll(RAISE)) {
      assertions.push({ file, line: index + 1, message: match[1].replace(/''/g, "'") });
    }
  });
  return assertions;
}

/** The name of the parity test that reproduces an assertion: quotes the SQL message. */
export function parityTestName(assertion: Pick<SqlAssertion, 'line' | 'message'>): string {
  return `L${assertion.line}: ${assertion.message}`;
}

export function sqlTestFiles(dir: string = SQL_TESTS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

export function sqlAssertionsOf(file: string, dir: string = SQL_TESTS_DIR): SqlAssertion[] {
  return parseSqlAssertions(file, readFileSync(join(dir, file), 'utf8'));
}

/** `scrum29_cancel_invite.sql` → `scrum29_cancel_invite.spec.ts`. */
export function paritySpecFile(sqlFile: string): string {
  return `${basename(sqlFile, '.sql')}.spec.ts`;
}
