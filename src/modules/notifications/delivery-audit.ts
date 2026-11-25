import type { AuditEntry } from '../audit';
import { ALERT_DELIVERY_TOPICS } from '../incidents/incident-delivery-status';
import type { DeliveryFinalOutcome } from './deliveries.repository';

/**
 * A delivery row as a final status write returns it, with the subject of the row: its incident
 * (null for a SCRUM-35 test alert) and the topic of its outbox row.
 */
export interface DeliveryFinalRow extends DeliveryFinalOutcome {
  incident_id: string | null;
  topic: string;
}

/**
 * SCRUM-74 (D75): the audit entry of a delivery row of an ALERT notice of an incident
 * (`incident.created` / `incident.renotified`, {@link ALERT_DELIVERY_TOPICS}) that has just become
 * final (sent, delivered, failed after its retries, or skipped). Written by the same transaction as
 * that final status write, which only a `queued` row (or a new row) passes, so there is exactly one
 * entry per delivery whatever retries or repeated jobs happen. `undefined` for a test alert or any
 * other notice (a status update, the closing notice, a notice to the resident).
 *
 * Detail: ids, codes and counts only: never a token, device push id, address, message text,
 * coordinates or medical / shared fields. No actor: the worker writes it (as the close sweeper).
 */
export function deliveryOutcomeAudit(row: DeliveryFinalRow): AuditEntry | undefined {
  if (row.incident_id === null) return undefined;
  if (!(ALERT_DELIVERY_TOPICS as readonly string[]).includes(row.topic)) return undefined;
  return {
    action: 'incident.delivery_outcome',
    actor_user_id: null,
    target_type: 'incident',
    target_id: row.incident_id,
    detail: {
      delivery_id: row.delivery_id,
      recipient_user_id: row.recipient_user_id,
      channel: row.channel,
      status: row.status,
      attempts: row.attempts,
      error_code: row.error_code,
    },
  };
}

/** The outcome part of a {@link DeliveryFinalRow} (what the worker logs, SCRUM-67). */
export function finalOutcomeOf(row: DeliveryFinalRow): DeliveryFinalOutcome {
  return {
    delivery_id: row.delivery_id,
    recipient_user_id: row.recipient_user_id,
    channel: row.channel,
    status: row.status,
    error_code: row.error_code,
    attempts: row.attempts,
  };
}

/**
 * SCRUM-74 (D75): the audit entry of the SCRUM-71 notice "the alert did not reach this member"
 * (`incident.delivery_failed_notice`), written in the transaction that records the notice (at most
 * one per member per incident). Ids and the reason (`no_device` / `failed`) only, never the name.
 */
export function deliveryFailedNoticeAudit(notice: {
  incident_id: string;
  resident_id: string;
  member_user_id: string;
  reason: string;
}): AuditEntry {
  return {
    action: 'incident.delivery_failed_notice',
    actor_user_id: null,
    target_type: 'incident',
    target_id: notice.incident_id,
    detail: {
      resident_id: notice.resident_id,
      member_user_id: notice.member_user_id,
      reason: notice.reason,
    },
  };
}
