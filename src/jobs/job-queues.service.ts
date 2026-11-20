import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type JobsOptions, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { ApiConfigService } from '../config';
import { DataStoreNotConfiguredError } from '../db/data-store-errors';
import { ROOT_LOGGER } from '../observability/logger';
import { REDIS_CONNECT_TIMEOUT_MS, REDIS_MAX_RECONNECT_DELAY_MS } from '../redis/redis.service';
import { JOB_QUEUES, type JobQueueName } from './jobs.constants';

/** ioredis options BullMQ needs (`maxRetriesPerRequest: null`), with the API's reconnect policy. */
export function bullRedisOptions(name: string) {
  return {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    connectionName: name,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, REDIS_MAX_RECONNECT_DELAY_MS),
  };
}

/**
 * The BullMQ producers (API-100-45, D23): one `Queue` per {@link JOB_QUEUES} entry, all on one
 * Redis connection of their own (BullMQ needs `maxRetriesPerRequest: null`, unlike
 * {@link RedisService}). Fail-soft like the other stores: it connects in the background, a down
 * Redis is logged once (and its recovery once), and `/readyz` reports `jobs` (AC5) through
 * {@link ping}. Not configured without REDIS_URL (development/test only).
 */
@Injectable()
export class JobQueues implements OnModuleInit, OnModuleDestroy {
  private readonly connection?: Redis;
  private readonly queues = new Map<JobQueueName, Queue>();
  private down = false;

  constructor(
    config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    const url = config.get('REDIS_URL');
    if (!url) return;
    this.connection = new Redis(url, bullRedisOptions('atlas-jobs'));
    this.connection.on('error', (err: Error) => this.markDown(err));
    this.connection.on('ready', () => {
      if (this.down) this.logger.info('jobs redis connection restored');
      this.down = false;
    });
    const prefix = config.get('JOBS_QUEUE_PREFIX');
    for (const name of JOB_QUEUES) {
      const queue = new Queue(name, { connection: this.connection, prefix });
      queue.on('error', (err: Error) => this.markDown(err));
      this.queues.set(name, queue);
    }
  }

  get isConfigured(): boolean {
    return this.connection !== undefined;
  }

  /** The producer of `name`. */
  queue(name: JobQueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new DataStoreNotConfiguredError('REDIS_URL');
    return queue;
  }

  /** Adds one job. With a `jobId` already in the queue (kept or pending), nothing is added. */
  async add(
    name: JobQueueName,
    jobName: string,
    data: Record<string, unknown>,
    options: JobsOptions,
  ): Promise<void> {
    await this.queue(name).add(jobName, data, options);
  }

  /** Readiness (`jobs`): the producers' connection answers PING. Fails at once while it is down. */
  async ping(): Promise<void> {
    if (!this.connection) throw new DataStoreNotConfiguredError('REDIS_URL');
    if (this.connection.status !== 'ready') throw new Error(`jobs redis ${this.connection.status}`);
    const reply = await this.connection.ping();
    if (reply !== 'PONG') throw new Error('unexpected PING reply');
  }

  onModuleInit(): void {
    // Not awaited: a down Redis must not block startup.
    this.connection?.connect().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    if (!this.connection) return;
    if (this.connection.status === 'ready') {
      try {
        await this.connection.quit();
        return;
      } catch {
        // fall through to a hard disconnect
      }
    }
    this.connection.disconnect();
  }

  private markDown(err: Error): void {
    if (this.down) return;
    this.down = true;
    this.logger.warn({ err }, 'jobs redis unavailable, reconnecting in the background');
  }
}
