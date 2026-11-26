import { setTimeout as sleep } from 'node:timers/promises';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { acceptInvite, createInviteLink, invitePhone, resendInvite } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createCircle, createUser } from '../support/fixtures';
import { insertMember } from '../support/invite-rows';
import { completeSetup } from '../support/profile-api';

/**
 * API-100-36: the lock order of `POST /v1/me/profile/complete` (profile → circle → member rows,
 * `ProfileSetupRepository`) against the circle's other writers.
 *
 * 1. Deterministic interleavings: another transaction holds the circle row (the first lock of every
 *    circle writer, e.g. a resend) while setup runs, then locks and writes a member row and commits.
 *    a) The emergency contact's DECLINED row: the writer finishes and setup follows.
 *    b) The circle's OWNER row: the API's setup waits for the circle before it touches any member
 *       row, so there is no deadlock.
 * 2. Rounds of the API's setup racing resends, phone invites, link invites and accepts on the same
 *    circle: no 5xx, at most 5 slots used, exactly one active owner row.
 * 3. Two setups for the same user at once: serialized on the profile row.
 *
 * Outcomes are asserted (both requests finish, one circle, no 5xx), never the database-wide
 * deadlock counter, which other test files move too (gap 32).
 */
type Body = Record<string, unknown>;

let phoneCounter = 0;
/** Fictional numbers (+44 7700 900xxx), distinct per call. */
const phoneNumber = () => `+447700900${String(100 + phoneCounter++).padStart(3, '0')}`;

describe('profile setup lock order and races (API-100-36)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let holder: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000', RATE_LIMIT_PUBLIC_MAX: '1000000' }),
    ));
    client = await openTestClient();
    holder = await openTestClient();
  });

  afterAll(async () => {
    await holder?.end();
    await client?.end();
    await app?.close();
  });

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
   * The interleaving: connection R takes the circle row (every circle writer's first lock), `setup`
   * starts and blocks, then R locks and writes the member row `rowId` and commits.
   */
  async function interleave(
    circleId: string,
    rowId: string,
    setup: () => Promise<{ status: number }>,
  ) {
    const r = holder;
    const rPid = await backendPid(r);
    await r.query('begin');
    await r.query('select 1 from public.safety_circles where id = $1 for update', [circleId]);
    const pending = setup();
    await waitForLockWait(rPid);
    let writer: { ok: boolean; sqlState?: string };
    try {
      await r.query('select 1 from public.safety_circle_members where id = $1 for update', [rowId]);
      await r.query('update public.safety_circle_members set updated_at = now() where id = $1', [
        rowId,
      ]);
      await r.query('commit');
      writer = { ok: true };
    } catch (error) {
      await r.query('rollback');
      writer = { ok: false, sqlState: (error as { code?: string }).code };
    }
    return { writer, setup: await pending };
  }

  it('API setup waits for the circle another writer holds: both succeed', async () => {
    const { owner, circle, contactRow } = await ownerWithDeclinedContact(2);
    const { writer, setup } = await interleave(circle.id, contactRow, async () => {
      const reply = await completeSetup(app, owner.id);
      return { status: reply.statusCode };
    });
    expect(writer).toEqual({ ok: true });
    expect(setup.status).toBe(200);
    // Setup then made the declined contact row a usable invite again (rule 6).
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

  it('API setup and a writer of the owner row (circle, then that row): both finish, no deadlock', async () => {
    const { owner, circle } = await ownerWithDeclinedContact(1);
    const ownerRow = await ownerRowOf(circle.id);
    const { writer, setup } = await interleave(circle.id, ownerRow, async () => {
      const reply = await completeSetup(app, owner.id);
      return { status: reply.statusCode };
    });
    expect(writer).toEqual({ ok: true });
    expect(setup.status).toBe(200);
  });

  it('rounds: API setup racing resends, invites, links and accepts: no 5xx', async () => {
    for (let round = 0; round < 8; round++) {
      const { owner, circle, contactRow } = await ownerWithDeclinedContact(round % 3);
      const linkA = await insertMember(client, circle.id, { name: 'Link A' });
      const linkB = await insertMember(client, circle.id, { name: 'Link B' });
      const joinerA = await createUser(client);
      const joinerB = await createUser(client);
      const api = await Promise.all([
        completeSetup(app, owner.id),
        resendInvite(app, owner.id, contactRow),
        invitePhone(app, owner.id, { display_name: 'Api Phone', phone: phoneNumber() }),
        createInviteLink(app, owner.id, {}),
        acceptInvite(app, joinerA.id, linkA.token),
        completeSetup(app, owner.id),
        resendInvite(app, owner.id, contactRow),
        invitePhone(app, owner.id, { display_name: 'Second Phone', phone: phoneNumber() }),
        acceptInvite(app, joinerB.id, linkB.token),
        createInviteLink(app, owner.id, {}),
      ]);
      for (const reply of api) {
        expect({ round, status: reply.statusCode < 500 }).toEqual({ round, status: true });
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
  });

  it('two setups for the same user at once: serialized, one circle, one contact row', async () => {
    for (let round = 0; round < 5; round++) {
      const owner = await createUser(client, { fullName: 'Twin Setup' });
      await client.query(
        `update public.profiles set emergency_contact_phone = $2, profile_setup_completed_at = null
          where id = $1`,
        [owner.id, phoneNumber()],
      );
      const [reply, twin] = await Promise.all([
        completeSetup(app, owner.id),
        completeSetup(app, owner.id),
      ]);
      expect([reply.statusCode, twin.statusCode]).toEqual([200, 200]);
      expect(reply.json<Body>().circle_id).toBe(twin.json<Body>().circle_id);
      expect(reply.json<Body>().member_id).toBe(twin.json<Body>().member_id);
      expect(reply.json<Body>().profile_setup_completed_at).toBe(
        twin.json<Body>().profile_setup_completed_at,
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
  });
});
