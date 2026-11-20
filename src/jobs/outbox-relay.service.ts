import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import { ApiConfigService } from '../config';
import { DATABASE_CONNECT_TIMEOUT_MS, DATABASE_IDLE_TIMEOUT_MS } from '../db/database.service';
import { ROOT_LOGGER } from '../observability/logger';
import { JobQueues } from './job-queues.service';
import { OUTBOX_JOB_OPTIONS, OUTBOX_QUEUE, type OutboxJobData } from './jobs.constants';

/** Longest wait for Redis while publishing one batch; the batch is retried on the next sweep. */
export const OUTBOX_PUBLISH_TIMEOUT_MS = 5_000;

class PublishTimeoutError extends Error {
  constructor() {
    super(`outbox publish timed out after ${OUTBOX_PUBLISH_TIMEOUT_MS} ms`);
    this.name = 'PublishTimeoutError';
  }
}

interface PendingRow extends Record<string, unknown> {
  id: string;
  topic: string;
  delay_ms: string | number;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PublishTimeoutError()), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The outbox relay (API-100-45 AC2, D23): publishes committed `notification_outbox` rows to the
 * `notification-outbox` queue and sets `published_at`.
 *
 * - Runs in every process (API and worker): a sweep every OUTBOX_RELAY_INTERVAL_MS, and right after
 *   a committed write ({@link kick}, from the post-commit hooks), so a notification does not wait
 *   for the timer. Several relays share the work safely: each batch is claimed with
 *   `FOR UPDATE SKIP LOCKED`.
 * - At-least-once: the job is added before `published_at` is written; if that write is lost (crash,
 *   timeout) the row is published again later. The job id is the outbox id, so BullMQ ignores the
 *   repeat while the first job is kept, and consumers are idempotent by outbox id anyway.
 * - Delayed rows (`deliver_at` in the future) become delayed jobs (AC4).
 * - Failures (database or Redis down) are logged once per outage; the rows stay unpublished and
 *   `attempts` counts the tries.
 * - It has its own single database connection, so a sweep never takes a connection an SOS request
 *   is waiting for (the request pool is DATABASE_POOL_MAX).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  private failing = false;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly pool?: Pool;
  private readonly db?: NodePgDatabase;

  constructor(
    private readonly queues: JobQueues,
    config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    this.batchSize = config.get('OUTBOX_RELAY_BATCH_SIZE');
    this.intervalMs = config.get('OUTBOX_RELAY_INTERVAL_MS');
    const url = config.get('DATABASE_URL');
    if (!url) return;
    this.pool = new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: DATABASE_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: DATABASE_IDLE_TIMEOUT_MS,
      application_name: 'atlas-outbox-relay',
    });
    // An idle connection lost (database restart) must not crash the process; the sweep logs it.
    this.pool.on('error', () => undefined);
    this.db = drizzle(this.pool);
  }

  private get enabled(): boolean {
    return this.db !== undefined && this.queues.isConfigured && !this.stopped;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.kick();
  }

  /** Starts a sweep now (or right after the running one). Never throws, never waits. */
  kick(): void {
    if (!this.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.sweep().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Publishes everything unpublished now and resolves when done (tests, shutdown). */
  async flush(): Promise<void> {
    while (this.running) await this.running;
    if (this.enabled) await this.sweep();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.running) await this.running;
    await this.pool?.end();
  }

  private async sweep(): Promise<void> {
    try {
      while ((await this.publishBatch()) === this.batchSize && !this.stopped) {
        // a full batch: there may be more
      }
      if (this.failing) this.logger.info('outbox relay recovered');
      this.failing = false;
    } catch (err) {
      if (!this.failing) {
        this.logger.warn(
          { err: { name: (err as Error).name, code: (err as { code?: unknown }).code } },
          'outbox relay cannot publish, retrying on the next sweep',
        );
      }
      this.failing = true;
    }
  }

  /** One batch in one transaction. Returns how many rows it published. */
  private async publishBatch(): Promise<number> {
    let claimed: string[] = [];
    try {
      return await this.db!.transaction(async (tx) => {
        const { rows } = await tx.execute<PendingRow>(sql`
          select o.id::text as id,
                 o.topic,
                 case when o.deliver_at is null then 0
                      else greatest(0, ceil(extract(epoch from (o.deliver_at - clock_timestamp()))
                                            * 1000))
                 end as delay_ms
            from public.notification_outbox o
           where o.published_at is null
           order by o.created_at, o.id
           limit ${this.batchSize}::int
             for update skip locked`);
        if (rows.length === 0) return 0;
        claimed = rows.map((row) => row.id);
        await withTimeout(
          Promise.all(
            rows.map((row) => {
              const data: OutboxJobData = { outbox_id: row.id, topic: row.topic };
              return this.queues.add(
                OUTBOX_QUEUE,
                row.topic,
                { ...data },
                {
                  ...OUTBOX_JOB_OPTIONS,
                  jobId: row.id,
                  delay: Number(row.delay_ms) || 0,
                },
              );
            }),
          ),
          OUTBOX_PUBLISH_TIMEOUT_MS,
        );
        await tx.execute(sql`
          update public.notification_outbox
             set published_at = now(),
                 attempts = attempts + 1
           where id in (select jsonb_array_elements_text(${JSON.stringify(claimed)}::jsonb)::uuid)`);
        return rows.length;
      });
    } catch (err) {
      if (claimed.length > 0) await this.countFailedAttempt(claimed);
      throw err;
    }
  }

  private async countFailedAttempt(ids: string[]): Promise<void> {
    try {
      await this.pool?.query(
        `update public.notification_outbox
            set attempts = attempts + 1
          where published_at is null
            and id in (select jsonb_array_elements_text($1::jsonb)::uuid)`,
        [JSON.stringify(ids)],
      );
    } catch {
      // The database is what failed: the next sweep tries again.
    }
  }
}
