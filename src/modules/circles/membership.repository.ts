import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { circleOwner } from '../../common/policies';
import type { Database } from '../../db/database.service';

/** The caller's open transaction (or one of its savepoints). */
export type MembershipTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Anything that runs SQL. */
export type MembershipExecutor = Pick<Database, 'execute'>;

/** A member row locked `FOR UPDATE` by remove or leave (the functions' `select * ... for update`). */
export interface LockedMembershipRow extends Record<string, unknown> {
  id: string;
  circle_id: string;
  role: 'owner' | 'member';
  /** Stored status: `pending`, `active` or `declined` (never an ended one: those are not locked). */
  status: string;
  user_id: string | null;
}

const LOCKED_COLUMNS = sql`m.id::text as id,
       m.circle_id::text as circle_id,
       m.role,
       m.status,
       m.user_id::text as user_id`;

/**
 * The SQL of remove and leave (spec §7.2 `remove_circle_member`, §7.3 `leave_safety_circle`, rule 24;
 * final definitions: baseline 20261019160000). Both lock exactly one row, the member row, `FOR
 * UPDATE`, and take no `safety_circles` lock (as the functions). The write of an active membership
 * keeps the row as history (D44, {@link MembershipRepository.endMembership}) and deletes its
 * `incident_deliveries` (what the SQL delete's cascade did); remove of a pending or declined row
 * stays the SQL's hard DELETE ({@link MembershipRepository.deleteMember}).
 */
@Injectable()
export class MembershipRepository {
  /**
   * `remove_circle_member`'s lock: the row `memberId`, locked. The function looks the row up by id
   * alone; the API's path also names the circle, and a row of another circle is not found (D15,
   * approved 2026-11-20; see the service), so the predicate carries the circle and such a row is
   * never locked. An ENDED row (`removed` / `left`, D44) is history: not found either, so a second
   * remove of the same member is 404 `not_found`, as after the SQL's delete.
   */
  async lockMemberInCircle(
    tx: MembershipExecutor,
    memberId: string,
    circleId: string,
  ): Promise<LockedMembershipRow | undefined> {
    const result = await tx.execute<LockedMembershipRow>(sql`
      select ${LOCKED_COLUMNS}
        from public.safety_circle_members m
       where m.id = ${memberId}::uuid
         and m.circle_id = ${circleId}::uuid
         and m.status not in ('removed', 'left')
         for update`);
    return result.rows[0];
  }

  /** `leave_safety_circle`'s first check: the circle exists (no lock). */
  async circleExists(tx: MembershipExecutor, circleId: string): Promise<boolean> {
    const result = await tx.execute<{ found: boolean }>(sql`
      select exists (select 1 from public.safety_circles c where c.id = ${circleId}::uuid)
               as found`);
    return result.rows[0].found === true;
  }

  /** `circle.owner`: the caller owns the circle (no lock). */
  async isCircleOwner(
    tx: MembershipExecutor,
    circleId: string,
    callerId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ owner: boolean }>(
      sql`select ${circleOwner.where({ circleId: sql`${circleId}::uuid`, callerId })} as owner`,
    );
    return result.rows[0].owner === true;
  }

  /**
   * `leave_safety_circle`'s lock: the caller's own `active` row with `role = 'member'` in the circle,
   * locked. Undefined when the caller is not an active (non-owner) member there.
   */
  async lockActiveMembership(
    tx: MembershipExecutor,
    circleId: string,
    callerId: string,
  ): Promise<LockedMembershipRow | undefined> {
    const result = await tx.execute<LockedMembershipRow>(sql`
      select ${LOCKED_COLUMNS}
        from public.safety_circle_members m
       where m.circle_id = ${circleId}::uuid
         and m.user_id = ${callerId}::uuid
         and m.status = 'active'
         and m.role = 'member'
         for update`);
    return result.rows[0];
  }

  /**
   * D44 (SCRUM-30/31; plan approved by Dawit 2026-11-22): the end of an ACTIVE membership keeps the
   * row as history instead of the SQL's delete: `status` = `removed` / `left`, `ended_at = now()`,
   * the invite token cleared (`invite_token = null`: the old accepted link then looks up as
   * `not_found` and can never reactivate the row) and `invite_consumed_at` kept (or stamped when
   * missing). `activated_at` is cleared by its trigger (the row is no longer `active`). `user_id`,
   * `phone`, names and `invited_at` stay; a new invite of the same person releases `user_id` (claim,
   * D41/D44) or `phone` (phone invite) later. The member's `incident_deliveries` rows are deleted,
   * exactly what the SQL delete's `on delete cascade` did, so counts, responder lists and fan-out
   * are as before. Touches the locked member row and its delivery rows only (the same rows, in the
   * same order, as the delete and its cascade). True when the row was ended.
   */
  async endMembership(
    tx: MembershipExecutor,
    memberId: string,
    status: 'removed' | 'left',
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      update public.safety_circle_members
         set status = ${status},
             ended_at = now(),
             invite_token = null,
             invite_consumed_at = coalesce(invite_consumed_at, now()),
             updated_at = now()
       where id = ${memberId}::uuid
         and status = 'active'
         and role = 'member'`);
    if ((result.rowCount ?? 0) !== 1) return false;
    await tx.execute(sql`
      delete from public.incident_deliveries
       where member_id = ${memberId}::uuid`);
    return true;
  }

  /**
   * The parity write of remove for a row that is NOT an active membership (a pending invite,
   * claimed or not, or a declined one): the function's `delete from public.safety_circle_members
   * where id = m.id`, kept as the SQL does (D44 changes active memberships only; such rows have no
   * deliveries). True when the row was deleted.
   */
  async deleteMember(tx: MembershipExecutor, memberId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      delete from public.safety_circle_members
       where id = ${memberId}::uuid`);
    return (result.rowCount ?? 0) === 1;
  }
}
