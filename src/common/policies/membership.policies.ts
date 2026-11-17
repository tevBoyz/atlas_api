import { sql, type SQLWrapper } from 'drizzle-orm';

import { safetyCircleMembers } from '../../db/schema';
import { circleOwner } from './circle.policies';
import {
  aliasColumn,
  evaluate,
  type Policy,
  type SqlExecutor,
  type UuidOperand,
  uuidSql,
} from './policy';

/**
 * `membership.activate` (spec §11.4, §4.4 "known bypass", rule 54): only invitee consent (accept)
 * and profile setup (the owner row) may set `status = 'active'`; `activated_at` is always server
 * time. It is a WRITE rule:
 * - `where({ path, member, callerId })` is the guard for the activating UPDATE/INSERT: which rows
 *   that path may activate (`invite_accept` → member rows; `profile_setup_owner_row` → the caller's
 *   own owner row of a circle they own). Any other path matches nothing.
 * - `assertNoActivatedAt(values)` refuses a write payload that carries `activated_at`: only the
 *   trigger `safety_circle_members_set_activated_at` stamps it (`now()`). The API role is neither
 *   `anon` nor `authenticated`, so the trigger WOULD keep an API-supplied value: never send one.
 * The invitee's consent itself (recipient, token, capacity) is checked by the accept operation
 * (`invite.recipient` and the lookup status).
 */

export const MEMBERSHIP_ACTIVATION_PATHS = ['invite_accept', 'profile_setup_owner_row'] as const;
export type MembershipActivationPath = (typeof MEMBERSHIP_ACTIVATION_PATHS)[number];

export function isMembershipActivationPath(path: string): path is MembershipActivationPath {
  return (MEMBERSHIP_ACTIVATION_PATHS as readonly string[]).includes(path);
}

export interface MembershipMemberRef {
  role: SQLWrapper;
  userId: SQLWrapper;
  circleId: SQLWrapper;
}

export const MEMBERSHIP_TABLE: MembershipMemberRef = {
  role: safetyCircleMembers.role,
  userId: safetyCircleMembers.userId,
  circleId: safetyCircleMembers.circleId,
};

export interface MembershipActivateArgs {
  /** The code path asking to activate (anything else is refused). */
  path: string;
  callerId: UuidOperand;
  /** Defaults to {@link MEMBERSHIP_TABLE}. */
  member?: MembershipMemberRef;
}

export interface MembershipActivatePolicy extends Policy<MembershipActivateArgs> {
  checkById(
    db: SqlExecutor,
    memberId: UuidOperand,
    args: Omit<MembershipActivateArgs, 'member'>,
  ): Promise<boolean>;
}

const where = ({ path, callerId, member = MEMBERSHIP_TABLE }: MembershipActivateArgs) => {
  switch (path) {
    case 'invite_accept':
      return sql`(${member.role} = 'member')`;
    case 'profile_setup_owner_row':
      return sql`(${member.role} = 'owner'
        and ${member.userId} = ${uuidSql(callerId)}
        and ${circleOwner.where({ circleId: member.circleId, callerId })})`;
    default:
      return sql`false`;
  }
};

export const membershipActivate: MembershipActivatePolicy = {
  name: 'membership.activate',
  where,
  check: (db, args) => evaluate(db, where(args)),
  checkById: (db, memberId, args) =>
    evaluate(
      db,
      sql`exists (
        select 1 from public.safety_circle_members pa_m
         where pa_m.id = ${uuidSql(memberId)}
           and ${where({
             ...args,
             member: {
               role: aliasColumn('pa_m', 'role'),
               userId: aliasColumn('pa_m', 'user_id'),
               circleId: aliasColumn('pa_m', 'circle_id'),
             },
           })})`,
    ),
};

/** Thrown when code tries to write `activated_at` itself (a programming error → 500). */
export class ActivatedAtWriteError extends Error {
  constructor() {
    super('safety_circle_members.activated_at is set only by its trigger (server time)');
    this.name = 'ActivatedAtWriteError';
  }
}

/** Refuses a member-row write payload carrying `activatedAt` / `activated_at`. */
export function assertNoActivatedAt(values: Record<string, unknown>): void {
  if ('activatedAt' in values || 'activated_at' in values) throw new ActivatedAtWriteError();
}
