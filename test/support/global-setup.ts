import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { Client } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

import { applyBaseline } from '../../src/db/tooling/baseline';
import { runMigrations } from '../../src/db/tooling/migrate';
import { assertSafeTarget } from '../../src/db/tooling/target-guard';
import {
  POSTGRES_IMAGE,
  REDIS_DATABASES,
  REDIS_IMAGE,
  STACK_ENV,
  TEMPLATE_DATABASE,
} from './stack';

/**
 * Jest globalSetup (API-100-13 AC1): one Postgres and one Redis container per run, on random host
 * ports, independent of the local compose stack. Postgres gets the baseline and API migrations
 * once, is frozen into a template database, and each test file then works on its own clone
 * (`worker-isolation.ts`). The password is random per run. Ryuk removes the containers if the run
 * is killed; `global-teardown.ts` stops them otherwise.
 */

const PG_PORT = 5432;
const REDIS_PORT = 6379;
const SHIM_TARGET = '/docker-entrypoint-initdb.d/migrations/99999999999999_atlas_local_shim.sql';
const STARTUP_TIMEOUT_MS = 180_000;
const silent = () => undefined;

export interface TestStack {
  postgres: StartedTestContainer;
  redis: StartedTestContainer;
}

declare global {
  var __ATLAS_TEST_STACK__: TestStack | undefined;
}

function startPostgres(password: string): Promise<StartedTestContainer> {
  return new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_PASSWORD: password,
      PGPASSWORD: password,
      JWT_SECRET: randomBytes(32).toString('hex'),
      JWT_EXP: '3600',
    })
    .withExposedPorts(PG_PORT)
    .withCopyFilesToContainer([
      { source: resolve('db/local/supabase-services-shim.sql'), target: SHIM_TARGET },
    ])
    .withHealthCheck({
      // Healthy only once the image's init (including the shim) has finished: as in compose.
      test: [
        'CMD-SHELL',
        `psql -h localhost -U postgres -d postgres -Atqc "select to_regclass('storage.buckets') is not null" | grep -q t`,
      ],
      interval: 1_000,
      timeout: 5_000,
      retries: 120,
      startPeriod: 5_000,
    })
    .withWaitStrategy(Wait.forHealthCheck())
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();
}

function startRedis(): Promise<StartedTestContainer> {
  return new GenericContainer(REDIS_IMAGE)
    .withCommand(['redis-server', '--databases', String(REDIS_DATABASES), '--save', ''])
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .withStartupTimeout(STARTUP_TIMEOUT_MS)
    .start();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, application_name: 'atlas-test-setup' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Baseline + API migrations as the API role, then a template every worker database clones. */
async function buildTemplate(apiUrl: string, adminMaintenanceUrl: string): Promise<void> {
  await withClient(apiUrl, async (client) => {
    await applyBaseline(client, resolve('db/baseline'), silent);
    await runMigrations(client, resolve('db/migrations'), silent);
  });
  await withClient(adminMaintenanceUrl, async (client) => {
    // CREATE DATABASE needs an idle source: the image's background workers are disconnected first.
    await client.query(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = 'postgres' and pid <> pg_backend_pid()`,
    );
    await client.query(`create database ${TEMPLATE_DATABASE} template postgres owner postgres`);
    await client.query(
      `alter database ${TEMPLATE_DATABASE} with is_template true allow_connections false`,
    );
  });
}

export default async function globalSetup(): Promise<void> {
  const password = randomBytes(24).toString('hex');
  const [postgres, redis] = await Promise.all([startPostgres(password), startRedis()]);
  globalThis.__ATLAS_TEST_STACK__ = { postgres, redis };

  const pgHost = `${postgres.getHost()}:${postgres.getMappedPort(PG_PORT)}`;
  const apiUrlBase = `postgresql://postgres:${password}@${pgHost}`;
  const adminBase = `postgresql://supabase_admin:${password}@${pgHost}`;
  // Tests only ever run against containers on this machine.
  assertSafeTarget(`${apiUrlBase}/postgres`, false);

  await buildTemplate(`${apiUrlBase}/postgres`, `${adminBase}/template1`);

  process.env[STACK_ENV.adminUrl] = `${adminBase}/template1`;
  process.env[STACK_ENV.apiUrlBase] = apiUrlBase;
  process.env[STACK_ENV.redisUrlBase] =
    `redis://${redis.getHost()}:${redis.getMappedPort(REDIS_PORT)}`;
}
