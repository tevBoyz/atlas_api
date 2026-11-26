import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  cancelInvite,
  createInviteLink,
  errorOf,
  invitePhone,
  inviteBatch,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  type CircleFixture,
  createCircle,
  createUser,
  fakeInviteToken,
  type UserFixture,
} from '../support/fixtures';

/**
 * Concurrency of the owner invite writes (epic §4 item 6, Phase 2 intro): every write locks the
 * caller's `safety_circles` row first, then member rows, so parallel invites serialize per circle;
 * a raw insert on its own connection is guarded by the capacity trigger. Capacity never goes above
 * 5, one phone never gets a second row, and no request fails with a 5xx (outcomes are asserted, not
 * the database-wide deadlock counter, gap 32).
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof invitePhone>>;

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(500 + counter++).padStart(3, '0')}`;

describe('owner invitations under concurrency (API-100-26/27/28)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  /** A separate connection for the raw insert. */
  let rawClient: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000', DATABASE_POOL_MAX: '12' }),
    ));
    client = await openTestClient();
    rawClient = await openTestClient();
  });

  afterAll(async () => {
    await rawClient?.end();
    await client?.end();
    await app?.close();
  });

  const ownerWithCircle = async (): Promise<{ owner: UserFixture; circle: CircleFixture }> => {
    const owner = await createUser(client, { fullName: 'Race Owner' });
    return { owner, circle: await createCircle(client, owner) };
  };

  const insertRow = async (
    circle: CircleFixture,
    options: { phone?: string; expired?: boolean; name?: string } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await client.query(
      `insert into public.safety_circle_members (id, circle_id, role, status, display_name, phone,
         invite_token, invited_at, invite_expires_at)
       values ($1, $2, 'member', 'pending', $3, $4, $5,
               case when $6::boolean then now() - interval '10 days' else now() end,
               case when $6::boolean then now() - interval '3 days' else now() + interval '7 days' end)`,
      [
        id,
        circle.id,
        options.name ?? 'Filler',
        options.phone ?? null,
        fakeInviteToken(),
        options.expired ?? false,
      ],
    );
    return id;
  };
  const fill = async (circle: CircleFixture, n: number) => {
    for (let i = 0; i < n; i += 1) await insertRow(circle);
  };

  /** Slots held now (owner excluded): active + valid pending (rule 8). */
  const used = async (circle: CircleFixture) =>
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from public.safety_circle_members m
          where m.circle_id = $1 and m.role = 'member'
            and (m.status = 'active'
                 or (m.status = 'pending' and m.invite_canceled_at is null
                     and m.invite_consumed_at is null
                     and coalesce(m.invite_expires_at, m.invited_at + interval '7 days') > now()))`,
        [circle.id],
      )
    ).rows[0].n;

  const ok = (reply: Reply) => reply.statusCode === 200 || reply.statusCode === 201;
  const no5xx = (replies: Reply[]) => {
    for (const reply of replies) expect(reply.statusCode).toBeLessThan(500);
  };

  it('6 parallel invites (phone, link, batch) into 1 free slot: exactly one slot is taken, never above 5', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      await fill(circle, 4);
      const replies = await Promise.all([
        invitePhone(app, owner.id, { display_name: 'P1', phone: phoneNumber() }),
        invitePhone(app, owner.id, { display_name: 'P2', phone: phoneNumber() }),
        createInviteLink(app, owner.id, {}),
        createInviteLink(app, owner.id, { display_name: 'L2' }),
        inviteBatch(app, owner.id, {
          invites: [
            { phone: phoneNumber(), display_name: 'B1' },
            { phone: phoneNumber(), display_name: 'B2' },
          ],
        }),
        inviteBatch(app, owner.id, { invites: [{ phone: phoneNumber(), display_name: 'B3' }] }),
      ]);
      no5xx(replies);
      // Phone and link answer 201 when they insert; a batch answers 200 with its `created` list.
      const created =
        replies.filter((r) => r.statusCode === 201).length +
        replies
          .filter((r) => r.statusCode === 200)
          .reduce((n, r) => n + r.json<{ created: Body[] }>().created.length, 0);
      expect(created).toBe(1);
      for (const reply of replies) {
        if (reply.statusCode === 409) expect(errorOf(reply).code).toMatch(/:circle_full$/);
        if (reply.statusCode === 200) {
          const body = reply.json<{ created: Body[]; not_created: Body[] }>();
          for (const entry of body.not_created) expect(entry.reason).toBe('circle_full');
        }
      }
      expect(await used(circle)).toBe(5);
    }
  });

  it('resend of an expired invite racing a new invite for the last slot: exactly one wins', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      await fill(circle, 4);
      const expired = await insertRow(circle, { expired: true, name: 'Expired' });
      const replies = await Promise.all([
        resendInvite(app, owner.id, expired),
        invitePhone(app, owner.id, { display_name: 'New', phone: phoneNumber() }),
        createInviteLink(app, owner.id, {}),
      ]);
      no5xx(replies);
      expect(replies.filter(ok)).toHaveLength(1);
      for (const reply of replies.filter((r) => !ok(r))) {
        expect(reply.statusCode).toBe(409);
        expect(errorOf(reply).code).toMatch(/:circle_full$/);
      }
      expect(await used(circle)).toBe(5);
    }
  });

  it('concurrent invites for the same phone leave one row: one created, the rest refreshed', async () => {
    const { owner, circle } = await ownerWithCircle();
    const phone = phoneNumber();
    const apiReplies = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        invitePhone(app, owner.id, { display_name: `Same ${i}`, phone }),
      ),
    );
    no5xx(apiReplies);
    const rows = (
      await client.query<{ id: string }>(
        'select id::text from public.safety_circle_members where circle_id = $1 and phone = $2',
        [circle.id, phone],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const bodies = apiReplies.map((r) => r.json<Body>());
    expect(bodies.filter((b) => b.resent === false)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.member_id))).toEqual(new Set([rows[0].id]));
    expect(apiReplies.filter((r) => r.statusCode === 201).length).toBeLessThanOrEqual(1);
  });

  it('cancel racing resend on one invite: both succeed in some order, the row ends consistent', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const id = await insertRow(circle, { phone: phoneNumber(), name: 'Racy' });
      const [cancel, resend] = await Promise.all([
        cancelInvite(app, owner.id, id),
        resendInvite(app, owner.id, id),
      ]);
      no5xx([cancel, resend]);
      expect(cancel.statusCode).toBe(200);
      expect(resend.statusCode).toBe(200);
      const row = (
        await client.query<{ status: string; token: string; canceled: boolean }>(
          `select status, invite_token as token, invite_canceled_at is not null as canceled
             from public.safety_circle_members where id = $1`,
          [id],
        )
      ).rows[0];
      const resentToken = resend.json<Body>().invite_token;
      // Cancel first then resend → pending with the resent token; resend first then cancel →
      // declined, still holding the resent token.
      expect(row.token).toBe(resentToken);
      expect(
        (row.status === 'pending' && !row.canceled) || (row.status === 'declined' && row.canceled),
      ).toBe(true);
    }
  });

  it('API writers and a raw insert on one circle with 1 free slot: one wins, the trigger never lets a sixth in', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      await fill(circle, 4);
      const [apiReplies, raw] = await Promise.all([
        Promise.all([
          invitePhone(app, owner.id, { display_name: 'Api', phone: phoneNumber() }),
          createInviteLink(app, owner.id, {}),
          inviteBatch(app, owner.id, { invites: [{ phone: phoneNumber(), display_name: 'Bat' }] }),
          invitePhone(app, owner.id, { display_name: 'Api2', phone: phoneNumber() }),
          createInviteLink(app, owner.id, { display_name: 'L2' }),
        ]),
        // A raw insert as the migration role: only the capacity trigger guards it.
        insertRowOn(rawClient, circle).then(
          () => ({
            error: undefined as string | undefined,
            sqlState: undefined as string | undefined,
          }),
          (error: { message: string; code?: string }) => ({
            error: error.message,
            sqlState: error.code,
          }),
        ),
      ]);
      no5xx(apiReplies);
      const apiCreated =
        apiReplies.filter((r) => r.statusCode === 201).length +
        apiReplies
          .filter((r) => r.statusCode === 200)
          .reduce((n, r) => n + (r.json<{ created: Body[] }>().created.length ?? 0), 0);
      const rawCreated = raw.error ? 0 : 1;
      expect(apiCreated + rawCreated).toBe(1);
      if (raw.error) expect(raw.error).toMatch(/circle_full$/);
      expect(await used(circle)).toBe(5);
    }
  });

  /** A raw valid pending insert on `c` (no circle lock first: the trigger takes it). */
  async function insertRowOn(c: Client, circle: CircleFixture): Promise<void> {
    await c.query(
      `insert into public.safety_circle_members (circle_id, role, status, display_name,
         invite_token, invite_expires_at)
       values ($1, 'member', 'pending', 'Raw', $2, now() + interval '7 days')`,
      [circle.id, fakeInviteToken()],
    );
  }
});
