import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import type { Database } from '../db';

/**
 * Topics of `notification_outbox` (spec §11.7). Phase 5 raises the three incident topics; SCRUM-44/59
 * (D70) the resident's status update `incident.status_update`; SCRUM-35 (D67) the test alert
 * `circle.test_alert` (aggregate = the test alert, never an incident).
 */
export const OUTBOX_TOPICS = [
  'incident.created',
  'incident.renotified',
  'incident.resolved',
  'incident.status_update',
  'circle.test_alert',
] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];

/** The domain write's open transaction. */
export type OutboxTransaction = Pick<Database, 'execute'>;

/** One committed outbox row, as the consumers read it. */
export interface OutboxRow {
  id: string;
  topic: string;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface OutboxEntry {
  topic: OutboxTopic;
  /** The row the event is about (the incident, or the test alert). */
  aggregateId: string | null;
  /**
   * The payload as a SQL expression evaluated in the domain transaction (so it reads that
   * transaction's own writes), producing a JSON object.
   */
  payload: SQL;
  /** Delay the job until this time (a SQL timestamptz expression); omitted = at once. */
  deliverAt?: SQL;
}

/**
 * Writes `notification_outbox` rows (API-100-45 AC2). The transaction is a required argument: the
 * row commits or rolls back with the domain write it reports ("DB write before notify", spec §11.6).
 * Nothing is sent from here; the relay publishes committed rows.
 */
@Injectable()
export class OutboxWriter {
  async insert(tx: OutboxTransaction, entry: OutboxEntry): Promise<string> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into public.notification_outbox (topic, aggregate_id, payload, deliver_at)
      values (
        ${entry.topic}::text,
        ${entry.aggregateId}::uuid,
        ${entry.payload},
        ${entry.deliverAt ?? sql`null`}
      )
      returning id::text as id`);
    return result.rows[0].id;
  }
}
