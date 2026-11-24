import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../config';
import { JobQueues } from '../../jobs/job-queues.service';
import {
  JobFailedError,
  jobErrorCode,
  type JobProcessor,
  PermanentJobFailure,
} from '../../jobs/job-workers';
import { DELIVERY_JOB_RETENTION, DELIVERY_QUEUE } from '../../jobs/jobs.constants';
import type { OutboxRow } from '../../jobs/outbox';
import { ROOT_LOGGER } from '../../observability/logger';
import { ChannelSenders } from './channels/channel-senders';
import {
  type Channel,
  failed,
  isPermanentFailure,
  type SendErrorCode,
  type SendResult,
} from './channels/channel.types';
import { pushMessageOf, pushText } from './channels/push-content';
import {
  DeliveriesRepository,
  type DeliveryRecipient,
  type DeliveryToSend,
} from './deliveries.repository';

/** Data of a delivery job: the row id only. */
export interface DeliveryJobData {
  delivery_id: string;
}

/**
 * Turns one outbox row into delivery rows and delivery jobs (API-100-47 AC2). Idempotent by outbox
 * id: a repeated run inserts no new rows, and re-adding the job of a `queued` row is ignored by
 * BullMQ (job id = delivery id) while that job exists.
 */
@Injectable()
export class DeliveryPlanner {
  private readonly attempts: number;
  private readonly baseDelayMs: number;

  constructor(
    private readonly repository: DeliveriesRepository,
    private readonly queues: JobQueues,
    private readonly channels: ChannelSenders,
    config: ApiConfigService,
  ) {
    // AC3: up to NOTIFICATIONS_RETRY_ATTEMPTS retries (default 3) after the first attempt,
    // exponential backoff from NOTIFICATIONS_RETRY_BASE_DELAY_MS (2 s, 4 s, 8 s by default).
    this.attempts = config.get('NOTIFICATIONS_RETRY_ATTEMPTS') + 1;
    this.baseDelayMs = config.get('NOTIFICATIONS_RETRY_BASE_DELAY_MS');
  }

  /**
   * Returns how many delivery jobs were (re)queued. The rows belong to `incidentId` (incident
   * notices) or to `testAlertId` (SCRUM-35 test alerts), never both.
   */
  async fanOut(
    row: OutboxRow,
    incidentId: string | null,
    recipients: readonly DeliveryRecipient[],
    channels: readonly Channel[],
    testAlertId: string | null = null,
  ): Promise<number> {
    await this.repository.fanOut({
      outboxId: row.id,
      incidentId,
      testAlertId,
      recipients,
      channels,
      enabled: {
        push: this.channels.isEnabled('push'),
        sms: this.channels.isEnabled('sms'),
        email: this.channels.isEnabled('email'),
      },
    });
    const queued = await this.repository.queuedIds(row.id);
    await Promise.all(
      queued.map((delivery) =>
        this.queues.add(
          DELIVERY_QUEUE,
          delivery.channel,
          { delivery_id: delivery.id } satisfies DeliveryJobData,
          {
            ...DELIVERY_JOB_RETENTION,
            jobId: delivery.id,
            attempts: this.attempts,
            backoff: { type: 'exponential', delay: this.baseDelayMs },
          },
        ),
      ),
    );
    return queued.length;
  }
}

/** `+` and digits: `auth.users.phone` is stored without the `+` (an API phone has it, D47). */
function e164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `+${digits}`;
}

/**
 * Consumer of the `notification-deliveries` queue (API-100-47): one send attempt per job.
 *
 * - Not `queued` any more (a repeat): nothing to do.
 * - Channel disabled now: `skipped` `channel_disabled`; push device without a token now:
 *   `skipped` `no_device`; no phone / email now: `skipped` `no_address`.
 * - `sent` / `delivered`: stored with the provider message id and `sent_at`.
 * - `unregistered`: the push token is cleared from `user_devices` (AC4), its SHA-256 kept in
 *   `push_token_invalid_hash` (D69: U1 refuses that token), and the row is `failed`.
 * - Other permanent failures: `failed` at once. Transient ones: retried with exponential backoff
 *   (AC3); the last attempt writes `failed` with the last `error_code`.
 *
 * Errors thrown to BullMQ carry an error code only (never a token, address or SQL parameter).
 */
@Injectable()
export class DeliverySender implements JobProcessor {
  readonly queue = DELIVERY_QUEUE;

  constructor(
    private readonly repository: DeliveriesRepository,
    private readonly channels: ChannelSenders,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async process(job: Job): Promise<void> {
    const { delivery_id: id } = job.data as DeliveryJobData;
    const delivery = await this.guard(() => this.repository.loadForSend(id));
    if (!delivery || delivery.status !== 'queued') return;
    if (!this.channels.isEnabled(delivery.channel)) {
      await this.guard(() => this.repository.markSkipped(id, 'channel_disabled'));
      return;
    }

    let result: SendResult | { skip: 'no_device' | 'no_address' };
    try {
      result = await this.send(delivery);
    } catch {
      // Adapters answer failures as results; anything thrown is treated as a transport failure.
      result = failed('transport_error');
    }
    if ('skip' in result) {
      const reason = result.skip;
      await this.guard(() => this.repository.markSkipped(id, reason));
      return;
    }
    const status = result.status;
    if (status === 'sent' || status === 'delivered') {
      const providerId = result.provider_message_id;
      await this.guard(() => this.repository.markSent(id, status, providerId));
      this.logAccepted(delivery);
      return;
    }

    const code: SendErrorCode = result.error_code ?? 'provider_unavailable';
    if (code === 'unregistered' && delivery.device_id && delivery.push_token) {
      const { device_id: deviceId, push_token: token } = delivery;
      await this.guard(() => this.repository.clearPushToken(deviceId, token));
      this.logger.info(
        { delivery_id: id, device_id: deviceId },
        'push token unregistered by the provider: cleared',
      );
    }
    const permanent = isPermanentFailure(code);
    const final = permanent || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await this.guard(() => this.repository.recordFailure(id, code, final));
    if (permanent) throw new PermanentJobFailure(code);
    throw new JobFailedError(code);
  }

  private async send(
    delivery: DeliveryToSend,
  ): Promise<SendResult | { skip: 'no_device' | 'no_address' }> {
    const message = pushMessageOf(delivery.topic, delivery.payload);
    if (!message) return failed('invalid_request');
    switch (delivery.channel) {
      case 'push':
        if (!delivery.push_token || !delivery.push_provider) return { skip: 'no_device' };
        return this.channels.push.send(
          {
            provider: delivery.push_provider,
            token: delivery.push_token,
            time_zone: delivery.time_zone,
          },
          message,
        );
      case 'sms': {
        if (!delivery.phone) return { skip: 'no_address' };
        const text = pushText(message, delivery.time_zone);
        return this.channels.sms.send(e164(delivery.phone), `${text.title}: ${text.body}`);
      }
      case 'email': {
        if (!delivery.email) return { skip: 'no_address' };
        const text = pushText(message, delivery.time_zone);
        return this.channels.email.send(delivery.email, text.body, `${text.title}: ${text.body}`);
      }
    }
  }

  /**
   * SCRUM-47 latency check: one line per delivery the provider accepted, with the milliseconds from
   * the event (`occurred_at` of the outbox payload: activation, re-notify, mark safe or a test alert's
   * send) to the
   * provider's acceptance. Ids, topic, channel and provider only: no token, name, phone, address,
   * text or medical data. The network leg to the device is measured on the device.
   */
  private logAccepted(delivery: DeliveryToSend): void {
    const occurredAt = delivery.payload.occurred_at;
    const at = typeof occurredAt === 'string' ? Date.parse(occurredAt) : Number.NaN;
    this.logger.info(
      {
        delivery_id: delivery.id,
        incident_id:
          typeof delivery.payload.incident_id === 'string' ? delivery.payload.incident_id : null,
        ...(typeof delivery.payload.test_alert_id === 'string'
          ? { test_alert_id: delivery.payload.test_alert_id }
          : {}),
        topic: delivery.topic,
        channel: delivery.channel,
        provider: delivery.channel === 'push' ? delivery.push_provider : null,
        latency_ms: Number.isNaN(at) ? null : Math.max(0, Date.now() - at),
      },
      'delivery accepted by the provider',
    );
  }

  /** Database work of a delivery: a failure becomes a code-only error (retried by BullMQ). */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new JobFailedError(jobErrorCode(error));
    }
  }
}
