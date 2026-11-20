import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { incidentRoom } from '../../src/realtime/realtime.constants';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp } from '../../src/testing/test-app';
import { leaveCircle, removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createIncident,
  createUser,
  type IncidentFixture,
  inviteMember,
  type MemberFixture,
  type UserFixture,
} from '../support/fixtures';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * Incident rooms (API-100-40) on two API instances: `incident.join` is authorized exactly like the
 * REST incident details (resident, or `incident.memberView` inside the membership window), re-checked
 * on every join, and a membership end through the API takes the user's sockets out of that circle's
 * incident rooms on every instance at once (also when it races a join).
 */
const NOT_FOUND = { ok: false, error: { code: 'get_incident_details:not_found' } };

describe('incident rooms with window authorization and revocation (API-100-40)', () => {
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

  /** A probe broadcast to the incident room from instance B. */
  function probe(incidentId: string, n: number) {
    appB.get(RealtimeGateway).emit([incidentRoom(incidentId)], 'probe', { n });
  }

  interface World {
    resident: UserFixture;
    circle: CircleFixture;
    member: UserFixture;
    memberRow: MemberFixture;
    incident: IncidentFixture;
  }

  /** A resident, a member who joined before the incident started, and the active incident. */
  async function world(): Promise<World> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const member = await createUser(client);
    const memberRow = await addActiveMember(client, circle, member);
    const incident = await createIncident(client, resident, circle);
    return { resident, circle, member, memberRow, incident };
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

  describe('incident.join (AC1)', () => {
    it('acks {ok: true} for the resident and for a member inside the window', async () => {
      const w = await world();
      const resident = await connect(urlA, w.resident);
      const member = await connect(urlA, w.member);
      await expect(resident.join(w.incident.id)).resolves.toEqual({ ok: true });
      await expect(member.join(w.incident.id)).resolves.toEqual({ ok: true });
      probe(w.incident.id, 1);
      await expect(resident.next('probe')).resolves.toEqual({ n: 1 });
      await expect(member.next('probe')).resolves.toEqual({ n: 1 });
    });

    it('a member may join a resolved incident inside the window (sees the flip to resolved)', async () => {
      const resident = await createUser(client);
      const circle = await createCircle(client, resident);
      const member = await createUser(client);
      await addActiveMember(client, circle, member);
      const incident = await createIncident(client, resident, circle, { status: 'resolved' });
      const socket = await connect(urlA, member);
      await expect(socket.join(incident.id)).resolves.toEqual({ ok: true });
    });

    it('refuses with get_incident_details:not_found everyone else, as REST details', async () => {
      const w = await world();
      // Joined after the incident started (rule 54).
      const late = await createUser(client);
      await addActiveMember(client, w.circle, late);
      // Invited and claimed, still pending.
      const pending = await createUser(client);
      await inviteMember(client, w.circle, { claimedBy: pending });
      // Declined.
      const declined = await createUser(client);
      const declinedRow = await inviteMember(client, w.circle, { claimedBy: declined });
      await client.query(
        `update public.safety_circle_members set status = 'declined' where id = $1`,
        [declinedRow.id],
      );
      const outsider = await createUser(client);
      for (const user of [late, pending, declined, outsider]) {
        const socket = await connect(urlA, user);
        await expect(socket.join(w.incident.id)).resolves.toEqual(NOT_FOUND);
      }
      // Unknown incident: the same answer.
      const member = await connect(urlA, w.member);
      await expect(member.join(randomUUID())).resolves.toEqual(NOT_FOUND);
      // Nobody refused receives anything.
      probe(w.incident.id, 2);
      await sleep(300);
      for (const socket of open) expect(socket.of('probe')).toEqual([]);
    });

    it('refuses a member while the incident is not active/resolved; the resident may join', async () => {
      const w = await world();
      await client.query(`update public.incidents set status = 'activating' where id = $1`, [
        w.incident.id,
      ]);
      const member = await connect(urlA, w.member);
      const resident = await connect(urlA, w.resident);
      await expect(member.join(w.incident.id)).resolves.toEqual(NOT_FOUND);
      await expect(resident.join(w.incident.id)).resolves.toEqual({ ok: true });
    });

    it('answers validation:invalid_request for a payload without a uuid incident_id', async () => {
      const w = await world();
      const socket = await connect(urlA, w.member);
      for (const id of [undefined, 42, 'not-a-uuid', '']) {
        await expect(socket.join(id)).resolves.toEqual({
          ok: false,
          error: { code: 'validation:invalid_request' },
        });
      }
    });
  });

  describe('incident.leave (AC2)', () => {
    it('stops events for that socket only', async () => {
      const w = await world();
      const first = await connect(urlA, w.member);
      const second = await connect(urlB, w.member);
      await first.join(w.incident.id);
      await second.join(w.incident.id);
      await expect(first.leave(w.incident.id)).resolves.toEqual({ ok: true });
      probe(w.incident.id, 3);
      await expect(second.next('probe')).resolves.toEqual({ n: 3 });
      await sleep(200);
      expect(first.of('probe')).toEqual([]);
    });
  });

  describe('re-checked on every join (AC4)', () => {
    it('a member removed in the database (no API call) cannot join again', async () => {
      const w = await world();
      const socket = await connect(urlA, w.member);
      await expect(socket.join(w.incident.id)).resolves.toEqual({ ok: true });
      await socket.leave(w.incident.id);
      await client.query(`delete from public.safety_circle_members where id = $1`, [
        w.memberRow.id,
      ]);
      await expect(socket.join(w.incident.id)).resolves.toEqual(NOT_FOUND);
    });
  });

  describe('membership end (AC3)', () => {
    it('remove on instance B takes the member socket on instance A out of the room at once', async () => {
      const resident0 = await createUser(client);
      const circle = await createCircle(client, resident0);
      const member = await createUser(client);
      const memberRow = await addActiveMember(client, circle, member);
      const other = await createUser(client);
      await addActiveMember(client, circle, other);
      const incident = await createIncident(client, resident0, circle);
      const w = { resident: resident0, circle, member, memberRow };
      const removed = await connect(urlA, w.member);
      const stays = await connect(urlA, other);
      const resident = await connect(urlB, w.resident);
      for (const socket of [removed, stays, resident]) {
        await expect(socket.join(incident.id)).resolves.toEqual({ ok: true });
      }
      const reply = await removeMember(appB, w.resident.id, w.circle.id, w.memberRow.id);
      expect(reply.statusCode).toBe(200);
      // The revocation travels through Redis like any broadcast; give it the same moment.
      await sleep(150);
      probe(incident.id, 4);
      await expect(stays.next('probe')).resolves.toEqual({ n: 4 });
      await expect(resident.next('probe')).resolves.toEqual({ n: 4 });
      await sleep(200);
      expect(removed.of('probe')).toEqual([]);
      // And the next join is refused.
      await expect(removed.join(incident.id)).resolves.toEqual(NOT_FOUND);
    });

    it('leave takes every socket of the user out of every incident room of that circle only', async () => {
      const w = await world();
      const second = await createIncident(client, w.resident, w.circle, { status: 'resolved' });
      // The member also belongs to another circle with its own incident.
      const otherResident = await createUser(client);
      const otherCircle = await createCircle(client, otherResident);
      await addActiveMember(client, otherCircle, w.member);
      const otherIncident = await createIncident(client, otherResident, otherCircle);
      const onA = await connect(urlA, w.member);
      const onB = await connect(urlB, w.member);
      for (const socket of [onA, onB]) {
        for (const id of [w.incident.id, second.id, otherIncident.id]) {
          await expect(socket.join(id)).resolves.toEqual({ ok: true });
        }
      }
      const reply = await leaveCircle(appA, w.member.id, w.circle.id);
      expect(reply.statusCode).toBe(200);
      await sleep(150);
      probe(w.incident.id, 5);
      probe(second.id, 6);
      probe(otherIncident.id, 7);
      await eventually(() => {
        expect(onA.of('probe')).toEqual([{ n: 7 }]);
        expect(onB.of('probe')).toEqual([{ n: 7 }]);
      });
      await sleep(200);
      expect(onA.of('probe')).toEqual([{ n: 7 }]);
      expect(onB.of('probe')).toEqual([{ n: 7 }]);
    });

    it('a removal racing a join never leaves the removed socket in the room', async () => {
      for (let round = 0; round < 12; round++) {
        const w = await world();
        const socket = await connect(round % 2 === 0 ? urlA : urlB, w.member);
        const joinApp = round % 3 === 0 ? appA : appB;
        const [ack, reply] = await Promise.all([
          socket.join(w.incident.id),
          removeMember(joinApp, w.resident.id, w.circle.id, w.memberRow.id),
        ]);
        expect(reply.statusCode).toBe(200);
        expect([true, false]).toContain(ack.ok);
        await sleep(150);
        probe(w.incident.id, round);
        await sleep(200);
        expect(socket.of('probe')).toEqual([]);
        socket.close();
      }
    });

    it('the resident is never revoked by a member leaving', async () => {
      const w = await world();
      const resident = await connect(urlA, w.resident);
      await resident.join(w.incident.id);
      await leaveCircle(appB, w.member.id, w.circle.id);
      await sleep(150);
      probe(w.incident.id, 8);
      await expect(resident.next('probe')).resolves.toEqual({ n: 8 });
    });
  });
});
