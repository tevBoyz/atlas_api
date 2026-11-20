import { setTimeout as sleep } from 'node:timers/promises';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { acceptInvite, createInviteLink, invitePhone, resendInvite } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createCircle, createUser, type UserFixture } from '../support/fixtures';
import { insertMember } from '../support/invite-rows';
import { completeSetup } from '../support/profile-api';

/**
 * API-100-36: the lock order of `POST /v1/me/profile/complete` (profile → circle → member rows,
 * `ProfileSetupRepository`) against the circle's other writers, through the API and through today's
 * SQL functions on their own connections.
 *
 * 1. Deterministic interleavings: a resend holds the circle row (its first lock) while setup runs.
 *    a) It then resends the emergency contact's DECLINED row: both the API and the SQL function take
 *       the circle before that row (the SQL through the capacity trigger, which fires BEFORE INSERT),
 *       so the resend finishes and setup follows.
 *    b) It then names the circle's OWNER row (resend locks it, then answers `not_invitable`). The
 *       API's setup waits for the circle before it touches any member row: no deadlock. The SQL
 *       function upserts (and so locks) the owner row first and only then waits for the circle in the
 *       contact row's capacity trigger, while the resend waits for the owner row: a deadlock (40P01),
 *       shown for contrast. The SQL function is not changed (Phase 1 / 2 practice); the hazard goes
 *       away with the switch.
 * 2. Rounds of the API's setup racing resend (API and SQL), phone invites (API and SQL), link
 *    invites and accepts (API and SQL) on the same circle: no 5xx, no 40P01, the deadlock counter of
 *    the database does not move, at most 5 slots used, exactly one active owner row.
 * 3. The API's setup and the SQL function for the same user at once: serialized on the profile row.
 */
type Body = Record<string, unknown>;

let phoneCounter = 0;
/** Fictional numbers (+44 7700 900xxx), distinct per call. */
const phoneNumber = () => `+447700900${String(100 + phoneCounter++).padStart(3, '0')}`;

describe('profile setup lock order and races (API-100-36)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let pool: Client[];

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000', RATE_LIMIT_PUBLIC_MAX: '1000000' }),
    ));
    client = await openTestClient();
    pool = await Promise.all([1, 2, 3, 4].map(() => openTestClient()));
  });

  afterAll(async () => {
    await Promise.all((pool ?? []).map((c) => c.end()));
    await client?.end();
    await app?.close();
  });

  const deadlocks = async () =>
    Number(
      (
        await client.query<{ n: string }>(
          'select deadlocks::text as n from pg_stat_database where datname = current_database()',
        )
      ).rows[0].n,
    );

  /** A SQL function as `userId` on connection `c`, committed; the error and SQLSTATE when it raises. */
  const sqlCall = async (
    c: Client,
    userId: string,
    call: string,
    params: unknown[] = [],
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

  /** An owner ready for setup, with a circle, `actives` active members and a DECLINED contact row. */
  const ownerWithDeclinedContact = async (actives: number) => {
    const owner = await createUser(client, { fullName: 'Race Setup Owner' });
    const contactPhone = phoneNumber();
    await client.query(
      `update public.profiles set emergency_contact_phone = $2, profile_setup_completed_at = null
        where id = $1`,
      [owner.id, contactPhone],
    );
    const circle = await createCircle(client, owner);
    for (let i = 0; i < actives; i++) {
      const member = await createUser(client);
      await insertMember(client, circle.id, {
        status: 'active',
        userId: member.id,
        consumed: true,
      });
    }
    const contact = await insertMember(client, circle.id, {
      phone: contactPhone,
      status: 'declined',
      canceled: true,
    });
    return { owner, circle, contactRow: contact.id };
  };

  /** Waits until some backend of this database is waiting for a row lock (at most 10 s). */
  const waitForLockWait = async (exceptPid: number) => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and pid <> $1 and wait_event_type = 'Lock'`,
        [exceptPid],
      );
      if (rows[0].n > 0) return;
      await sleep(50);
    }
    throw new Error('no backend started waiting for a lock');
  };

  const backendPid = async (c: Client) =>
    (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid;

  /**
   * The interleaving: connection R takes the circle row (as resend's `_owner_circle_for_invite`
   * does first), `setup` starts and blocks, then R runs `resend_circle_invite` of the contact row as
   * the owner and commits.
   */
  async function interleave(
    owner: UserFixture,
    circleId: string,
    resendRow: string,
    setup: () => Promise<{ status: number | string }>,
  ) {
    const [r] = pool;
    const rPid = await backendPid(r);
    await r.query('begin');
    await r.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true)`,
      [owner.id, JSON.stringify({ sub: owner.id, role: 'authenticated' })],
    );
    await r.query('select 1 from public.safety_circles where id = $1 for update', [circleId]);
    const pending = setup();
    await waitForLockWait(rPid);
    let resend: { ok: boolean; sqlState?: string };
    try {
      await r.query('select public.resend_circle_invite($1)', [resendRow]);
      await r.query('commit');
      resend = { ok: true };
    } catch (error) {
      await r.query('rollback');
      resend = { ok: false, sqlState: (error as { code?: string }).code };
    }
    return { resend, setup: await pending };
  }

  it('API setup waits for the circle a resend holds: both succeed, no deadlock', async () => {
    const { owner, circle, contactRow } = await ownerWithDeclinedContact(2);
    const before = await deadlocks();
    const { resend, setup } = await interleave(owner, circle.id, contactRow, async () => {
      const reply = await completeSetup(app, owner.id);
      return { status: reply.statusCode, body: reply.json<Body>() };
    });
    expect(resend).toEqual({ ok: true });
    expect(setup.status).toBe(200);
    expect(await deadlocks()).toBe(before);
    // The resend made the row pending with a new token; setup then kept that token (rule 6).
    const row = (
      await client.query<{ status: string }>(
        'select status from public.safety_circle_members where id = $1',
        [contactRow],
      )
    ).rows[0];
    expect(row.status).toBe('pending');
  });

  /** The circle's owner row (created by the fixture). */
  const ownerRowOf = async (circleId: string) =>
    (
      await client.query<{ id: string }>(
        `select id::text from public.safety_circle_members where circle_id = $1 and role = 'owner'`,
        [circleId],
      )
    ).rows[0].id;

  it('API setup and a resend naming the owner row (circle, then that row): no deadlock', async () => {
    const { owner, circle } = await ownerWithDeclinedContact(1);
    const ownerRow = await ownerRowOf(circle.id);
    const before = await deadlocks();
    const { resend, setup } = await interleave(owner, circle.id, ownerRow, async () => {
      const reply = await completeSetup(app, owner.id);
      return { status: reply.statusCode };
    });
    // resend_circle_invite of the owner row answers not_invitable (P0001) after locking it.
    expect(resend).toEqual({ ok: false, sqlState: 'P0001' });
    expect(setup.status).toBe(200);
    expect(await deadlocks()).toBe(before);
  });

  it('for contrast: the SQL function in the same interleaving deadlocks (40P01): it locks the owner row before the circle', async () => {
    const { owner, circle } = await ownerWithDeclinedContact(1);
    const ownerRow = await ownerRowOf(circle.id);
    const before = await deadlocks();
    const [, c] = pool;
    const { resend, setup } = await interleave(owner, circle.id, ownerRow, async () => {
      const result = await sqlCall(c, owner.id, 'public.complete_profile_setup()');
      return { status: result.sqlState ?? 'ok' };
    });
    expect([resend.sqlState, setup.status]).toContain('40P01');
    expect(await deadlocks()).toBeGreaterThan(before);
  });

  it('rounds: API setup racing resend, invites, links and accepts (API and SQL): no 5xx, no 40P01', async () => {
    const before = await deadlocks();
    for (let round = 0; round < 8; round++) {
      const { owner, circle, contactRow } = await ownerWithDeclinedContact(round % 3);
      const linkA = await insertMember(client, circle.id, { name: 'Link A' });
      const linkB = await insertMember(client, circle.id, { name: 'Link B' });
      const joinerA = await createUser(client);
      const joinerB = await createUser(client);
      const [c1, c2, c3, c4] = pool;
      const api = await Promise.all([
        completeSetup(app, owner.id),
        resendInvite(app, owner.id, contactRow),
        invitePhone(app, owner.id, { display_name: 'Api Phone', phone: phoneNumber() }),
        createInviteLink(app, owner.id, {}),
        acceptInvite(app, joinerA.id, linkA.token),
        completeSetup(app, owner.id),
        ...[
          sqlCall(c1, owner.id, 'public.resend_circle_invite($1)', [contactRow]),
          sqlCall(c2, owner.id, 'public.invite_circle_member_by_phone($1, $2)', [
            'Sql Phone',
            phoneNumber(),
          ]),
          sqlCall(c3, joinerB.id, 'public.accept_circle_invite($1)', [linkB.token]),
          sqlCall(c4, owner.id, 'public.create_circle_invite_link(null)'),
        ].map(async (p) => ({ statusCode: 0, sql: await p })),
      ]);
      for (const reply of api) {
        if ('sql' in reply) {
          const sql = reply.sql as { error?: string; sqlState?: string };
          expect({ round, sqlState: sql.sqlState ?? 'ok' }).not.toEqual({
            round,
            sqlState: '40P01',
          });
          if (sql.error) expect(sql.sqlState).toBe('P0001');
        } else {
          expect({ round, status: reply.statusCode < 500 }).toEqual({ round, status: true });
        }
      }
      expect(api[0].statusCode).toBe(200);
      const state = (
        await client.query<{ used: number; owners: number; active_owners: number }>(
          `select count(*) filter (
                    where m.role = 'member' and (m.status = 'active' or (m.status = 'pending'
                      and m.invite_canceled_at is null and m.invite_consumed_at is null
                      and coalesce(m.invite_expires_at, m.invited_at + interval '7 days') > now())))::int as used,
                  count(*) filter (where m.role = 'owner')::int as owners,
                  count(*) filter (where m.role = 'owner' and m.status = 'active'
                                     and m.activated_at is not null)::int as active_owners
             from public.safety_circle_members m where m.circle_id = $1`,
          [circle.id],
        )
      ).rows[0];
      expect(state.used).toBeLessThanOrEqual(5);
      expect(state).toMatchObject({ owners: 1, active_owners: 1 });
    }
    expect(await deadlocks()).toBe(before);
  });

  it('API setup and the SQL function for the same user at once: serialized, one circle, one contact row', async () => {
    const before = await deadlocks();
    for (let round = 0; round < 5; round++) {
      const owner = await createUser(client, { fullName: 'Twin Setup' });
      await client.query(
        `update public.profiles set emergency_contact_phone = $2, profile_setup_completed_at = null
          where id = $1`,
        [owner.id, phoneNumber()],
      );
      const [reply, sql] = await Promise.all([
        completeSetup(app, owner.id),
        sqlCall(pool[0], owner.id, 'public.complete_profile_setup()'),
      ]);
      expect(reply.statusCode).toBe(200);
      expect(sql.error).toBeUndefined();
      expect(reply.json<Body>().circle_id).toBe(sql.body?.circle_id);
      expect(reply.json<Body>().member_id).toBe(sql.body?.member_id);
      expect(reply.json<Body>().profile_setup_completed_at).toBe(
        sql.body?.profile_setup_completed_at,
      );
      const rows = (
        await client.query<{ n: number }>(
          `select count(*)::int as n from public.safety_circle_members m
             join public.safety_circles c on c.id = m.circle_id where c.owner_id = $1`,
          [owner.id],
        )
      ).rows[0].n;
      expect(rows).toBe(2);
    }
    expect(await deadlocks()).toBe(before);
  });
});
