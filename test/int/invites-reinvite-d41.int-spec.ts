import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  declineInvite,
  errorOf,
  leaveCircle,
  listMyInvites,
  previewInvite,
  removeMember,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import { submitAlert } from '../support/incident-api';
import { insertExpiredMember, insertMember, memberRow } from '../support/invite-rows';

/**
 * D41 (gap 7; approved by Dawit 2026-11-21): a new invite of a person to a circle works after an
 * earlier invite of the same person to that circle FINISHED (declined, canceled after the person
 * had claimed it, or expired while claimed). Before the preview claim and the accept write, the API
 * releases the caller's finished rows of that circle (`user_id = null`, everything else kept as
 * history) in the same transaction, the circle locked first (D18 order). Live rows are untouched:
 * an `active` row → `already_member`, a still-valid pending row claimed by the caller →
 * `duplicate_membership`, as before. The owner row is never touched.

 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof previewInvite>>;

const ROUNDS = 10;

describe('re-invite after a finished invite (D41)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
        DATABASE_POOL_MAX: '16',
      }),
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
  const ownerWithCircle = async (): Promise<Owned> => {
    const owner = await createUser(client, { fullName: 'Reinvite Owner', phone: true });
    return { owner, circle: await createCircle(client, owner) };
  };
  const newLink = async (owner: UserFixture) => {
    const reply = await createInviteLink(app, owner.id, { display_name: 'Invited Friend' });
    expect(reply.statusCode).toBe(201);
    const body = reply.json<Body>();
    return { id: body.member_id as string, token: body.invite_token as string };
  };
  const codeOf = (reply: Reply) => (reply.statusCode >= 400 ? errorOf(reply).code : 'ok');
  const rowsOf = async (circleId: string, userId: string) =>
    (
      await client.query<Body>(
        `select id::text as id, status, role from public.safety_circle_members
          where circle_id = $1 and user_id = $2 order by id`,
        [circleId, userId],
      )
    ).rows;
  /** The row without `user_id` / `updated_at`: what D41 must keep as history. */
  const history = (row: Body) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => key !== 'user_id' && key !== 'updated_at'),
    );

  /** Released: same history, `user_id` null, `updated_at` moved. */
  const expectReleased = async (id: string, before: Body) => {
    const after = await memberRow(client, id);
    expect(after.user_id).toBeNull();
    expect(history(after)).toEqual(history(before));
    expect(new Date(after.updated_at as string).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updated_at as string).getTime(),
    );
  };

  describe('finished rows are released, then the new invite is claimed and accepted', () => {
    it('decline → new link → preview 200 → accept 200 (all through the API)', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ownerRowBefore = await memberRow(client, circle.ownerMemberId);
      const dan = await createUser(client, { fullName: 'Dan Decliner' });

      const first = await newLink(owner);
      expect((await previewInvite(app, dan.id, first.token)).statusCode).toBe(200);
      const declined = await declineInvite(app, dan.id, first.token);
      expect(declined.statusCode).toBe(200);
      const declinedRow = await memberRow(client, first.id);
      expect(declinedRow).toMatchObject({ status: 'declined', user_id: dan.id });

      const second = await newLink(owner);
      const preview = await previewInvite(app, dan.id, second.token);
      expect(preview.statusCode).toBe(200);
      expect(preview.json<Body>()).toMatchObject({
        status: 'pending',
        claimed: true,
        member_id: second.id,
      });
      await expectReleased(first.id, declinedRow);
      expect((await memberRow(client, second.id)).user_id).toBe(dan.id);

      const accept = await acceptInvite(app, dan.id, second.token);
      expect(accept.statusCode).toBe(200);
      expect(accept.json<Body>()).toMatchObject({ status: 'active', member_id: second.id });
      expect(await rowsOf(circle.id, dan.id)).toEqual([
        { id: second.id, status: 'active', role: 'member' },
      ]);
      expect(await memberRow(client, first.id)).toMatchObject({
        status: 'declined',
        user_id: null,
      });
      expect(await memberRow(client, circle.ownerMemberId)).toEqual(ownerRowBefore);
    });

    it('decline → new link → accept directly (no preview) 200; the audit records the release', async () => {
      const { owner, circle } = await ownerWithCircle();
      const dan = await createUser(client);
      const old = await insertMember(client, circle.id, {
        status: 'declined',
        canceled: true,
        userId: dan.id,
      });
      const before = await memberRow(client, old.id);
      const link = await newLink(owner);
      const accept = await acceptInvite(app, dan.id, link.token);
      expect(accept.statusCode).toBe(200);
      await expectReleased(old.id, before);
      const audit = (
        await client.query<{ detail: Body }>(
          `select detail from public.audit_log
            where target_id = $1 and action = 'circle.invite.accepted'`,
          [link.id],
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].detail).toMatchObject({ released_finished_rows: 1 });
    });

    it('cancel after preview → new link → preview 200 → accept 200', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ownerRowBefore = await memberRow(client, circle.ownerMemberId);
      const dan = await createUser(client);
      const first = await newLink(owner);
      expect((await previewInvite(app, dan.id, first.token)).statusCode).toBe(200);
      expect((await cancelInvite(app, owner.id, first.id)).statusCode).toBe(200);
      const canceledRow = await memberRow(client, first.id);
      expect(canceledRow.user_id).toBe(dan.id);
      expect(canceledRow.invite_canceled_at).not.toBeNull();

      const second = await newLink(owner);
      expect((await previewInvite(app, dan.id, second.token)).statusCode).toBe(200);
      await expectReleased(first.id, canceledRow);
      expect((await acceptInvite(app, dan.id, second.token)).statusCode).toBe(200);
      expect(await rowsOf(circle.id, dan.id)).toEqual([
        { id: second.id, status: 'active', role: 'member' },
      ]);
      expect(await memberRow(client, circle.ownerMemberId)).toEqual(ownerRowBefore);
    });

    it('an expired pending row claimed by the caller → new link → preview 200 → accept 200', async () => {
      const { owner, circle } = await ownerWithCircle();
      const dan = await createUser(client);
      const old = await insertExpiredMember(client, circle.id, { userId: dan.id });
      const before = await memberRow(client, old.id);
      const link = await newLink(owner);
      expect((await previewInvite(app, dan.id, link.token)).statusCode).toBe(200);
      await expectReleased(old.id, before);
      expect((await memberRow(client, old.id)).status).toBe('pending');
      expect((await acceptInvite(app, dan.id, link.token)).statusCode).toBe(200);
      expect(await rowsOf(circle.id, dan.id)).toEqual([
        { id: link.id, status: 'active', role: 'member' },
      ]);
    });

    it('a canceled expired row is released; history rows without a user are never written', async () => {
      const { owner, circle } = await ownerWithCircle();
      const dan = await createUser(client);
      const old = await insertExpiredMember(client, circle.id, { userId: dan.id, canceled: true });
      const oldBefore = await memberRow(client, old.id);
      const earlier = await insertMember(client, circle.id, { status: 'declined', canceled: true });
      const earlierBefore = await memberRow(client, earlier.id);
      const link = await newLink(owner);
      expect((await acceptInvite(app, dan.id, link.token)).statusCode).toBe(200);
      await expectReleased(old.id, oldBefore);
      expect(await memberRow(client, earlier.id)).toEqual(earlierBefore);
    });
  });

  describe('live rows are untouched (unchanged answers)', () => {
    it('an active member: preview already_member, accept 409 already_member, nothing written', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client);
      const active = await addActiveMember(client, circle, ben);
      const activeBefore = await memberRow(client, active.id);
      const link = await newLink(owner);
      const linkBefore = await memberRow(client, link.id);
      const preview = await previewInvite(app, ben.id, link.token);
      expect(preview.statusCode).toBe(200);
      expect(preview.json<Body>().status).toBe('already_member');
      const accept = await acceptInvite(app, ben.id, link.token);
      expect(codeOf(accept)).toBe('accept_circle_invite:already_member');
      expect(await memberRow(client, active.id)).toEqual(activeBefore);
      expect(await memberRow(client, link.id)).toEqual(linkBefore);
    });

    it('two live invites: preview and accept stay 409 duplicate_membership', async () => {
      const { owner } = await ownerWithCircle();
      const dan = await createUser(client);
      const live = await newLink(owner);
      expect((await previewInvite(app, dan.id, live.token)).statusCode).toBe(200);
      const liveBefore = await memberRow(client, live.id);
      const second = await newLink(owner);
      const secondBefore = await memberRow(client, second.id);

      expect(codeOf(await previewInvite(app, dan.id, second.token))).toBe(
        'preview_circle_invite:duplicate_membership',
      );
      expect(codeOf(await acceptInvite(app, dan.id, second.token))).toBe(
        'accept_circle_invite:duplicate_membership',
      );
      expect(await memberRow(client, live.id)).toEqual(liveBefore);
      expect(await memberRow(client, second.id)).toEqual(secondBefore);
    });

    it('the owner row is never released: the owner previewing / accepting their own invite', async () => {
      const { owner, circle } = await ownerWithCircle();
      const ownerRowBefore = await memberRow(client, circle.ownerMemberId);
      const link = await newLink(owner);
      expect((await previewInvite(app, owner.id, link.token)).json<Body>().status).toBe(
        'own_circle',
      );
      expect(codeOf(await acceptInvite(app, owner.id, link.token))).toBe(
        'accept_circle_invite:own_circle',
      );
      expect(await memberRow(client, circle.ownerMemberId)).toEqual(ownerRowBefore);
      expect((await memberRow(client, link.id)).user_id).toBeNull();
    });

    it('rows of another circle are never released', async () => {
      const a = await ownerWithCircle();
      const b = await ownerWithCircle();
      const dan = await createUser(client);
      const elsewhere = await insertMember(client, b.circle.id, {
        status: 'declined',
        canceled: true,
        userId: dan.id,
      });
      const before = await memberRow(client, elsewhere.id);
      const link = await newLink(a.owner);
      expect((await acceptInvite(app, dan.id, link.token)).statusCode).toBe(200);
      expect(await memberRow(client, elsewhere.id)).toEqual(before);
    });
  });

  // --- races ---------------------------------------------------------------------------------------

  const no5xx = (replies: Reply[]) => {
    for (const reply of replies) {
      if (reply.statusCode >= 500) throw new Error(`${reply.statusCode} ${reply.body}`);
    }
  };
  /** At most one row of the circle holds the user, and at most one is active. */
  const expectConsistent = async (circleId: string, userId: string) => {
    const rows = await rowsOf(circleId, userId);
    expect(rows.length).toBeLessThanOrEqual(1);
    return rows;
  };

  it('race: two new invites previewed and accepted at once after a decline, with an owner cancel and remove (no 5xx, one outcome)', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const ownerRowBefore = await memberRow(client, circle.ownerMemberId);
      const dan = await createUser(client);
      const old = await insertMember(client, circle.id, {
        status: 'declined',
        canceled: true,
        userId: dan.id,
      });
      const l1 = await newLink(owner);
      const l2 = await newLink(owner);

      const replies = await Promise.all([
        previewInvite(app, dan.id, l1.token),
        previewInvite(app, dan.id, l2.token),
        acceptInvite(app, dan.id, l1.token),
        acceptInvite(app, dan.id, l2.token),
        round % 2 === 0
          ? cancelInvite(app, owner.id, l2.id)
          : removeMember(app, owner.id, circle.id, old.id),
      ]);
      no5xx(replies);
      const [p1, p2, a1, a2] = replies;
      for (const p of [p1, p2]) {
        expect(['ok', 'preview_circle_invite:duplicate_membership']).toContain(codeOf(p));
      }
      const acceptCodes = [a1, a2].map(codeOf);
      for (const code of acceptCodes) {
        expect([
          'ok',
          'accept_circle_invite:duplicate_membership',
          'accept_circle_invite:already_member',
          'accept_circle_invite:canceled',
        ]).toContain(code);
      }
      // At most one accept wins (both lose only when L2 was claimed by the preview, so L1 clashes
      // with that live row, and the owner then canceled L2 before its accept).
      const winners = [a1, a2].filter((a) => codeOf(a) === 'ok');
      expect(winners.length).toBeLessThanOrEqual(1);
      const rows = await expectConsistent(circle.id, dan.id);
      if (winners.length === 1) {
        expect(rows).toEqual([
          { id: winners[0].json<Body>().member_id, status: 'active', role: 'member' },
        ]);
      } else {
        expect(acceptCodes).toContain('accept_circle_invite:canceled');
      }
      // The old row is released (or removed by the owner), never left holding Dan.
      const oldRow = await memberRow(client, old.id);
      if (oldRow) expect(oldRow).toMatchObject({ status: 'declined', user_id: null });
      expect(await memberRow(client, circle.ownerMemberId)).toEqual(ownerRowBefore);
    }
  });

  it('race: preview/accept mixed with the incoming-list claim and a cancel (phone invite, expired claimed row): no 5xx', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const dan = await createUser(client, { phone: true });
      // An expired claimed link row (stored `pending`: the incoming-list claim loop locks it too),
      // then a phone invite (unclaimed, matched by phone: the loop locks it as well) and a link.
      const old = await insertExpiredMember(client, circle.id, { userId: dan.id });
      const phoneRow = await insertMember(client, circle.id, { phone: dan.phone });
      const link = await newLink(owner);

      const apiReplies = await Promise.all([
        previewInvite(app, dan.id, phoneRow.token),
        acceptInvite(app, dan.id, link.token),
        listMyInvites(app, dan.id),
        acceptInvite(app, dan.id, phoneRow.token),
        listMyInvites(app, dan.id),
        previewInvite(app, dan.id, link.token),
        cancelInvite(app, owner.id, old.id),
      ]);
      no5xx(apiReplies);
      const rows = await expectConsistent(circle.id, dan.id);
      // At most one active row of Dan; any row holding Dan is live (never a finished one next to it).
      expect(rows.filter((r) => r.status === 'active').length).toBeLessThanOrEqual(1);
    }
  });
  it('race: re-invite after a decline against decline, leave, SOS submit and a second accept (no 5xx)', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client);
      await addActiveMember(client, circle, ben);
      const dan = await createUser(client);
      const old = await insertMember(client, circle.id, {
        status: 'declined',
        canceled: true,
        userId: dan.id,
      });
      const l1 = await newLink(owner);
      const l2 = await newLink(owner);
      const l3 = await newLink(owner);

      const apiReplies = await Promise.all([
        previewInvite(app, dan.id, l1.token),
        acceptInvite(app, dan.id, l1.token),
        declineInvite(app, dan.id, l2.token),
        acceptInvite(app, dan.id, l3.token),
        leaveCircle(app, ben.id, circle.id),
        submitAlert(app, owner.id, 'medical'),
        removeMember(app, owner.id, circle.id, old.id),
        acceptInvite(app, dan.id, l2.token),
        declineInvite(app, dan.id, l3.token),
      ]);
      no5xx(apiReplies);
      const rows = await expectConsistent(circle.id, dan.id);
      expect(rows.filter((r) => r.status === 'active').length).toBeLessThanOrEqual(1);
    }
  });
});
