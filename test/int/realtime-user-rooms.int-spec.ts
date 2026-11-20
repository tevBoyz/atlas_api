import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp } from '../../src/testing/test-app';
import { removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  inviteMember,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import { listResponderIncidents, renotifyAlert, submitAlert } from '../support/incident-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * User rooms (API-100-42) on two API instances: a created or promoted SOS sends `incident.incoming`
 * to `user:{id}` of every delivery recipient (nothing joined), a re-notify sends
 * `incident.renotified` to the same user rooms, and nobody outside the window (pending, removed,
 * joined later, outsiders, the resident) gets either.
 */
type Body = Record<string, unknown>;

describe('user rooms: incoming incidents (API-100-42)', () => {
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

  interface Scene {
    resident: UserFixture;
    circle: CircleFixture;
    m1: UserFixture;
    m2: UserFixture;
    m2Row: MemberFixture;
    pending: UserFixture;
    outsider: UserFixture;
    sockets: {
      resident: TestSocket;
      m1: TestSocket;
      m2: TestSocket;
      m2b: TestSocket;
      pending: TestSocket;
      outsider: TestSocket;
    };
  }

  async function scene(): Promise<Scene> {
    const resident = await createUser(client, { fullName: 'Ada Resident' });
    const circle = await createCircle(client, resident);
    const m1 = await createUser(client);
    const m2 = await createUser(client);
    await addActiveMember(client, circle, m1);
    const m2Row = await addActiveMember(client, circle, m2);
    const pending = await createUser(client);
    await inviteMember(client, circle, { claimedBy: pending });
    const outsider = await createUser(client);
    const sockets = {
      resident: await connect(urlA, resident),
      m1: await connect(urlA, m1),
      m2: await connect(urlB, m2),
      m2b: await connect(urlA, m2),
      pending: await connect(urlB, pending),
      outsider: await connect(urlA, outsider),
    };
    return { resident, circle, m1, m2, m2Row, pending, outsider, sockets };
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

  it('created submit: incident.incoming to every recipient socket on both instances (AC1)', async () => {
    const s = await scene();
    const submitted = await submitAlert(appB, s.resident.id, 'fire');
    expect(submitted.statusCode).toBe(201);
    const id = submitted.json<Body>().id as string;
    const incoming = await s.sockets.m1.next<Body>('incident.incoming');
    const listed = (await listResponderIncidents(appA, s.m1.id)).json<Body[]>()[0];
    expect(incoming).toEqual({
      incident_id: id,
      resident_name: 'Ada Resident',
      emergency_type: 'fire',
      activated_at: listed.activated_at,
      sent_at: listed.sent_at,
      updated_at: expect.any(String) as unknown,
      occurred_at: expect.any(String) as unknown,
    });
    expect(listed).toMatchObject({ id, resident_name: 'Ada Resident', emergency_type: 'fire' });
    await expect(s.sockets.m2.next('incident.incoming')).resolves.toEqual(incoming);
    await expect(s.sockets.m2b.next('incident.incoming')).resolves.toEqual(incoming);
    await sleep(300);
    // AC3: the resident, the pending invitee and the outsider get nothing.
    for (const socket of [s.sockets.resident, s.sockets.pending, s.sockets.outsider]) {
      expect(socket.of('incident.incoming')).toEqual([]);
    }
    expect(s.sockets.pending.received).toEqual([]);
    expect(s.sockets.outsider.received).toEqual([]);
  });

  it('promoted submit (an activating incident) also sends incident.incoming', async () => {
    const s = await scene();
    const draftId = randomUUID();
    await client.query(
      `insert into public.incidents (id, resident_id, circle_id, status, activated_at)
       values ($1, $2, $3, 'activating', now())`,
      [draftId, s.resident.id, s.circle.id],
    );
    const submitted = await submitAlert(appA, s.resident.id, 'medical');
    expect(submitted.statusCode).toBe(201);
    expect(submitted.json<Body>().submit_outcome).toBe('promoted');
    await expect(s.sockets.m1.next<Body>('incident.incoming')).resolves.toMatchObject({
      incident_id: draftId,
      emergency_type: 'medical',
    });
  });

  it('re-notify (explicit, and a second submit) sends incident.renotified to the recipients (AC2)', async () => {
    const s = await scene();
    const id = (await submitAlert(appA, s.resident.id, 'medical')).json<Body>().id as string;
    await s.sockets.m1.next('incident.incoming');
    // m1 also joined the incident room: one renotified per socket, not two.
    await sleep(200);
    await expect(s.sockets.m1.join(id)).resolves.toEqual({ ok: true });

    const reply = await renotifyAlert(appB, s.resident.id, id);
    expect(reply.statusCode).toBe(200);
    const renotified = await s.sockets.m2.next<Body>('incident.renotified');
    expect(renotified).toMatchObject({
      incident_id: id,
      renotified_at: reply.json<Body>().renotified_at,
    });
    await expect(s.sockets.m2b.next('incident.renotified')).resolves.toEqual(renotified);
    await expect(s.sockets.m1.next('incident.renotified')).resolves.toEqual(renotified);

    const again = await submitAlert(appA, s.resident.id, 'medical');
    expect(again.statusCode).toBe(200);
    expect(again.json<Body>().submit_outcome).toBe('renotified');
    await expect(s.sockets.m2.next<Body>('incident.renotified')).resolves.toMatchObject({
      incident_id: id,
      renotified_at: again.json<Body>().renotified_at,
    });
    await sleep(300);
    expect(s.sockets.m1.of('incident.renotified')).toHaveLength(2);
    for (const socket of [s.sockets.resident, s.sockets.pending, s.sockets.outsider]) {
      expect(socket.of('incident.renotified')).toEqual([]);
    }
  });

  it('a removed member and a member who joined after the alert get no renotified (AC3)', async () => {
    const s = await scene();
    const id = (await submitAlert(appA, s.resident.id, 'medical')).json<Body>().id as string;
    await s.sockets.m1.next('incident.incoming');
    const late = await createUser(client);
    await addActiveMember(client, s.circle, late);
    const lateSocket = await connect(urlB, late);
    expect((await removeMember(appB, s.resident.id, s.circle.id, s.m2Row.id)).statusCode).toBe(200);
    expect((await renotifyAlert(appA, s.resident.id, id)).statusCode).toBe(200);
    await s.sockets.m1.next('incident.renotified');
    await sleep(300);
    expect(s.sockets.m2.of('incident.renotified')).toEqual([]);
    expect(s.sockets.m2b.of('incident.renotified')).toEqual([]);
    expect(lateSocket.received).toEqual([]);
  });

  it('an SOS of a circle without members sends no incoming to anyone', async () => {
    const lonely = await createUser(client);
    await createCircle(client, lonely);
    const outsider = await createUser(client);
    const socket = await connect(urlA, outsider);
    expect((await submitAlert(appA, lonely.id, 'other')).statusCode).toBe(201);
    await sleep(300);
    expect(socket.received).toEqual([]);
  });
});
