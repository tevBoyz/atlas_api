import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { declineInvite, errorOf, getCapacity } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createCircle, createUser, fakePhone, type UserFixture } from '../support/fixtures';
import { insertExpiredMember, insertMember } from '../support/invite-rows';
import { completeSetup, createAuthUser, patchLocationSharing } from '../support/profile-api';
import { runSetup } from '../support/setup-compare';

/**
 * API-100-36: `POST /v1/me/profile/complete`. Every scenario asserts the answer and the effects on
 * the profile, the circle and every member row (`test/support/setup-compare.ts`).
 *
 * - AC1 errors in the function's order (401, 404, the three `*_incomplete`);
 * - AC2 `profile_setup_completed_at` keeps its first value;
 * - AC3 location sharing off: no circle, null ids;
 * - AC4 the circle, the owner row (trigger-stamped `activated_at`) and every state of the emergency
 *   contact's row (spec rule 6), including 5/5 (left unchanged, setup still succeeds);
 * - AC5 the answer; AC6 idempotent, audit once; AC7 deferred creation through P6.
 * Races and the lock order: `profile-setup-races.int-spec.ts`.
 */
type Body = Record<string, unknown>;

describe('POST /v1/me/profile/complete (API-100-36)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000', RATE_LIMIT_PUBLIC_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  /** A user ready for setup: complete profile with a fresh contact phone, setup not done yet. */
  const readyUser = async (options: { sharing?: boolean; name?: string } = {}) => {
    const user = await createUser(client, { fullName: options.name ?? 'Setup Owner' });
    const contactPhone = fakePhone();
    await client.query(
      `update public.profiles
          set profile_setup_completed_at = null, emergency_contact_phone = $2,
              emergency_contact_full_name = ' Contact  Person ', emergency_contact_email = ' c@example.test ',
              emergency_contact_relationship = 'sibling', location_sharing_enabled = $3
        where id = $1`,
      [user.id, contactPhone, options.sharing ?? true],
    );
    return { user, contactPhone };
  };

  const compare = (owner: UserFixture) =>
    runSetup(client, owner.id, () => completeSetup(app, owner.id));

  /** A circle owned by `owner` (fixture), with `n` active members. */
  const circleWithActives = async (owner: UserFixture, n: number) => {
    const circle = await createCircle(client, owner);
    for (let i = 0; i < n; i++) {
      const member = await createUser(client, { fullName: `Active ${i}` });
      await insertMember(client, circle.id, {
        status: 'active',
        userId: member.id,
        consumed: true,
      });
    }
    return circle;
  };

  describe('AC1 errors in the function’s order', () => {
    it('no token → 401 complete_profile_setup:not_authenticated', async () => {
      const reply = await completeSetup(app, null);
      expect(reply.statusCode).toBe(401);
      expect(errorOf(reply).code).toBe('complete_profile_setup:not_authenticated');
    });

    it('no profile → 404 profile_not_found', async () => {
      const id = randomUUID();
      await createAuthUser(client, id);
      const result = await runSetup(client, id, () => completeSetup(app, id));
      expect(result.reply.statusCode).toBe(404);
      expect(result.apiError).toBe('complete_profile_setup:profile_not_found');
    });

    it.each([
      [
        'personal_info_completed_at null',
        'personal_info_completed_at = null',
        'personal_info_incomplete',
      ],
      [
        'emergency_info_completed_at null',
        'emergency_info_completed_at = null',
        'emergency_info_incomplete',
      ],
      ['contact name null', 'emergency_contact_full_name = null', 'emergency_info_incomplete'],
      ['contact name blank', `emergency_contact_full_name = '   '`, 'emergency_info_incomplete'],
      ['relationship null', 'emergency_contact_relationship = null', 'emergency_info_incomplete'],
      ['phone null', 'emergency_contact_phone = null', 'emergency_info_incomplete'],
      [
        'phone with 7 digits (the app accepts it)',
        `emergency_contact_phone = '+1234567'`,
        'emergency_info_incomplete',
      ],
      ['phone without +', `emergency_contact_phone = '2203000001'`, 'emergency_info_incomplete'],
      [
        'preferences_completed_at null',
        'preferences_completed_at = null',
        'preferences_incomplete',
      ],
      [
        'personal and preferences both missing: personal wins',
        'personal_info_completed_at = null, preferences_completed_at = null',
        'personal_info_incomplete',
      ],
      [
        'emergency and preferences both missing: emergency wins',
        'emergency_info_completed_at = null, preferences_completed_at = null',
        'emergency_info_incomplete',
      ],
    ])('%s → 409 %s', async (_label, set, code) => {
      const { user } = await readyUser();
      await client.query(`update public.profiles set ${set} where id = $1`, [user.id]);
      const result = await compare(user);
      expect(result.reply.statusCode).toBe(409);
      expect(result.apiError).toBe(`complete_profile_setup:${code}`);
      // Nothing written.
      expect(
        (await client.query('select 1 from public.safety_circles where owner_id = $1', [user.id]))
          .rowCount,
      ).toBe(0);
    });
  });

  describe('AC2-AC5 completion, circle, owner row, contact row (rule 6)', () => {
    it('first completion: circle, owner row (activated_at from the trigger) and a pending 7-day contact invite', async () => {
      const { user, contactPhone } = await readyUser();
      const { snapshot, apiBody } = await compare(user);
      expect(Object.keys(apiBody ?? {})).toEqual([
        'circle_id',
        'member_id',
        'member_status',
        'location_sharing_enabled',
        'profile_setup_completed_at',
      ]);
      expect(apiBody).toMatchObject({ location_sharing_enabled: true, member_status: 'pending' });
      expect(snapshot.circle).toEqual({ id: 'new', name: 'My Safety Circle', created_now: true });
      expect(snapshot.profile.setup_completed_at).toBe('now');
      const [owner, contact] = snapshot.members;
      expect(owner).toMatchObject({
        id: 'new',
        role: 'owner',
        status: 'active',
        display_name: 'Setup Owner',
        user_id: user.id,
        phone: null,
        email: null,
        invite_token: null,
        invited_at: 'now',
        activated_at: 'now',
        activated_at_invited_at: true,
      });
      expect(contact).toMatchObject({
        id: 'new',
        role: 'member',
        status: 'pending',
        display_name: 'Contact  Person',
        relationship: 'sibling',
        phone: contactPhone,
        email: 'c@example.test',
        user_id: null,
        invite_token: 'new',
        invited_at: 'now',
        expires_at: 'now+7d',
        activated_at: null,
      });
      const stored = await client.query<{ token: string; circle: string }>(
        `select m.invite_token as token, m.circle_id::text as circle from public.safety_circle_members m
          where m.id = $1`,
        [apiBody?.member_id],
      );
      expect(stored.rows[0].token).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.rows[0].circle).toBe(apiBody?.circle_id);
    });

    it('a repeat keeps profile_setup_completed_at, the circle and the owner row; refreshes the pending invite (same token, new expiry)', async () => {
      const { user } = await readyUser();
      const first = (await completeSetup(app, user.id)).json<Body>();
      const { apiBody, snapshot } = await compare(user);
      expect(apiBody?.profile_setup_completed_at).toBe(first.profile_setup_completed_at);
      expect(apiBody?.circle_id).toBe(first.circle_id);
      expect(apiBody?.member_id).toBe(first.member_id);
      expect(snapshot.circle?.created_now).toBe(false);
      const [owner, contact] = snapshot.members;
      expect(owner).toMatchObject({ status: 'active', activated_now: false, updated_now: true });
      expect(contact).toMatchObject({
        status: 'pending',
        invite_token: 'kept',
        expires_at: 'now+7d',
        invited_at: 'now',
      });
    });

    it('a renamed profile: the owner row takes the new trimmed name; activated_at does not move', async () => {
      const { user } = await readyUser();
      await completeSetup(app, user.id);
      await client.query(`update public.profiles set full_name = '  New Name ' where id = $1`, [
        user.id,
      ]);
      const { snapshot } = await compare(user);
      expect(snapshot.members[0]).toMatchObject({ display_name: 'New Name', activated_now: false });
    });

    it('contact row active (accepted): status, token, timestamps and user untouched; name/relationship/email refreshed', async () => {
      const { user, contactPhone } = await readyUser();
      const circle = await createCircle(client, user);
      const contactUser = await createUser(client, { fullName: 'Contact Account' });
      await insertMember(client, circle.id, {
        phone: contactPhone,
        status: 'active',
        userId: contactUser.id,
        consumed: true,
        name: 'Old Name',
      });
      const { snapshot, apiBody } = await compare(user);
      expect(apiBody?.member_status).toBe('active');
      expect(snapshot.members.find((m) => m.phone === contactPhone)).toMatchObject({
        status: 'active',
        display_name: 'Contact  Person',
        relationship: 'sibling',
        email: 'c@example.test',
        user_id: contactUser.id,
        invite_token: 'kept',
        invited_now: false,
        activated_now: false,
      });
    });

    it('contact row pending and claimed: token and user kept, new 7-day expiry', async () => {
      const { user, contactPhone } = await readyUser();
      const circle = await createCircle(client, user);
      const claimer = await createUser(client);
      await insertMember(client, circle.id, { phone: contactPhone, userId: claimer.id });
      const { snapshot } = await compare(user);
      expect(snapshot.members.find((m) => m.phone === contactPhone)).toMatchObject({
        status: 'pending',
        user_id: claimer.id,
        invite_token: 'kept',
        expires_at: 'now+7d',
      });
    });

    it('contact row declined by the contact: a usable invite again (new token, cleared, 7 days)', async () => {
      const { user, contactPhone } = await readyUser();
      const circle = await createCircle(client, user);
      const decliner = await createUser(client);
      await insertMember(client, circle.id, {
        phone: contactPhone,
        status: 'declined',
        canceled: true,
        userId: decliner.id,
      });
      const { snapshot, apiBody } = await compare(user);
      expect(apiBody?.member_status).toBe('pending');
      expect(snapshot.members.find((m) => m.phone === contactPhone)).toMatchObject({
        status: 'pending',
        user_id: null,
        invite_token: 'new',
        canceled_at: null,
        consumed_at: null,
        expires_at: 'now+7d',
      });
    });

    it('contact row expired (stored pending): token kept, new expiry, takes a free slot', async () => {
      const { user, contactPhone } = await readyUser();
      const circle = await createCircle(client, user);
      await insertExpiredMember(client, circle.id, { phone: contactPhone });
      const { snapshot } = await compare(user);
      expect(snapshot.members.find((m) => m.phone === contactPhone)).toMatchObject({
        status: 'pending',
        invite_token: 'kept',
        expires_at: 'now+7d',
      });
    });

    it('5/5 and a declined contact row: setup succeeds, the row is left as it is (member_status declined)', async () => {
      const { user, contactPhone } = await readyUser();
      const circle = await circleWithActives(user, 5);
      const row = await insertMember(client, circle.id, {
        phone: contactPhone,
        status: 'declined',
        canceled: true,
      });
      const { snapshot, apiBody } = await compare(user);
      expect(apiBody).toMatchObject({ member_id: row.id, member_status: 'declined' });
      expect(snapshot.members.find((m) => m.phone === contactPhone)).toMatchObject({
        status: 'declined',
        invite_token: 'kept',
        updated_now: false,
      });
      expect(snapshot.profile.setup_completed_at).toBe('now');
    });

    it('5/5 and an expired contact row: left as it is (member_status pending, its stored status)', async () => {
      const { user, contactPhone } = await readyUser();
      const circle = await circleWithActives(user, 5);
      await insertExpiredMember(client, circle.id, { phone: contactPhone });
      const { snapshot, apiBody } = await compare(user);
      expect(apiBody?.member_status).toBe('pending');
      expect(snapshot.members.find((m) => m.phone === contactPhone)).toMatchObject({
        invited_now: false,
        updated_now: false,
      });
    });

    it('5/5 and no contact row: the insert is refused by the trigger; setup succeeds with null ids of the contact', async () => {
      const { user } = await readyUser();
      await circleWithActives(user, 5);
      const { apiBody } = await compare(user);
      expect(apiBody).toMatchObject({ member_id: null, member_status: null });
      const capacity = (await getCapacity(app, user.id)).json<Body>();
      expect(capacity.used).toBe(5);
    });
  });

  describe('AC3 / AC7 location sharing off, then on (deferred creation)', () => {
    it('off: completed, no circle; on (P6) then complete: circle, owner row, contact invite', async () => {
      const { user } = await readyUser({ sharing: false });
      const off = await compare(user);
      expect(off.apiBody).toMatchObject({
        location_sharing_enabled: false,
        circle_id: null,
        member_id: null,
        member_status: null,
      });
      expect(off.snapshot.circle).toBeNull();
      const completedAt = off.apiBody?.profile_setup_completed_at;

      expect((await patchLocationSharing(app, user.id, { enabled: true })).statusCode).toBe(200);
      // P6 alone creates nothing.
      expect(
        (await client.query('select 1 from public.safety_circles where owner_id = $1', [user.id]))
          .rowCount,
      ).toBe(0);
      const on = await compare(user);
      expect(on.apiBody).toMatchObject({
        location_sharing_enabled: true,
        member_status: 'pending',
        profile_setup_completed_at: completedAt,
      });
      expect(on.snapshot.circle).toMatchObject({ id: 'new', created_now: true });
      expect(on.snapshot.members.map((m) => m.role)).toEqual(['owner', 'member']);
    });

    it('off with an existing circle: answers circle_id null and leaves the circle alone', async () => {
      const { user } = await readyUser({ sharing: false });
      await createCircle(client, user);
      const { apiBody, snapshot } = await compare(user);
      expect(apiBody).toMatchObject({ circle_id: null, member_id: null });
      expect(snapshot.members).toHaveLength(1);
      expect(snapshot.members[0].updated_now).toBe(false);
    });
  });

  describe('AC6 idempotent; audit once', () => {
    it('three calls: the same answer each time, one profile.setup_completed audit row', async () => {
      const { user } = await readyUser();
      const bodies = [];
      for (let i = 0; i < 3; i++) bodies.push((await completeSetup(app, user.id)).json<Body>());
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      const audit = await client.query<{ n: number; detail: Body }>(
        `select count(*) over ()::int as n, detail from public.audit_log
          where action = 'profile.setup_completed' and actor_user_id = $1`,
        [user.id],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].detail).toMatchObject({
        deferred: false,
        circle_created: true,
        member_status: 'pending',
      });
      expect(JSON.stringify(audit.rows[0].detail)).not.toMatch(/Contact|\+1201/);
    });

    it('a decline between two runs gives the contact a usable invite again (the parity scenario)', async () => {
      const { user } = await readyUser();
      const contact = await createUser(client, { fullName: 'Contact' });
      const first = (await completeSetup(app, user.id)).json<Body>();
      const token = (
        await client.query<{ t: string }>(
          'select invite_token as t from public.safety_circle_members where id = $1',
          [first.member_id],
        )
      ).rows[0].t;
      // A link-style decline (the contact has no verified phone here): the row as decline leaves it.
      await client.query(
        `update public.safety_circle_members
            set status = 'declined', invite_canceled_at = now(), user_id = $2 where id = $1`,
        [first.member_id, contact.id],
      );
      expect((await declineInvite(app, contact.id, token)).statusCode).toBe(409);
      const { apiBody, snapshot } = await compare(user);
      expect(apiBody).toMatchObject({ member_id: first.member_id, member_status: 'pending' });
      expect(snapshot.members[1]).toMatchObject({
        invite_token: 'new',
        user_id: null,
        canceled_at: null,
      });
    });
  });
});
