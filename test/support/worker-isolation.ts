import { Redis } from 'ioredis';
import { Client } from 'pg';

import { adminDatabaseUrl, TEMPLATE_DATABASE, workerDatabaseName, workerRedisUrl } from './stack';
import {
  clearSeededTestSessions,
  closeTestSessionClient,
  registerTestSessionSeeder,
} from './test-sessions';

/**
 * Jest setupFilesAfterEnv (API-100-13 AC1). Test files running in parallel use different workers,
 * so they never share a database or Redis index. Files that follow each other on one worker start
 * clean too: the worker's database is re-cloned from the template and its Redis index flushed before
 * every file. Suites may therefore commit real rows (the idempotency concurrency tests must).
 */
async function resetWorkerStores(): Promise<void> {
  await closeTestSessionClient();
  clearSeededTestSessions();
  const name = workerDatabaseName();
  const admin = new Client({
    connectionString: adminDatabaseUrl(),
    application_name: 'atlas-test-isolation',
  });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name} template ${TEMPLATE_DATABASE} owner postgres`);
  } finally {
    await admin.end();
  }

  const redis = new Redis(workerRedisUrl(), { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

registerTestSessionSeeder();
beforeAll(resetWorkerStores, 120_000);
afterAll(closeTestSessionClient);
