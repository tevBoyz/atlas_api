import { resolve } from 'node:path';

import type { Client } from 'pg';

import { runSqlTests, type SqlTestResult } from '../../src/db/tooling/sql-tests';
import { openTestClient } from '../support/database';
import { sqlTestFiles } from '../support/sql-assertions';

/**
 * `npm run test:baseline` (API-100-13 AC4): runs each original SQL behaviour test against the
 * container (baseline + API migrations). A file passes only when it ends with its own `<name>_ok`
 * exception, which proves the baseline here behaves like the hosted database did.
 */
const FILES = sqlTestFiles();

describe('SQL behaviour tests against the baseline (API-100-13 AC4)', () => {
  let client: Client;
  let results: Map<string, SqlTestResult>;

  beforeAll(async () => {
    client = await openTestClient();
    const run = await runSqlTests(client, resolve('db/baseline/tests'), () => undefined);
    results = new Map(run.map((result) => [result.file, result]));
  }, 120_000);

  afterAll(async () => {
    await client.end();
  });

  it('covers all 7 SQL files', () => {
    expect(FILES).toHaveLength(7);
  });

  it.each(FILES)('%s ends with its _ok sentinel', (file) => {
    const result = results.get(file);
    expect(result?.detail).toBe(`${file.replace(/\.sql$/, '')}_ok`);
    expect(result?.passed).toBe(true);
  });
});
