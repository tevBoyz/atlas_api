import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { InviteeInvitesRepository } from '../../src/modules/invites/invitee-invites.repository';
import { InviteeInvitesService } from '../../src/modules/invites/invitee-invites.service';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  declineInvite,
  errorOf,
  getCapacity,
  listMembers,
  lookupInvite,
  removeMember,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  fakeInviteToken,
  fakePhone,
  type UserFixture,
} from '../support/fixtures';
import {
  callWithRows,
  insertExpiredMember,
  insertMember,
  insertOverCapacity,
  memberRow,
} from '../support/invite-rows';

/**
 * API-100-30: accept (`POST /v1/invites/{token}/accept`, `accept_circle_invite`) and decline
 * (`POST /v1/invites/{token}/decline`, `decline_circle_invite`): every acceptance criterion, the
 * check order and codes, the SQL answer for the same state and caller (JSON text, rows, codes),
 * the activation trigger, capacity, and audit without personal data.
 */
type Body = Record<string, unknown>;

describe('accept and decline (API-100-30)', () => {
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

  interface Owned {
    owner: UserFixture;
    circle: CircleFixture;
  }
  const ownerWithCircle = async (fullName = 'Ada Owner'): Promise<Owned> => {
    const owner = await createUser(client, { fullName, phone: true });
    return { owner, circle: await createCircle(client, owner) };
  };
  const used = async (owner: UserFixture) => (await getCapacity(app, owner.id)).json<Body>().used;
  const auditOf = async (targetId: string) =>
    (
      await client.query<{ action: string; detail: Body; actor: string; target_type: string }>(
        `select action, detail, actor_user_id::text as actor, target_type
           from public.audit_log where target_id = $1 order by id`,
        [targetId],
      )
    ).rows;

  const compareAccept = (caller: UserFixture, token: string, circleIds: string[]) =>
    callWithRows(client, {
      callerId: caller.id,
      circleIds,
      api: () => acceptInvite(app, caller.id, token),
    });
  const compareDecline = (caller: UserFixture, token: string, circleIds: string[]) =>
    callWithRows(client, {
      callerId: caller.id,
      circleIds,
      api: () => declineInvite(app, caller.id, token),
    });
  const expectCode = (reply: { statusCode: number }, status: number, code: string) => {
    expect({ status: reply.statusCode, code: errorOf(reply as never).code }).toEqual({
      status,
      code,
    });
  };

  // --- accept ------------------------------------------------------------------------------------

  describe('accept (AC1-AC3)', () => {
    it('joins under the accepter’s trimmed profile name; trigger stamps activated_at; capacity unchanged', async () => {
      const { owner, circle } = await ownerWithCircle('Owner One');
      const joiner = await createUser(client, { fullName: '  Link Joiner  ' });
      const link = await insertMember(client, circle.id, { name: 'Invited member' });
      const usedBefore = await used(owner);
      const { reply } = await compareAccept(joiner, link.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(
        JSON.stringify({
          status: 'active',
          circle_id: circle.id,
          member_id: link.id,
          owner_name: 'Owner One',
        }),
      );
      const row = await memberRow(client, link.id);
      expect(row).toMatchObject({
        status: 'active',
        user_id: joiner.id,
        display_name: 'Link Joiner',
        invite_canceled_at: null,
        invite_token: link.token,
      });
      expect(row.invite_consumed_at).not.toBeNull();
      // activated_at = the transaction's now() (the trigger), same instant as invite_consumed_at.
      expect(row.activated_at).toEqual(row.invite_consumed_at);
      // The pending slot became an active one: used is unchanged.
      expect(await used(owner)).toBe(usedBefore);
      expect((await lookupInvite(app, link.token)).json<Body>().status).toBe('consumed');
      // The owner's list shows the profile name.
      const list = (await listMembers(app, owner.id, circle.id)).json<Body[]>();
      expect(list.find((m) => m.member_id === link.id)).toMatchObject({
        display_name: 'Link Joiner',
        status: 'active',
      });
    });

    it('keeps the stored name when there is no profile (a blank profile name cannot be stored: profiles_full_name_nonempty); writes no profile and creates no circle', async () => {
      const { circle } = await ownerWithCircle();
      const noProfile = await createUser(client, { profile: false });
      const sharingOff = await createUser(client, { fullName: 'Sharing Off' });
      await client.query(
        `update public.profiles set location_sharing_enabled = false where id = $1`,
        [sharingOff.id],
      );
      const profileBefore = (
        await client.query<Body>(`select * from public.profiles where id = $1`, [sharingOff.id])
      ).rows[0];
      const cases: Array<[UserFixture, string, string]> = [
        [noProfile, 'Stored None', 'Stored None'],
        [sharingOff, 'Stored Off', 'Sharing Off'],
      ];
      for (const [user, stored, shown] of cases) {
        const row = await insertMember(client, circle.id, { name: stored });
        const { reply } = await compareAccept(user, row.token, [circle.id]);
        expect(reply.statusCode).toBe(200);
        expect((await memberRow(client, row.id)).display_name).toBe(shown);
      }
      expect(
        (await client.query('select 1 from public.profiles where id = $1', [noProfile.id]))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await client.query('select 1 from public.safety_circles where owner_id = any($1)', [
            [noProfile.id, sharingOff.id],
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (await client.query<Body>(`select * from public.profiles where id = $1`, [sharingOff.id]))
          .rows[0],
      ).toEqual(profileBefore);
    });

    it('is idempotent for the same caller: same 200 body, no second write, one audit row', async () => {
      const { circle } = await ownerWithCircle();
      const joiner = await createUser(client);
      const link = await insertMember(client, circle.id);
      const first = await acceptInvite(app, joiner.id, link.token);
      const stored = await memberRow(client, link.id);
      const { reply } = await compareAccept(joiner, link.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(first.body);
      expect(await memberRow(client, link.id)).toEqual(stored);
      expect(
        (await auditOf(link.id)).filter((a) => a.action === 'circle.invite.accepted'),
      ).toHaveLength(1);
    });

    it('audit circle.invite.accepted: ids, channel and previous status only', async () => {
      const { circle } = await ownerWithCircle();
      const dan = await createUser(client, { phone: true, fullName: 'Dan Phone' });
      const row = await insertMember(client, circle.id, { phone: dan.phone, name: 'Dan Invite' });
      expect((await acceptInvite(app, dan.id, row.token)).statusCode).toBe(200);
      const audit = await auditOf(row.id);
      expect(audit).toEqual([
        {
          action: 'circle.invite.accepted',
          actor: dan.id,
          target_type: 'circle_member',
          detail: { circle_id: circle.id, channel: 'phone', previous_status: 'pending' },
        },
      ]);
      const text = JSON.stringify(audit);
      for (const secret of [
        row.token,
        dan.phone as string,
        'Dan',
        (dan.phone as string).slice(1),
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('error codes in order, nothing written', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client, { phone: true });
      const benRow = await addActiveMember(client, circle, ben);
      const dan = await createUser(client, { phone: true });
      const noPhone = await createUser(client);
      const cara = await createUser(client);

      const blank = await acceptInvite(app, dan.id, '%20', { raw: true });
      expectCode(blank, 404, 'accept_circle_invite:not_found');

      const states: Array<[string, () => Promise<string>, UserFixture, number, string]> = [
        ['unknown', () => Promise.resolve(fakeInviteToken()), dan, 404, 'not_found'],
        [
          'expired (410)',
          async () => (await insertExpiredMember(client, circle.id)).token,
          dan,
          410,
          'expired',
        ],
        // Expired wins over not_recipient (lookup status first).
        [
          'expired + not recipient',
          async () => (await insertExpiredMember(client, circle.id, { phone: fakePhone() })).token,
          noPhone,
          410,
          'expired',
        ],
        ['consumed', () => Promise.resolve(benRow.inviteToken), dan, 409, 'consumed'],
        [
          'canceled',
          async () =>
            (await insertMember(client, circle.id, { status: 'declined', canceled: true })).token,
          dan,
          409,
          'canceled',
        ],
        [
          'phone invite, other number',
          async () => (await insertMember(client, circle.id, { phone: fakePhone() })).token,
          ben,
          403,
          'not_recipient',
        ],
        [
          'phone invite, caller without an Auth phone',
          async () => (await insertMember(client, circle.id, { phone: fakePhone() })).token,
          noPhone,
          403,
          'not_recipient',
        ],
        [
          'claimed by someone else',
          async () => (await insertMember(client, circle.id, { userId: cara.id })).token,
          dan,
          403,
          'not_recipient',
        ],
        // not_recipient wins over own_circle.
        [
          'owner, phone invite to another number',
          async () => (await insertMember(client, circle.id, { phone: fakePhone() })).token,
          owner,
          403,
          'not_recipient',
        ],
        // own_circle wins over already_member (the owner is active in their circle).
        [
          'owner, link invite',
          async () => (await insertMember(client, circle.id)).token,
          owner,
          409,
          'own_circle',
        ],
        [
          'already active via another row',
          async () => (await insertMember(client, circle.id)).token,
          ben,
          409,
          'already_member',
        ],
      ];
      for (const [name, tokenOf, caller, status, suffix] of states) {
        const token = await tokenOf();
        const { reply, apiError } = await compareAccept(caller, token, [circle.id]);
        expect({ name, apiError }).toEqual({ name, apiError: `accept_circle_invite:${suffix}` });
        expect({ name, status: reply.statusCode }).toEqual({ name, status });
        // Free the slot for the next case (the circle has 5 places).
        await client.query(
          `delete from public.safety_circle_members where invite_token = $1 and id <> $2`,
          [token, benRow.id],
        );
      }
    });

    it('circle_full when other active + other valid pending + 1 > 5: 409, nothing written', async () => {
      const { owner, circle } = await ownerWithCircle('Owner Three');
      const users = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(client)));
      const blocked = await createUser(client);
      const [, , , , , row] = await insertOverCapacity(client, circle.id, [
        ...users.map((u) => ({ status: 'active' as const, userId: u.id, consumed: true })),
        { name: 'Blocked' },
      ]);
      const before = await memberRow(client, row.id);
      const { reply } = await compareAccept(blocked, row.token, [circle.id]);
      expectCode(reply, 409, 'accept_circle_invite:circle_full');
      expect(await memberRow(client, row.id)).toEqual(before);
      void owner;
    });

    it('accept at exactly 5 (4 active + this pending) succeeds; expired rows are not counted', async () => {
      const { owner, circle } = await ownerWithCircle();
      for (const u of await Promise.all([1, 2, 3, 4].map(() => createUser(client)))) {
        await addActiveMember(client, circle, u);
      }
      await insertExpiredMember(client, circle.id);
      const row = await insertMember(client, circle.id);
      const joiner = await createUser(client, { profile: false });
      expect(await used(owner)).toBe(5);
      const { reply } = await compareAccept(joiner, row.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
      expect(await used(owner)).toBe(5);
    });

    it('duplicate_membership: the caller already holds another (pending) row of the circle', async () => {
      const { circle } = await ownerWithCircle();
      const dan = await createUser(client);
      await insertMember(client, circle.id, { userId: dan.id, name: 'Claimed' });
      const link = await insertMember(client, circle.id);
      const before = await memberRow(client, link.id);
      const { reply } = await compareAccept(dan, link.token, [circle.id]);
      expectCode(reply, 409, 'accept_circle_invite:duplicate_membership');
      expect(await memberRow(client, link.id)).toEqual(before);
      expect(await auditOf(link.id)).toEqual([]);
    });

    it('a phone invite with the Auth phone stored without "+" is accepted (normalized)', async () => {
      const { circle } = await ownerWithCircle();
      const dan = await createUser(client, { phone: true });
      const row = await insertMember(client, circle.id, { phone: dan.phone });
      const { reply } = await compareAccept(dan, row.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
    });

    it('the token is trimmed (spaces only)', async () => {
      const { circle } = await ownerWithCircle();
      const joiner = await createUser(client);
      const link = await insertMember(client, circle.id);
      const reply = await acceptInvite(app, joiner.id, `%20${link.token}%20`, { raw: true });
      expect(reply.statusCode).toBe(200);
    });

    it('no token: 401 accept_circle_invite:not_authenticated; a NUL in the token is 422', async () => {
      expectCode(
        await acceptInvite(app, null, fakeInviteToken()),
        401,
        'accept_circle_invite:not_authenticated',
      );
      expectCode(
        await declineInvite(app, null, fakeInviteToken()),
        401,
        'decline_circle_invite:not_authenticated',
      );
      const nul = await acceptInvite(app, randomUUID(), `${fakeInviteToken()}%00`, { raw: true });
      expectCode(nul, 422, 'validation:invalid_request');
      expect(errorOf(nul).details).toEqual({ field: 'token' });
    });

    it('accept reads the profile name through a helper only: no location_sharing, no profile write', () => {
      const source = [
        String(Object.getOwnPropertyDescriptor(InviteeInvitesService.prototype, 'accept')?.value),
        String(
          Object.getOwnPropertyDescriptor(InviteeInvitesRepository.prototype, 'acceptWrite')?.value,
        ),
      ].join('\n');
      expect(source).toMatch(/memberProfileNameSql\(/);
      expect(source).not.toMatch(/location_sharing/i);
      expect(source).not.toMatch(/public\.profiles/i);
      expect(source).not.toMatch(/activated_at/i);
    });
  });

  // --- decline -----------------------------------------------------------------------------------

  describe('decline (AC4)', () => {
    it('declines, records the user, frees the slot; a second decline is canceled', async () => {
      const { owner, circle } = await ownerWithCircle('Owner Two');
      const dan = await createUser(client, { phone: true });
      const row = await insertMember(client, circle.id, { phone: dan.phone });
      const usedBefore = await used(owner);
      const { reply } = await compareDecline(dan, row.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
      expect(reply.body).toBe(
        JSON.stringify({
          status: 'declined',
          circle_id: circle.id,
          member_id: row.id,
          owner_name: 'Owner Two',
        }),
      );
      expect(await memberRow(client, row.id)).toMatchObject({
        status: 'declined',
        user_id: dan.id,
        invite_consumed_at: null,
        activated_at: null,
        invite_token: row.token,
      });
      expect((await memberRow(client, row.id)).invite_canceled_at).not.toBeNull();
      expect(await used(owner)).toBe((usedBefore as number) - 1);
      expect((await lookupInvite(app, row.token)).json<Body>().status).toBe('canceled');
      const audit = await auditOf(row.id);
      expect(audit).toEqual([
        {
          action: 'circle.invite.declined',
          actor: dan.id,
          target_type: 'circle_member',
          detail: {
            circle_id: circle.id,
            channel: 'phone',
            previous_status: 'pending',
            user_recorded: true,
          },
        },
      ]);
      const again = await compareDecline(dan, row.token, [circle.id]);
      expectCode(again.reply, 409, 'decline_circle_invite:canceled');
    });

    it("Stage 3 [B10b] (SCRUM-28): the owner's list shows the invitee's decline as declined until a re-invite or a remove; an owner cancel is not listed", async () => {
      const { owner, circle } = await ownerWithCircle('Owner B10');
      const dan = await createUser(client, { phone: true });
      const row = await insertMember(client, circle.id, { phone: dan.phone });
      const statusOf = async (memberId: string) =>
        (await listMembers(app, owner.id, circle.id))
          .json<Body[]>()
          .find((m) => m.member_id === memberId)?.status;
      expect(await statusOf(row.id)).toBe('pending');
      expect((await declineInvite(app, dan.id, row.token)).statusCode).toBe(200);
      expect(await statusOf(row.id)).toBe('declined');
      expect((await memberRow(client, row.id)).declined_at).not.toBeNull();
      // The member view never lists it.
      // Re-invite (resend) -> pending again, declined_at cleared.
      expect((await resendInvite(app, owner.id, row.id)).statusCode).toBe(200);
      expect(await statusOf(row.id)).toBe('pending');
      expect((await memberRow(client, row.id)).declined_at).toBeNull();
      // The owner cancels the pending invite: stored declined, but not the invitee's "no": not listed.
      expect((await cancelInvite(app, owner.id, row.id)).statusCode).toBe(200);
      expect((await memberRow(client, row.id)).status).toBe('declined');
      expect(await statusOf(row.id)).toBeUndefined();

      // A second invitee declines; the owner removes the declined row: gone.
      const eve = await createUser(client, { phone: true });
      const other = await insertMember(client, circle.id, { phone: eve.phone });
      await declineInvite(app, eve.id, other.token);
      expect(await statusOf(other.id)).toBe('declined');
      expect((await removeMember(app, owner.id, circle.id, other.id)).statusCode).toBe(200);
      expect(await statusOf(other.id)).toBeUndefined();
    });

    it('errors in order', async () => {
      const { circle } = await ownerWithCircle();
      const ben = await createUser(client, { phone: true });
      const benRow = await addActiveMember(client, circle, ben);
      const dan = await createUser(client, { phone: true });
      expectCode(
        await declineInvite(app, dan.id, '%20', { raw: true }),
        404,
        'decline_circle_invite:not_found',
      );
      const states: Array<[string, () => Promise<string>, UserFixture, number, string]> = [
        ['unknown', () => Promise.resolve(fakeInviteToken()), dan, 404, 'not_found'],
        [
          'expired (410)',
          async () => (await insertExpiredMember(client, circle.id)).token,
          dan,
          410,
          'expired',
        ],
        ['consumed', () => Promise.resolve(benRow.inviteToken), dan, 409, 'consumed'],
        [
          'canceled',
          async () =>
            (await insertMember(client, circle.id, { status: 'declined', canceled: true })).token,
          dan,
          409,
          'canceled',
        ],
        [
          'not recipient',
          async () => (await insertMember(client, circle.id, { phone: dan.phone })).token,
          ben,
          403,
          'not_recipient',
        ],
      ];
      for (const [name, tokenOf, caller, status, suffix] of states) {
        const { reply, apiError } = await compareDecline(caller, await tokenOf(), [circle.id]);
        expect({ name, apiError }).toEqual({ name, apiError: `decline_circle_invite:${suffix}` });
        expect({ name, status: reply.statusCode }).toEqual({ name, status });
      }
    });

    it('no own-circle or capacity check: the owner can decline a link invite of their own circle (user not recorded: clash)', async () => {
      const { owner, circle } = await ownerWithCircle();
      const link = await insertMember(client, circle.id);
      const { reply } = await compareDecline(owner, link.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
      expect(await memberRow(client, link.id)).toMatchObject({ status: 'declined', user_id: null });
      expect((await auditOf(link.id))[0].detail).toMatchObject({ user_recorded: false });
    });

    it('an active member of the circle declining another invite: declined without the user (clash)', async () => {
      const { circle } = await ownerWithCircle();
      const ben = await createUser(client);
      await addActiveMember(client, circle, ben);
      const link = await insertMember(client, circle.id);
      const { reply } = await compareDecline(ben, link.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
      expect((await memberRow(client, link.id)).user_id).toBeNull();
    });

    it('decline in an over-full circle works (no capacity check)', async () => {
      const { circle } = await ownerWithCircle();
      const users = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(client)));
      const [, , , , , row] = await insertOverCapacity(client, circle.id, [
        ...users.map((u) => ({ status: 'active' as const, userId: u.id, consumed: true })),
        {},
      ]);
      const { reply } = await compareDecline(await createUser(client), row.token, [circle.id]);
      expect(reply.statusCode).toBe(200);
    });
  });
});
