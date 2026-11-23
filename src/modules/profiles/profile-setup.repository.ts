import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { assertNoActivatedAt, membershipActivate } from '../../common/policies';
import { self, type ProfilesExecutor } from './profiles.repository';

/** The checks of `complete_profile_setup` on the caller's locked profile row (spec rule 4). */
export interface SetupProfileRow extends Record<string, unknown> {
  personal_incomplete: boolean;
  emergency_incomplete: boolean;
  preferences_incomplete: boolean;
  location_sharing_enabled: boolean;
  /** `profile_setup_completed_at is null` before this call (the audit row is written once). */
  first_completion: boolean;
}

/** `{profile_setup_completed_at, location_sharing_enabled, circle_id, member_id, member_status}`. */
export type ProfileSetupJson = Record<string, unknown> & {
  profile_setup_completed_at: string;
  location_sharing_enabled: boolean;
  circle_id: string | null;
  member_id: string | null;
  member_status: string | null;
};

export interface ContactRow extends Record<string, unknown> {
  id: string;
  status: string;
}

/** The circle name `complete_profile_setup` creates (never renamed on a repeat). */
export const SETUP_CIRCLE_NAME = 'My Safety Circle';

/**
 * The SQL of `complete_profile_setup()` (final: baseline 20261117120000), one statement per step of
 * the function, with the same values, conflict targets and CASE rules. Values are taken from the
 * caller's locked `profiles` row inside each statement (Postgres `trim`, as the function).
 *
 * Lock order (safe with the owner's invite writes, resend and accept; Phase 2 round 2):
 * 1. the caller's `profiles` row `FOR UPDATE` (as the function);
 * 2. the caller's `safety_circles` row `FOR UPDATE`, or a new one. The function reads the circle
 *    without a lock and first takes it in the contact row's capacity trigger (BEFORE INSERT), i.e.
 *    AFTER its owner-row upsert has locked the owner row; resend (and any writer naming the owner
 *    row after the circle) then deadlocks with it (`profile-setup-races.int-spec.ts` shows the 40P01);
 * 3. the owner member row (upsert), then the emergency contact's row (upsert).
 * So every API writer of a circle takes the circle row before any member row.
 */
@Injectable()
export class ProfileSetupRepository {
  /** Step 1: lock the caller's profile and evaluate the three completion checks in Postgres. */
  async lockProfile(tx: ProfilesExecutor, callerId: string): Promise<SetupProfileRow | undefined> {
    const result = await tx.execute<SetupProfileRow>(sql`
      select coalesce(
               p.personal_info_completed_at is null
                 or char_length(trim(p.full_name)) = 0
                 or p.date_of_birth is null,
               false
             ) as personal_incomplete,
             coalesce(
               p.emergency_info_completed_at is null
                 or p.emergency_contact_full_name is null
                 or char_length(trim(p.emergency_contact_full_name)) = 0
                 or p.emergency_contact_relationship is null
                 or p.emergency_contact_phone is null
                 or p.emergency_contact_phone !~ '^\\+[1-9][0-9]{7,14}$',
               false
             ) as emergency_incomplete,
             (p.preferences_completed_at is null) as preferences_incomplete,
             p.location_sharing_enabled,
             (p.profile_setup_completed_at is null) as first_completion
        from public.profiles p
       where ${self('p', callerId)}
         for update`);
    return result.rows[0];
  }

  /** `profile_setup_completed_at = coalesce(existing, now())`; its value as UTC text. */
  async markCompleted(tx: ProfilesExecutor, callerId: string): Promise<string> {
    const result = await tx.execute<{ completed_at: string }>(sql`
      update public.profiles as p
         set profile_setup_completed_at = coalesce(p.profile_setup_completed_at, now())
       where ${self('p', callerId)}
      returning to_jsonb(p.profile_setup_completed_at) #>> '{}' as completed_at`);
    return result.rows[0].completed_at;
  }

  /**
   * Step 2: the caller's circle, locked `FOR UPDATE`; created (`My Safety Circle`) when there is
   * none. A circle inserted concurrently by another writer (the app's direct RLS insert) is locked
   * instead of failing on `safety_circles_owner_id_key`.
   */
  async lockOrCreateCircle(
    tx: ProfilesExecutor,
    callerId: string,
  ): Promise<{ id: string; created: boolean }> {
    const locked = await this.lockOwnedCircle(tx, callerId);
    if (locked) return { id: locked, created: false };
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into public.safety_circles as sc (owner_id, name)
      values (${callerId}::uuid, ${SETUP_CIRCLE_NAME})
      on conflict (owner_id) do nothing
      returning sc.id::text as id`);
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
    const raced = await this.lockOwnedCircle(tx, callerId);
    if (!raced) throw new Error('safety_circles row vanished during profile setup');
    return { id: raced, created: false };
  }

  /**
   * Step 3a: the owner row, upsert on `(circle_id, user_id)` exactly as the function: insert
   * `owner` / `active` / `trim(full_name)` / `invited_at = now()`, or set `display_name`, `role`,
   * `status`, `updated_at` on the existing row. `activated_at` is never written (its trigger stamps
   * `now()` on the first activation and keeps it afterwards). Both the insert and the update are
   * guarded by `membership.activate` for path `profile_setup_owner_row` (the caller's own owner row
   * of a circle the caller owns). Returns the row id.
   */
  async upsertOwnerRow(tx: ProfilesExecutor, circleId: string, callerId: string): Promise<string> {
    const values: Record<string, SQL> = {
      circle_id: sql`${circleId}::uuid`,
      role: sql`'owner'::text`,
      status: sql`'active'::text`,
      display_name: sql`trim(p.full_name)`,
      user_id: sql`${callerId}::uuid`,
    };
    assertNoActivatedAt(values);
    const guard = (alias: string) =>
      membershipActivate.where({
        path: 'profile_setup_owner_row',
        callerId,
        member: {
          role: sql.raw(`${alias}.role`),
          userId: sql.raw(`${alias}.user_id`),
          circleId: sql.raw(`${alias}.circle_id`),
        },
      });
    const result = await tx.execute<{ id: string }>(sql`
      insert into public.safety_circle_members as scm (
        circle_id, role, status, display_name, relationship, phone, email, user_id, invited_at
      )
      select v.circle_id, v.role, v.status, v.display_name, null, null, null, v.user_id, now()
        from (
          select ${values.circle_id} as circle_id,
                 ${values.role} as role,
                 ${values.status} as status,
                 ${values.display_name} as display_name,
                 ${values.user_id} as user_id
            from public.profiles p
           where ${self('p', callerId)}
        ) v
       where ${guard('v')}
      on conflict (circle_id, user_id) where user_id is not null
      do update set
        display_name = excluded.display_name,
        role = 'owner',
        status = 'active',
        updated_at = now()
       where ${guard('excluded')}
      returning scm.id::text as id`);
    const id = result.rows[0]?.id;
    if (!id) throw new Error('membership.activate refused the profile-setup owner row');
    return id;
  }

  /**
   * D44: before the contact upsert, the circle's ENDED rows (`removed` / `left`, history) of the
   * contact's phone give the phone up (`phone = null`), so the upsert on `(circle_id, phone)` never
   * turns a history row back into an invite: a removed or departed contact gets a new row. The
   * caller holds the circle row lock. Returns the count.
   */
  async releaseEndedContactPhone(
    tx: ProfilesExecutor,
    circleId: string,
    callerId: string,
  ): Promise<number> {
    const result = await tx.execute(sql`
      update public.safety_circle_members as scm
         set phone = null,
             updated_at = now()
        from public.profiles p
       where ${self('p', callerId)}
         and scm.circle_id = ${circleId}::uuid
         and scm.phone = p.emergency_contact_phone
         and scm.status in ('removed', 'left')`);
    return result.rowCount ?? 0;
  }

  /**
   * Step 3b: the emergency contact's row, upsert on `(circle_id, phone)` exactly as the function
   * (spec rule 6): a new pending invite (7-day token), or on the existing row: name, relationship,
   * email refreshed; an `active` row keeps its status, token, timestamps and user; a still-pending
   * uncanceled row keeps its token and user, gets `invited_at = now()` and a new 7-day expiry; a
   * declined / canceled row becomes a usable pending invite (new token, `invite_canceled_at`,
   * `invite_consumed_at` and `user_id` cleared). The capacity trigger refuses a refresh that needs a
   * slot at 5/5 with its raw `circle_full` (the caller runs this in a savepoint). Returns the row's id
   * and stored status.
   */
  async upsertContactRow(
    tx: ProfilesExecutor,
    circleId: string,
    callerId: string,
    token: string,
  ): Promise<ContactRow> {
    const result = await tx.execute<ContactRow>(sql`
      insert into public.safety_circle_members as scm (
        circle_id, role, status, display_name, relationship, phone, email, user_id, invited_at,
        invite_token, invite_expires_at
      )
      select ${circleId}::uuid, 'member', 'pending', trim(p.emergency_contact_full_name),
             p.emergency_contact_relationship, p.emergency_contact_phone,
             nullif(trim(coalesce(p.emergency_contact_email, '')), ''), null, now(), ${token},
             now() + interval '7 days'
        from public.profiles p
       where ${self('p', callerId)}
      on conflict (circle_id, phone) where phone is not null
      do update set
        display_name = excluded.display_name,
        relationship = excluded.relationship,
        email = excluded.email,
        status = case
          when scm.status = 'active' then 'active'
          else 'pending'
        end,
        invited_at = case
          when scm.status = 'active' then scm.invited_at
          else now()
        end,
        invite_token = case
          when scm.status = 'active' then scm.invite_token
          when scm.status = 'pending'
               and scm.invite_canceled_at is null
               and scm.invite_token is not null
            then scm.invite_token
          else excluded.invite_token
        end,
        invite_canceled_at = case
          when scm.status = 'active' then scm.invite_canceled_at
          else null
        end,
        invite_consumed_at = case
          when scm.status = 'active' then scm.invite_consumed_at
          else null
        end,
        user_id = case
          when scm.status = 'active' then scm.user_id
          when scm.status = 'pending' and scm.invite_canceled_at is null then scm.user_id
          else null
        end,
        invite_expires_at = case
          when scm.status = 'active' then scm.invite_expires_at
          else excluded.invite_expires_at
        end,
        updated_at = now()
      returning scm.id::text as id, scm.status`);
    return result.rows[0];
  }

  /** The contact's row as it is (after a refused refresh): `select ... where phone = contact phone`. */
  async contactRow(
    tx: ProfilesExecutor,
    circleId: string,
    callerId: string,
  ): Promise<ContactRow | undefined> {
    const result = await tx.execute<ContactRow>(sql`
      select scm.id::text as id, scm.status
        from public.safety_circle_members scm
        join public.profiles p on ${self('p', callerId)}
       where scm.circle_id = ${circleId}::uuid
         and scm.phone = p.emergency_contact_phone`);
    return result.rows[0];
  }

  /**
   * The function's answer, built by Postgres with its `jsonb_build_object` (so the key order and
   * the timestamp text are the RPC's).
   */
  async result(
    tx: ProfilesExecutor,
    completedAt: string,
    sharing: boolean,
    circleId: string | null,
    contact: ContactRow | undefined,
  ): Promise<ProfileSetupJson> {
    const out = await tx.execute<{ body: ProfileSetupJson }>(sql`
      select jsonb_build_object(
        'profile_setup_completed_at', ${completedAt}::timestamptz,
        'location_sharing_enabled', ${sharing}::boolean,
        'circle_id', ${circleId}::uuid,
        'member_id', ${contact?.id ?? null}::uuid,
        'member_status', ${contact?.status ?? null}::text
      ) as body`);
    return out.rows[0].body;
  }

  private async lockOwnedCircle(
    tx: ProfilesExecutor,
    callerId: string,
  ): Promise<string | undefined> {
    const result = await tx.execute<{ id: string }>(sql`
      select sc.id::text as id
        from public.safety_circles sc
       where sc.owner_id = ${callerId}::uuid
         for update`);
    return result.rows[0]?.id;
  }
}
