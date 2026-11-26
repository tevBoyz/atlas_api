import type { ClientBase } from 'pg';

import { assertBaselinePresent, type Log } from './baseline';

/**
 * `npm run db:seed` (API-100-03): FAKE local data only. Idempotent: fixed ids, re-running inserts
 * nothing new. Emails use the reserved `example.test` domain and phones the fictional
 * NANP 555-01xx range (+1 201 555-0101 ...). Never put real people, numbers or addresses here.
 *
 * Creates four `public.users` accounts with complete profiles, and one Safety Circle owned by Ada with:
 *   - Ada (owner, active), Ben (member, active, also her emergency contact),
 *   - Cara (member, active), Dan (member, pending invite; Dan has an account but has not answered).
 * `activated_at` is never written: the `safety_circle_members_set_activated_at` trigger owns it.
 */

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

interface SeedUser {
  id: string;
  fullName: string;
  email: string;
  /** E.164 (as profiles and circle rows store it). */
  phone: string;
}

export const SEED_USERS = {
  ada: {
    id: '00000000-0000-4000-8000-00000000a001',
    fullName: 'Ada Example',
    email: 'ada@example.test',
    phone: '+12015550101',
  },
  ben: {
    id: '00000000-0000-4000-8000-00000000a002',
    fullName: 'Ben Example',
    email: 'ben@example.test',
    phone: '+12015550102',
  },
  cara: {
    id: '00000000-0000-4000-8000-00000000a003',
    fullName: 'Cara Example',
    email: 'cara@example.test',
    phone: '+12015550103',
  },
  dan: {
    id: '00000000-0000-4000-8000-00000000a004',
    fullName: 'Dan Example',
    email: 'dan@example.test',
    phone: '+12015550104',
  },
} as const satisfies Record<string, SeedUser>;

export const SEED_CIRCLE_ID = '00000000-0000-4000-8000-00000000c001';

const MEMBER_ROW = {
  owner: '00000000-0000-4000-8000-00000000d001',
  ben: '00000000-0000-4000-8000-00000000d002',
  cara: '00000000-0000-4000-8000-00000000d003',
  dan: '00000000-0000-4000-8000-00000000d004',
} as const;

/** Fake 64-hex invite tokens (the shape `new_circle_invite_token()` produces). */
const token = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

/** Rows `pg` will run, in order. Exported for tests that assert the data stays fake. */
export function seedStatements(): Array<{ sql: string; values: unknown[] }> {
  const users = Object.values(SEED_USERS);
  const statements: Array<{ sql: string; values: unknown[] }> = [];

  for (const user of users) {
    statements.push({
      // The account table (D76: the API reads only public.users; phones are E.164).
      sql: `insert into public.users (
              id, email, email_confirmed_at, phone, phone_confirmed_at, metadata)
            values ($1, $2, now(), $3, now(), jsonb_build_object('full_name', $4::text))
            on conflict (id) do nothing`,
      values: [user.id, user.email, user.phone, user.fullName],
    });
  }

  for (const [index, user] of users.entries()) {
    const contact = user.id === SEED_USERS.ada.id ? SEED_USERS.ben : SEED_USERS.ada;
    statements.push({
      sql: `insert into public.profiles (
              id, full_name, date_of_birth, gender,
              personal_info_completed_at, preferences_completed_at,
              emergency_contact_full_name, emergency_contact_relationship,
              emergency_contact_phone, emergency_contact_email,
              blood_type, emergency_info_completed_at, profile_setup_completed_at)
            values ($1, $2, $3, null, now(), now(), $4, 'friend', $5, $6, 'Unknown', now(), now())
            on conflict (id) do nothing`,
      values: [
        user.id,
        user.fullName,
        `199${index}-01-15`,
        contact.fullName,
        contact.phone,
        contact.email,
      ],
    });
  }

  statements.push({
    sql: `insert into public.safety_circles (id, owner_id, name)
          values ($1, $2, 'My Safety Circle')
          on conflict (id) do nothing`,
    values: [SEED_CIRCLE_ID, SEED_USERS.ada.id],
  });

  statements.push({
    sql: `insert into public.safety_circle_members (
            id, circle_id, role, status, display_name, user_id, invited_at)
          values ($1, $2, 'owner', 'active', $3, $4, now())
          on conflict (id) do nothing`,
    values: [MEMBER_ROW.owner, SEED_CIRCLE_ID, SEED_USERS.ada.fullName, SEED_USERS.ada.id],
  });

  const accepted = [
    [MEMBER_ROW.ben, SEED_USERS.ben, 'friend', token(1)],
    [MEMBER_ROW.cara, SEED_USERS.cara, 'sibling', token(2)],
  ] as const;
  for (const [rowId, user, relationship, inviteToken] of accepted) {
    statements.push({
      // As left by accept_circle_invitation: active, consumed, token kept.
      sql: `insert into public.safety_circle_members (
              id, circle_id, role, status, display_name, relationship, phone, user_id,
              invited_at, invite_token, invite_expires_at, invite_consumed_at)
            values ($1, $2, 'member', 'active', $3, $4, $5, $6,
              now(), $7, now() + interval '7 days', now())
            on conflict (id) do nothing`,
      values: [
        rowId,
        SEED_CIRCLE_ID,
        user.fullName,
        relationship,
        user.phone,
        user.id,
        inviteToken,
      ],
    });
  }

  statements.push({
    // A pending phone invite: no user_id until Dan claims/accepts it.
    sql: `insert into public.safety_circle_members (
            id, circle_id, role, status, display_name, relationship, phone,
            invited_at, invite_token, invite_expires_at)
          values ($1, $2, 'member', 'pending', $3, 'friend', $4,
            now(), $5, now() + interval '7 days')
          on conflict (id) do nothing`,
    values: [
      MEMBER_ROW.dan,
      SEED_CIRCLE_ID,
      SEED_USERS.dan.fullName,
      SEED_USERS.dan.phone,
      token(3),
    ],
  });

  return statements;
}

export async function seedLocalData(client: ClientBase, log: Log): Promise<void> {
  await assertBaselinePresent(client);
  let inserted = 0;
  await client.query('begin');
  try {
    for (const { sql, values } of seedStatements()) {
      const result = await client.query(sql, values);
      inserted += result.rowCount ?? 0;
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw new SeedError(
      `Seeding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const counts = await client.query<{ users: number; profiles: number; members: number }>(
    `select (select count(*) from public.users where email like '%@example.test')::int as users,
            (select count(*) from public.profiles p join public.users u on u.id = p.id
              where u.email like '%@example.test')::int as profiles,
            (select count(*) from public.safety_circle_members where circle_id = $1)::int as members`,
    [SEED_CIRCLE_ID],
  );
  const c = counts.rows[0];
  log(
    inserted === 0
      ? 'Seed data already present. Nothing inserted.'
      : `Inserted ${inserted} row(s).`,
  );
  if (c) {
    log(
      `Seed users: ${c.users}, profiles: ${c.profiles}, circle members (incl. owner): ${c.members}. ` +
        `Fake data only (@example.test, +1 201 555-01xx).`,
    );
  }
}
