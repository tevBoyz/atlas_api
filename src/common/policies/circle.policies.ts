import { sql } from 'drizzle-orm';

import {
  definePolicy,
  type TimestampOperand,
  timestampSql,
  type UuidOperand,
  uuidSql,
} from './policy';

/**
 * Circle policies (spec §11.4, API-100-09). SQL parity:
 * - `circle.owner`              = `safety_circles.owner_id = caller` (RLS `safety_circles_select_own`).
 * - `circle.activeMember`       = `_is_active_circle_member(circle_id, caller)`: an active member row
 *   of that circle for the caller, owner row included. Gates circle and member-list reads.
 * - `circle.activeMemberSince`  = `_is_active_circle_member_since(circle_id, caller, t)` (rule 54):
 *   active row with `activated_at IS NOT NULL AND activated_at <= t`; false when any argument is
 *   null (API-100-09 AC2).
 */

export interface CircleCallerArgs {
  circleId: UuidOperand;
  callerId: UuidOperand;
}

export interface CircleWindowArgs extends CircleCallerArgs {
  /** The instant to test (the incident's `activated_at`). */
  at: TimestampOperand;
}

export const circleOwner = definePolicy<CircleCallerArgs>(
  'circle.owner',
  ({ circleId, callerId }) => sql`exists (
    select 1 from public.safety_circles pc_c
     where pc_c.id = ${uuidSql(circleId)}
       and pc_c.owner_id = ${uuidSql(callerId)})`,
);

export const circleActiveMember = definePolicy<CircleCallerArgs>(
  'circle.activeMember',
  ({ circleId, callerId }) => sql`exists (
    select 1 from public.safety_circle_members pc_m
     where pc_m.circle_id = ${uuidSql(circleId)}
       and pc_m.user_id = ${uuidSql(callerId)}
       and pc_m.status = 'active')`,
);

export const circleActiveMemberSince = definePolicy<CircleWindowArgs>(
  'circle.activeMemberSince',
  ({ circleId, callerId, at }) => {
    const circle = uuidSql(circleId);
    const caller = uuidSql(callerId);
    const instant = timestampSql(at);
    return sql`(${circle} is not null
      and ${caller} is not null
      and ${instant} is not null
      and exists (
        select 1 from public.safety_circle_members pc_w
         where pc_w.circle_id = ${circle}
           and pc_w.user_id = ${caller}
           and pc_w.status = 'active'
           and pc_w.activated_at is not null
           and pc_w.activated_at <= ${instant}))`;
  },
);
