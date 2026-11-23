import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  cancelInvite,
  getCapacity,
  leaveCircle,
  listJoinedCircles,
  listMembers,
  removeMember,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import { insertExpiredMember, insertMember } from '../support/invite-rows';

/**
 * Gap 20 (D50): every element of `GET /v1/me/joined-circles` carries `capacity_used` = active
 * members + valid pending invitations of that circle, owner excluded (SCRUM-30 §5.2, SCRUM-31 §6.2,
 * SCRUM-33 §7-8): the Member View's "Members (n of 5)" equals the owner screen's Capacity `used`.
 * `active_member_count` stays active-only ("n active members" on Circles I've Joined). A count only:
 * nothing about who is pending reaches a member.
 */
type Body = Record<string, unknown>;

describe('joined circles: capacity_used (gap 20, D50)', () => {
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

  const entryFor = async (user: UserFixture, circleId: string) => {
    const reply = await listJoinedCircles(app, user.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body[]>().find((e) => e.circle_id === circleId);
  };
  const ownerUsed = async (owner: UserFixture) => {
    const reply = await getCapacity(app, owner.id);
    expect(reply.statusCode).toBe(200);
    return reply.json<{ used: number }>().used;
  };

  it('counts active + valid pending (owner excluded), equal to the owner Capacity used', async () => {
    const rita = await createUser(client, { fullName: 'Rita Owner' });
    const circle = await createCircle(client, rita);
    const milo = await createUser(client, { fullName: 'Milo Member' });
    const ben = await createUser(client, { fullName: 'Ben Member' });
    const gone = await createUser(client, { fullName: 'Gone Member' });
    await addActiveMember(client, circle, milo);
    await addActiveMember(client, circle, ben);
    const goneRow = await addActiveMember(client, circle, gone);
    const pending = await insertMember(client, circle.id, { name: 'Pending One' });
    // Not counted: expired, canceled, declined, and an ended membership (D44 history).
    await insertExpiredMember(client, circle.id, { name: 'Expired' });
    await insertMember(client, circle.id, { name: 'Canceled', canceled: true });
    await insertMember(client, circle.id, { name: 'Declined', status: 'declined' });
    expect((await removeMember(app, rita.id, circle.id, goneRow.id)).statusCode).toBe(200);

    const entry = await entryFor(milo, circle.id);
    expect(entry).toMatchObject({ role: 'member', active_member_count: 2, capacity_used: 3 });
    expect(await ownerUsed(rita)).toBe(3);
    // The owner's own row carries the same number.
    expect((await entryFor(rita, circle.id))?.capacity_used).toBe(3);
    // The member still sees active rows only: no pending name or contact reaches them.
    const members = (await listMembers(app, milo.id, circle.id)).json<Body[]>();
    expect(members.every((m) => m.status === 'active')).toBe(true);
    expect(JSON.stringify(await entryFor(milo, circle.id))).not.toContain('Pending One');

    // Cancel the pending invite, then a member leaves: the count follows at once.
    expect((await cancelInvite(app, rita.id, pending.id)).statusCode).toBe(200);
    expect((await entryFor(milo, circle.id))?.capacity_used).toBe(2);
    expect((await leaveCircle(app, ben.id, circle.id)).statusCode).toBe(200);
    expect(await entryFor(milo, circle.id)).toMatchObject({
      active_member_count: 1,
      capacity_used: 1,
    });
    expect(await ownerUsed(rita)).toBe(1);
  });

  it('a circle with only the owner and the member: 1', async () => {
    const owner = await createUser(client);
    const circle = await createCircle(client, owner);
    const member = await createUser(client);
    await addActiveMember(client, circle, member);
    expect((await entryFor(member, circle.id))?.capacity_used).toBe(1);
    expect(await ownerUsed(owner)).toBe(1);
  });
});
