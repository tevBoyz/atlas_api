import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  declineInvite,
  errorOf,
  listMyInvites,
  previewInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createCircle, createUser, type UserFixture } from '../support/fixtures';
import { insertMember, memberRow } from '../support/invite-rows';

/**
 * Gap 16 (D47): phone invitations match the caller's phone read from the API's own account
 * (`public.users.phone` with `phone_confirmed_at` set), falling back to `auth.users.phone` for
 * migrated / Supabase accounts. An API-signup account (no `auth.users` row) with a confirmed phone
 * sees, previews, accepts and declines a phone invite; an unconfirmed phone never matches; a
 * migrated account keeps matching its `auth.users` phone; a phone changed through the API wins.
 */
type Body = Record<string, unknown>;

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(700 + counter++).padStart(3, '0')}`;

describe('phone invites for API accounts (gap 16, D47)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  /**
   * An account created by the API's own auth (Phase 6): a `public.users` row only (no
   * `auth.users` row), with a complete profile. `confirmed` sets `phone_confirmed_at`.
   */
  const apiUser = async (phone: string, confirmed: boolean): Promise<UserFixture> => {
    const id = randomUUID();
    const email = `api-${id}@example.test`;
    await client.query(
      `insert into public.users (id, email, email_confirmed_at, phone, phone_confirmed_at, metadata)
       values ($1, $2, now(), $3, case when $4::boolean then now() end, '{}'::jsonb)`,
      [id, email, phone, confirmed],
    );
    await client.query(
      `insert into public.profiles (
         id, full_name, date_of_birth, personal_info_completed_at, preferences_completed_at,
         emergency_contact_full_name, emergency_contact_relationship, emergency_contact_phone,
         blood_type, emergency_info_completed_at, profile_setup_completed_at)
       values ($1, 'Api Person', date '1990-01-15', now(), now(), 'Contact Example', 'friend',
               '+12015550199', 'Unknown', now(), now())`,
      [id],
    );
    const auth = await client.query('select 1 from auth.users where id = $1', [id]);
    expect(auth.rowCount).toBe(0);
    return { id, email, phone, fullName: 'Api Person' };
  };

  const newCircle = async () => {
    const owner = await createUser(client, { fullName: 'Owner D47', phone: phoneNumber() });
    return createCircle(client, owner);
  };

  const invitesOf = async (user: UserFixture) => {
    const reply = await listMyInvites(app, user.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body[]>();
  };

  it('an API account with a confirmed phone sees, previews, accepts and declines a phone invite', async () => {
    const phone = phoneNumber();
    const user = await apiUser(phone, true);
    const listed = await newCircle();
    const previewed = await newCircle();
    const declined = await newCircle();
    const listedRow = await insertMember(client, listed.id, { phone });
    const previewRow = await insertMember(client, previewed.id, { phone });
    const declineRow = await insertMember(client, declined.id, { phone });

    // Incoming list: all three are listed; the claim side effect claims them.
    const list = await invitesOf(user);
    expect(list.map((x) => x.member_id).sort()).toEqual(
      [listedRow.id, previewRow.id, declineRow.id].sort(),
    );
    expect((await memberRow(client, listedRow.id)).user_id).toBe(user.id);

    const preview = await previewInvite(app, user.id, previewRow.token);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      status: 'pending',
      member_id: previewRow.id,
      recipient_ok: true,
      claimed: true,
    });

    const accept = await acceptInvite(app, user.id, previewRow.token);
    expect(accept.statusCode).toBe(200);
    expect(await memberRow(client, previewRow.id)).toMatchObject({
      status: 'active',
      user_id: user.id,
    });

    const decline = await declineInvite(app, user.id, declineRow.token);
    expect(decline.statusCode).toBe(200);
    expect((await memberRow(client, declineRow.id)).status).toBe('declined');
  });

  it('an unconfirmed API phone never matches (list, preview, accept, decline)', async () => {
    const phone = phoneNumber();
    const user = await apiUser(phone, false);
    const circle = await newCircle();
    const row = await insertMember(client, circle.id, { phone });

    expect(await invitesOf(user)).toEqual([]);
    expect((await memberRow(client, row.id)).user_id).toBeNull();

    const preview = await previewInvite(app, user.id, row.token);
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ recipient_ok: false, claimed: false, member_id: null });

    const accept = await acceptInvite(app, user.id, row.token);
    expect(accept.statusCode).toBe(403);
    expect(errorOf(accept).code).toBe('accept_circle_invite:not_recipient');
    const decline = await declineInvite(app, user.id, row.token);
    expect(decline.statusCode).toBe(403);
    expect(errorOf(decline).code).toBe('decline_circle_invite:not_recipient');
    expect(await memberRow(client, row.id)).toMatchObject({ status: 'pending', user_id: null });

    // Confirming the phone makes the same invite match.
    await client.query('update public.users set phone_confirmed_at = now() where id = $1', [
      user.id,
    ]);
    expect((await invitesOf(user)).map((x) => x.member_id)).toEqual([row.id]);
  });

  it('migrated accounts are unchanged: the auth.users phone still matches', async () => {
    const phone = phoneNumber();
    const migrated = await createUser(client, { phone });
    // An `auth.users` phone stored without "+" and with spaces, the `public.users` copy dropped
    // (e.g. a duplicate at migration): the fallback still finds it.
    await client.query(`update auth.users set phone = $2 where id = $1`, [
      migrated.id,
      `  ${phone.slice(1)} `,
    ]);
    await client.query(
      'update public.users set phone = null, phone_confirmed_at = null where id = $1',
      [migrated.id],
    );
    const circle = await newCircle();
    const row = await insertMember(client, circle.id, { phone });
    expect((await invitesOf(migrated)).map((x) => x.member_id)).toEqual([row.id]);
    const accept = await acceptInvite(app, migrated.id, row.token);
    expect(accept.statusCode).toBe(200);
  });

  it('a phone changed through the API wins over the old auth.users phone', async () => {
    const oldPhone = phoneNumber();
    const newPhone = phoneNumber();
    const user = await createUser(client, { phone: oldPhone });
    await client.query(
      'update public.users set phone = $2, phone_confirmed_at = now() where id = $1',
      [user.id, newPhone],
    );
    const circle = await newCircle();
    const toOld = await insertMember(client, circle.id, { phone: oldPhone });
    const other = await newCircle();
    const toNew = await insertMember(client, other.id, { phone: newPhone });
    expect((await invitesOf(user)).map((x) => x.member_id)).toEqual([toNew.id]);
    const preview = await previewInvite(app, user.id, toOld.token);
    expect(preview.json()).toMatchObject({ recipient_ok: false });
  });
});
