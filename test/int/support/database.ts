import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import * as schema from '../../../src/db/schema';
import { assertSafeTarget } from '../../../src/db/tooling/target-guard';

/**
 * Minimal test-database helper for integration tests (API-100-09/10). One dedicated connection to
 * the LOCAL docker database (remote hosts refused), inside a transaction that is always rolled
 * back: fixtures never persist and seed data is untouched. API-100-13 replaces this with the shared
 * harness (Testcontainers, fixture builders, isolation per test).
 */
export interface TestTransaction {
  client: Client;
  db: NodePgDatabase<typeof schema>;
  /** Runs `fn` inside a savepoint that is rolled back afterwards (for destructive steps). */
  scoped<T>(fn: () => Promise<T>): Promise<T>;
  rollback(): Promise<void>;
}

export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (test/int/setup-env.ts sets the local one)');
  assertSafeTarget(url, false);
  return url;
}

export async function openTestTransaction(): Promise<TestTransaction> {
  const client = new Client({
    connectionString: testDatabaseUrl(),
    application_name: 'atlas-int-test',
  });
  await client.connect();
  await client.query('begin');
  let savepoints = 0;
  return {
    client,
    db: drizzle(client, { schema }),
    async scoped<T>(fn: () => Promise<T>): Promise<T> {
      const name = `int_test_${++savepoints}`;
      await client.query(`savepoint ${name}`);
      try {
        return await fn();
      } finally {
        await client.query(`rollback to savepoint ${name}`);
      }
    },
    async rollback() {
      try {
        await client.query('rollback');
      } finally {
        await client.end();
      }
    },
  };
}
