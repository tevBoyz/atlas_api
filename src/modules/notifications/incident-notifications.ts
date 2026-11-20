import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { incidentAlias, incidentMemberView } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import type { OutboxTopicHandler } from '../../jobs/job-workers';
import {
  type OutboxRow,
  type OutboxTopic,
  type OutboxTransaction,
  OutboxWriter,
} from '../../jobs/outbox';
import { OutboxRelay } from '../../jobs/outbox-relay.service';
import type { IncidentPostCommitHook } from '../incidents/incident-post-commit';
import type { Channel } from './channels/channel.types';
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
               where d.incident_id = ${incidentId}::uuid)`;
}

/**
 * Writes the incident outbox rows inside the incident write's transaction (API-100-48 AC1): a
 * rolled-back write leaves no row. Called by the incident service (submit, re-notify, mark safe).
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
}

/**
 * Worker side (API-100-48 AC2): the incident outbox rows become delivery rows. Each recipient of the
 * row is checked again with `incident.memberView` at fan-out time (still an active member, inside
 * the window, not the resident: as the realtime recipients of D21); one who is not is recorded
 * `skipped` `not_eligible`. Preferences are recorded on the rows but not enforced: an SOS always
 * goes through (D4). With the channel disabled (the default) every row is `skipped`
 * `channel_disabled`.
 */
@Injectable()
export class IncidentNotificationsHandler implements OutboxTopicHandler {
  readonly topics = INCIDENT_TOPICS;

  constructor(
    private readonly database: DatabaseService,
    private readonly planner: DeliveryPlanner,
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
  }
}
