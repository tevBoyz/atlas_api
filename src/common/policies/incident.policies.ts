import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

import { incidents } from '../../db/schema';
import { DomainError } from '../errors/domain-error';
import { type ErrorPrefix, PARITY_ERROR_CODES, parityCode } from '../errors/error-codes';
import { circleActiveMemberSince } from './circle.policies';
import {
  aliasColumn,
  evaluate,
  type Policy,
  type PolicyName,
  type SqlExecutor,
  type UuidOperand,
  uuidSql,
} from './policy';

/**
 * Incident policies (spec §11.4, §6.10, rule 54; API-100-09). SQL parity:
 * - `incident.resident`   = `resident_id = caller` (RLS `incidents_select_own`; the resident passes
 *   for every status and regardless of any membership window).
 * - `incident.memberView` = RLS `incidents_select_active_member` + "not the resident":
 *   `circle_id IS NOT NULL AND status IN ('active','resolved','closed') AND
 *   circle.activeMemberSince(circle_id, caller, activated_at) AND resident_id <> caller`
 *   (`list_responder_incidents`, `get_incident_details`).
 * - `incident.eventsView` = `_can_view_incident_events`: resident, or (circle_id not null, status
 *   active/resolved/closed, inside the window).
 * SCRUM-63 (D61): `closed` joins `active`/`resolved` in memberView and eventsView, so a closed
 * incident's details, responders and history stay readable (read-only). The SQL functions and RLS
 * know no `closed` (recorded divergence).
 * - `incident.countsView` = `incident_delivery_counts`: resident (any status), or (circle_id not
 *   null, status active, inside the window).
 *
 * Hidden existence (AC4): a failed incident policy raises the operation's `<fn>:not_found`, never
 * 403, so an incident outside the caller's access (including pre-join) looks like no incident.
 */

/** The incident columns a policy reads; defaults to the `incidents` table (Drizzle columns). */
export interface IncidentRef {
  /** Stage 2 [B13]: needed by the ended-member history rule; without it that rule is false. */
  id?: SQLWrapper;
  residentId: SQLWrapper;
  circleId: SQLWrapper;
  status: SQLWrapper;
  activatedAt: SQLWrapper;
}

export const INCIDENTS_TABLE: IncidentRef = {
  id: incidents.id,
  residentId: incidents.residentId,
  circleId: incidents.circleId,
  status: incidents.status,
  activatedAt: incidents.activatedAt,
};

/** The incident columns of a table alias, e.g. `incidentAlias('i')` for `from incidents i`. */
export function incidentAlias(alias: string): IncidentRef {
  return {
    id: aliasColumn(alias, 'id'),
    residentId: aliasColumn(alias, 'resident_id'),
    circleId: aliasColumn(alias, 'circle_id'),
    status: aliasColumn(alias, 'status'),
    activatedAt: aliasColumn(alias, 'activated_at'),
  };
}

export interface IncidentArgs {
  callerId: UuidOperand;
  /** Defaults to {@link INCIDENTS_TABLE}. */
  incident?: IncidentRef;
}

export interface IncidentPolicy extends Policy<IncidentArgs> {
  /** Single-row check by incident id (an unknown id is false). */
  checkById(db: SqlExecutor, incidentId: UuidOperand, callerId: UuidOperand): Promise<boolean>;
}

const ID_ALIAS = 'pi_i';

function defineIncidentPolicy(
  name: PolicyName,
  rule: (incident: IncidentRef, caller: SQL, callerId: UuidOperand) => SQL,
): IncidentPolicy {
  const where = ({ callerId, incident = INCIDENTS_TABLE }: IncidentArgs) =>
    rule(incident, uuidSql(callerId), callerId);
  return {
    name,
    where,
    check: (db, args) => evaluate(db, where(args)),
    checkById: (db, incidentId, callerId) =>
      evaluate(
        db,
        sql`exists (
          select 1 from public.incidents ${sql.raw(ID_ALIAS)}
           where ${aliasColumn(ID_ALIAS, 'id')} = ${uuidSql(incidentId)}
             and ${where({ callerId, incident: incidentAlias(ID_ALIAS) })})`,
      ),
  };
}

function insideWindow(incident: IncidentRef, callerId: UuidOperand): SQL {
  return circleActiveMemberSince.where({
    circleId: incident.circleId,
    callerId,
    at: incident.activatedAt,
  });
}

export const incidentResident = defineIncidentPolicy(
  'incident.resident',
  (incident, caller) => sql`(${incident.residentId} = ${caller})`,
);

export const incidentMemberView = defineIncidentPolicy(
  'incident.memberView',
  (incident, caller, callerId) => sql`(${incident.circleId} is not null
    and ${incident.status} in ('active', 'resolved', 'closed')
    and ${insideWindow(incident, callerId)}
    and ${incident.residentId} is distinct from ${caller})`,
);

export const incidentEventsView = defineIncidentPolicy(
  'incident.eventsView',
  (incident, caller, callerId) => sql`(${incident.residentId} = ${caller}
    or (${incident.circleId} is not null
        and ${incident.status} in ('active', 'resolved', 'closed')
        and ${insideWindow(incident, callerId)}))`,
);

export const incidentCountsView = defineIncidentPolicy(
  'incident.countsView',
  (incident, caller, callerId) => sql`(${incident.residentId} = ${caller}
    or (${incident.circleId} is not null
        and ${incident.status} = 'active'
        and ${insideWindow(incident, callerId)}))`,
);

/**
 * Stage 2 [B13] (SCRUM-64 AC3): a member whose membership ENDED (removed or left, D44) keeps
 * read-only access to a past incident of that circle when they had a delivery row for it created
 * before the membership's `ended_at` (they were alerted while a member) and the incident is over
 * (`resolved` / `closed`). While the incident is still active this is false ("not available").
 * Never the resident. The delivery row is kept by remove / leave since Stage 2 (no longer deleted).
 */
export function incidentEndedMemberPastSql(incident: IncidentRef, callerId: UuidOperand): SQL {
  if (!incident.id) return sql`false`;
  const caller = uuidSql(callerId);
  return sql`(${incident.circleId} is not null
    and ${incident.status} in ('resolved', 'closed')
    and ${incident.residentId} is distinct from ${caller}
    and exists (
      select 1
        from public.incident_deliveries ph_d
        join public.safety_circle_members ph_m on ph_m.id = ph_d.member_id
       where ph_d.incident_id = ${incident.id}
         and ph_d.member_user_id = ${caller}
         and ph_m.circle_id = ${incident.circleId}
         and ph_m.status in ('removed', 'left')
         and ph_m.ended_at is not null
         and ph_d.delivered_at < ph_m.ended_at))`;
}

/**
 * Stage 2 [B13]: the READ-ONLY member reads of an incident (details, the responder incident list,
 * Activity's circle category): `incident.memberView` OR {@link incidentEndedMemberPastSql}. Never used
 * for a write, a room join, a fan-out or a count: those keep `incident.memberView`.
 */
export const incidentHistoryView = defineIncidentPolicy(
  'incident.historyView',
  (incident, _caller, callerId) => sql`(${incidentMemberView.where({ callerId, incident })}
    or ${incidentEndedMemberPastSql(incident, callerId)})`,
);

/**
 * Stage 2 [B13]: the READ-ONLY reads of an incident's events and responders:
 * `incident.eventsView` OR {@link incidentEndedMemberPastSql}.
 */
export const incidentEventsHistoryView = defineIncidentPolicy(
  'incident.eventsHistoryView',
  (incident, _caller, callerId) => sql`(${incidentEventsView.where({ callerId, incident })}
    or ${incidentEndedMemberPastSql(incident, callerId)})`,
);

/**
 * Stage 2 [B13]: an `incident_deliveries` row (alias `alias`) of a CURRENT membership (its member row
 * is `active`). Rows of an ended membership are kept as history (remove / leave no longer delete
 * them) but never count, re-notify or receive anything.
 */
export function liveDeliverySql(alias: string): SQL {
  // A primary-key lookup per delivery row (the counts poll stays on indexes only).
  return sql`(select ld_m.status from public.safety_circle_members ld_m
               where ld_m.id = ${aliasColumn(alias, 'member_id')}) = 'active'`;
}

/** Operations whose catalogue has a `not_found` code (hidden existence). */
export type NotFoundOperation = {
  [P in ErrorPrefix]: 'not_found' extends (typeof PARITY_ERROR_CODES)[P][number] ? P : never;
}[ErrorPrefix];

/**
 * Runs an incident policy for one incident and raises `<operation>:not_found` (404) when it fails
 * (API-100-09 AC4), e.g. `requireIncident(db, incidentMemberView, id, caller, 'get_incident_details')`.
 */
export async function requireIncident(
  db: SqlExecutor,
  policy: IncidentPolicy,
  incidentId: UuidOperand,
  callerId: UuidOperand,
  operation: NotFoundOperation,
): Promise<void> {
  if (await policy.checkById(db, incidentId, callerId)) return;
  throw new DomainError(parityCode(operation, 'not_found') ?? 'http:not_found');
}
