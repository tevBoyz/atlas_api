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
  /** Stored status: `pending`, `active` or `declined`. */
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
 * UPDATE`, and take no `safety_circles` lock (as the functions). The write is a hard DELETE
 * ({@link MembershipRepository.deleteMember}); `incident_deliveries` rows of that member go with it
 * (`on delete cascade`).
 */
@Injectable()
export class MembershipRepository {
  /**
   * `remove_circle_member`'s lock: the row `memberId`, locked. The function looks the row up by id
   * alone; the API's path also names the circle, and a row of another circle is not found (decision
   * of API-100-32, see the service), so the predicate carries the circle and such a row is never
   * locked.
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
   * The parity write of remove and leave: the functions' `delete from public.safety_circle_members
   * where id = m.id` (hard delete; no status is stored). Its `incident_deliveries` rows are deleted
   * by the foreign key's `on delete cascade`. True when the row was deleted.
   */
  async deleteMember(tx: MembershipExecutor, memberId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      delete from public.safety_circle_members
       where id = ${memberId}::uuid`);
    return (result.rowCount ?? 0) === 1;
  }
}
