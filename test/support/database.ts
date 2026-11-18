import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import * as schema from '../../src/db/schema';
import { assertSafeTarget } from '../../src/db/tooling/target-guard';

/**
 * Database access for tests (API-100-09/10/13): dedicated connections to THIS worker's container
 * database (remote hosts refused). {@link openTestTransaction} wraps fixtures in a transaction that
 * is always rolled back; {@link openTestClient} is for suites that must commit.
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
  if (!url) throw new Error('DATABASE_URL is not set (test/support/worker-env.ts sets it)');
  assertSafeTarget(url, false);
  return url;
}

/** A connected client on this worker's database. The caller ends it. */
export async function openTestClient(): Promise<Client> {
  const client = new Client({
    connectionString: testDatabaseUrl(),
    application_name: 'atlas-int-test',
  });
  await client.connect();
  return client;
}

export async function openTestTransaction(): Promise<TestTransaction> {
  const client = await openTestClient();
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
