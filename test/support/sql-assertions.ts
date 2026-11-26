import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The SQL behaviour tests of the frozen baseline (`db/baseline/tests`, API-100-13 AC4/AC5), run by
 * `npm run test:baseline` against the template built before 0012. The files are frozen by the
 * baseline checksums.
 */
export const SQL_TESTS_DIR = resolve('db/baseline/tests');

export function sqlTestFiles(dir: string = SQL_TESTS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}
