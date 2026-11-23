import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { CirclesRepository } from '../../src/modules/circles/circles.repository';
import { MembershipRepository } from '../../src/modules/circles/membership.repository';
import { OwnerInvitesRepository } from '../../src/modules/invites/owner-invites.repository';
import { OwnerInvitesService } from '../../src/modules/invites/owner-invites.service';
import { createTestApp } from '../../src/testing/test-app';
import {
  cancelInvite,
  errorOf,
  getCapacity,
  listJoinedCircles,
  listMembers,
  lookupInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createUser, fakeInviteToken, fakePhone, type UserFixture } from '../support/fixtures';

/**
 * Parity coverage of db/baseline/tests/scrum29_cancel_invite.sql (API-100-13 AC5), complete with
 * API-100-28. One entry per SQL assertion: the name quotes the SQL message, prefixed with its line.
 *
 * `beforeAll` walks the script's scenario in its order, with the same fixtures (raw inserts as the
 * migration role). Every cancel goes through the API (`POST /v1/me/circle/invites/{id}/cancel`);
 * capacity (`GET /v1/me/circle/capacity`) and the member lists (`GET /v1/circles/{id}/members`) too.
 * The canceled token's lookup (L415) goes through `GET /v1/invites/{token}/status` (API-100-29), and
 * the joined circles of the owner and the member (L220, L239, L456) through `GET /v1/me/joined-circles`
 * (API-100-31). The static checks (L47-L86) read the database the API shares; L47 also checks the
 * API's own cancel write, L57 the API's joined-circles query (count, no contact or medical field),
 * L64/L71 the API's remove/leave write (`MembershipRepository.deleteMember`, API-100-32: a hard
 * delete that never sets `invite_canceled_at`). No `it.todo` left.
 *
 * `cancel_circle_invite(null)` (L302/L306): a path cannot carry SQL null. The route answers a
 * `{member_id}` that is not uuid input (including the text `null`) with 422
 * `validation:invalid_request` (the round 1 rule for path ids); the operation itself takes null like
 * the RPC and answers `not_found`, which is what these two entries check.
 */
type Body = Record<string, unknown>;

describe('scrum29_cancel_invite.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;

  const src = async (fn: string) =>
    (
      await client.query<{ src: string }>(`select pg_get_functiondef($1::regprocedure) as src`, [
        fn,
      ])
    ).rows[0].src;
  const privilege = async (role: string) =>
    (
      await client.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'public.cancel_circle_invite(uuid)', 'execute') as ok`,
        [role],
      )
    ).rows[0].ok;

  let cancelSrc: string;
  let apiCancelSrc: string;
  let apiJoinedSrc: string;
  let apiEndSrc: string;
  let joinedSrc: string;
  let removeSrc: string;
  let leaveSrc: string;
  let anonCan: boolean;
  let authenticatedCan: boolean;
  let phones: string[];
  let phonesInUse: number;

  let owner: UserFixture;
  let member: UserFixture;
  let cid: string;
  let ownerMemberId: string;
  let pendingId: string;
  let expiredId: string;
  let activeId: string;
  let declinedId: string;
  let tPending: string;
  let tExpired: string;
  let profileBefore: { updated_at: string; emergency: string | null };

  type Reply = { status: number; code?: string; body: Body };
  const replyOf = (reply: Awaited<ReturnType<typeof cancelInvite>>): Reply => ({
    status: reply.statusCode,
    code: reply.statusCode >= 400 ? errorOf(reply).code : undefined,
    body: reply.json<Body>(),
  });
  const row = async (id: string) =>
    (
      await client.query<Body>(
        `select status, role, invite_token, invite_canceled_at, invite_consumed_at, updated_at
           from public.safety_circle_members where id = $1`,
        [id],
      )
    ).rows[0];
  const joined = async (user: UserFixture) => {
    const reply = await listJoinedCircles(app, user.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body[]>().find((e) => e.circle_id === cid);
  };
  const capacity = async () => (await getCapacity(app, owner.id)).json<Body>();

  let cap1: Body;
  let ownerJoined: Body | undefined;
  let memberJoined: Body | undefined;
  let memberList: { status: number; rows: Body[] };
  let savedUpdated: unknown;
  let nonOwner: Reply;
  let pendingAfterNonOwner: Body;
  let ownerList: Body[];
  let nullPath: Reply;
  let nullService: string | undefined;
  let unknown: Reply;
  let ownerRowCancel: Reply;
  let ownerRowAfter: Body;
  let activeCancel: Reply;
  let activeAfter: Body;
  let expiredCancel: Reply;
  let expiredAfter: Body;
  let declinedCancel: Reply;
  let cap2: Body;
  let pendingCancel: Reply;
  let pendingAfter: Body;
  let lookupCanceled: Body;
  let cap3: Body;
  let memberRows: number;
  let circleCount: number;
  let profileAfter: { updated_at: string; emergency: string | null };
  let joinedAfter: Body | undefined;
  let secondCancel: Reply;
  let canceledAfterSecond: unknown;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    cancelSrc = await src('public.cancel_circle_invite(uuid)');
    joinedSrc = await src('public.list_my_joined_circles()');
    removeSrc = await src('public.remove_circle_member(uuid)');
    leaveSrc = await src('public.leave_safety_circle(uuid)');
    anonCan = await privilege('anon');
    authenticatedCan = await privilege('authenticated');
    // The API's cancel write (compiled method source, SQL text included).
    apiCancelSrc = Function.prototype.toString.call(
      Object.getOwnPropertyDescriptor(OwnerInvitesRepository.prototype, 'cancel')?.value,
    );
    // The API's joined-circles query and its remove/leave write (compiled method source).
    apiJoinedSrc = Function.prototype.toString.call(
      Object.getOwnPropertyDescriptor(CirclesRepository.prototype, 'joinedCircles')?.value,
    );
    apiEndSrc = Function.prototype.toString.call(
      Object.getOwnPropertyDescriptor(MembershipRepository.prototype, 'deleteMember')?.value,
    );

    phones = [fakePhone(), fakePhone()];
    phonesInUse = (
      await client.query<{ n: number }>(
        `select ((select count(*) from auth.users u
                  where u.phone = any($1) or ('+' || u.phone) = any($1))
              + (select count(*) from public.safety_circle_members m where m.phone = any($1)))::int
              as n`,
        [phones],
      )
    ).rows[0].n;

    // Fixtures exactly as the script: minimal profiles (no emergency contact).
    owner = await createUser(client, {
      fullName: 'Owner Cancel',
      phone: phones[0],
      profile: false,
    });
    member = await createUser(client, {
      fullName: 'Active Member',
      phone: phones[1],
      profile: false,
    });
    await client.query(
      `insert into public.profiles (id, full_name, date_of_birth)
       values ($1, 'Owner Cancel', date '1990-01-01'), ($2, 'Active Member', date '1992-02-02')`,
      [owner.id, member.id],
    );
    const readProfile = async () =>
      (
        await client.query<{ updated_at: string; emergency: string | null }>(
          `select updated_at::text, emergency_contact_full_name as emergency
             from public.profiles where id = $1`,
          [owner.id],
        )
      ).rows[0];
    profileBefore = await readProfile();

    tPending = fakeInviteToken();
    tExpired = fakeInviteToken();
    cid = randomUUID();
    await client.query(
      `insert into public.safety_circles (id, owner_id, name) values ($1, $2, 'My Safety Circle')`,
      [cid, owner.id],
    );
    const insert = async (statement: string, params: unknown[]) =>
      (await client.query<{ id: string }>(statement, params)).rows[0].id;
    ownerMemberId = await insert(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
       values ($1, 'owner', 'active', 'Owner Cancel', $2) returning id::text`,
      [cid, owner.id],
    );
    activeId = await insert(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
         invite_consumed_at)
       values ($1, 'member', 'active', 'Active Member', $2, now()) returning id::text`,
      [cid, member.id],
    );
    pendingId = await insert(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
         invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Pending Invite', $2, now() + interval '7 days')
       returning id::text`,
      [cid, tPending],
    );
    expiredId = await insert(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
         invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Expired Invite', $2, now() - interval '1 day')
       returning id::text`,
      [cid, tExpired],
    );
    declinedId = await insert(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
         invite_canceled_at)
       values ($1, 'member', 'declined', 'Already Declined', now()) returning id::text`,
      [cid],
    );

    cap1 = await capacity();
    ownerJoined = await joined(owner);
    memberJoined = await joined(member);
    const memberReply = await listMembers(app, member.id, cid);
    memberList = { status: memberReply.statusCode, rows: memberReply.json<Body[]>() };

    savedUpdated = (await row(pendingId)).updated_at;
    nonOwner = replyOf(await cancelInvite(app, member.id, pendingId));
    pendingAfterNonOwner = await row(pendingId);

    ownerList = (await listMembers(app, owner.id, cid)).json<Body[]>();

    nullPath = replyOf(await cancelInvite(app, owner.id, 'null'));
    nullService = await app
      .get(OwnerInvitesService)
      .cancel({ id: owner.id, issuer: 'supabase', sessionId: null, email: null, phone: null }, null)
      .then(
        () => undefined,
        (error: { code?: string }) => error.code,
      );
    unknown = replyOf(await cancelInvite(app, owner.id, randomUUID()));

    ownerRowCancel = replyOf(await cancelInvite(app, owner.id, ownerMemberId));
    ownerRowAfter = await row(ownerMemberId);
    activeCancel = replyOf(await cancelInvite(app, owner.id, activeId));
    activeAfter = await row(activeId);
    expiredCancel = replyOf(await cancelInvite(app, owner.id, expiredId));
    expiredAfter = await row(expiredId);
    declinedCancel = replyOf(await cancelInvite(app, owner.id, declinedId));
    cap2 = await capacity();

    pendingCancel = replyOf(await cancelInvite(app, owner.id, pendingId));
    pendingAfter = await row(pendingId);
    lookupCanceled = (await lookupInvite(app, tPending)).json<Body>();
    cap3 = await capacity();
    memberRows = (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.safety_circle_members where circle_id = $1',
        [cid],
      )
    ).rows[0].n;
    circleCount = (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.safety_circles where owner_id = $1',
        [owner.id],
      )
    ).rows[0].n;
    profileAfter = await readProfile();
    joinedAfter = await joined(owner);

    secondCancel = replyOf(await cancelInvite(app, owner.id, pendingId));
    canceledAfterSecond = (await row(pendingId)).invite_canceled_at;
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it('L47: cancel_circle_invite deletes, touches profiles, or consumes', () => {
    for (const text of [cancelSrc, apiCancelSrc]) {
      expect(text).not.toMatch(/delete from/i);
      expect(text).not.toMatch(/profiles/i);
      expect(text).not.toMatch(/invite_consumed_at/i);
    }
    expect(apiCancelSrc).toMatch(/update public\.safety_circle_members/);
  });

  it('L57: list_my_joined_circles count or privacy regressed', () => {
    for (const text of [joinedSrc, apiJoinedSrc]) {
      expect(text).toMatch(/active_member_count/i);
      for (const word of ['phone', 'email', 'emergency', 'medical']) {
        expect(text.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('L64: remove_circle_member was changed', () => {
    for (const text of [removeSrc, apiEndSrc]) {
      expect(text).toMatch(/delete from public\.safety_circle_members/i);
      expect(text).not.toMatch(/invite_canceled_at/i);
    }
  });

  it('L71: leave_safety_circle was changed', () => {
    for (const text of [leaveSrc, apiEndSrc]) {
      expect(text).toMatch(/delete from public\.safety_circle_members/i);
      expect(text).not.toMatch(/invite_canceled_at/i);
    }
  });

  it('L79: anon can execute cancel_circle_invite', () => {
    expect(anonCan).toBe(false);
  });

  it('L86: authenticated cannot execute cancel_circle_invite', () => {
    expect(authenticatedCan).toBe(true);
  });

  it('L106: could not allocate test phones', () => {
    expect(new Set(phones).size).toBe(2);
    expect(phonesInUse).toBe(0);
  });

  it('L187: capacity baseline failed: %', () => {
    // The expired pending row holds no slot (fix #14).
    expect(cap1).toEqual({ limit: 5, active_count: 1, pending_count: 1, used: 2, available: 3 });
  });

  it('L220: owner joined count failed: %', () => {
    expect(ownerJoined).toMatchObject({
      role: 'owner',
      status: 'active',
      name: 'My Safety Circle',
      owner_name: 'Owner Cancel',
      member_id: ownerMemberId,
      active_member_count: 1,
    });
    expect(ownerJoined?.joined_at).not.toBeNull();
    // SCRUM-81 (D45) and gap 20 (D50): the API adds `active_incident_id` (null here, no active
    // incident) and `capacity_used` (additive, not in the SQL function). The SQL function's keys are
    // otherwise exactly these.
    expect(ownerJoined?.active_incident_id).toBeNull();
    expect(typeof ownerJoined?.capacity_used).toBe('number');
    expect(
      Object.keys(ownerJoined ?? {})
        .filter((key) => key !== 'active_incident_id' && key !== 'capacity_used')
        .sort(),
    ).toEqual(
      [
        'active_member_count',
        'circle_id',
        'joined_at',
        'member_id',
        'name',
        'owner_name',
        'role',
        'status',
      ].sort(),
    );
  });

  it('L239: member joined count failed: %', () => {
    expect(memberJoined).toMatchObject({
      role: 'member',
      member_id: activeId,
      active_member_count: 1,
    });
    expect(memberJoined).not.toHaveProperty('phone');
    expect(memberJoined).not.toHaveProperty('email');
  });

  it('L252: non-owner member list leaked contact or pending: %', () => {
    expect(memberList.status).toBe(200);
    for (const e of memberList.rows) {
      expect(e).not.toHaveProperty('phone');
      expect(e).not.toHaveProperty('email');
      expect(e).not.toHaveProperty('relationship');
      expect(e.status).not.toBe('pending');
    }
  });

  it('L262: non-owner cancel did not raise', () => {
    expect(nonOwner.status).toBe(403);
  });

  it('L266: non-owner cancel got %', () => {
    expect(nonOwner.code).toBe('cancel_circle_invite:not_authorized');
  });

  it('L278: non-owner cancel wrote the invite', () => {
    expect(pendingAfterNonOwner).toMatchObject({
      status: 'pending',
      invite_canceled_at: null,
      invite_consumed_at: null,
    });
    expect(pendingAfterNonOwner.updated_at).toEqual(savedUpdated);
  });

  it('L297: owner member list dropped contact keys: %', () => {
    const elem = ownerList.find((e) => e.member_id === pendingId);
    expect(elem).toHaveProperty('phone');
    expect(elem).toHaveProperty('email');
    expect(elem).toHaveProperty('relationship');
  });

  it('L302: null member id did not raise', () => {
    expect(nullService).toBeDefined();
    // The route: `null` in the path is not uuid input.
    expect(nullPath).toMatchObject({ status: 422, code: 'validation:invalid_request' });
  });

  it('L306: null member id got %', () => {
    expect(nullService).toBe('cancel_circle_invite:not_found');
  });

  it('L312: unknown member id did not raise', () => {
    expect(unknown.status).toBe(404);
  });

  it('L316: unknown member id got %', () => {
    expect(unknown.code).toBe('cancel_circle_invite:not_found');
  });

  it('L322: owner-row cancel did not raise', () => {
    expect(ownerRowCancel.status).toBe(409);
  });

  it('L326: owner-row cancel got %', () => {
    expect(ownerRowCancel.code).toBe('cancel_circle_invite:cannot_cancel_owner');
  });

  it('L337: owner-row cancel wrote the owner', () => {
    expect(ownerRowAfter).toMatchObject({
      status: 'active',
      role: 'owner',
      invite_canceled_at: null,
    });
  });

  it('L342: active cancel did not raise', () => {
    expect(activeCancel.status).toBe(409);
  });

  it('L346: active cancel got %', () => {
    expect(activeCancel.code).toBe('cancel_circle_invite:not_pending');
  });

  it('L357: active cancel wrote the member', () => {
    expect(activeAfter).toMatchObject({ status: 'active', invite_canceled_at: null });
    expect(activeAfter.invite_consumed_at).not.toBeNull();
  });

  it('L363: expired cancel failed: %', () => {
    expect(expiredCancel.status).toBe(200);
    expect(expiredCancel.body.status).toBe('canceled');
  });

  it('L373: expired cancel did not decline the invite', () => {
    expect(expiredAfter.status).toBe('declined');
    expect(expiredAfter.invite_canceled_at).not.toBeNull();
    expect(expiredAfter.invite_token).toBe(tExpired);
  });

  it('L378: declined cancel did not raise', () => {
    expect(declinedCancel.status).toBe(409);
  });

  it('L382: declined cancel got %', () => {
    expect(declinedCancel.code).toBe('cancel_circle_invite:not_pending');
  });

  it('L389: failed cancels changed capacity: %', () => {
    expect(cap2).toMatchObject({ pending_count: 1, available: 3 });
  });

  it('L398: cancel payload failed: %', () => {
    expect(pendingCancel.status).toBe(200);
    expect(pendingCancel.body).toEqual({
      status: 'canceled',
      member_id: pendingId,
      circle_id: cid,
      owner_name: 'Owner Cancel',
    });
  });

  it('L409: cancel did not decline without consuming', () => {
    expect(pendingAfter).toMatchObject({
      status: 'declined',
      invite_token: tPending,
      invite_consumed_at: null,
    });
    expect(pendingAfter.invite_canceled_at).not.toBeNull();
  });

  it('L415: canceled token lookup failed: %', () => {
    expect(lookupCanceled.status).toBe('canceled');
  });

  it('L423: slot was not released: %', () => {
    expect(cap3).toEqual({ limit: 5, active_count: 1, pending_count: 0, used: 1, available: 4 });
  });

  it('L431: cancel deleted or inserted a member row: %', () => {
    expect(memberRows).toBe(5);
  });

  it('L439: cancel created or deleted a circle', () => {
    expect(circleCount).toBe(1);
  });

  it('L448: cancel wrote the owner profile', () => {
    expect(profileAfter.updated_at).toBe(profileBefore.updated_at);
    expect(profileAfter.emergency).toBeNull();
  });

  it('L456: count changed after cancel: %', () => {
    expect(joinedAfter?.active_member_count).toBe(1);
  });

  it('L461: second cancel did not raise', () => {
    expect(secondCancel.status).toBe(409);
  });

  it('L465: second cancel got %', () => {
    expect(secondCancel.code).toBe('cancel_circle_invite:not_pending');
  });

  it('L474: second cancel wrote the invite', () => {
    expect(canceledAfterSecond).toEqual(pendingAfter.invite_canceled_at);
  });
});
