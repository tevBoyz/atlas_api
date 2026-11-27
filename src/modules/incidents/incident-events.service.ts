import { Injectable } from '@nestjs/common';
import { isSQLWrapper, type SQL, sql } from 'drizzle-orm';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { incidentAlias, incidentEventsHistoryView } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import type { IncidentTransaction } from './incidents.repository';

/**
 * The known `incident_events.event_type` values (spec §5.6), with who writes each, its `detail` and
 * whether it happens at most once per incident. This is the list the API validates against
 * (API-100-22 AC2): `record()` refuses any other type in code, before it reaches the database.
 *
 * Adding a type: add it here (and to `ONCE_PER_INCIDENT` if it is a once-only lifecycle step). NOTE:
 * the baseline schema also has a CHECK constraint (`incident_events_type_allowed`, migration
 * 20261023140000, widened by 0020 for `status_update` and 0021 for `responder_acknowledged` /
 * `responder_status`) listing exactly these types, so a new type also needs an additive migration
 * that widens that constraint (and, if once-only, a new partial unique index); see the story report.
 */
export const INCIDENT_EVENT_TYPES = {
  /** Submit (created/promoted). `{recipient_count, recipient_ids (sorted), emergency_type}`. */
  alert_sent: { oncePerIncident: true },
  /** Submit (created/promoted). `{}`. */
  location_sharing_started: { oncePerIncident: true },
  /** Submit on an active incident, or explicit re-notify. `{recipient_count}` (rows refreshed). */
  renotified: { oncePerIncident: false },
  /** Mark safe. `{}`. */
  safe_recorded: { oncePerIncident: true },
  /**
   * The real close (SCRUM-63, D62), by the close sweeper (no actor): `{reason: "safe"|"ended",
   * auto_closed}`. Rows written by mark safe before SCRUM-63 (and by the old SQL function) hold
   * `{resolved_reason: "safe"}` and the resident as actor.
   */
  incident_closed: { oncePerIncident: true },
  /** Mark safe, or the automatic close of an inactive alert (no actor). `{}`. */
  location_sharing_ended: { oncePerIncident: true },
  /** Mark safe. `{recipient_count, recipient_ids}`: members inside the window (rule 54), sorted. */
  closure_notified: { oncePerIncident: true },
  /**
   * SCRUM-44/59 (D70): the resident's status update (`POST /v1/incidents/{id}/updates`), actor = the
   * resident. `{preset: "situation_worsening"|"help_is_here"}` or `{text}` (1-250 characters). May
   * repeat. Migration 0020 widened `incident_events_type_allowed` for it.
   */
  status_update: { oncePerIncident: false },
  /**
   * SCRUM-60/61 (D71): a member acknowledged the alert, actor = the member, `{}`. Written by
   * `POST /v1/incidents/{id}/acknowledge`, or by the first `POST /v1/incidents/{id}/response` (which
   * acknowledges implicitly), only when that call sets `acknowledged_at` for the first time: at most
   * once per member, but once per member is not once per incident. Migration 0021.
   */
  responder_acknowledged: { oncePerIncident: false },
  /**
   * SCRUM-60/61 (D71): a member's response status changed (`POST /v1/incidents/{id}/response`),
   * actor = the member, `{status: "responding"|"unable"}`. Not written when the member sends the
   * status they already have. May repeat. Migration 0021.
   */
  responder_status: { oncePerIncident: false },
} as const;

export type IncidentEventType = keyof typeof INCIDENT_EVENT_TYPES;

export function isKnownIncidentEventType(value: unknown): value is IncidentEventType {
  return typeof value === 'string' && Object.hasOwn(INCIDENT_EVENT_TYPES, value);
}

/**
 * The once-only types, in the order of the predicate of `incident_events_once_per_incident_uidx`.
 * `ON CONFLICT` names that predicate so Postgres uses the index as the arbiter.
 */
export const ONCE_PER_INCIDENT_EVENT_TYPES = [
  'alert_sent',
  'location_sharing_started',
  'location_sharing_ended',
  'safe_recorded',
  'incident_closed',
  'closure_notified',
] as const satisfies readonly IncidentEventType[];

/**
 * `detail` keys never sent to anyone (D79, Stage 3 [IDS]; before: resident only, epic §18 D3):
 * `recipient_ids` are user ids of the members. `recipient_count` stays. Kept in the stored row for
 * the closure notice.
 */
export const HIDDEN_DETAIL_KEYS = ['recipient_ids'] as const;

/**
 * D79 (Stage 3 [IDS], replaces the D11 masking): an event's `actor_id` as `callerId` sees it: the
 * caller's own id when they are the actor, else null (another user's id is never sent).
 */
export function actorIdFor(actorId: unknown, callerId: string | null): string | null {
  if (typeof actorId !== 'string' || !callerId) return null;
  return actorId.toLowerCase() === callerId.toLowerCase() ? actorId.toLowerCase() : null;
}

/**
 * D79: `actor_handle` of the event aliased `event`: the actor's membership row id in that incident
 * (`incident_deliveries.member_id`, the responder row's `handle`) when a member caused it; null for
 * the resident and for events no user caused.
 */
export function eventActorHandleSql(event: string): SQL {
  const e = sql.raw(event);
  return sql`(select ah_d.member_id
      from public.incident_deliveries ah_d
     where ah_d.incident_id = ${e}.incident_id
       and ${e}.actor_id is not null
       and ah_d.member_user_id = ${e}.actor_id
     limit 1)`;
}

/** A programming error: an event type the API does not know (never stored). */
export class UnknownIncidentEventTypeError extends Error {
  constructor(readonly eventType: string) {
    super(`unknown incident event type: ${eventType}`);
    this.name = 'UnknownIncidentEventTypeError';
  }
}

/** An event row this transaction inserted. Ids and the type only (never the detail). */
export interface RecordedIncidentEvent {
  id: string;
  incident_id: string;
  event_type: IncidentEventType;
}

/**
 * `actor_name` of the event row aliased `event` of the incident aliased `incident` (D71: the app
 * shows names, never ids). Null when `actor_id` is null. The resident: their profile name, trimmed
 * (the name members see on the alert), else ''. Anyone else (a member): the name the responder list
 * shows (`responderRowsSql`): the profile name trimmed when not empty, else the name stored on the
 * membership of their delivery row of this incident, else ''. The same for every caller.
 */
export function eventActorNameSql(event: string, incident: string): SQL {
  const e = sql.raw(event);
  const rec = sql.raw(incident);
  return sql`case
      when ${e}.actor_id is null then null
      when ${e}.actor_id = ${rec}.resident_id then
        coalesce((select trim(an_p.full_name) from public.profiles an_p where an_p.id = ${e}.actor_id), '')
      else coalesce(
        (select nullif(trim(an_p.full_name), '') from public.profiles an_p where an_p.id = ${e}.actor_id),
        (select an_m.display_name
           from public.incident_deliveries an_d
           join public.safety_circle_members an_m on an_m.id = an_d.member_id
          where an_d.incident_id = ${e}.incident_id
            and an_d.member_user_id = ${e}.actor_id
          limit 1),
        '')
    end`;
}

const ONCE_PREDICATE = sql.raw(
  `event_type in (${ONCE_PER_INCIDENT_EVENT_TYPES.map((type) => `'${type}'`).join(', ')})`,
);

/**
 * The one writer and reader of `incident_events` (API-100-22). Append-only: the API never updates or
 * deletes an event (AC5); there is no method that could.
 */
@Injectable()
export class IncidentEventService {
  /** Events inserted per open transaction, handed to the post-commit hook once it commits. */
  private readonly recorded = new WeakMap<object, RecordedIncidentEvent[]>();

  constructor(private readonly database: DatabaseService) {}

  /**
   * `GET /v1/incidents/{id}/events` (API-100-22 AC3): {@link listVisible} in a read-only transaction
   * in UTC (timestamps as the SQL functions return them). Unknown or hidden → 404
   * `incident_events:not_found` (the same body either way).
   */
  async read(user: AuthenticatedUser, incidentId: string): Promise<Record<string, unknown>[]> {
    const body = await this.database.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
        return this.listVisible(tx, incidentId, user.id);
      },
      { accessMode: 'read only' },
    );
    if (!body) throw new DomainError('incident_events:not_found');
    return body;
  }

  /**
   * `_incident_record_event`: inserts one event in the caller's transaction (server time `now()`).
   * A repeat of a once-only type is a no-op through `incident_events_once_per_incident_uidx`
   * (`ON CONFLICT DO NOTHING`) and returns undefined. `detail` is a JSON object, or a SQL expression
   * building one in the same statement (so ids and counts come from the transaction's own rows).
   * `options.afterEarlierEvents` (D71) stores `clock_timestamp()` instead of the transaction time, so
   * the event sorts after the events this transaction already wrote (the list is ordered
   * `occurred_at, id`, and `id` is random): used for a `responder_status` written after the
   * `responder_acknowledged` of the same call.
   */
  async record(
    tx: IncidentTransaction,
    incidentId: string,
    eventType: IncidentEventType,
    actorId: string | null,
    detail: SQL | Record<string, unknown> = {},
    options: { afterEarlierEvents?: boolean } = {},
  ): Promise<RecordedIncidentEvent | undefined> {
    if (!isKnownIncidentEventType(eventType)) throw new UnknownIncidentEventTypeError(eventType);
    const detailSql = isSQLWrapper(detail) ? detail : sql`${JSON.stringify(detail)}::jsonb`;
    const later = options.afterEarlierEvents === true;
    const result = await tx.execute<{ id: string }>(sql`
      insert into public.incident_events (incident_id, event_type, actor_id, detail${
        later ? sql`, occurred_at` : sql``
      })
      values (${incidentId}::uuid, ${eventType}::text, ${actorId}::uuid,
              coalesce(${detailSql}, '{}'::jsonb)${later ? sql`, clock_timestamp()` : sql``})
      on conflict (incident_id, event_type)
        where ${ONCE_PREDICATE}
      do nothing
      returning id::text as id`);
    const row = result.rows[0];
    if (!row) return undefined;
    const event: RecordedIncidentEvent = {
      id: row.id,
      incident_id: incidentId,
      event_type: eventType,
    };
    const list = this.recorded.get(tx) ?? [];
    list.push(event);
    this.recorded.set(tx, list);
    return event;
  }

  /** The events `tx` inserted so far, in insertion order; forgets them. */
  drain(tx: object): RecordedIncidentEvent[] {
    const list = this.recorded.get(tx) ?? [];
    this.recorded.delete(tx);
    return list;
  }

  /**
   * `GET /v1/incidents/{id}/events`: the incident's events ordered `occurred_at, id`, each with its
   * `actor_name` ({@link eventActorNameSql}, D71, the same for every caller), when the caller
   * passes `incident.eventsView` (the resident; or an active member inside the window while the
   * incident is `active`/`resolved`/`closed`, rule 54; SCRUM-63: history stays readable). A caller who is not the resident never gets
   * `recipient_ids` (D79: nobody does); `recipient_count` stays. Each `actor_id` is the caller's own
   * id or null ({@link actorIdFor}, D79), `actor_handle` the actor member's handle. Undefined when the
   * incident is unknown or hidden from the caller (both `not_found`). One statement: the access check
   * and the events come from one snapshot.
   */
  async listVisible(
    tx: IncidentTransaction,
    incidentId: string,
    callerId: string,
  ): Promise<Record<string, unknown>[] | undefined> {
    const incident = incidentAlias('rec');
    const hidden = sql.raw(`array[${HIDDEN_DETAIL_KEYS.map((k) => `'${k}'`).join(', ')}]`);
    const result = await tx.execute<{ body: Record<string, unknown>[] }>(sql`
      select coalesce(
               (select jsonb_agg(
                         jsonb_build_object(
                           'id', e.id,
                           'event_type', e.event_type,
                           'occurred_at', e.occurred_at,
                           'actor_id', e.actor_id,
                           'actor_handle', ${eventActorHandleSql('e')},
                           'actor_name', ${eventActorNameSql('e', 'rec')},
                           'detail', e.detail - ${hidden}::text[]
                         )
                         order by e.occurred_at, e.id
                       )
                  from public.incident_events e
                 where e.incident_id = rec.id),
               '[]'::jsonb
             ) as body
        from public.incidents rec
       where rec.id = ${incidentId}::uuid
         and ${incidentEventsHistoryView.where({ callerId, incident })}`);
    const row = result.rows[0];
    if (!row) return undefined;
    return row.body.map((event) => ({ ...event, actor_id: actorIdFor(event.actor_id, callerId) }));
  }
}
