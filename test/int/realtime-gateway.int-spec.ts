import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { userRoom } from '../../src/realtime/realtime.constants';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp, type LogCapture } from '../../src/testing/test-app';
import { signTestToken } from '../../src/testing/test-tokens';
import {
  connectError,
  connectSocket,
  eventually,
  sleep,
  type TestSocket,
} from '../support/realtime-client';

/**
 * The Socket.IO gateway (API-100-39) on two API instances sharing the test Redis (the adapter) and
 * database: handshake authentication, the `connect_error` code, the user room, cross-instance
 * delivery, disconnect at token expiry and readiness.
 */
const ALICE = '0b6c3f1e-4d2a-4c8b-9e1f-2a3b4c5d6e01';
const BOB = '0b6c3f1e-4d2a-4c8b-9e1f-2a3b4c5d6e02';

describe('realtime gateway (API-100-39)', () => {
  let appA: NestFastifyApplication;
  let appB: NestFastifyApplication;
  let logsA: LogCapture;
  let urlA: string;
  let urlB: string;
  const open: TestSocket[] = [];

  async function connect(url: string, userId: string, expiresInSeconds?: number) {
    const client = await connectSocket(url, userId, { expiresInSeconds });
    open.push(client);
    return client;
  }

  beforeAll(async () => {
    ({ app: appA, logs: logsA } = await createTestApp());
    ({ app: appB } = await createTestApp());
    await appA.listen(0, '127.0.0.1');
    await appB.listen(0, '127.0.0.1');
    urlA = await appA.getUrl();
    urlB = await appB.getUrl();
    // Both adapters subscribed before any broadcast.
    await eventually(async () => {
      await appA.get(RealtimeGateway).ping();
      await appB.get(RealtimeGateway).ping();
    });
  });

  afterEach(() => {
    for (const client of open.splice(0)) client.close();
  });

  afterAll(async () => {
    await appA.close();
    await appB.close();
  });

  describe('handshake (AC2)', () => {
    it('accepts a valid access token on the /v1/realtime namespace', async () => {
      const client = await connect(urlA, ALICE);
      expect(client.socket.connected).toBe(true);
    });

    it.each([
      ['no auth at all', { auth: {} }],
      ['a token that is not a string', { auth: { token: 42 } }],
      ['a malformed token', { auth: { token: 'not-a-jwt' } }],
      ['an expired token', { expiresInSeconds: -60 }],
      ['a token signed with another key', { secret: 'another-secret-another-secret-0123456789' }],
      ['an anonymous token', { claims: { is_anonymous: true } }],
      ['a token with a non-uuid subject', { claims: { sub: 'not-a-uuid' } }],
    ])('refuses %s with connect_error auth:session_expired', async (_name, options) => {
      const err = await connectError(urlA, ALICE, options);
      expect(err.message).toBe('auth:session_expired');
      expect(err.data).toEqual({ code: 'auth:session_expired' });
    });

    it('refuses a token that verifies only inside the clock skew (exp already passed)', async () => {
      const err = await connectError(urlA, ALICE, { expiresInSeconds: -5 });
      expect(err.data).toEqual({ code: 'auth:session_expired' });
    });

    it('refuses the default namespace and unknown namespaces', async () => {
      const token = await signTestToken({ claims: { sub: ALICE } });
      const root = await connectError(urlA, ALICE, { namespace: '/', auth: { token } });
      expect(root.message).toBe('realtime:not_found');
      const other = await connectError(urlA, ALICE, { namespace: '/v1/other', auth: { token } });
      expect(other.message).toBe('Invalid namespace');
    });

    it('never logs the token', async () => {
      const token = await signTestToken({ claims: { sub: ALICE }, expiresInSeconds: -60 });
      await connectError(urlA, ALICE, { auth: { token } });
      await connect(urlA, ALICE);
      expect(logsA.text).not.toContain(token.split('.')[2]);
    });
  });

  describe('user room and cross-instance fan-out (AC1, AC3)', () => {
    it('auto-joins user:{id}; an emit on instance B reaches the socket on instance A only', async () => {
      const alice = await connect(urlA, ALICE);
      const bob = await connect(urlA, BOB);
      const aliceOnB = await connect(urlB, ALICE);
      const received = alice.next('probe');
      const receivedOnB = aliceOnB.next('probe');
      appB.get(RealtimeGateway).emit([userRoom(ALICE)], 'probe', { n: 1 });
      await expect(received).resolves.toEqual({ n: 1 });
      await expect(receivedOnB).resolves.toEqual({ n: 1 });
      await sleep(200);
      expect(bob.of('probe')).toEqual([]);
      expect(alice.of('probe')).toEqual([{ n: 1 }]);
    });

    it('delivers every event across instances in order', async () => {
      const alice = await connect(urlA, ALICE);
      const gateway = appB.get(RealtimeGateway);
      for (let n = 0; n < 50; n++) gateway.emit([userRoom(ALICE)], 'probe', { n });
      await eventually(() => expect(alice.of('probe')).toHaveLength(50));
      expect(alice.of<{ n: number }>('probe').map((p) => p.n)).toEqual([...Array(50).keys()]);
    });

    it('a socket in several target rooms gets an event once', async () => {
      const alice = await connect(urlA, ALICE);
      appB
        .get(RealtimeGateway)
        .emit([userRoom(ALICE), userRoom(ALICE), userRoom(BOB)], 'probe', {});
      await eventually(() => expect(alice.of('probe')).toHaveLength(1));
      await sleep(200);
      expect(alice.of('probe')).toHaveLength(1);
    });
  });

  describe('token expiry (AC4)', () => {
    it('disconnects the socket at exp, after session.expired', async () => {
      const client = await connect(urlA, ALICE, 2);
      const disconnected = new Promise<string>((resolve) =>
        client.socket.once('disconnect', (reason) => resolve(reason)),
      );
      const started = Date.now();
      await expect(client.next('session.expired', 5_000)).resolves.toEqual({
        code: 'auth:session_expired',
      });
      await expect(disconnected).resolves.toBe('io server disconnect');
      expect(Date.now() - started).toBeLessThan(3_500);
    });
  });

  describe('readiness (AC5)', () => {
    it('uses the Redis adapter and /readyz is 200 with it up', async () => {
      expect(appA.get(RealtimeGateway).usesRedisAdapter).toBe(true);
      const res = await appA.inject({ method: 'GET', url: '/readyz' });
      expect(res.json()).toEqual({ status: 'ok' });
    });
  });
});
