import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type QueryResultRow } from 'pg';
import type { Logger } from 'pino';

import { ApiConfigService } from '../config';
import { ROOT_LOGGER } from '../observability/logger';
import { DataStoreNotConfiguredError } from './data-store-errors';
import { guardPoolErrors } from './pool-errors';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/** Time allowed to open one new pool connection before the attempt fails. */
export const DATABASE_CONNECT_TIMEOUT_MS = 5_000;
/** Idle pool connections are closed after this long. */
export const DATABASE_IDLE_TIMEOUT_MS = 30_000;

/**
 * The API's Postgres connection (API-100-07): one node-postgres pool sized by DATABASE_POOL_MAX,
 * with Drizzle on top (`src/db/schema.ts`).
 *
 * Lazy and fail-soft: the pool opens connections only when a query runs, so the API boots and
 * `/healthz` answers while the database is down; `/readyz` reports it. When DATABASE_URL is unset
 * (development/test only; required in production) {@link db} and {@link query} throw
 * {@link DataStoreNotConfiguredError}. The pool is closed on shutdown.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool?: Pool;
  private readonly database?: Database;

  constructor(config: ApiConfigService, @Inject(ROOT_LOGGER) logger: Logger) {
    const url = config.get('DATABASE_URL');
    if (!url) return;
    this.pool = new Pool({
      connectionString: url,
      max: config.get('DATABASE_POOL_MAX'),
      connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MS,
      application_name: 'atlas-api',
    });
    // A connection lost (database restart, network, pooler reset), idle or checked out, must not
    // crash the process: the client is logged and discarded, its query fails normally.
    guardPoolErrors(this.pool, logger, 'api');
    this.database = drizzle(this.pool, { schema });
  }

  get isConfigured(): boolean {
    return this.pool !== undefined;
  }

  /** Drizzle over the pool. */
  get db(): Database {
    if (!this.database) throw new DataStoreNotConfiguredError('DATABASE_URL');
    return this.database;
  }

  /** A plain parameterised query on the pool. Returns the rows. */
  async query<R extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    if (!this.pool) throw new DataStoreNotConfiguredError('DATABASE_URL');
    const result = await this.pool.query<R>(sql, params);
    return result.rows;
  }

  /** One round trip to the database (readiness). */
  async ping(): Promise<void> {
    await this.query('select 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }
}
