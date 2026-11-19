import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp } from '../../src/testing/test-app';
import {
  createInviteLink,
  errorOf,
  getCapacity,
  invitePhone,
  listMembers,
  sqlAs,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createUser, fakeInviteToken, fakePhone, type UserFixture } from '../support/fixtures';

/**
 * Parity coverage of db/baseline/tests/scrum28_accept_amendment.sql (API-100-13 AC5). One entry per
 * SQL assertion: the name quotes the SQL message, prefixed with its line in the file.
 *
 * `beforeAll` walks the parts of the script these stories can read through the API, in its order:
 * the owner's and a member's list of the first circle (`GET /v1/circles/{id}/members`, API-100-25),
 * and the capacity of the decline circle before and after a decline (`GET /v1/me/circle/capacity`,
 * API-100-24, as the circle's owner; the script reads `_circle_invite_capacity_json` directly). The
 * script's writes are done as it does them: raw inserts as the migration role, and the SQL functions
 * `accept_circle_invite` / `decline_circle_invite` as the invitee (API-100-30 replaces them).
 *
 * L308/L312 (no slot past 5, API-100-26/27): the script's raw insert at 5/5 still meets the
 * capacity trigger's raw `circle_full` (the backstop the API relies on), and the owner's API invite
 * writes at 5/5 answer the operation's code (`create_circle_invite_link:circle_full`,
 * `invite_circle_member_by_phone:circle_full`); no row is added by any of them.
 *
 * Done here: API-100-24/25 L69, L248, L267, L274, L297, L330; API-100-26/27 L308, L312.
 *
 * Still `it.todo`, with the story that completes them:
 * - API-100-29 (preview): L141, L148, L212, L226, L233, L418, L425.
 * - API-100-30 (accept / decline): L49, L153, L157, L165, L179, L187, L192, L198, L205, L319, L326,
 *   L363, L366, L369, L399, L403, L411.
 */
type Member = Record<string, unknown>;
type Body = Record<string, unknown>;

describe('scrum28_accept_amendment.sql', () => {
  let app: NestFastifyApplication;
  let client: Client;

  let phones: string[];
  let phonesInUse: number;
  let ownerList: Member[];
  let inviteeList: { status: number; body: string; rows: Member[] };
  let usedBeforeDecline: Body;
  let usedAfterDecline: Body;
  let overflowRaw: string | undefined;
  let overflowApi: Array<{ status: number; code: string }>;
  let overflowRowsAdded: number;

  const declineCircleRows = async (circleId: string) =>
    (
      await client.query<{ n: number }>(
        'select count(*)::int as n from public.safety_circle_members where circle_id = $1',
        [circleId],
      )
    ).rows[0].n;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();

    phones = Array.from({ length: 7 }, () => fakePhone());
    phonesInUse = (
      await client.query<{ n: number }>(
        `select ((select count(*) from auth.users u
                  where u.phone = any($1) or ('+' || u.phone) = any($1))
              + (select count(*) from public.safety_circle_members m where m.phone = any($1)))::int
              as n`,
        [phones],
      )
    ).rows[0].n;
    const [phoneOwner, phoneInvitee, phoneNoprofile, phoneBlocked, phoneOwner2] = phones;
    const owner: UserFixture = await createUser(client, {
      fullName: 'Owner One',
      phone: phoneOwner,
    });
    const owner2 = await createUser(client, { fullName: 'Owner Two', phone: phoneOwner2 });
    const invitee = await createUser(client, { fullName: 'Invitee One', phone: phoneInvitee });
    await client.query(
      'update public.profiles set location_sharing_enabled = false where id = $1',
      [invitee.id],
    );
    await createUser(client, { phone: phoneNoprofile, profile: false });
    await createUser(client, { phone: phoneBlocked, profile: false });

    const cid = randomUUID();
    const cidDecline = randomUUID();
    await client.query(
      `insert into public.safety_circles (id, owner_id, name)
       values ($1, $2, 'My Safety Circle'), ($3, $4, 'My Safety Circle')`,
      [cid, owner.id, cidDecline, owner2.id],
    );
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
       values ($1, 'owner', 'active', 'Owner One', $2), ($3, 'owner', 'active', 'Owner Two', $4)`,
      [cid, owner.id, cidDecline, owner2.id],
    );
    const tAccept = fakeInviteToken();
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name, phone,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Invitee One', $2, $3, now() + interval '7 days'),
              ($1, 'member', 'pending', 'Link For Owner', null, $4, now() + interval '7 days')`,
      [cid, phoneInvitee, tAccept, fakeInviteToken()],
    );

    // The invitee accepts (SQL, API-100-30); a second link invite stays pending.
    await sqlAs(client, invitee.id, 'public.accept_circle_invite($1)', [tAccept]);
    await client.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
                                                 invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Someone Else', $2, now() + interval '7 days')`,
      [cid, fakeInviteToken()],
    );

    const ownerReply = await listMembers(app, owner.id, cid);
    expect(ownerReply.statusCode).toBe(200);
    ownerList = ownerReply.json<Member[]>();
    const inviteeReply = await listMembers(app, invitee.id, cid);
    inviteeList = {
      status: inviteeReply.statusCode,
      body: inviteeReply.body,
      rows: inviteeReply.json<Member[]>(),
    };

    // Decline releases the slot. Five pending, then one decline.
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
    // Past 5: the script's raw insert (the capacity trigger), and the API's invite writes.
    const rowsBefore = await declineCircleRows(cidDecline);
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
    overflowRowsAdded = (await declineCircleRows(cidDecline)) - rowsBefore;
    await sqlAs(client, invitee.id, 'public.decline_circle_invite($1)', [tDecline]);
    usedAfterDecline = (await getCapacity(app, owner2.id)).json<Body>();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  it.todo('L49: accept_circle_invite still references profiles or location sharing');

  it('L69: could not allocate test phones', () => {
    expect(new Set(phones).size).toBe(7);
    expect(phonesInUse).toBe(0);
  });

  it.todo('L141: preview own_circle failed: %');
  it.todo('L148: own_circle preview claimed or activated');
  it.todo('L153: own_circle accept did not raise');
  it.todo('L157: own_circle accept got %');
  it.todo('L165: own_circle accept wrote the invite');
  it.todo('L179: accept without location sharing failed: %');
  it.todo('L187: accept turned location sharing on');
  it.todo('L192: accept created a personal circle');
  it.todo('L198: second accept was not idempotent: %');
  it.todo('L205: second accept inserted another row');
  it.todo('L212: preview of own active token failed: %');
  it.todo('L226: preview already_member failed: %');
  it.todo('L233: already_member preview claimed a second row');

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
  it.todo('L319: decline failed: %');
  it.todo('L326: decline did not set declined');

  it('L330: decline did not release the slot, used=%', () => {
    expect(usedAfterDecline.used).toBe(4);
  });

  it.todo('L363: accept at 5 without a profile failed: %');
  it.todo('L366: accept created a profile');
  it.todo('L369: accept created a circle for the no-profile user');
  it.todo('L399: circle_full accept did not raise');
  it.todo('L403: circle_full accept got %');
  it.todo('L411: circle_full accept wrote the invite');
  it.todo('L418: preview circle_full failed: %');
  it.todo('L425: preview circle_full activated the invite');
});
