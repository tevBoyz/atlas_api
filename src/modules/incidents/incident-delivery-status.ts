import { type SQL, sql } from 'drizzle-orm';

/**
 * SCRUM-65 / 71 (D73): the outbox topics of the ALERT itself. A member's delivery status counts only
 * the push rows of these notices of the incident (the alert and every re-notify), never a status
 * update, the closing notice or a notice to the resident.
 */
export const ALERT_DELIVERY_TOPICS = ['incident.created', 'incident.renotified'] as const;

/** A member's delivery status of the alert, as the resident sees it (D73). */
export const MEMBER_DELIVERY_STATUSES = ['sent', 'delivered', 'failed'] as const;
export type MemberDeliveryStatus = (typeof MEMBER_DELIVERY_STATUSES)[number];

/** Why the alert did not reach a member (D73). */
export const MEMBER_DELIVERY_FAILED_REASONS = ['no_device', 'failed'] as const;
export type MemberDeliveryFailedReason = (typeof MEMBER_DELIVERY_FAILED_REASONS)[number];

export interface MemberDelivery {
  delivery_status: MemberDeliveryStatus;
  delivery_at: string | null;
  delivery_failed_reason: MemberDeliveryFailedReason | null;
}

const ALERT_TOPICS_SQL = sql.raw(ALERT_DELIVERY_TOPICS.map((topic) => `'${topic}'`).join(', '));

/**
 * The delivery status of member `memberUserId` for the alert of incident `incidentId` (D73; the rule
 * of SCRUM-65 and SCRUM-71), as ONE jsonb object `{delivery_status, delivery_at,
 * delivery_failed_reason}`, from the member's `push` rows of the alert notices
 * ({@link ALERT_DELIVERY_TOPICS}) in `notification_deliveries`:
 * - `delivered`: at least one row was accepted by the push service (`sent` / `delivered`, decision 1,
 *   as the SCRUM-35 test alert); `delivery_at` = the first acceptance (`sent_at`);
 * - `sent`: nothing accepted yet and a row is still `queued` (first attempt or a retry to come), or
 *   an alert notice naming the member has not been fanned out yet (no row of that notice exists);
 *   `delivery_at` null;
 * - `failed`: every row is final and none was accepted, or the member has no row at all (nothing
 *   could be sent); `delivery_at` = the latest `final_at` (null when there is no row);
 *   `delivery_failed_reason` = `failed` when a row failed after its retries, else `no_device` (only
 *   skipped rows: no device with a push token, push switched off, or no row).
 * A re-notify adds rows, so `failed` becomes `sent` again and then `delivered` or `failed`; once a
 * row was accepted the member stays `delivered`. Timestamps as the session writes them (callers run
 * in UTC). Uses `notification_deliveries_incident_idx` and `notification_outbox_aggregate_idx`.
 */
export function memberDeliverySql(incidentId: SQL, memberUserId: SQL): SQL {
  return sql`(
    select jsonb_build_object(
             'delivery_status', case
                                  when a.accepted > 0 then 'delivered'
                                  when a.queued > 0 or a.pending_notice then 'sent'
                                  else 'failed'
                                end,
             'delivery_at', case
                              when a.accepted > 0 then a.first_accepted_at
                              when a.queued > 0 or a.pending_notice then null
                              else a.last_final_at
                            end,
             'delivery_failed_reason', case
                                         when a.accepted > 0 or a.queued > 0 or a.pending_notice
                                           then null
                                         when a.failed > 0 then 'failed'
                                         else 'no_device'
                                       end
           )
      from (
        select count(*) filter (where nd.status in ('sent', 'delivered')) as accepted,
               min(nd.sent_at) filter (where nd.status in ('sent', 'delivered')) as first_accepted_at,
               count(*) filter (where nd.status = 'queued') as queued,
               count(*) filter (where nd.status = 'failed') as failed,
               max(nd.final_at) as last_final_at,
               exists (
                 select 1
                   from public.notification_outbox po
                  where po.aggregate_id = ${incidentId}
                    and po.topic in (${ALERT_TOPICS_SQL})
                    and po.payload -> 'recipient_user_ids' @> jsonb_build_array(${memberUserId}::text)
                    and not exists (select 1
                                      from public.notification_deliveries pd
                                     where pd.outbox_id = po.id)
               ) as pending_notice
          from public.notification_deliveries nd
          join public.notification_outbox ao
            on ao.id = nd.outbox_id
           and ao.topic in (${ALERT_TOPICS_SQL})
         where nd.incident_id = ${incidentId}
           and nd.recipient_user_id = ${memberUserId}
           and nd.channel = 'push'
      ) a
  )`;
}
