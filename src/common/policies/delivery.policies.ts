import { sql, type SQLWrapper } from 'drizzle-orm';

import { incidentDeliveries } from '../../db/schema';
import { incidentAlias, incidentEventsView } from './incident.policies';
import {
  aliasColumn,
  evaluate,
  type Policy,
  type SqlExecutor,
  type UuidOperand,
  uuidSql,
} from './policy';

/**
 * `delivery.own` (spec §11.4; RLS `incident_deliveries_select_own` / `_update_own`, rule 54):
 * the delivery row is the caller's (`member_user_id = caller`) AND the caller passes
 * `incident.eventsView` for its incident (resident, or active member inside the window while the
 * incident is active/resolved/closed, SCRUM-63). A stray delivery row outside the window opens nothing.
 */

export interface DeliveryRef {
  incidentId: SQLWrapper;
  memberUserId: SQLWrapper;
}

export const INCIDENT_DELIVERIES_TABLE: DeliveryRef = {
  incidentId: incidentDeliveries.incidentId,
  memberUserId: incidentDeliveries.memberUserId,
};

export interface DeliveryArgs {
  callerId: UuidOperand;
  /** Defaults to {@link INCIDENT_DELIVERIES_TABLE}. */
  delivery?: DeliveryRef;
}

export interface DeliveryPolicy extends Policy<DeliveryArgs> {
  /** Single-row check by delivery id (an unknown id is false). */
  checkById(db: SqlExecutor, deliveryId: UuidOperand, callerId: UuidOperand): Promise<boolean>;
}

const where = ({ callerId, delivery = INCIDENT_DELIVERIES_TABLE }: DeliveryArgs) =>
  sql`(${delivery.memberUserId} = ${uuidSql(callerId)}
    and exists (
      select 1 from public.incidents pd_i
       where pd_i.id = ${delivery.incidentId}
         and ${incidentEventsView.where({ callerId, incident: incidentAlias('pd_i') })}))`;

export const deliveryOwn: DeliveryPolicy = {
  name: 'delivery.own',
  where,
  check: (db, args) => evaluate(db, where(args)),
  checkById: (db, deliveryId, callerId) =>
    evaluate(
      db,
      sql`exists (
        select 1 from public.incident_deliveries pd_d
         where pd_d.id = ${uuidSql(deliveryId)}
           and ${where({
             callerId,
             delivery: {
               incidentId: aliasColumn('pd_d', 'incident_id'),
               memberUserId: aliasColumn('pd_d', 'member_user_id'),
             },
           })})`,
    ),
};
