import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { Identifier } from './auth-input';
import { type AuthTx, firstRow } from './auth-transaction';

/** `LockoutStatus` of spec §7.0 (`_login_lockout_payload`). */
export interface LockoutStatus {
  locked: boolean;
  locked_until: string | null;
  failed_attempts: number;
}

/** The lock row, as `_login_lockout_load` leaves it. */
interface LockRow {
  failed_attempts: number;
  locked: boolean;
  locked_until: string | null;
}

/** Spec rule 42: 5 failures within 15 minutes lock for 15 minutes. */
export const LOCK_THRESHOLD = 5;
export const LOCK_WINDOW = '15 minutes';

const UNLOCKED: LockoutStatus = { locked: false, locked_until: null, failed_attempts: 0 };

/** A usable lock email (`_login_lockout_key_for_user`): lower(trim()), at most 254, `x@y`. */
const USABLE_EMAIL = sql`(nullif(lower(btrim(coalesce(u.email::text, ''))), '') is not null
  and char_length(lower(btrim(u.email::text))) <= 254
  and lower(btrim(u.email::text)) ~ '^[^@\\s]+@[^@\\s]+$')`;

/**
 * `public.login_lockouts`, the SAME table the SQL lockout functions use (spec §4.9, §6.8), so the
 * old app and the API share one counter per account during the dual-token window and the Supabase
 * access-token hook still sees locks made by API sign-ins. The rules are those of
 * `login_lockout_status`, `record_login_failure` and `clear_login_failures` (migrations
 * 20261020080000, 20261021100000), statement for statement:
 *
 * - key (rule 44): email sign-in → `lower(trim(email))`; phone sign-in → the account's usable email
 *   when the phone belongs to an account that has one, else the E.164 number;
 * - load (`_login_lockout_load(key, true)`, row locked `FOR UPDATE`): an expired lock resets the
 *   row to 0 failures; a last failure older than 15 minutes resets the count;
 * - a failure while locked changes nothing (no extension, rule 42); otherwise +1, and the 5th
 *   locks until now + 15 minutes.
 *
 * Accounts are looked up in the API's `users` table (the SQL reads `auth.users`; migrated users have
 * the same email, phone and ids, API-100-58). The row is created with `on conflict do nothing`
 * before it is locked, so two first failures in parallel both count (the SQL insert can fail one of
 * them with a unique violation).
 */
@Injectable()
export class LockoutRepository {
  /** `_login_lockout_resolve_key` against `users`. */
  async keyOf(tx: AuthTx, identifier: Identifier): Promise<string> {
    if (identifier.kind === 'email') return identifier.email;
    const row = firstRow<{ key: string | null }>(
      await tx.execute(sql`
        select case when ${USABLE_EMAIL} then lower(btrim(u.email::text))
                    else u.phone end as key
          from public.users u
         where u.phone = ${identifier.phone}
         order by case when ${USABLE_EMAIL} then 0 else 1 end, u.created_at nulls last
         limit 1`),
    );
    return row?.key ?? identifier.phone;
  }

  /** The keys of a user (`_login_lockout_key_for_user` and the E.164 row `clear_login_failures` deletes). */
  async keysOfUser(
    tx: AuthTx,
    userId: string,
  ): Promise<{ email: string | null; phone: string | null }> {
    const row = firstRow<{ email: string | null; phone: string | null }>(
      await tx.execute(sql`
        select case when ${USABLE_EMAIL} then lower(btrim(u.email::text)) end as email, u.phone
          from public.users u where u.id = ${userId}::uuid`),
    );
    return row ?? { email: null, phone: null };
  }

  /** `_login_lockout_load(key, true)`: locks the row and applies the resets. Undefined: no row. */
  private async load(tx: AuthTx, key: string): Promise<LockRow | undefined> {
    const row = firstRow<LockRow & { reset_lock: boolean; reset_window: boolean }>(
      await tx.execute(sql`
        select failed_attempts,
               (locked_until is not null and locked_until > now()) as locked,
               to_jsonb(locked_until) #>> '{}' as locked_until,
               (locked_until is not null and locked_until <= now()) as reset_lock,
               (locked_until is null and last_failed_at is not null
                 and last_failed_at <= now() - interval '15 minutes') as reset_window
          from public.login_lockouts
         where email = ${key}
         for update`),
    );
    if (!row) return undefined;
    if (row.reset_lock) {
      await tx.execute(sql`
        update public.login_lockouts
           set failed_attempts = 0, locked_until = null, last_failed_at = null, updated_at = now()
         where email = ${key}`);
      return { failed_attempts: 0, locked: false, locked_until: null };
    }
    if (row.reset_window) {
      await tx.execute(sql`
        update public.login_lockouts
           set failed_attempts = 0, last_failed_at = null, updated_at = now()
         where email = ${key}`);
      return { failed_attempts: 0, locked: false, locked_until: null };
    }
    return {
      failed_attempts: row.failed_attempts,
      locked: row.locked,
      locked_until: row.locked_until,
    };
  }

  private static payload(row: LockRow | undefined): LockoutStatus {
    if (!row) return { ...UNLOCKED };
    return {
      locked: row.locked,
      locked_until: row.locked ? row.locked_until : null,
      failed_attempts: row.failed_attempts,
    };
  }

  /** `login_lockout_status` (after its rate limit and key resolution). */
  async status(tx: AuthTx, key: string): Promise<LockoutStatus> {
    return LockoutRepository.payload(await this.load(tx, key));
  }

  /**
   * `record_login_failure`: `{locked: true}` status when it was already locked (nothing written; the
   * SQL raises `login_lockout:locked`), else the status after counting this failure.
   */
  async recordFailure(
    tx: AuthTx,
    key: string,
  ): Promise<{ alreadyLocked: boolean; status: LockoutStatus }> {
    await tx.execute(sql`
      insert into public.login_lockouts (email, failed_attempts, locked_until, last_failed_at, updated_at)
      values (${key}, 0, null, null, now())
      on conflict (email) do nothing`);
    const row = await this.load(tx, key);
    if (row?.locked) return { alreadyLocked: true, status: LockoutRepository.payload(row) };
    const updated = firstRow<LockRow>(
      await tx.execute(sql`
        update public.login_lockouts
           set failed_attempts = failed_attempts + 1,
               last_failed_at = now(),
               updated_at = now(),
               locked_until = case when failed_attempts + 1 >= ${LOCK_THRESHOLD}
                                   then now() + interval '15 minutes' else locked_until end
         where email = ${key}
        returning failed_attempts,
                  (locked_until is not null and locked_until > now()) as locked,
                  to_jsonb(locked_until) #>> '{}' as locked_until`),
    );
    return { alreadyLocked: false, status: LockoutRepository.payload(updated) };
  }

  /** The hook's check (`hook_reject_locked_password_session`): is this key locked right now? */
  async isLocked(tx: AuthTx, key: string): Promise<LockoutStatus | undefined> {
    const status = await this.status(tx, key);
    return status.locked ? status : undefined;
  }

  /** `clear_login_failures`: deletes the user's email row and E.164 row. */
  async clear(tx: AuthTx, keys: { email: string | null; phone: string | null }): Promise<void> {
    const list = [keys.email, keys.phone].filter((k): k is string => k !== null);
    if (list.length === 0) return;
    await tx.execute(sql`delete from public.login_lockouts where email in ${list}`);
  }
}
