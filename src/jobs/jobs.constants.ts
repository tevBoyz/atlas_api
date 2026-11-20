import type { JobsOptions } from 'bullmq';

/**
 * BullMQ queues of the API (API-100-45, D23). Queue keys live under `JOBS_QUEUE_PREFIX` in Redis.
 *
 * - `notification-outbox`: one job per `notification_outbox` row, published by the relay
 *   (job id = outbox id, so a second publish of the same row is ignored while the job is kept).
 * - `notification-deliveries`: one job per `notification_deliveries` row (job id = delivery id),
 *   added by the outbox consumer (API-100-47).
 */
export const OUTBOX_QUEUE = 'notification-outbox';
export const DELIVERY_QUEUE = 'notification-deliveries';
export const JOB_QUEUES = [OUTBOX_QUEUE, DELIVERY_QUEUE] as const;
export type JobQueueName = (typeof JOB_QUEUES)[number];

/** Data of an outbox job: the row id only; the consumer reads the committed row. */
export interface OutboxJobData {
  outbox_id: string;
  topic: string;
}

/** Completed jobs are kept a day (so a re-publish of the same id is ignored), failed ones a week. */
const RETENTION: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: { age: 24 * 60 * 60, count: 50_000 },
  removeOnFail: { age: 7 * 24 * 60 * 60, count: 50_000 },
};

/**
 * Outbox jobs: the consumer only reads and writes the database, so a failure is transient (database
 * restart): 5 attempts, 1 s / 2 s / 4 s / 8 s apart.
 */
export const OUTBOX_JOB_OPTIONS: JobsOptions = {
  ...RETENTION,
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
};

/** Delivery jobs: attempts and backoff come from NOTIFICATIONS_RETRY_* (API-100-47). */
export const DELIVERY_JOB_RETENTION = RETENTION;
