import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  errorOf,
  leaveCircle,
  listMyInvites,
  removeMember,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import { acknowledgeIncident, markSafe, renotifyAlert, submitAlert } from '../support/incident-api';
import { expectMembershipGone, insertMember, memberRow } from '../support/invite-rows';

/**
 * Concurrency of remove and leave (API-100-32) and of the incoming-list claim (API-100-31) against
 * the writes they can meet on the same rows: acknowledge (locks the caller's delivery row, which the
 * delete cascades to), mark safe, submit and re-notify (incident and delivery rows), and the invite
 * writes (circle row, then member row). Every race ends in one consistent outcome with no 5xx (a
 * deadlock would surface as a 500). Outcomes are asserted, not the database-wide deadlock counter,
 * which other test files move too (gap 32).
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof removeMember>>;

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(500 + counter++).padStart(3, '0')}`;

const ROUNDS = 6;

describe('remove, leave and the incoming-list claim under concurrency (API-100-31/32)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp(
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

  interface Setup {
    owner: UserFixture;
    circle: CircleFixture;
    ben: UserFixture;
    benRow: MemberFixture;
  }
  const circleWithBen = async (): Promise<Setup> => {
    const owner = await createUser(client, { fullName: 'Race Owner' });
    const circle = await createCircle(client, owner);
    const ben = await createUser(client, { fullName: 'Race Ben' });
    const benRow = await addActiveMember(client, circle, ben);
    await addActiveMember(client, circle, await createUser(client));
    return { owner, circle, ben, benRow };
  };

  const no5xx = (replies: Reply[]) => {
    for (const reply of replies) {
      if (reply.statusCode >= 500) throw new Error(`${reply.statusCode} ${reply.body}`);
    }
  };
  const codeOf = (reply: Reply) => (reply.statusCode >= 400 ? errorOf(reply).code : 'ok');

  /** The owner's SOS with deliveries to the circle's active members (incident id). */
  const sos = async (owner: UserFixture) => {
    const reply = await submitAlert(app, owner.id, 'medical');
    expect(reply.statusCode).toBe(201);
    return reply.json<Body>().id as string;
  };

  it('remove racing the member’s acknowledge: one consistent outcome, no 5xx', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle, ben, benRow } = await circleWithBen();
      const incident = await sos(owner);
      const [removed, acked] = await Promise.all([
        removeMember(app, owner.id, circle.id, benRow.id),
        acknowledgeIncident(app, ben.id, incident),
      ]);
      no5xx([removed, acked]);
      expect(removed.statusCode).toBe(200);
      expect(['ok', 'acknowledge_incident:not_found']).toContain(codeOf(acked));
      await expectMembershipGone(client, benRow.id);
      expect(
        (
          await client.query('select 1 from public.incident_deliveries where member_id = $1', [
            benRow.id,
          ])
        ).rowCount,
      ).toBe(0);
    }
  });

  it('leave racing the resident’s mark safe: both succeed, no 5xx', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle, ben, benRow } = await circleWithBen();
      const incident = await sos(owner);
      const replies = await Promise.all([
        leaveCircle(app, ben.id, circle.id),
        markSafe(app, owner.id, incident),
      ]);
      no5xx(replies);
      expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
      await expectMembershipGone(client, benRow.id);
      const status = await client.query<{ status: string }>(
        'select status from public.incidents where id = $1',
        [incident],
      );
      expect(status.rows[0].status).toBe('resolved');
    }
  });

  it('remove racing re-notify of an active incident: both succeed, no 5xx', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, circle, benRow } = await circleWithBen();
      const incident = await sos(owner);
      const [removed, renotified] = await Promise.all([
        removeMember(app, owner.id, circle.id, benRow.id),
        renotifyAlert(app, owner.id, incident),
      ]);
      no5xx([removed, renotified]);
      expect(renotified.statusCode).toBe(200);
      await expectMembershipGone(client, benRow.id);
    }
  });

  it('remove racing accept, resend and cancel of the same invite rows: remove wins, no 5xx', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const sharing = await createUser(client, { fullName: 'Race Sharing Owner' });
      await client.query(
        'update public.profiles set location_sharing_enabled = true where id = $1',
        [sharing.id],
      );
      const circle = await createCircle(client, sharing);
      const joiner = await createUser(client);
      const rows = [
        await insertMember(client, circle.id),
        await insertMember(client, circle.id),
        await insertMember(client, circle.id),
      ];
      const [r1, r2, r3, accept, resend, cancel] = await Promise.all([
        removeMember(app, sharing.id, circle.id, rows[0].id),
        removeMember(app, sharing.id, circle.id, rows[1].id),
        removeMember(app, sharing.id, circle.id, rows[2].id),
        acceptInvite(app, joiner.id, rows[0].token),
        resendInvite(app, sharing.id, rows[1].id),
        cancelInvite(app, sharing.id, rows[2].id),
      ]);
      no5xx([r1, r2, r3, accept, resend, cancel]);
      // Remove always wins in the end (it deletes whatever the other write left).
      for (const removed of [r1, r2, r3]) expect(codeOf(removed)).toBe('ok');
      expect(['ok', 'accept_circle_invite:not_found']).toContain(codeOf(accept));
      expect(['ok', 'resend_circle_invite:member_not_found']).toContain(codeOf(resend));
      expect(['ok', 'cancel_circle_invite:not_found']).toContain(codeOf(cancel));
      for (const row of rows) await expectMembershipGone(client, row.id);
    }
  });

  /**
   * Leave racing submit. No deadlock is possible (leave locks the member row, submit's delivery
   * insert takes `FOR KEY SHARE` on it; neither then waits on the other). Since D14 the submit reads
   * the member rows `FOR KEY SHARE` before its insert, so it always succeeds; since D44 the leave
   * keeps the member row (`status = 'left'`) and deletes the member's deliveries, and the submit
   * waits behind the leave's row lock and then skips the leaver: no delivery of the leaver survives.
   * The full D14 proof is incidents-submit-membership-race.int-spec.ts.
   */
  it('leave racing the resident’s submit: the submit always succeeds (D14), the leaver keeps no delivery', async () => {
    for (let round = 0; round < ROUNDS * 2; round += 1) {
      const { owner, circle, ben, benRow } = await circleWithBen();
      const [left, submitted] = await Promise.all([
        leaveCircle(app, ben.id, circle.id),
        submitAlert(app, owner.id, 'fire'),
      ]);
      no5xx([left, submitted]);
      expect(left.statusCode).toBe(200);
      expect(submitted.statusCode).toBe(201);
      await expectMembershipGone(client, benRow.id);
      const survivors = (
        await client.query('select 1 from public.incident_deliveries where member_id = $1', [
          benRow.id,
        ])
      ).rowCount;
      expect(survivors).toBe(0);
    }
    expect(
      logs.lines.filter(
        (line) => line.operation === 'submit_emergency_alert' && line.level === 'error',
      ),
    ).toEqual([]);
  });

  it('the incoming-list claim: two lists of one user racing accepts and removes of the same rows: no 5xx', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const phone = phoneNumber();
      const invitee = await createUser(client, { phone });
      const owners = await Promise.all([1, 2, 3, 4].map(() => createUser(client)));
      const circles = await Promise.all(owners.map((o) => createCircle(client, o)));
      const rows = await Promise.all(circles.map((c) => insertMember(client, c.id, { phone })));
      const [api1, api2, api3, accepted, removed] = await Promise.all([
        listMyInvites(app, invitee.id),
        listMyInvites(app, invitee.id),
        listMyInvites(app, invitee.id),
        acceptInvite(app, invitee.id, rows[0].token),
        removeMember(app, owners[1].id, circles[1].id, rows[1].id),
      ]);
      no5xx([api1, api2, api3, accepted, removed]);
      expect(removed.statusCode).toBe(200);
      // The accept always succeeds (the invitee is the recipient, claimed or not).
      expect(accepted.statusCode).toBe(200);
      expect(await memberRow(client, rows[0].id)).toMatchObject({
        status: 'active',
        user_id: invitee.id,
      });
      // The two untouched rows end claimed by the invitee, still pending.
      for (const row of rows.slice(2)) {
        expect(await memberRow(client, row.id)).toMatchObject({
          status: 'pending',
          user_id: invitee.id,
        });
      }
      // A list after the dust settles: the two pending rows.
      const listed = (await listMyInvites(app, invitee.id)).json<Body[]>();
      expect(new Set(listed.map((x) => x.member_id))).toEqual(
        new Set(rows.slice(2).map((r) => r.id)),
      );
    }
  });
});
