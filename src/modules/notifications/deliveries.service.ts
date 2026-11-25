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
import { AlertDeliveryOutcomes, isAlertDeliveryTopic } from './alert-delivery-outcomes';
import {
  DeliveriesRepository,
  type DeliveryFinalOutcome,
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
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    // AC3: up to NOTIFICATIONS_RETRY_ATTEMPTS retries (default 3) after the first attempt,
    // exponential backoff from NOTIFICATIONS_RETRY_BASE_DELAY_MS (2 s, 4 s, 8 s by default).
    this.attempts = config.get('NOTIFICATIONS_RETRY_ATTEMPTS') + 1;
    this.baseDelayMs = config.get('NOTIFICATIONS_RETRY_BASE_DELAY_MS');
  }

  /**
   * Returns how many delivery jobs were (re)queued. The rows belong to `incidentId` (incident
   * notices) or to `testAlertId` (SCRUM-35 test alerts), never both. Each row skipped at fan-out is
   * final at once and logged as one outcome line (SCRUM-67, {@link logFinalOutcome}).
   */
  async fanOut(
    row: OutboxRow,
    incidentId: string | null,
    recipients: readonly DeliveryRecipient[],
    channels: readonly Channel[],
    testAlertId: string | null = null,
  ): Promise<number> {
    const skipped = await this.repository.fanOut({
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
    for (const outcome of skipped) logFinalOutcome(this.logger, outcome, row.topic, incidentId);
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

/**
 * SCRUM-67 (D73): ONE structured info line per final outcome of a delivery row (sent, delivered,
 * failed after the retries, or skipped), with exactly these keys: `delivery_id`, `topic` (the outbox
 * kind), `channel`, `status`, `error_code`, `attempts`, `incident_id` (null for a test alert). Never
 * a token, address, phone, email, name or text.
 */
export function logFinalOutcome(
  logger: Logger,
  outcome: DeliveryFinalOutcome,
  topic: string,
  incidentId: string | null,
): void {
  logger.info(
    {
      delivery_id: outcome.delivery_id,
      topic,
      channel: outcome.channel,
      status: outcome.status,
      error_code: outcome.error_code,
      attempts: outcome.attempts,
      incident_id: incidentId,
    },
    'delivery outcome',
  );
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
 * - Every final outcome is logged once ({@link logFinalOutcome}, SCRUM-67). A row of an alert notice
 *   (`incident.created` / `incident.renotified`) then re-checks its member's delivery status
 *   ({@link AlertDeliveryOutcomes}, SCRUM-65 / 71): the resident's responder row is refreshed and a
 *   member who is now `failed` is reported to the resident once. A repeat of a job whose alert row is
 *   already final re-runs that check (idempotent), so a check lost to an error is retried.
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
    private readonly alerts: AlertDeliveryOutcomes,
  ) {}

  async process(job: Job): Promise<void> {
    const { delivery_id: id } = job.data as DeliveryJobData;
    const delivery = await this.guard(() => this.repository.loadForSend(id));
    if (!delivery) return;
    if (delivery.status !== 'queued') {
      await this.afterFinal(delivery, undefined);
      return;
    }
    if (!this.channels.isEnabled(delivery.channel)) {
      const outcome = await this.guard(() => this.repository.markSkipped(id, 'channel_disabled'));
      await this.afterFinal(delivery, outcome);
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
      const outcome = await this.guard(() => this.repository.markSkipped(id, reason));
      await this.afterFinal(delivery, outcome);
      return;
    }
    const status = result.status;
    if (status === 'sent' || status === 'delivered') {
      const providerId = result.provider_message_id;
      const outcome = await this.guard(() => this.repository.markSent(id, status, providerId));
      if (outcome) this.logAccepted(delivery);
      await this.afterFinal(delivery, outcome);
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
    const outcome = await this.guard(() => this.repository.recordFailure(id, code, final));
    if (final) await this.afterFinal(delivery, outcome);
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

  /**
   * A row is final: log its outcome when this job wrote it (`outcome`), then, for a row of an alert
   * notice, re-check the member's delivery status (SCRUM-65 / 71). A failure of that check becomes a
   * code-only error (the job is retried; the retry finds the row final and runs the check again).
   */
  private async afterFinal(
    delivery: DeliveryToSend,
    outcome: DeliveryFinalOutcome | undefined,
  ): Promise<void> {
    if (outcome) logFinalOutcome(this.logger, outcome, delivery.topic, delivery.incident_id);
    const incidentId = delivery.incident_id;
    if (!incidentId || !isAlertDeliveryTopic(delivery.topic)) return;
    await this.guard(() =>
      this.alerts.afterMemberOutcome(incidentId, [delivery.recipient_user_id]),
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
