import { randomBytes, randomUUID } from 'node:crypto';

import type { ClientBase } from 'pg';

/**
 * Fixture builders (API-100-13 AC2). They write through SQL because no endpoint exists yet: when a
 * phase ships an endpoint, its parity tests create the same state through the API instead.
 * Data is fake: `example.test` emails and the fictional +1 201 555-01xx range.
 * `activated_at` on member rows is never written here: the database trigger owns it.
 */
export type Queryable = Pick<ClientBase, 'query'>;

let phoneCounter = 0;

/** The next fictional E.164 number (+1 201 555-0100 to -0198; -0199 is the emergency contact). */
export function fakePhone(): string {
  if (phoneCounter >= 99) throw new Error('Fake phone range exhausted in this test file.');
  return `+1201555${String(100 + phoneCounter++).padStart(4, '0')}`;
}

export const fakeInviteToken = (): string => randomBytes(32).toString('hex');

export interface UserFixture {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
}

export interface UserOptions {
  id?: string;
  fullName?: string;
  /** E.164 number, or `true` for a generated one. Default none. */
  phone?: string | true;
  /** `false` leaves the `auth.users` row without a profile. */
  profile?: boolean;
}

/** An `auth.users` row plus a complete profile (GoTrue stores the phone without its `+`). */
export async function createUser(q: Queryable, options: UserOptions = {}): Promise<UserFixture> {
  const id = options.id ?? randomUUID();
  const fullName = options.fullName ?? `Test User ${id.slice(0, 8)}`;
  const email = `user-${id}@example.test`;
  const phone = options.phone === true ? fakePhone() : (options.phone ?? null);
  await q.query(
    `insert into auth.users (instance_id, id, aud, role, email, phone, email_confirmed_at,
                             phone_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                             created_at, updated_at)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
             $3::text, now(), case when $3::text is null then null else now() end,
             '{"provider":"email","providers":["email"]}'::jsonb,
             jsonb_build_object('full_name', $4::text), now(), now())`,
    [id, email, phone?.replace(/^\+/, '') ?? null, fullName],
  );
  if (options.profile !== false) {
    await q.query(
      `insert into public.profiles (
         id, full_name, date_of_birth, personal_info_completed_at, preferences_completed_at,
         emergency_contact_full_name, emergency_contact_relationship, emergency_contact_phone,
         blood_type, emergency_info_completed_at, profile_setup_completed_at)
       values ($1, $2, date '1990-01-15', now(), now(), 'Contact Example', 'friend',
               '+12015550199', 'Unknown', now(), now())`,
      [id, fullName],
    );
  }
  return { id, email, phone, fullName };
}

export interface CircleFixture {
  id: string;
  ownerId: string;
  ownerMemberId: string;
}

/** A Safety Circle with its active owner row. */
export async function createCircle(q: Queryable, owner: UserFixture): Promise<CircleFixture> {
  const id = randomUUID();
  const ownerMemberId = randomUUID();
  await q.query(
    `insert into public.safety_circles (id, owner_id, name) values ($1, $2, 'My Safety Circle')`,
    [id, owner.id],
  );
  await q.query(
    `insert into public.safety_circle_members (id, circle_id, role, status, display_name, user_id,
                                               invited_at)
     values ($1, $2, 'owner', 'active', $3, $4, now())`,
    [ownerMemberId, id, owner.fullName, owner.id],
  );
  return { id, ownerId: owner.id, ownerMemberId };
}

export interface MemberFixture {
  id: string;
  circleId: string;
  userId: string | null;
  inviteToken: string;
  phone: string | null;
}

export interface InviteOptions {
  displayName?: string;
  /** E.164 number the invite was sent to. Default a generated one. */
  phone?: string | null;
  /** Claimed by this user (`user_id` set while still pending). */
  claimedBy?: UserFixture;
  /** Days until the invite expires; negative = already expired. Default 7. */
  expiresInDays?: number;
}

/** A pending phone invite. */
export async function inviteMember(
  q: Queryable,
  circle: CircleFixture,
  options: InviteOptions = {},
): Promise<MemberFixture> {
  const id = randomUUID();
  const inviteToken = fakeInviteToken();
  const phone = options.phone === undefined ? fakePhone() : options.phone;
  const userId = options.claimedBy?.id ?? null;
  await q.query(
    `insert into public.safety_circle_members (
       id, circle_id, role, status, display_name, relationship, phone, user_id, invited_at,
       invite_token, invite_expires_at)
     values ($1, $2, 'member', 'pending', $3, 'friend', $4, $5, now(), $6,
             now() + make_interval(days => $7))`,
    [
      id,
      circle.id,
      options.displayName ?? 'Invited Member',
      phone,
      userId,
      inviteToken,
      options.expiresInDays ?? 7,
    ],
  );
  return { id, circleId: circle.id, userId, inviteToken, phone };
}

/** An accepted member: active, invite consumed, as `accept_circle_invite` leaves the row. */
export async function addActiveMember(
  q: Queryable,
  circle: CircleFixture,
  user: UserFixture,
): Promise<MemberFixture> {
  const id = randomUUID();
  const inviteToken = fakeInviteToken();
  await q.query(
    `insert into public.safety_circle_members (
       id, circle_id, role, status, display_name, relationship, phone, user_id, invited_at,
       invite_token, invite_expires_at, invite_consumed_at)
     values ($1, $2, 'member', 'active', $3, 'friend', $4, $5, now(), $6,
             now() + interval '7 days', now())`,
    [id, circle.id, user.fullName, user.phone, user.id, inviteToken],
  );
  return { id, circleId: circle.id, userId: user.id, inviteToken, phone: user.phone };
}

export interface IncidentFixture {
  id: string;
  residentId: string;
  circleId: string | null;
  status: string;
}

export interface IncidentOptions {
  status?: 'active' | 'resolved';
  emergencyType?: string;
}

/** An incident row of `resident`'s circle. Deliveries and events are not created. */
export async function createIncident(
  q: Queryable,
  resident: UserFixture,
  circle: CircleFixture | null,
  options: IncidentOptions = {},
): Promise<IncidentFixture> {
  const id = randomUUID();
  const status = options.status ?? 'active';
  const resolved = status === 'resolved';
  await q.query(
    `insert into public.incidents (id, resident_id, circle_id, status, activated_at, sent_at,
                                   emergency_type, resolved_at, resolved_reason)
     values ($1, $2, $3, $4, now(), now(), $5,
             case when $6::boolean then now() end, case when $6::boolean then 'safe' end)`,
    [id, resident.id, circle?.id ?? null, status, options.emergencyType ?? 'medical', resolved],
  );
  return { id, residentId: resident.id, circleId: circle?.id ?? null, status };
}
