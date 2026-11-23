import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp } from '../../src/testing/test-app';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  createCircle,
  createUser,
  inviteMember,
  type UserFixture,
} from '../support/fixtures';
import { submitAlert } from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * Gap 19 (D49): after a remove or a leave commits (and the D20 eviction ran), the ended member's
 * user room gets `circle.membership_ended {circle_id, occurred_at}` on every instance, so their
 * open alert / Member View screens of that circle can switch to "no longer available". No reason,
 * no names; nobody else gets it; a removed pending invite (no membership) sends nothing.
 */
type Body = Record<string, unknown>;
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const EVENT = 'circle.membership_ended';

describe('circle.membership_ended (gap 19, D49)', () => {
  let appA: NestFastifyApplication;
  let appB: NestFastifyApplication;
  let urlA: string;
  let urlB: string;
  let client: Client;
  const open: TestSocket[] = [];

  async function connect(url: string, user: UserFixture) {
    const socket = await connectSocket(url, user.id);
    open.push(socket);
    return socket;
  }

  beforeAll(async () => {
    ({ app: appA } = await createTestApp());
    ({ app: appB } = await createTestApp());
    await appA.listen(0, '127.0.0.1');
    await appB.listen(0, '127.0.0.1');
    urlA = await appA.getUrl();
    urlB = await appB.getUrl();
    client = await openTestClient();
    await eventually(async () => {
      await appA.get(RealtimeGateway).ping();
      await appB.get(RealtimeGateway).ping();
    });
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await appA.close();
    await appB.close();
  });

  const endedAtOf = async (memberId: string, text: unknown) => {
    const { rows } = await client.query<{ same: boolean }>(
      'select ended_at = $2::timestamptz as same from public.safety_circle_members where id = $1',
      [memberId, text],
    );
    return rows[0]?.same === true;
  };

  it('remove: every socket of the removed member gets it (one watching the alert), nobody else', async () => {
    const resident = await createUser(client, { fullName: 'Rita Resident' });
    const circle = await createCircle(client, resident);
    const milo = await createUser(client);
    const other = await createUser(client);
    const miloRow = await addActiveMember(client, circle, milo);
    await addActiveMember(client, circle, other);
    const id = (await submitAlert(appA, resident.id, 'medical')).json<Body>().id as string;
    await sleep(200);

    const watching = await connect(urlA, milo);
    const second = await connect(urlB, milo);
    const residentSocket = await connect(urlB, resident);
    const otherSocket = await connect(urlA, other);
    await expect(watching.join(id)).resolves.toEqual({ ok: true });
    await expect(otherSocket.join(id)).resolves.toEqual({ ok: true });

    expect((await removeMember(appB, resident.id, circle.id, miloRow.id)).statusCode).toBe(200);
    const onA = await watching.next<Body>(EVENT);
    expect(onA).toEqual({
      circle_id: circle.id,
      occurred_at: expect.stringMatching(UTC_TEXT) as unknown,
    });
    expect(Object.keys(onA)).toEqual(['circle_id', 'occurred_at']);
    expect(await endedAtOf(miloRow.id, onA.occurred_at)).toBe(true);
    await expect(second.next<Body>(EVENT)).resolves.toEqual(onA);

    // D20 ran too: the watching socket is out of the incident room, a new join is refused.
    await expect(watching.join(id)).resolves.toEqual({
      ok: false,
      error: { code: 'get_incident_details:not_found' },
    });
    await sleep(300);
    expect(watching.of(EVENT)).toHaveLength(1);
    expect(residentSocket.of(EVENT)).toEqual([]);
    expect(otherSocket.of(EVENT)).toEqual([]);
  });

  it("leave: reaches the leaver's other devices", async () => {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const ben = await createUser(client);
    const benRow = await addActiveMember(client, circle, ben);
    const phone = await connect(urlA, ben);
    const tablet = await connect(urlB, ben);
    const residentSocket = await connect(urlA, resident);
    await sleep(200);

    expect((await leaveCircle(appA, ben.id, circle.id)).statusCode).toBe(200);
    const event = await tablet.next<Body>(EVENT);
    expect(event).toEqual({
      circle_id: circle.id,
      occurred_at: expect.stringMatching(UTC_TEXT) as unknown,
    });
    expect(await endedAtOf(benRow.id, event.occurred_at)).toBe(true);
    await expect(phone.next<Body>(EVENT)).resolves.toEqual(event);
    await sleep(300);
    expect(residentSocket.of(EVENT)).toEqual([]);
  });

  it('removing a claimed pending invite (no membership) sends nothing', async () => {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const invitee = await createUser(client);
    const row = await inviteMember(client, circle, { claimedBy: invitee });
    const socket = await connect(urlA, invitee);
    await sleep(200);
    expect((await removeMember(appB, resident.id, circle.id, row.id)).statusCode).toBe(200);
    await sleep(500);
    expect(socket.of(EVENT)).toEqual([]);
  });
});
