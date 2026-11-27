import { Body, Controller, HttpCode, Inject, Injectable, Post } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';

import { Public } from '../../common/guards/route-access';
import { RateLimit, type RateLimitRule } from '../../common/rate-limit';
import { DatabaseService } from '../../db/database.service';
import { ROOT_LOGGER } from '../../observability/logger';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { IncidentBroadcaster } from '../../realtime/incident-broadcaster';
import { AuditService } from '../audit';
import { isAlertDeliveryTopic } from './alert-delivery-outcomes';
import { FINAL_RETURNING } from './deliveries.repository';
import { type DeliveryFinalRow, deliveryOutcomeAudit } from './delivery-audit';
import { ReceiptTokens } from './receipt-token';

/**
 * Stage 2 [B7] (D77): "Delivered" means the receiving phone confirmed that the push arrived. The
 * app's push handlers (foreground and background, where no session may exist) post the push's
 * `receipt_token` to `POST /v1/notifications/receipts`.
 */

/** Per client address: a phone posts one receipt per push it receives. */
export const NOTIFICATION_RECEIPTS_LIMIT: RateLimitRule = {
  name: 'notification_receipts',
  max: 120,
  windowSeconds: 60,
  scope: 'ip',
};

export const notificationReceiptRequestSchema = z.object({
  receipt_token: z
    .string()
    .describe('The `receipt_token` data key of the push, exactly as received (opaque).'),
});

/** What a receipt did. Only `delivered` and `pending` have an effect. */
export type ReceiptOutcome =
  /** The row was `sent` (accepted by the push service): now `delivered`, audited once. */
  | 'delivered'
  /** The row is still being sent (the receipt beat the provider's answer): recorded, the sender makes it `delivered`. */
  | 'pending'
  /** Not a token this API signed, or malformed. */
  | 'invalid'
  /** A valid token whose row is already delivered, failed, skipped, gone, or not a push. */
  | 'no_effect';

@Injectable()
export class NotificationReceiptsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: ReceiptTokens,
    private readonly audit: AuditService,
    private readonly broadcaster: IncidentBroadcaster,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Records the receipt of one push. Never throws for the caller's input: an invalid or repeated
   * token has no effect and logs one warning without the token.
   *
   * One transaction: the row (a push row, not yet received, `queued` or `sent`) gets
   * `delivered_at = now()`; a `sent` row becomes `delivered` and, for an alert notice of an
   * incident, writes its `incident.delivery_outcome` audit row (status `delivered`) in the same
   * transaction. The guard `delivered_at is null` makes a repeat a no-op, so that audit row is written
   * once. A `queued` row (the provider has not answered yet) keeps its status; the sender then writes
   * it `delivered` instead of `sent`. After the commit the resident's sockets get the member's
   * responder row again (SCRUM-65: Delivered).
   */
  async record(token: unknown): Promise<ReceiptOutcome> {
    const deliveryId = this.tokens.verify(token);
    if (!deliveryId) {
      this.logger.warn({ reason: 'invalid' }, 'notification receipt ignored');
      return 'invalid';
    }
    const row = await this.database.db.transaction(async (tx) => {
      const result = await tx.execute<DeliveryFinalRow>(sql`
        update public.notification_deliveries
           set delivered_at = now(),
               status = case when status = 'sent' then 'delivered' else status end,
               updated_at = now()
         where id = ${deliveryId}::uuid
           and channel = 'push'
           and delivered_at is null
           and status in ('queued', 'sent')
        ${FINAL_RETURNING}`);
      const updated = result.rows[0];
      if (updated?.status === 'delivered') {
        const entry = deliveryOutcomeAudit(updated);
        if (entry) await this.audit.record(entry, tx);
      }
      return updated;
    });
    if (!row) {
      this.logger.warn(
        { reason: 'no_effect', delivery_id: deliveryId },
        'notification receipt ignored',
      );
      return 'no_effect';
    }
    if (row.status !== 'delivered') return 'pending';
    this.logger.info(
      { delivery_id: row.delivery_id, incident_id: row.incident_id, topic: row.topic },
      'push receipt confirmed by the device',
    );
    if (row.incident_id && isAlertDeliveryTopic(row.topic)) {
      try {
        await this.broadcaster.afterDeliveryStatus({
          incident_id: row.incident_id,
          member_user_id: row.recipient_user_id,
        });
      } catch {
        // The receipt is committed; a failed broadcast only delays the resident's live refresh.
        this.logger.warn({ delivery_id: row.delivery_id }, 'receipt broadcast failed');
      }
    }
    return 'delivered';
  }
}

/**
 * `POST /v1/notifications/receipts` (Stage 2 [B7], D77). No session (the background push handler
 * may have none): the signed token is the only credential and names one delivery row. Always 204,
 * so a caller learns nothing about tokens or rows; rate limited per client address.
 */
@Controller('notifications/receipts')
@Public()
export class NotificationReceiptsController {
  constructor(private readonly receipts: NotificationReceiptsService) {}

  @Post()
  @HttpCode(204)
  @RateLimit(NOTIFICATION_RECEIPTS_LIMIT)
  @ApiContract({
    operationId: 'reportNotificationReceipt',
    summary: 'Report that this phone received a push (no sign-in needed)',
    tag: 'devices',
    body: { name: 'NotificationReceiptRequest', schema: notificationReceiptRequestSchema },
    responses: {
      204: {
        description:
          "Always, also for a repeated, unknown or forged token (it then has no effect). Send it from the foreground and the background push handler, without an Authorization header; on a network failure retry once at the next app start. The delivery then shows as Delivered on the resident's responder list (D77).",
      },
    },
  })
  async report(@Body() body: unknown): Promise<void> {
    const token =
      body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).receipt_token
        : undefined;
    await this.receipts.record(token);
  }
}
