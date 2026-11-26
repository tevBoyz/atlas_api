/**
 * The throwaway data stores shared by one Jest run (API-100-13). `global-setup.ts` starts them and
 * publishes their addresses through these environment variables; every worker derives its own
 * database and Redis index from them (`worker-env.ts`). Nothing here reads `.env`.
 */

/** Same images as docker-compose.yml (epic §18 D1b). */
export const POSTGRES_IMAGE = 'supabase/postgres:17.11.0.019';
export const REDIS_IMAGE = 'redis:7.4.12-alpine';

/** Logical Redis databases available: one per Jest worker. */
export const REDIS_DATABASES = 128;

/**
 * Built once per run: baseline + API migrations, exactly the production state (no test-only
 * grants since the parity suite was retired, D76). Every worker database is cloned from it.
 */
export const TEMPLATE_DATABASE = 'atlas_template';

/** The production state of 0012 / D42 and 0025 / D76: the same template. */
export const PRODUCTION_TEMPLATE_DATABASE = TEMPLATE_DATABASE;

/**
 * The baseline and the API migrations BEFORE 0012 (D42): cloned only by
 * `test/int/rollback-0012.int-spec.ts`, which applies 0012, rolls it back and compares the state.
 */
export const PRE_0012_TEMPLATE_DATABASE = 'atlas_template_pre0012';

/** Migrations numbered below this are in {@link PRE_0012_TEMPLATE_DATABASE}. */
export const RETIREMENT_MIGRATION_NUMBER = 12;

export const STACK_ENV = {
  /** Superuser connection to a maintenance database (creates and drops worker databases). */
  adminUrl: 'ATLAS_TEST_PG_ADMIN_URL',
  /** Connection as the API role (epic §18 D10), without a database name. */
  apiUrlBase: 'ATLAS_TEST_PG_API_URL_BASE',
  /** Redis address, without a database index. */
  redisUrlBase: 'ATLAS_TEST_REDIS_URL_BASE',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set: run this suite through its Jest config (globalSetup).`);
  }
  return value;
}

/** 1-based id of this Jest worker (1 when running in band). */
export function workerId(): number {
  return Number(process.env.JEST_WORKER_ID ?? '1');
}

export function workerDatabaseName(id: number = workerId()): string {
  return `atlas_test_w${id}`;
}

export function workerDatabaseUrl(id: number = workerId()): string {
  return `${required(STACK_ENV.apiUrlBase)}/${workerDatabaseName(id)}`;
}

export function workerRedisUrl(id: number = workerId()): string {
  if (id >= REDIS_DATABASES) throw new Error(`Too many Jest workers (max ${REDIS_DATABASES - 1}).`);
  return `${required(STACK_ENV.redisUrlBase)}/${id}`;
}

export function adminDatabaseUrl(): string {
  return required(STACK_ENV.adminUrl);
}
