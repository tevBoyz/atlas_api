import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { incidentAlias, incidentMemberView, liveDeliverySql } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import type { OutboxTopicHandler } from '../../jobs/job-workers';
import {
  type OutboxRow,
  type OutboxTopic,
  type OutboxTransaction,
  OutboxWriter,
} from '../../jobs/outbox';
import { OutboxRelay } from '../../jobs/outbox-relay.service';
import type {
  IncidentEventRecordedEvent,
  IncidentPostCommitHook,
} from '../incidents/incident-post-commit';
import { AlertDeliveryOutcomes, isAlertDeliveryTopic } from './alert-delivery-outcomes';
import { type Channel, DELIVERY_FAILED_TOPIC } from './channels/channel.types';
import { DeliveryPlanner } from './deliveries.service';

/**
 * The channels of the incident notices (D26): push only in Epic 100 (SCRUM-47). SMS is the
 * fallback of SCRUM-75 (Phase 1.1, Twilio hold) and email is not an incident channel in any story.
 */
export const INCIDENT_CHANNELS: readonly Channel[] = ['push'];

export const INCIDENT_TOPICS = [
  'incident.created',
  'incident.renotified',
  'incident.resolved',
  'incident.status_update',
] as const satisfies readonly OutboxTopic[];

/**
 * The payload of an incident outbox row, built by Postgres inside the incident write's transaction
 * (so it reads that transaction's own rows; the transaction runs in UTC): the incident id, the
 * emergency type, the resident's display name, the time of the event and the recipient user ids.
 * Nothing else: no share or medical data, notes or coordinates.
 */
function incidentPayload(incidentId: string, time: SQL, recipients: SQL): SQL {
  return sql`(
    select jsonb_build_object(
             'incident_id', i.id,
             'emergency_type', i.emergency_type,
             'resident_name', nullif(btrim(p.full_name), ''),
             'occurred_at', ${time},
             'recipient_user_ids', ${recipients}
           )
      from public.incidents i
      join public.profiles p on p.id = i.resident_id
     where i.id = ${incidentId}::uuid)`;
}

/** The incident's delivery rows (D14: the members notified by this submit), sorted. */
function deliveryRecipients(incidentId: string): SQL {
  return sql`(select coalesce(jsonb_agg(d.member_user_id order by d.member_user_id), '[]'::jsonb)
                from public.incident_deliveries d
               where d.incident_id = ${incidentId}::uuid
                 and ${liveDeliverySql('d')})`;
}

/**
 * Writes the incident outbox rows inside the incident write's transaction (API-100-48 AC1): a
 * rolled-back write leaves no row. Called by the incident service (submit, re-notify, mark safe)
 * and the status updates service (D70).
 */
@Injectable()
export class IncidentNotificationsOutbox {
  constructor(private readonly outbox: OutboxWriter) {}

  /** `incident.created`: a created or promoted submit. Recipients = its delivery rows. */
  created(tx: OutboxTransaction, incidentId: string): Promise<string> {
    return this.write(
      tx,
      'incident.created',
      incidentId,
      sql`i.sent_at`,
      deliveryRecipients(incidentId),
    );
  }

  /** `incident.renotified`: a submit on an active alert, or an explicit re-notify. */
  renotified(tx: OutboxTransaction, incidentId: string): Promise<string> {
    return this.write(
      tx,
      'incident.renotified',
      incidentId,
      sql`i.renotified_at`,
      deliveryRecipients(incidentId),
    );
  }

  /**
   * `incident.resolved`: mark safe closed the alert. Recipients = `closure_notified.recipient_ids`
   * (the active members inside the window, rule 54), passed in from that same read.
   */
  resolved(
    tx: OutboxTransaction,
    incidentId: string,
    recipientIds: readonly string[],
  ): Promise<string> {
    return this.write(
      tx,
      'incident.resolved',
      incidentId,
      sql`i.resolved_at`,
      sql`${JSON.stringify(recipientIds)}::jsonb`,
    );
  }

  /**
   * `incident.status_update` (SCRUM-44/59, D70): the resident sent a status update (the
   * `status_update` event `eventId`, inserted in this transaction). Recipients = the incident's
   * delivery rows (as `incident.renotified`), re-checked with `incident.memberView` at fan-out. The
   * payload carries the incident id, the resident's display name, the time of the update, the update
   * id and the preset or the text (the text is needed for the visible body; never a data key of the
   * push, never logged).
   */
  statusUpdate(tx: OutboxTransaction, incidentId: string, eventId: string): Promise<string> {
    return this.outbox.insert(tx, {
      topic: 'incident.status_update',
      aggregateId: incidentId,
      payload: sql`(
        select jsonb_build_object(
                 'incident_id', i.id,
                 'resident_name', nullif(btrim(p.full_name), ''),
                 'occurred_at', e.occurred_at,
                 'update_id', e.id,
                 'preset', e.detail->>'preset',
                 'text', e.detail->>'text',
                 'recipient_user_ids', ${deliveryRecipients(incidentId)}
               )
          from public.incident_events e
          join public.incidents i on i.id = e.incident_id
          join public.profiles p on p.id = i.resident_id
         where e.id = ${eventId}::uuid
           and e.incident_id = ${incidentId}::uuid)`,
    });
  }

  private write(
    tx: OutboxTransaction,
    topic: OutboxTopic,
    incidentId: string,
    time: SQL,
    recipients: SQL,
  ): Promise<string> {
    return this.outbox.insert(tx, {
      topic,
      aggregateId: incidentId,
      payload: incidentPayload(incidentId, time, recipients),
    });
  }
}

/**
 * After an incident write has committed: publish its outbox row now instead of at the next relay
 * sweep (the HTTP response never waits for this). Registered with the incident post-commit hooks.
 */
@Injectable()
export class IncidentNotificationsHook implements IncidentPostCommitHook {
  constructor(private readonly relay: OutboxRelay) {}

  afterSubmit(): void {
    this.relay.kick();
  }

  afterRenotify(): void {
    this.relay.kick();
  }

  afterResolved(): void {
    this.relay.kick();
  }

  /** SCRUM-44/59 (D70): a status update wrote its `incident.status_update` row. */
  afterEvent(event: IncidentEventRecordedEvent): void {
    if (event.event_type === 'status_update') this.relay.kick();
  }
}

/**
 * Worker side (API-100-48 AC2): the incident outbox rows become delivery rows. Each recipient of the
 * row is checked again with `incident.memberView` at fan-out time (still an active member, inside
 * the window, not the resident: as the realtime recipients of D21); one who is not is recorded
 * `skipped` `not_eligible`. Preferences are recorded on the rows but not enforced: an SOS always
 * goes through (D4). With the channel disabled (the default) every row is `skipped`
 * `channel_disabled`.
 *
 * SCRUM-65 / 71 (D73): after an ALERT notice (`incident.created` / `incident.renotified`) was fanned
 * out, each eligible recipient's delivery status is re-checked ({@link AlertDeliveryOutcomes}): rows
 * skipped at fan-out (no device, push off) are final at once, so such a member is `failed` now; a
 * re-notify's new `queued` rows turn `failed` back into `sent`.
 */
@Injectable()
export class IncidentNotificationsHandler implements OutboxTopicHandler {
  readonly topics = INCIDENT_TOPICS;

  constructor(
    private readonly database: DatabaseService,
    private readonly planner: DeliveryPlanner,
    private readonly alerts: AlertDeliveryOutcomes,
  ) {}

  async handle(row: OutboxRow): Promise<void> {
    const incidentId = row.aggregate_id;
    const raw = row.payload.recipient_user_ids;
    const recipients = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string')
      : [];
    if (!incidentId || recipients.length === 0) return;

    const memberView = incidentMemberView.where({
      callerId: sql`r.user_id`,
      incident: incidentAlias('rec'),
    });
    const result = await this.database.db.execute<{ user_id: string; eligible: boolean }>(sql`
      select r.user_id::text as user_id,
             coalesce((select ${memberView}
                         from public.incidents rec
                        where rec.id = ${incidentId}::uuid), false) as eligible
        from (select distinct value::uuid as user_id
                from jsonb_array_elements_text(${JSON.stringify(recipients)}::jsonb)) as r`);
    await this.planner.fanOut(row, incidentId, result.rows, INCIDENT_CHANNELS);
    if (isAlertDeliveryTopic(row.topic)) {
      const eligible = result.rows.filter((r) => r.eligible).map((r) => r.user_id);
      await this.alerts.afterMemberOutcome(incidentId, eligible);
    }
  }
}

/**
 * Worker side of the resident's "alert not delivered" notice (SCRUM-71, D73; topic
 * `incident.delivery_failed`, written by {@link AlertDeliveryOutcomes}): one push to the resident's
 * devices (every device with a token, as every notice), on the incident channel (D26: push only).
 * The only recipient is the incident's resident, read again now; they are eligible only while the
 * incident is still `active` (a notice is never sent after the alert ended: recorded `skipped`
 * `not_eligible`). Its rows never count for a member's delivery status (not an alert topic).
 */
@Injectable()
export class DeliveryFailedNotificationsHandler implements OutboxTopicHandler {
  readonly topics = [DELIVERY_FAILED_TOPIC] as const;

  constructor(
    private readonly database: DatabaseService,
    private readonly planner: DeliveryPlanner,
  ) {}

  async handle(row: OutboxRow): Promise<void> {
    const incidentId = row.aggregate_id;
    if (!incidentId) return;
    const result = await this.database.db.execute<{ user_id: string; eligible: boolean }>(sql`
      select rec.resident_id::text as user_id, rec.status = 'active' as eligible
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
    if (result.rows.length === 0) return;
    await this.planner.fanOut(row, incidentId, result.rows, INCIDENT_CHANNELS);
  }
}
