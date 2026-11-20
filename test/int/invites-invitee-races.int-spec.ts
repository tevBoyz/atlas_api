import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  declineInvite,
  errorOf,
  invitePhone,
  previewInvite,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import { markSafe, renotifyAlert, submitAlert } from '../support/incident-api';
import { insertMember, insertOverCapacity, memberRow } from '../support/invite-rows';

/**
 * Concurrency of the invitee writes (API-100-29/30; epic §4 item 6, Phase 2 intro). Accept locks
 * the token's `safety_circles` row first, then the member row (the order of the owner invite
 * writes); preview and decline lock the member row only, as the SQL. API requests run on the app's
 * pool, SQL functions each on their own connection. Every race ends in one consistent outcome, with
 * no 5xx and no deadlock (40P01): a deadlock would surface as a 500 on the API side and as SQLSTATE
 * 40P01 on the SQL side, and the database's deadlock counter must not move.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof acceptInvite>>;

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(700 + counter++).padStart(3, '0')}`;

describe('invitee writes under concurrency (API-100-29/30)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let sqlClients: Client[];

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
    sqlClients = await Promise.all(Array.from({ length: 4 }, () => openTestClient()));
  });

  afterAll(async () => {
    await Promise.all((sqlClients ?? []).map((c) => c.end()));
    await client?.end();
    await app?.close();
  });

  const ownerWithCircle = async (): Promise<{ owner: UserFixture; circle: CircleFixture }> => {
    const owner = await createUser(client, { fullName: 'Race Owner' });
    return { owner, circle: await createCircle(client, owner) };
  };

  const deadlocks = async () =>
    Number(
      (
        await client.query<{ n: string }>(
          'select deadlocks::text as n from pg_stat_database where datname = current_database()',
        )
      ).rows[0].n,
    );

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

  /** A SQL function as `userId` on its own connection; the error and SQLSTATE when it raises. */
  const sqlCall = async (
    c: Client,
    userId: string,
    call: string,
    params: unknown[],
  ): Promise<{ body?: Body; error?: string; sqlState?: string }> => {
    await c.query('begin');
    try {
      await c.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true),
                set_config('TimeZone', 'UTC', true)`,
        [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
      );
      const { rows } = await c.query<{ body: Body }>(`select ${call} as body`, params);
      await c.query('commit');
      return { body: rows[0].body };
    } catch (error) {
      await c.query('rollback');
      return { error: (error as Error).message, sqlState: (error as { code?: string }).code };
    }
  };

  const no5xx = (replies: Reply[]) => {
    for (const reply of replies) expect(reply.statusCode).toBeLessThan(500);
  };
  const noSqlDeadlock = (results: Array<{ sqlState?: string; error?: string }>) => {
    for (const result of results) {
      expect(result.sqlState).not.toBe('40P01');
      if (result.error) expect(result.sqlState).toBe('P0001');
    }
  };

  it('two different invitees accept the same link at once (API, and API vs SQL): exactly one joins', async () => {
    for (let round = 0; round < 4; round += 1) {
      const { circle } = await ownerWithCircle();
      const link = await insertMember(client, circle.id);
      const [ada, bea] = [await createUser(client), await createUser(client)];
      const before = await deadlocks();
      let winners: string[];
      if (round % 2 === 0) {
        const replies = await Promise.all([
          acceptInvite(app, ada.id, link.token),
          acceptInvite(app, bea.id, link.token),
        ]);
        no5xx(replies);
        expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(errorOf(replies.find((r) => r.statusCode === 409)!).code).toBe(
          'accept_circle_invite:consumed',
        );
        winners = [ada, bea].filter((_, i) => replies[i].statusCode === 200).map((u) => u.id);
      } else {
        const [reply, viaSql] = await Promise.all([
          acceptInvite(app, ada.id, link.token),
          sqlCall(sqlClients[0], bea.id, 'public.accept_circle_invite($1)', [link.token]),
        ]);
        no5xx([reply]);
        noSqlDeadlock([viaSql]);
        const apiWon = reply.statusCode === 200;
        expect(apiWon).toBe(viaSql.error !== undefined);
        if (apiWon) expect(viaSql.error).toMatch('accept_circle_invite:consumed');
        else expect(errorOf(reply).code).toBe('accept_circle_invite:consumed');
        winners = [apiWon ? ada.id : bea.id];
      }
      expect(winners).toHaveLength(1);
      expect(await memberRow(client, link.id)).toMatchObject({
        status: 'active',
        user_id: winners[0],
      });
      expect(await deadlocks()).toBe(before);
    }
  });

  it('the same invitee accepts several times at once (API and SQL): all 200 with one body, one write', async () => {
    const { circle } = await ownerWithCircle();
    const joiner = await createUser(client);
    const link = await insertMember(client, circle.id);
    const before = await deadlocks();
    const [replies, sqlResults] = await Promise.all([
      Promise.all([1, 2, 3].map(() => acceptInvite(app, joiner.id, link.token))),
      Promise.all(
        sqlClients
          .slice(0, 2)
          .map((c) => sqlCall(c, joiner.id, 'public.accept_circle_invite($1)', [link.token])),
      ),
    ]);
    no5xx(replies);
    noSqlDeadlock(sqlResults);
    for (const reply of replies) expect(reply.statusCode).toBe(200);
    const bodies = new Set([
      ...replies.map((r) => r.body),
      ...sqlResults.map((r) => JSON.stringify(r.body)),
    ]);
    expect(bodies.size).toBe(1);
    const accepted = await client.query(
      `select 1 from public.audit_log where target_id = $1 and action = 'circle.invite.accepted'`,
      [link.id],
    );
    // One write: by the API (one audit row) or by the SQL function (none).
    expect(accepted.rowCount).toBeLessThanOrEqual(1);
    expect(await memberRow(client, link.id)).toMatchObject({
      status: 'active',
      user_id: joiner.id,
    });
    expect(await deadlocks()).toBe(before);
  });

  it('accepts of different rows at 5/5 all join (each pending slot becomes active); over 5 none does', async () => {
    const { owner, circle } = await ownerWithCircle();
    for (const u of await Promise.all([1, 2, 3].map(() => createUser(client)))) {
      await addActiveMember(client, circle, u);
    }
    const rows = [await insertMember(client, circle.id), await insertMember(client, circle.id)];
    const users = [await createUser(client), await createUser(client)];
    const replies = await Promise.all(rows.map((r, i) => acceptInvite(app, users[i].id, r.token)));
    no5xx(replies);
    expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await used(circle)).toBe(5);

    // A circle already over 5 (legacy rows): every parallel accept is circle_full, no write.
    const over = await ownerWithCircle();
    const actives = await Promise.all([1, 2, 3, 4, 5].map(() => createUser(client)));
    const created = await insertOverCapacity(client, over.circle.id, [
      ...actives.map((u) => ({ status: 'active' as const, userId: u.id, consumed: true })),
      {},
      {},
    ]);
    const pending = created.slice(5);
    const callers = [await createUser(client), await createUser(client)];
    const [r1, r2, viaSql] = await Promise.all([
      acceptInvite(app, callers[0].id, pending[0].token),
      acceptInvite(app, callers[1].id, pending[1].token),
      sqlCall(sqlClients[0], callers[1].id, 'public.accept_circle_invite($1)', [pending[1].token]),
    ]);
    no5xx([r1, r2]);
    noSqlDeadlock([viaSql]);
    expect([errorOf(r1).code, errorOf(r2).code]).toEqual([
      'accept_circle_invite:circle_full',
      'accept_circle_invite:circle_full',
    ]);
    expect(viaSql.error).toMatch('accept_circle_invite:circle_full');
    for (const row of pending) {
      expect(await memberRow(client, row.id)).toMatchObject({ status: 'pending', user_id: null });
    }
    void owner;
  });

  it('accept racing the owner’s cancel of the same row: one of them wins, never both', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const joiner = await createUser(client);
      const link = await insertMember(client, circle.id);
      const before = await deadlocks();
      const [accept, cancel] = await Promise.all([
        acceptInvite(app, joiner.id, link.token),
        cancelInvite(app, owner.id, link.id),
      ]);
      no5xx([accept, cancel]);
      const row = await memberRow(client, link.id);
      if (accept.statusCode === 200) {
        expect(cancel.statusCode).toBe(409);
        expect(errorOf(cancel).code).toBe('cancel_circle_invite:not_pending');
        expect(row.status).toBe('active');
      } else {
        expect(cancel.statusCode).toBe(200);
        expect(errorOf(accept).code).toBe('accept_circle_invite:canceled');
        expect(row).toMatchObject({ status: 'declined', user_id: null, activated_at: null });
      }
      expect(await deadlocks()).toBe(before);
    }
  });

  it('accept racing the owner’s resend of the same row: accepted (resend already_active) or rotated (accept not_found)', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const dan = await createUser(client, { phone: phoneNumber() });
      const row = await insertMember(client, circle.id, { phone: dan.phone });
      const [accept, resend] = await Promise.all([
        acceptInvite(app, dan.id, row.token),
        resendInvite(app, owner.id, row.id),
      ]);
      no5xx([accept, resend]);
      const stored = await memberRow(client, row.id);
      if (accept.statusCode === 200) {
        expect(errorOf(resend).code).toBe('resend_circle_invite:already_active');
        expect(stored).toMatchObject({ status: 'active', invite_token: row.token });
      } else {
        expect(resend.statusCode).toBe(200);
        expect(errorOf(accept).code).toBe('accept_circle_invite:not_found');
        expect(stored.status).toBe('pending');
        expect(stored.invite_token).not.toBe(row.token);
      }
    }
  });

  it('two users preview the same link at once: exactly one claims it', async () => {
    for (let round = 0; round < 6; round += 1) {
      const { circle } = await ownerWithCircle();
      const link = await insertMember(client, circle.id);
      const users = [await createUser(client), await createUser(client)];
      const replies =
        round % 2 === 0
          ? await Promise.all(users.map((u) => previewInvite(app, u.id, link.token)))
          : null;
      let claimedBy: string[];
      if (replies) {
        no5xx(replies);
        const bodies = replies.map((r) => r.json<Body>());
        claimedBy = users.filter((_, i) => bodies[i].claimed === true).map((u) => u.id);
        for (const [i, body] of bodies.entries()) {
          if (body.claimed === true) {
            expect(body).toMatchObject({ status: 'pending', recipient_ok: true });
          } else {
            expect(body).toMatchObject({ status: 'pending', recipient_ok: false, member_id: null });
          }
          void i;
        }
      } else {
        const [reply, viaSql] = await Promise.all([
          previewInvite(app, users[0].id, link.token),
          sqlCall(sqlClients[1], users[1].id, 'public.preview_circle_invite($1)', [link.token]),
        ]);
        no5xx([reply]);
        noSqlDeadlock([viaSql]);
        claimedBy = [
          ...(reply.json<Body>().claimed === true ? [users[0].id] : []),
          ...(viaSql.body?.claimed === true ? [users[1].id] : []),
        ];
      }
      expect(claimedBy).toHaveLength(1);
      expect((await memberRow(client, link.id)).user_id).toBe(claimedBy[0]);
    }
  });

  it('accept and decline mixed with SOS submit, re-notify, mark safe and the owner’s invite writes: no 5xx, no deadlock', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { owner, circle } = await ownerWithCircle();
      const ben = await createUser(client);
      const benRow = await addActiveMember(client, circle, ben);
      const links = [await insertMember(client, circle.id), await insertMember(client, circle.id)];
      const toCancel = await insertMember(client, circle.id);
      const toDecline = await insertMember(client, circle.id);
      const joiners = [await createUser(client), await createUser(client)];
      const decliner = await createUser(client);
      const before = await deadlocks();

      const submitted = await submitAlert(app, owner.id, 'medical');
      expect(submitted.statusCode).toBe(201);
      const incidentId = submitted.json<Body>().id as string;

      const [replies, sqlResults] = await Promise.all([
        Promise.all([
          acceptInvite(app, joiners[0].id, links[0].token),
          acceptInvite(app, ben.id, benRow.inviteToken), // idempotent: active row of the caller
          declineInvite(app, decliner.id, toDecline.token),
          previewInvite(app, joiners[1].id, links[1].token),
          submitAlert(app, owner.id, 'medical'), // re-notify of the open alert
          renotifyAlert(app, owner.id, incidentId),
          cancelInvite(app, owner.id, toCancel.id),
          createInviteLink(app, owner.id, {}),
          invitePhone(app, owner.id, { display_name: 'Racer', phone: phoneNumber() }),
          markSafe(app, owner.id, incidentId),
        ]),
        Promise.all([
          sqlCall(sqlClients[0], joiners[1].id, 'public.accept_circle_invite($1)', [
            links[1].token,
          ]),
          sqlCall(sqlClients[1], owner.id, 'public.renotify_emergency_alert($1)', [incidentId]),
          sqlCall(sqlClients[2], ben.id, 'public.accept_circle_invite($1)', [benRow.inviteToken]),
        ]),
      ]);
      no5xx(replies);
      noSqlDeadlock(sqlResults);
      expect(replies[0].statusCode).toBe(200);
      expect(replies[1].statusCode).toBe(200);
      expect(replies[2].statusCode).toBe(200);
      expect(await used(circle)).toBeLessThanOrEqual(5);
      expect(await memberRow(client, links[0].id)).toMatchObject({ status: 'active' });
      expect(await deadlocks()).toBe(before);
    }
  });
});
