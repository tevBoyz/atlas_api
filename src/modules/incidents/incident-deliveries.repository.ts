import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import {
  circleActiveMemberSince,
  incidentAlias,
  incidentCountsView,
  liveDeliverySql,
} from '../../common/policies';
import type { IncidentTransaction } from './incidents.repository';

/** DeliveryCounts (spec §7.4): `{incident_id, delivered_count, acknowledged_count, status}`. */
export type DeliveryCounts = Record<string, unknown> & {
  incident_id: string;
  delivered_count: number;
  acknowledged_count: number;
  status: string;
};

/** The caller's own delivery row, locked `FOR UPDATE` (first step of `acknowledge_incident`). */
export interface LockedDeliveryRow extends Record<string, unknown> {
  id: string;
  /** `delivered_at is not null` (the column is NOT NULL today; the SQL checks it anyway). */
  delivered: boolean;
  acknowledged: boolean;
}

/** The incident of an acknowledge, read without a lock (as the SQL function reads it). */
export interface AckIncidentRow extends Record<string, unknown> {
  id: string;
  status: string;
  resident_id: string;
  circle_id: string | null;
  /** `circle.activeMemberSince(circle_id, caller, activated_at)` (rule 54). */
  inside_window: boolean;
}

/**
 * `_incident_delivery_counts_json(rec.id, rec.status)` for the incident aliased `rec`: both counts in
 * one pass over `incident_deliveries_incident_id_idx`. The SQL helper runs two `count(*)` subqueries;
 * a `filter` gives the same two numbers from one scan of the same rows.
 */
const COUNTS_JSON = sql`jsonb_build_object(
    'incident_id', rec.id,
    'delivered_count', c.delivered_count,
    'acknowledged_count', c.acknowledged_count,
    'status', rec.status
  )`;

const COUNTS_LATERAL = sql`cross join lateral (
    select count(*)::int as delivered_count,
           count(*) filter (where d.acknowledged_at is not null)::int as acknowledged_count
      from public.incident_deliveries d
     where d.incident_id = rec.id
       and ${liveDeliverySql('d')}
  ) c`;

/**
 * The statements of `incident_delivery_counts` and `acknowledge_incident` (final definitions: baseline
 * migration 20261117100000). Access decisions are the API-100-09 policies as SQL predicates:
 * `incident.countsView` for counts; for acknowledge, the caller's own row (`member_user_id = caller`,
 * the first half of `delivery.own`) and `circle.activeMemberSince` for the window, in the SQL
 * function's order.
 */
@Injectable()
export class IncidentDeliveriesRepository {
  /**
   * `incident_delivery_counts`: ONE statement (the app polls it every 2 s while an alert is open):
   * the incident by primary key, `incident.countsView` (resident any status; member of an `active`
   * incident inside the window), and both counts from `incident_deliveries_incident_id_idx`.
   * Undefined when the incident is unknown or the caller may not see it (both `not_found`).
   */
  async visibleCounts(
    db: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<DeliveryCounts | undefined> {
    const result = await db.execute<{ body: DeliveryCounts }>(
      this.visibleCountsQuery(incidentId, callerId),
    );
    return result.rows[0]?.body;
  }

  /** The statement of {@link visibleCounts} (exposed so tests can EXPLAIN the exact query). */
  visibleCountsQuery(incidentId: string, callerId: string): SQL {
    return sql`
      select ${COUNTS_JSON} as body
        from public.incidents rec
        ${COUNTS_LATERAL}
       where rec.id = ${incidentId}::uuid
         and ${incidentCountsView.where({ callerId, incident: incidentAlias('rec') })}`;
  }

  /** `_incident_delivery_counts_json(rec.id, status)` inside the acknowledge transaction. */
  async counts(
    tx: IncidentTransaction,
    incidentId: string,
    status: string,
  ): Promise<DeliveryCounts> {
    const result = await tx.execute<{ body: DeliveryCounts }>(sql`
      select jsonb_build_object(
               'incident_id', rec.id,
               'delivered_count', c.delivered_count,
               'acknowledged_count', c.acknowledged_count,
               'status', ${status}::text
             ) as body
        from (select ${incidentId}::uuid as id) rec
        ${COUNTS_LATERAL}`);
    return result.rows[0].body;
  }

  /**
   * D71 lock order: `FOR KEY SHARE` on the caller's profile, then on the incident, taken BEFORE the
   * delivery row lock by acknowledge and the response. These are the locks the `incident_events`
   * insert (FKs `actor_id` → profiles, `incident_id` → incidents) takes anyway; taken first, the
   * order is profile → incident → delivery, the order of submit, re-notify and mark safe, so a
   * re-notify (incident `FOR UPDATE`, then the delivery rows) cannot deadlock with them. Changes no
   * result (a missing row locks nothing), only the order.
   */
  async keyShareCallerAndIncident(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<void> {
    await tx.execute(sql`
      select 1 from public.profiles p where p.id = ${callerId}::uuid for key share`);
    await tx.execute(sql`
      select 1 from public.incidents rec where rec.id = ${incidentId}::uuid for key share`);
  }

  /**
   * `select * from incident_deliveries where incident_id = $1 and member_user_id = uid for update`.
   * The only exclusive row lock acknowledge takes (after {@link keyShareCallerAndIncident}). Undefined
   * when the caller has no delivery row.
   */
  async lockOwnDelivery(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<LockedDeliveryRow | undefined> {
    const result = await tx.execute<LockedDeliveryRow>(sql`
      select d.id::text as id,
             d.delivered_at is not null as delivered,
             d.acknowledged_at is not null as acknowledged
        from public.incident_deliveries d
       where d.incident_id = ${incidentId}::uuid
         and d.member_user_id = ${callerId}::uuid
       for update`);
    return result.rows[0];
  }

  /**
   * The incident of an acknowledge, read WITHOUT a lock (the SQL function's plain `select *`), with
   * the rule 54 window evaluated in the same statement. Undefined when the incident is gone.
   */
  async ackIncident(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<AckIncidentRow | undefined> {
    const result = await tx.execute<AckIncidentRow>(sql`
      select rec.id::text as id,
             rec.status,
             rec.resident_id::text as resident_id,
             rec.circle_id::text as circle_id,
             coalesce(${circleActiveMemberSince.where({
               circleId: sql`rec.circle_id`,
               callerId,
               at: sql`rec.activated_at`,
             })}, false) as inside_window
        from public.incidents rec
       where rec.id = ${incidentId}::uuid`);
    return result.rows[0];
  }

  /** `update incident_deliveries set acknowledged_at = now() where id = d.id` (row already locked). */
  async acknowledge(tx: IncidentTransaction, deliveryId: string): Promise<void> {
    await tx.execute(sql`
      update public.incident_deliveries
         set acknowledged_at = now()
       where id = ${deliveryId}::uuid`);
  }
}
