import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { ApiConfigService } from '../config';
import { DataStoreNotConfiguredError } from '../db/data-store-errors';
import { ROOT_LOGGER } from '../observability/logger';

/** Time allowed for one connection attempt. */
export const REDIS_CONNECT_TIMEOUT_MS = 2_000;
/** Longest wait between reconnect attempts (attempt n waits min(n * 200 ms, this)). */
export const REDIS_MAX_RECONNECT_DELAY_MS = 2_000;

/**
 * The API's Redis client (API-100-07), ioredis (traced by OpenTelemetry when enabled, API-100-06).
 *
 * Fail-soft: it starts connecting when the app initialises but never blocks or fails startup;
 * while Redis is down it keeps reconnecting in the background, `/healthz` still answers and
 * `/readyz` reports `redis`. The offline queue is off, so commands fail at once while disconnected
 * instead of waiting. Connection loss is logged once (warn) and recovery once (info), not on every
 * retry. When REDIS_URL is unset (development/test only) {@link client} and {@link ping} throw
 * {@link DataStoreNotConfiguredError}. Closed on shutdown.
 *
 * BullMQ (jobs story) needs its own connections (`maxRetriesPerRequest: null`); do not reuse this one.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly redis?: Redis;
  private down = false;

  constructor(
    config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    const url = config.get('REDIS_URL');
    if (!url) return;
    this.redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      enableOfflineQueue: false,
      connectionName: 'atlas-api',
      retryStrategy: (attempt: number) => Math.min(attempt * 200, REDIS_MAX_RECONNECT_DELAY_MS),
    });
    this.redis.on('error', (err: Error) => {
      if (this.down) return;
      this.down = true;
      this.logger.warn({ err }, 'redis unavailable, reconnecting in the background');
    });
    this.redis.on('ready', () => {
      if (this.down) this.logger.info('redis connection restored');
      this.down = false;
    });
  }

  get isConfigured(): boolean {
    return this.redis !== undefined;
  }

  get client(): Redis {
    if (!this.redis) throw new DataStoreNotConfiguredError('REDIS_URL');
    return this.redis;
  }

  /** Redis PING (readiness). Fails at once while disconnected. */
  async ping(): Promise<void> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') throw new Error('unexpected PING reply');
  }

  onModuleInit(): void {
    // Not awaited: a down Redis must not block startup. Failures surface through the error event.
    this.redis?.connect().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    if (this.redis.status === 'ready') {
      try {
        await this.redis.quit();
        return;
      } catch {
        // fall through to a hard disconnect
      }
    }
    this.redis.disconnect();
  }
}
