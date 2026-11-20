import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { ApiConfigService } from '../config';
import { DatabaseService } from '../db/database.service';
import { ROOT_LOGGER } from '../observability/logger';
import { sqlStateOf } from '../modules/incidents/incident-transaction';
import { bullRedisOptions } from './job-queues.service';
import { type JobQueueName, OUTBOX_QUEUE, type OutboxJobData } from './jobs.constants';
import type { OutboxRow } from './outbox';

/** Processes the jobs of one queue in the worker process. */
export interface JobProcessor {
  readonly queue: JobQueueName;
  process(job: Job): Promise<void>;
}

/** DI token: every {@link JobProcessor} of the worker process. */
export const JOB_PROCESSORS = Symbol('JOB_PROCESSORS');

/** Consumes the outbox rows of some topics. Must be idempotent by `row.id` (at-least-once). */
export interface OutboxTopicHandler {
  readonly topics: readonly string[];
  handle(row: OutboxRow): Promise<void>;
}

/** DI token: every {@link OutboxTopicHandler}. */
export const OUTBOX_TOPIC_HANDLERS = Symbol('OUTBOX_TOPIC_HANDLERS');

/**
 * A job that failed. Replaces the original error, which can carry query parameters (a Drizzle query
 * error lists them) and would otherwise be stored by BullMQ as the job's `failedReason` and logged.
 * Only a short code is kept.
 */
export class JobFailedError extends Error {
  constructor(readonly errorCode: string) {
    super(`job failed: ${errorCode}`);
    this.name = 'JobFailedError';
  }
}

/**
 * A job that failed for good: BullMQ does not retry it (`UnrecoverableError`). Its message is the
 * error code only.
 */
export class PermanentJobFailure extends UnrecoverableError {
  constructor(readonly errorCode: string) {
    super(errorCode);
    this.name = 'PermanentJobFailure';
  }
}

/** The code of any job error: its own code, a SQLSTATE, or `internal_error`. */
export function jobErrorCode(error: unknown): string {
  if (error instanceof JobFailedError || error instanceof PermanentJobFailure) {
    return error.errorCode;
  }
  // A worker that restarted reads failures back from Redis as plain errors (message = code).
  if (error instanceof Error && error.name === 'UnrecoverableError') return error.message;
  const sqlState = sqlStateOf(error);
  return sqlState ? `sqlstate_${sqlState}` : 'internal_error';
}

/**
 * Consumer of the `notification-outbox` queue (API-100-45): reads the committed row of the job and
 * hands it to the handler of its topic. A missing row or a topic without a handler is logged and
 * the job completes (retrying cannot help).
 */
@Injectable()
export class OutboxDispatcher implements JobProcessor {
  readonly queue = OUTBOX_QUEUE;
  private readonly handlers = new Map<string, OutboxTopicHandler>();

  constructor(
    private readonly database: DatabaseService,
    @Inject(OUTBOX_TOPIC_HANDLERS) handlers: readonly OutboxTopicHandler[],
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    for (const handler of handlers) {
      for (const topic of handler.topics) this.handlers.set(topic, handler);
    }
  }

  async process(job: Job): Promise<void> {
    const { outbox_id: outboxId } = job.data as OutboxJobData;
    let row: OutboxRow | undefined;
    try {
      const result = await this.database.db.execute<OutboxRow & Record<string, unknown>>(sql`
        select o.id::text as id, o.topic, o.aggregate_id::text as aggregate_id, o.payload,
               o.created_at::text as created_at
          from public.notification_outbox o
         where o.id = ${outboxId}::uuid`);
      row = result.rows[0];
    } catch (error) {
      throw new JobFailedError(jobErrorCode(error));
    }
    if (!row) {
      this.logger.warn({ outbox_id: outboxId }, 'outbox job without a committed row: skipped');
      return;
    }
    const handler = this.handlers.get(row.topic);
    if (!handler) {
      this.logger.warn({ outbox_id: outboxId, topic: row.topic }, 'outbox topic without a handler');
      return;
    }
    try {
      await handler.handle(row);
    } catch (error) {
      throw new JobFailedError(jobErrorCode(error));
    }
  }
}

/**
 * The BullMQ workers of the worker process (`WORKER=1`, API-100-45 AC3): one `Worker` per
 * {@link JobProcessor}, JOBS_WORKER_CONCURRENCY jobs at a time each, on their own Redis
 * connections. Failed attempts are logged (AC5) with the queue, job, attempt and error code only.
 */
@Injectable()
export class JobWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly workers: Worker[] = [];
  private down = false;

  constructor(
    @Inject(JOB_PROCESSORS) private readonly processors: readonly JobProcessor[],
    private readonly config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const url = this.config.get('REDIS_URL');
    if (!url) {
      this.logger.warn('REDIS_URL is not set: no job workers started');
      return;
    }
    for (const processor of this.processors) {
      const worker = new Worker(processor.queue, (job: Job) => processor.process(job), {
        connection: { url, ...bullRedisOptions('atlas-worker') },
        prefix: this.config.get('JOBS_QUEUE_PREFIX'),
        concurrency: this.config.get('JOBS_WORKER_CONCURRENCY'),
      });
      worker.on('failed', (job: Job | undefined, error: Error) => {
        const attempts = job?.opts.attempts ?? 1;
        const made = job?.attemptsMade ?? 0;
        const final = made >= attempts || error instanceof UnrecoverableError;
        this.logger.warn(
          {
            queue: processor.queue,
            job_id: job?.id,
            job_name: job?.name,
            attempts_made: made,
            final,
            error_code: jobErrorCode(error),
          },
          final ? 'job failed, no retries left' : 'job failed, will retry',
        );
      });
      worker.on('error', (err: Error) => {
        if (this.down) return;
        this.down = true;
        this.logger.warn({ err, queue: processor.queue }, 'job worker cannot reach redis');
      });
      worker.on('ready', () => {
        if (this.down) this.logger.info({ queue: processor.queue }, 'job worker reconnected');
        this.down = false;
      });
      this.workers.push(worker);
    }
    this.logger.info({ queues: this.processors.map((p) => p.queue) }, 'job workers started');
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.workers.map((worker) => worker.close()));
  }
}
