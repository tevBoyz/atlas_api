import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors';
import type { IncidentCloseSettings } from './incident-close-settings';
import { IncidentEventService } from './incident-events.service';
import type { IncidentTransaction } from './incidents.repository';

/**
 * The incident states of SCRUM-63 (D61) and the only transitions between them:
 * - `active -> resolved`: mark safe (Resolved / Safe, `resolved_reason = 'safe'`);
 * - `resolved -> closed`: the close sweeper, `incident_close_after_minutes` after `resolved_at`;
 * - `active -> closed`: the close sweeper, `incident_auto_close_after_hours` without activity
 *   (`resolved_reason = 'ended'`, `auto_closed = true`).
 * `closed` is final. The legacy statuses (`activating`, `cancelled`) have no transition here; submit
 * still promotes a legacy `activating` row to `active` exactly as `submit_emergency_alert` does.
 */
export const INCIDENT_STATE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  active: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

export function isIncidentStateTransition(from: string, to: string): boolean {
  return Object.hasOwn(INCIDENT_STATE_TRANSITIONS, from)
    ? INCIDENT_STATE_TRANSITIONS[from].includes(to)
    : false;
}

/** Throws 409 `incidents:invalid_state_transition` unless `from -> to` is a defined transition. */
export function assertIncidentStateTransition(from: string, to: string): void {
  if (!isIncidentStateTransition(from, to)) {
    throw new DomainError('incidents:invalid_state_transition');
  }
}

/**
 * The last activity of an incident (alias `rec`), D62: the latest of its activation and send, any
 * write of the row (`updated_at`: a stored location ping, a note, a re-notify, the resident's shared
 * info changing during the alert), the re-notify and note times, the legacy still-active stamp, and
 * every member's acknowledge and response time. `greatest` ignores nulls.
 */
export const INCIDENT_LAST_ACTIVITY_SQL = sql`greatest(
    rec.activated_at,
    rec.sent_at,
    rec.updated_at,
    rec.renotified_at,
    rec.incident_notes_updated_at,
    rec.activity_confirmed_at,
    (select max(greatest(d.acknowledged_at, d.response_at))
       from public.incident_deliveries d
      where d.incident_id = rec.id)
  )`;

/** An incident the sweeper claimed (row locked by this transaction). */
export interface ClaimedIncident extends Record<string, unknown> {
  id: string;
  status: 'active' | 'resolved';
}

/** An incident the sweeper closed in this transaction. */
export interface ClosedIncident extends Record<string, unknown> {
  id: string;
  resident_id: string;
  circle_id: string | null;
  /** The state it left. */
  from: 'active' | 'resolved';
  resolved_reason: 'safe' | 'ended';
  auto_closed: boolean;
}

/**
 * The one writer of incident status changes (SCRUM-63, D61): mark safe's `active -> resolved` and the
 * close sweeper's `resolved -> closed` / `active -> closed`. Every write checks the transition first
 * ({@link assertIncidentStateTransition}) and again in its `where` (the row must still be in the
 * state it leaves), so a concurrent change can never be overwritten.
 */
@Injectable()
export class IncidentStateService {
  constructor(private readonly events: IncidentEventService) {}

  /**
   * `active -> resolved` (mark safe): `status = 'resolved'`, `resolved_at = now()`,
   * `resolved_reason = 'safe'`, `auto_closed = false`, `location_sharing_ended_at = now()` (the write
   * of `mark_incident_safe`, baseline 20261023140000). The caller holds the row lock and passes the
   * status it read. Undefined (nothing written) when the row is no longer `active`.
   */
  async resolveSafe(
    tx: IncidentTransaction,
    incidentId: string,
    from: string,
  ): Promise<{ circle_id: string | null } | undefined> {
    assertIncidentStateTransition(from, 'resolved');
    const result = await tx.execute<{ circle_id: string | null }>(sql`
      update public.incidents
         set status = 'resolved',
             resolved_at = now(),
             resolved_reason = 'safe',
             auto_closed = false,
             location_sharing_ended_at = now()
       where id = ${incidentId}::uuid
         and status = 'active'
      returning circle_id::text as circle_id`);
    return result.rows[0];
  }

  /**
   * Locks up to `limit` incidents that are due to close (`FOR UPDATE SKIP LOCKED`: a row another
   * transaction holds, such as a mark safe, a location ping or another sweeper, is skipped and seen
   * on a later sweep). Resolved rows whose wrap-up has passed first, then active rows without
   * activity for the auto-close period; each oldest first. Takes no other lock.
   */
  async claimDue(
    tx: IncidentTransaction,
    settings: IncidentCloseSettings,
    limit: number,
  ): Promise<ClaimedIncident[]> {
    const resolved = await tx.execute<ClaimedIncident>(sql`
      select rec.id::text as id, rec.status
        from public.incidents rec
       where rec.status = 'resolved'
         and rec.resolved_at <= now() - make_interval(mins => ${settings.close_after_minutes}::int)
       order by rec.resolved_at, rec.id
       limit ${limit}::int
         for update of rec skip locked`);
    const left = limit - resolved.rows.length;
    if (left <= 0) return resolved.rows;
    const active = await tx.execute<ClaimedIncident>(sql`
      select rec.id::text as id, rec.status
        from public.incidents rec
       where rec.status = 'active'
         and ${INCIDENT_LAST_ACTIVITY_SQL}
             <= now() - make_interval(hours => ${settings.auto_close_after_hours}::int)
       order by rec.activated_at, rec.id
       limit ${left}::int
         for update of rec skip locked`);
    return [...resolved.rows, ...active.rows];
  }

  /**
   * Closes one claimed incident if it is still due, in one statement that re-reads the row and its
   * activity (a fresh snapshot: an acknowledge or response committed since the claim keeps it open).
   * - `resolved -> closed`: `closed_at = now()`; the reason and `auto_closed` are kept.
   * - `active -> closed`: `closed_at = resolved_at = now()`, `resolved_reason = 'ended'`,
   *   `auto_closed = true`, and location sharing ends as at mark safe
   *   (`location_sharing_ended_at`, event `location_sharing_ended`).
   * Then the once-only event `incident_closed {reason, auto_closed}` (no actor: the system closed it).
   * Undefined when it is no longer due (nothing written).
   */
  async closeDue(
    tx: IncidentTransaction,
    claimed: ClaimedIncident,
    settings: IncidentCloseSettings,
  ): Promise<ClosedIncident | undefined> {
    assertIncidentStateTransition(claimed.status, 'closed');
    const returning = sql`returning rec.id::text as id,
                rec.resident_id::text as resident_id,
                rec.circle_id::text as circle_id,
                ${claimed.status}::text as "from",
                rec.resolved_reason,
                rec.auto_closed`;
    const result =
      claimed.status === 'resolved'
        ? await tx.execute<ClosedIncident>(sql`
            update public.incidents rec
               set status = 'closed',
                   closed_at = now()
             where rec.id = ${claimed.id}::uuid
               and rec.status = 'resolved'
               and rec.resolved_at
                   <= now() - make_interval(mins => ${settings.close_after_minutes}::int)
            ${returning}`)
        : await tx.execute<ClosedIncident>(sql`
            update public.incidents rec
               set status = 'closed',
                   closed_at = now(),
                   resolved_at = now(),
                   resolved_reason = 'ended',
                   auto_closed = true,
                   location_sharing_ended_at = coalesce(rec.location_sharing_ended_at, now())
             where rec.id = ${claimed.id}::uuid
               and rec.status = 'active'
               and ${INCIDENT_LAST_ACTIVITY_SQL}
                   <= now() - make_interval(hours => ${settings.auto_close_after_hours}::int)
            ${returning}`);
    const closed = result.rows[0];
    if (!closed) return undefined;
    if (closed.from === 'active') {
      await this.events.record(tx, closed.id, 'location_sharing_ended', null, {});
    }
    await this.events.record(tx, closed.id, 'incident_closed', null, {
      reason: closed.resolved_reason,
      auto_closed: closed.auto_closed,
    });
    return closed;
  }
}
