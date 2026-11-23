import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';

import { safetyCircleMembers } from '../../db/schema';
import {
  aliasColumn,
  evaluate,
  type Policy,
  type SqlExecutor,
  type TextOperand,
  textSql,
  type UuidOperand,
  uuidSql,
} from './policy';

/**
 * `invite.recipient(row)` (spec §11.4, §6.3 rule 18; SQL `_circle_invite_recipient_ok` and
 * `_normalize_e164`, migration 20261019170000):
 * - a claimed row (`user_id` set) is only for that user;
 * - a phone invite (`phone` set) needs the caller's Auth phone, normalized, to be non-null and equal
 *   to the row phone normalized;
 * - a link invite (`phone` null) accepts any holder of the current token.
 * The caller's phone is {@link callerPhoneSql} (D47: the API account's CONFIRMED phone, else
 * `auth.users.phone` as `_auth_user_phone` reads it), never from the token. Lookup status
 * (pending/expired/...) is the operation's job, not this rule's.
 */

const E164 = /^\+[1-9][0-9]{7,14}$/;
const E164_DIGITS = /^[1-9][0-9]{7,14}$/;

/** `btrim` (spaces only, like Postgres' default) */
function btrim(value: string): string {
  return value.replace(/^ +| +$/g, '');
}

/**
 * `_normalize_e164`: null/blank → null; trimmed `+E.164` kept; 8-15 digits starting 1-9 get a `+`;
 * anything else → the trimmed text.
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = btrim(raw);
  if (trimmed === '') return null;
  if (E164.test(trimmed)) return trimmed;
  if (E164_DIGITS.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

/** `_normalize_e164` as a SQL expression (the API does not call the internal SQL helper). */
export function normalizeE164Sql(value: SQL): SQL {
  return sql`(case
    when ${value} is null then null
    when btrim(${value}) = '' then null
    when btrim(${value}) ~ ${E164.source} then btrim(${value})
    when btrim(${value}) ~ ${E164_DIGITS.source} then '+' || btrim(${value})
    else btrim(${value})
  end)`;
}

/** Pure form of the rule for an already loaded member row. */
export function isInviteRecipient(
  row: { userId: string | null; phone: string | null },
  callerId: string,
  authPhone: string | null,
): boolean {
  if (row.userId !== null && row.userId.toLowerCase() !== callerId.toLowerCase()) return false;
  if (row.phone !== null) {
    const caller = normalizeE164(authPhone);
    return caller !== null && normalizeE164(row.phone) === caller;
  }
  return true;
}

/**
 * D47 (gap 16): the caller's phone for invite matching and SMS, as stored (not normalized):
 * `public.users.phone` when `phone_confirmed_at` is set (accounts made or changed by the API's own
 * auth, Phase 6), else `auth.users.phone` (migrated / Supabase accounts, exactly what the SQL
 * `_auth_user_phone` reads). An unconfirmed API phone never matches; a user with neither gets null.
 * The SQL functions read `auth.users` only (a deliberate divergence, D47). `uid` is a uuid SQL
 * expression.
 */
export function callerPhoneSql(uid: SQL): SQL {
  return sql`coalesce(
    (select nullif(btrim(cp_u.phone), '') from public.users cp_u
      where cp_u.id = ${uid} and cp_u.phone_confirmed_at is not null),
    (select cp_a.phone from auth.users cp_a where cp_a.id = ${uid}))`;
}

export interface InviteMemberRef {
  userId: SQLWrapper;
  phone: SQLWrapper;
}

export const SAFETY_CIRCLE_MEMBERS_TABLE: InviteMemberRef = {
  userId: safetyCircleMembers.userId,
  phone: safetyCircleMembers.phone,
};

export interface InviteRecipientArgs {
  callerId: UuidOperand;
  /** Defaults to {@link SAFETY_CIRCLE_MEMBERS_TABLE}. */
  member?: InviteMemberRef;
  /** The caller's phone; defaults to {@link callerPhoneSql} of the caller (D47). */
  authPhone?: TextOperand;
}

export interface InviteRecipientPolicy extends Policy<InviteRecipientArgs> {
  /** Single-row check by member row id (an unknown id is false). */
  checkById(db: SqlExecutor, memberId: UuidOperand, callerId: UuidOperand): Promise<boolean>;
}

const where = ({
  callerId,
  member = SAFETY_CIRCLE_MEMBERS_TABLE,
  authPhone,
}: InviteRecipientArgs) => {
  const caller = uuidSql(callerId);
  const phone = authPhone === undefined ? callerPhoneSql(caller) : textSql(authPhone);
  const callerPhone = normalizeE164Sql(phone);
  return sql`((${member.userId} is null or ${member.userId} = ${caller})
    and (${member.phone} is null
         or (${callerPhone} is not null
             and ${normalizeE164Sql(sql`${member.phone}`)} = ${callerPhone})))`;
};

export const inviteRecipient: InviteRecipientPolicy = {
  name: 'invite.recipient',
  where,
  check: (db, args) => evaluate(db, where(args)),
  checkById: (db, memberId, callerId) =>
    evaluate(
      db,
      sql`exists (
        select 1 from public.safety_circle_members pv_m
         where pv_m.id = ${uuidSql(memberId)}
           and ${where({
             callerId,
             member: {
               userId: aliasColumn('pv_m', 'user_id'),
               phone: aliasColumn('pv_m', 'phone'),
             },
           })})`,
    ),
};
