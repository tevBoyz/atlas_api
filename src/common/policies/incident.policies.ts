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
 *   `circle_id IS NOT NULL AND status IN ('active','resolved') AND
 *   circle.activeMemberSince(circle_id, caller, activated_at) AND resident_id <> caller`
 *   (`list_responder_incidents`, `get_incident_details`).
 * - `incident.eventsView` = `_can_view_incident_events`: resident, or (circle_id not null, status
 *   active/resolved, inside the window).
 * - `incident.countsView` = `incident_delivery_counts`: resident (any status), or (circle_id not
 *   null, status active, inside the window).
 *
 * Hidden existence (AC4): a failed incident policy raises the operation's `<fn>:not_found`, never
 * 403, so an incident outside the caller's access (including pre-join) looks like no incident.
 */

/** The incident columns a policy reads; defaults to the `incidents` table (Drizzle columns). */
export interface IncidentRef {
  residentId: SQLWrapper;
  circleId: SQLWrapper;
  status: SQLWrapper;
  activatedAt: SQLWrapper;
}

export const INCIDENTS_TABLE: IncidentRef = {
  residentId: incidents.residentId,
  circleId: incidents.circleId,
  status: incidents.status,
  activatedAt: incidents.activatedAt,
};

/** The incident columns of a table alias, e.g. `incidentAlias('i')` for `from incidents i`. */
export function incidentAlias(alias: string): IncidentRef {
  return {
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
    and ${incident.status} in ('active', 'resolved')
    and ${insideWindow(incident, callerId)}
    and ${incident.residentId} is distinct from ${caller})`,
);

export const incidentEventsView = defineIncidentPolicy(
  'incident.eventsView',
  (incident, caller, callerId) => sql`(${incident.residentId} = ${caller}
    or (${incident.circleId} is not null
        and ${incident.status} in ('active', 'resolved')
        and ${insideWindow(incident, callerId)}))`,
);

export const incidentCountsView = defineIncidentPolicy(
  'incident.countsView',
  (incident, caller, callerId) => sql`(${incident.residentId} = ${caller}
    or (${incident.circleId} is not null
        and ${incident.status} = 'active'
        and ${insideWindow(incident, callerId)}))`,
);

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
