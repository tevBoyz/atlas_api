import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { InviteeInvitesRepository } from '../../src/modules/invites/invitee-invites.repository';
import { InviteeInvitesService } from '../../src/modules/invites/invitee-invites.service';
import { createTestApp } from '../../src/testing/test-app';
import {
  acceptInvite,
  createInviteLink,
  declineInvite,
  errorOf,
  getCapacity,
  invitePhone,
  listMembers,
  previewInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createUser, fakeInviteToken, fakePhone, type UserFixture } from '../support/fixtures';

/**
 * Parity coverage of db/baseline/tests/scrum28_accept_amendment.sql (API-100-13 AC5), complete with
 * API-100-30. One entry per SQL assertion: the name quotes the SQL message, prefixed with its line in
 * the file.
 *
 * `beforeAll` walks the script's scenario in its order, with the same fixtures (raw inserts as the
 * migration role, including the script's over-full circle built with the capacity trigger disabled).
 * Every preview, accept and decline goes through the API (`POST /v1/invites/{token}/preview|accept|
 * decline`, API-100-29/30), as the same caller; the member lists (`GET /v1/circles/{id}/members`,
 * API-100-25) and capacity (`GET /v1/me/circle/capacity`, API-100-24, as the circle's owner; the
 * script reads `_circle_invite_capacity_json` directly) too.
 *
 * L49 (static): the SQL `accept_circle_invite` and the API's accept (the service method and its
 * write, compiled source with the SQL text) reference neither location sharing nor `public.profiles`
 * (the accepter's name is read through `memberProfileNameSql`, as the SQL reads it through
 * `_member_profile_name`). The behaviour itself is L179-L192 and L363-L369.
 *
 * L308/L312 (no slot past 5, API-100-26/27): the script's raw insert at 5/5 still meets the capacity
 * trigger's raw `circle_full` (the backstop the API relies on), and the owner's API invite writes at
 * 5/5 answer the operation's code; no row is added by any of them.
 *
 * No `it.todo` left.
 */
type Member = Record<string, unknown>;
type Body = Record<string, unknown>;
type Reply = { status: number; code?: string; body: Body };

describe('scrum28_accept_amendment.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;

  let sqlAcceptSrc: string;
  let apiAcceptSrc: string;
  let phones: string[];
  let phonesInUse: number;
  let cid: string;
  let cidFull: string;

  let ownerPreview: Reply;
  let tOwnerAfterPreview: Body;
  let ownerAccept: Reply;
  let tOwnerAfterAccept: Body;
  let accepted: Reply;
  let inviteeSharing: boolean;
  let inviteeCircles: number;
  let acceptedAgain: Reply;
  let tAcceptRows: number;
  let previewOwnActive: Reply;
  let previewOther: Reply;
  let tOtherAfter: Body;
  let ownerList: Member[];
  let inviteeList: { status: number; body: string; rows: Member[] };
  let usedBeforeDecline: Body;
  let overflowRaw: string | undefined;
  let overflowApi: Array<{ status: number; code: string }>;
  let overflowRowsAdded: number;
  let declined: Reply;
  let tDeclineStatus: string;
  let usedAfterDecline: Body;
  let exactAccept: Reply;
  let noprofileProfiles: number;
  let noprofileCircles: number;
  let fullAccept: Reply;
  let tFullAfterAccept: Body;
  let fullPreview: Reply;
  let tFullAfterPreview: Body;

  const replyOf = (reply: Awaited<ReturnType<typeof acceptInvite>>): Reply => ({
    status: reply.statusCode,
    code: reply.statusCode >= 400 ? errorOf(reply).code : undefined,
    body: reply.json<Body>(),
  });
  const byToken = async (token: string) =>
    (
      await client.query<Body>(
        `select user_id::text as user_id, status from public.safety_circle_members
          where invite_token = $1`,
        [token],
      )
    ).rows[0];
  const count = async (statement: string, params: unknown[]) =>
    (await client.query<{ n: number }>(statement, params)).rows[0].n;
  const circleRows = (circleId: string) =>
    count('select count(*)::int as n from public.safety_circle_members where circle_id = $1', [
      circleId,
    ]);

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    // Static (L49): the SQL function and the API's accept.
    sqlAcceptSrc = (
      await client.query<{ src: string }>(
        `select pg_get_functiondef('public.accept_circle_invite(text)'::regprocedure) as src`,
      )
    ).rows[0].src;
    apiAcceptSrc = [
      String(Object.getOwnPropertyDescriptor(InviteeInvitesService.prototype, 'accept')?.value),
      String(
        Object.getOwnPropertyDescriptor(InviteeInvitesRepository.prototype, 'acceptWrite')?.value,
      ),
    ].join('\n');

    // Fixtures (L69): seven fake phones nobody uses yet.
    phones = Array.from({ length: 7 }, () => fakePhone());
    phonesInUse = await count(
      `select ((select count(*) from auth.users u
                where u.phone = any($1) or ('+' || u.phone) = any($1))
            + (select count(*) from public.safety_circle_members m where m.phone = any($1)))::int
            as n`,
      [phones],
    );
    const [phoneOwner, phoneInvitee, phoneNoprofile, phoneBlocked, phoneOwner2, phoneOwner3] =
      phones;
    const owner: UserFixture = await createUser(client, {
      fullName: 'Owner One',
      phone: phoneOwner,
    });
    const owner2 = await createUser(client, { fullName: 'Owner Two', phone: phoneOwner2 });
    const owner3 = await createUser(client, { fullName: 'Owner Three', phone: phoneOwner3 });
    const owner4 = await createUser(client, { fullName: 'Owner Four', phone: phones[6] });
    const invitee = await createUser(client, { fullName: 'Invitee One', phone: phoneInvitee });
    await client.query(
      'update public.profiles set location_sharing_enabled = false where id = $1',
      [invitee.id],
    );
    const noprofile = await createUser(client, { phone: phoneNoprofile, profile: false });
    const blocked = await createUser(client, { phone: phoneBlocked, profile: false });

    cid = randomUUID();
    const cidDecline = randomUUID();
    cidFull = randomUUID();
    const cidExact = randomUUID();
    await client.query(
      `insert into public.safety_circles (id, owner_id, name)
       values ($1, $2, 'My Safety Circle'), ($3, $4, 'My Safety Circle'),
              ($5, $6, 'My Safety Circle'), ($7, $8, 'My Safety Circle')`,
      [cid, owner.id, cidDecline, owner2.id, cidFull, owner3.id, cidExact, owner4.id],
    );
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
       values ($1, 'owner', 'active', 'Owner One', $2), ($3, 'owner', 'active', 'Owner Two', $4),
              ($5, 'owner', 'active', 'Owner Three', $6), ($7, 'owner', 'active', 'Owner Four', $8)`,
      [cid, owner.id, cidDecline, owner2.id, cidFull, owner3.id, cidExact, owner4.id],
    );
    const tAccept = fakeInviteToken();
    const tOwner = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, phone,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Invitee One', $2, $3, now() + interval '7 days'),
              ($1, 'member', 'pending', 'Link For Owner', null, $4, now() + interval '7 days')`,
      [cid, phoneInvitee, tAccept, tOwner],
    );

    // The owner previews and accepts the link of their own circle (L141-L165).
    ownerPreview = replyOf(await previewInvite(app, owner.id, tOwner));
    tOwnerAfterPreview = await byToken(tOwner);
    ownerAccept = replyOf(await acceptInvite(app, owner.id, tOwner));
    tOwnerAfterAccept = await byToken(tOwner);

    // The invitee (location sharing off) accepts, twice (L179-L205).
    accepted = replyOf(await acceptInvite(app, invitee.id, tAccept));
    inviteeSharing = (
      await client.query<{ s: boolean }>(
        'select location_sharing_enabled as s from public.profiles where id = $1',
        [invitee.id],
      )
    ).rows[0].s;
    inviteeCircles = await count(
      'select count(*)::int as n from public.safety_circles where owner_id = $1',
      [invitee.id],
    );
    acceptedAgain = replyOf(await acceptInvite(app, invitee.id, tAccept));
    tAcceptRows = await count(
      'select count(*)::int as n from public.safety_circle_members where invite_token = $1',
      [tAccept],
    );

    // Previews of the invitee's own active token and of another invite of that circle (L212-L233).
    previewOwnActive = replyOf(await previewInvite(app, invitee.id, tAccept));
    const tOther = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Someone Else', $2, now() + interval '7 days')`,
      [cid, tOther],
    );
    previewOther = replyOf(await previewInvite(app, invitee.id, tOther));
    tOtherAfter = await byToken(tOther);

    // Lists (L248-L274).
    const ownerReply = await listMembers(app, owner.id, cid);
    expect(ownerReply.statusCode).toBe(200);
    ownerList = ownerReply.json<Member[]>();
    const inviteeReply = await listMembers(app, invitee.id, cid);
    inviteeList = {
      status: inviteeReply.statusCode,
      body: inviteeReply.body,
      rows: inviteeReply.json<Member[]>(),
    };

    // Decline releases the slot. Five pending, then one decline (L297-L330).
    const tDecline = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, phone,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Invitee One', $2, $3, now() + interval '7 days')`,
      [cidDecline, phoneInvitee, tDecline],
    );
    for (let i = 1; i <= 4; i += 1) {
      await client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                   invite_token, invite_expires_at)
         values ($1, 'member', 'pending', $2, $3, now() + interval '7 days')`,
        [cidDecline, `Pending ${i}`, fakeInviteToken()],
      );
    }
    usedBeforeDecline = (await getCapacity(app, owner2.id)).json<Body>();
    const rowsBefore = await circleRows(cidDecline);
    overflowRaw = await client
      .query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                   invite_token, invite_expires_at)
         values ($1, 'member', 'pending', 'Overflow', $2, now() + interval '7 days')`,
        [cidDecline, fakeInviteToken()],
      )
      .then(
        () => undefined,
        (error: Error) => error.message,
      );
    overflowApi = [];
    for (const reply of [
      await createInviteLink(app, owner2.id, { display_name: 'Overflow' }),
      await invitePhone(app, owner2.id, { display_name: 'Overflow', phone: phones[5] }),
    ]) {
      overflowApi.push({ status: reply.statusCode, code: errorOf(reply).code });
    }
    overflowRowsAdded = (await circleRows(cidDecline)) - rowsBefore;
    declined = replyOf(await declineInvite(app, invitee.id, tDecline));
    tDeclineStatus = (await byToken(tDecline)).status as string;
    usedAfterDecline = (await getCapacity(app, owner2.id)).json<Body>();
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'After Decline', $2, now() + interval '7 days')`,
      [cidDecline, fakeInviteToken()],
    );

    // Accept at exactly 5 (4 other active + this pending), by a user without a profile (L363-L369).
    for (let i = 1; i <= 4; i += 1) {
      await client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name)
         values ($1, 'member', 'active', $2)`,
        [cidExact, `Seat ${i}`],
      );
    }
    const tExact = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'No Profile', $2, now() + interval '7 days')`,
      [cidExact, tExact],
    );
    exactAccept = replyOf(await acceptInvite(app, noprofile.id, tExact));
    noprofileProfiles = await count(
      'select count(*)::int as n from public.profiles where id = $1',
      [noprofile.id],
    );
    noprofileCircles = await count(
      'select count(*)::int as n from public.safety_circles where owner_id = $1',
      [noprofile.id],
    );

    // 5 other active rows plus this pending cannot be activated (L399-L425).
    const tFull = fakeInviteToken();
    await client.query('begin');
    await client.query(
      'alter table public.safety_circle_members disable trigger safety_circle_members_enforce_capacity',
    );
    for (let i = 1; i <= 5; i += 1) {
      await client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name)
         values ($1, 'member', 'active', $2)`,
        [cidFull, `Full Seat ${i}`],
      );
    }
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Blocked', $2, now() + interval '7 days')`,
      [cidFull, tFull],
    );
    await client.query(
      'alter table public.safety_circle_members enable trigger safety_circle_members_enforce_capacity',
    );
    await client.query('commit');
    fullAccept = replyOf(await acceptInvite(app, blocked.id, tFull));
    tFullAfterAccept = await byToken(tFull);
    fullPreview = replyOf(await previewInvite(app, blocked.id, tFull));
    tFullAfterPreview = await byToken(tFull);
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it('L49: accept_circle_invite still references profiles or location sharing', () => {
    for (const src of [sqlAcceptSrc, apiAcceptSrc]) {
      expect(src).not.toMatch(/location_sharing/i);
      expect(src).not.toMatch(/public\.profiles/i);
    }
    expect(apiAcceptSrc).toMatch(/memberProfileNameSql\(/);
  });

  it('L69: could not allocate test phones', () => {
    expect(new Set(phones).size).toBe(7);
    expect(phonesInUse).toBe(0);
  });

  it('L141: preview own_circle failed: %', () => {
    expect(ownerPreview.status).toBe(200);
    expect(ownerPreview.body).toMatchObject({
      status: 'own_circle',
      owner_name: 'Owner One',
      circle_id: cid,
    });
    expect(ownerPreview.body).toHaveProperty('owner_avatar_url');
  });

  it('L148: own_circle preview claimed or activated', () => {
    expect(tOwnerAfterPreview).toEqual({ user_id: null, status: 'pending' });
  });

  it('L153: own_circle accept did not raise', () => {
    expect(ownerAccept.status).toBe(409);
  });

  it('L157: own_circle accept got %', () => {
    expect(ownerAccept.code).toBe('accept_circle_invite:own_circle');
  });

  it('L165: own_circle accept wrote the invite', () => {
    expect(tOwnerAfterAccept).toEqual({ user_id: null, status: 'pending' });
  });

  it('L179: accept without location sharing failed: %', () => {
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      status: 'active',
      owner_name: 'Owner One',
      circle_id: cid,
    });
  });

  it('L187: accept turned location sharing on', () => {
    expect(inviteeSharing).toBe(false);
  });

  it('L192: accept created a personal circle', () => {
    expect(inviteeCircles).toBe(0);
  });

  it('L198: second accept was not idempotent: %', () => {
    expect(acceptedAgain.status).toBe(200);
    expect(acceptedAgain.body.member_id).toBe(accepted.body.member_id);
    expect(acceptedAgain.body.status).toBe('active');
    expect(acceptedAgain.body).toEqual(accepted.body);
  });

  it('L205: second accept inserted another row', () => {
    expect(tAcceptRows).toBe(1);
  });

  it('L212: preview of own active token failed: %', () => {
    expect(previewOwnActive.body).toMatchObject({
      status: 'already_member',
      circle_id: cid,
      owner_name: 'Owner One',
    });
  });

  it('L226: preview already_member failed: %', () => {
    expect(previewOther.body).toMatchObject({
      status: 'already_member',
      circle_id: cid,
      owner_name: 'Owner One',
    });
  });

  it('L233: already_member preview claimed a second row', () => {
    expect(tOtherAfter).toEqual({ user_id: null, status: 'pending' });
  });

  it('L248: owner list hid pending: %', () => {
    expect(ownerList.some((e) => e.status === 'pending')).toBe(true);
  });

  it('L267: non-owner list leaked pending or contact fields: %', () => {
    expect(inviteeList.status).toBe(200);
    for (const e of inviteeList.rows) {
      expect(e.status).not.toBe('pending');
      for (const key of ['phone', 'email', 'relationship', 'invite_token']) {
        expect(e).not.toHaveProperty(key);
      }
    }
    expect(inviteeList.body).not.toContain('invite_token');
  });

  it('L274: non-owner list missed the owner row: %', () => {
    expect(inviteeList.rows.some((e) => e.role === 'owner' && e.status === 'active')).toBe(true);
  });

  it('L297: expected 5 used before decline, got %', () => {
    expect(usedBeforeDecline.used).toBe(5);
  });

  it('L308: insert past 5 was allowed before decline', () => {
    expect(overflowRaw).toBeDefined();
    expect(overflowApi.map((r) => r.status)).toEqual([409, 409]);
    expect(overflowRowsAdded).toBe(0);
  });

  it('L312: full insert got %', () => {
    expect(overflowRaw).toMatch(/circle_full/);
    expect(overflowApi.map((r) => r.code)).toEqual([
      'create_circle_invite_link:circle_full',
      'invite_circle_member_by_phone:circle_full',
    ]);
  });

  it('L319: decline failed: %', () => {
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: 'declined', owner_name: 'Owner Two' });
  });

  it('L326: decline did not set declined', () => {
    expect(tDeclineStatus).toBe('declined');
  });

  it('L330: decline did not release the slot, used=%', () => {
    expect(usedAfterDecline.used).toBe(4);
  });

  it('L363: accept at 5 without a profile failed: %', () => {
    expect(exactAccept.status).toBe(200);
    expect(exactAccept.body.status).toBe('active');
  });

  it('L366: accept created a profile', () => {
    expect(noprofileProfiles).toBe(0);
  });

  it('L369: accept created a circle for the no-profile user', () => {
    expect(noprofileCircles).toBe(0);
  });

  it('L399: circle_full accept did not raise', () => {
    expect(fullAccept.status).toBe(409);
  });

  it('L403: circle_full accept got %', () => {
    expect(fullAccept.code).toBe('accept_circle_invite:circle_full');
  });

  it('L411: circle_full accept wrote the invite', () => {
    expect(tFullAfterAccept).toEqual({ user_id: null, status: 'pending' });
  });

  it('L418: preview circle_full failed: %', () => {
    expect(fullPreview.status).toBe(200);
    expect(fullPreview.body).toMatchObject({
      status: 'circle_full',
      owner_name: 'Owner Three',
      circle_id: cidFull,
    });
  });

  it('L425: preview circle_full activated the invite', () => {
    expect(tFullAfterPreview.status).toBe('pending');
  });
});
