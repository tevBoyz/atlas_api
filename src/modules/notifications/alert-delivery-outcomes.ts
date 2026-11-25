import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { incidentAlias, incidentMemberView } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import { OutboxWriter } from '../../jobs/outbox';
import { OutboxRelay } from '../../jobs/outbox-relay.service';
import { ROOT_LOGGER } from '../../observability/logger';
import { AuditService } from '../audit';
import {
  IncidentBroadcaster,
  type IncidentDeliveryFailedEvent,
} from '../../realtime/incident-broadcaster';
import {
  ALERT_DELIVERY_TOPICS,
  type MemberDelivery,
  memberDeliverySql,
} from '../incidents/incident-delivery-status';
import { DELIVERY_FAILED_TOPIC } from './channels/channel.types';
import { deliveryFailedNoticeAudit } from './delivery-audit';

/** True for the outbox topics whose push rows make a member's delivery status (D73). */
export function isAlertDeliveryTopic(topic: string): boolean {
  return (ALERT_DELIVERY_TOPICS as readonly string[]).includes(topic);
}

/**
 * SCRUM-71 (D73): the resident was told now that this member did not receive the alert. The member's
 * full user id (the resident gets full ids on the responder list) and display name only;
 * `occurred_at` = `delivery_failed_notified_at` (UTC).
 */
export type DeliveryFailedNotice = IncidentDeliveryFailedEvent;

/**
 * After a member's alert push rows changed (SCRUM-65 / 71, D73), in the worker process: called when a
 * row of an alert notice ({@link ALERT_DELIVERY_TOPICS}) became final, and after an alert notice was
 * fanned out (its skipped rows are final at once; a re-notify adds `queued` rows). Per member:
 *
 * 1. One short transaction: the incident `FOR SHARE` while it is `active` (so mark safe cannot
 *    resolve it in between: no notice after the alert ended), the member's delivery status
 *    ({@link memberDeliverySql}); when it is `failed`, `incident_deliveries.delivery_failed_notified_at`
 *    is set if still null (the member must still pass `incident.memberView`) and, only when this
 *    call set it, an `incident.delivery_failed` outbox row for the resident and the
 *    `incident.delivery_failed_notice` audit row (SCRUM-74, D75) are written in the same
 *    transaction. At most one notice per member per incident (decision 3), whatever retries,
 *    re-notifies or repeated jobs happen. Lock order: incident, then the member's delivery row (as
 *    acknowledge and re-notify), never the other way round.
 * 2. After the commit: the resident's sockets get the member's responder row again
 *    (`incident.responders`, resident room only: the delivery keys are the resident's), and, for a
 *    new notice, `incident.delivery_failed` (resident room only); the outbox relay is kicked so the
 *    resident's push leaves at once.
 *
 * Nothing here is visible to members: their responder rows and payloads are unchanged.
 */
@Injectable()
export class AlertDeliveryOutcomes {
  constructor(
    private readonly database: DatabaseService,
    private readonly outbox: OutboxWriter,
    private readonly relay: OutboxRelay,
    private readonly broadcaster: IncidentBroadcaster,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}

  /** Re-checks every member in `memberUserIds` of incident `incidentId` (see the class comment). */
  async afterMemberOutcome(incidentId: string, memberUserIds: readonly string[]): Promise<void> {
    for (const memberUserId of new Set(memberUserIds)) {
      const notice = await this.checkMember(incidentId, memberUserId);
      await this.broadcaster.afterDeliveryStatus({
        incident_id: incidentId,
        member_user_id: memberUserId,
      });
      if (notice) {
        this.relay.kick();
        this.logger.info(
          { incident_id: notice.incident_id, delivery_failed_reason: notice.reason },
          'alert not delivered to a member: resident notified',
        );
        await this.broadcaster.afterDeliveryFailed(notice);
      }
    }
  }

  /** Step 1 of the class comment; the notice when this call recorded it. */
  private checkMember(
    incidentId: string,
    memberUserId: string,
  ): Promise<DeliveryFailedNotice | undefined> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
      const incident = await tx.execute<{ resident_id: string }>(sql`
        select rec.resident_id::text as resident_id
          from public.incidents rec
         where rec.id = ${incidentId}::uuid
           and rec.status = 'active'
           for share`);
      if (incident.rows.length === 0) return undefined;

      const status = await tx.execute<{ delivery: MemberDelivery }>(sql`
        select ${memberDeliverySql(sql`${incidentId}::uuid`, sql`${memberUserId}::uuid`)}
                 as delivery`);
      const delivery = status.rows[0]?.delivery;
      if (delivery?.delivery_status !== 'failed') return undefined;
      const reason = delivery.delivery_failed_reason ?? 'no_device';

      const memberView = incidentMemberView.where({
        callerId: sql`d.member_user_id`,
        incident: incidentAlias('rec'),
      });
      const marked = await tx.execute<{ display_name: string; occurred_at: string }>(sql`
        update public.incident_deliveries d
           set delivery_failed_notified_at = now()
          from public.incidents rec
         where rec.id = d.incident_id
           and d.incident_id = ${incidentId}::uuid
           and d.member_user_id = ${memberUserId}::uuid
           and d.delivery_failed_notified_at is null
           and ${memberView}
        returning coalesce(
                    (select nullif(trim(p.full_name), '')
                       from public.profiles p
                      where p.id = d.member_user_id),
                    (select m.display_name
                       from public.safety_circle_members m
                      where m.id = d.member_id),
                    ''
                  ) as display_name,
                  (to_jsonb(d.delivery_failed_notified_at) #>> '{}') as occurred_at`);
      const row = marked.rows[0];
      if (!row) return undefined;

      const residentId = incident.rows[0].resident_id;
      await this.outbox.insert(tx, {
        topic: DELIVERY_FAILED_TOPIC,
        aggregateId: incidentId,
        payload: sql`jsonb_build_object(
          'incident_id', ${incidentId}::uuid,
          'member_name', nullif(${row.display_name}::text, ''),
          'reason', ${reason}::text,
          'occurred_at', ${row.occurred_at}::timestamptz,
          'recipient_user_ids', jsonb_build_array(${residentId}::uuid)
        )`,
      });
      await this.audit.record(
        deliveryFailedNoticeAudit({
          incident_id: incidentId,
          resident_id: residentId,
          member_user_id: memberUserId,
          reason,
        }),
        tx,
      );
      return {
        incident_id: incidentId,
        resident_id: residentId,
        member_user_id: memberUserId,
        display_name: row.display_name,
        reason,
        occurred_at: row.occurred_at,
      };
    });
  }
}
