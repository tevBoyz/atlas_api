import { resolve } from 'node:path';

import type { Client } from 'pg';

import { runSqlTests, type SqlTestResult } from '../../src/db/tooling/sql-tests';
import { openTestClient } from '../support/database';
import { recloneWorkerDatabase } from '../support/retirement-state';
import { sqlTestFiles } from '../support/sql-assertions';
import { PRE_0012_TEMPLATE_DATABASE } from '../support/stack';

/**
 * `npm run test:baseline` (API-100-13 AC4): runs each original SQL behaviour test against the
 * FROZEN baseline (the template built before 0012: baseline + 0001-0011), where the Supabase-era
 * functions those tests call still exist. 0025 (D76) removes them from every migrated database, so
 * these tests prove that the frozen starting schema (`db/baseline`, checksummed) is intact, not
 * anything about the API. A file passes only when it ends with its own `<name>_ok` exception.
 */
const FILES = sqlTestFiles();

describe('SQL behaviour tests against the baseline (API-100-13 AC4)', () => {
  let client: Client;
  let results: Map<string, SqlTestResult>;

  beforeAll(async () => {
    await recloneWorkerDatabase(PRE_0012_TEMPLATE_DATABASE);
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
