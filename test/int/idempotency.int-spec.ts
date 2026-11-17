import { randomUUID } from 'node:crypto';

import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { DomainError, Operation } from '../../src/common/errors';
import {
  IDEMPOTENCY_ABANDONED_AFTER_SECONDS,
  Idempotent,
  IdempotencyStore,
  requestHash,
} from '../../src/common/idempotency';
import { DatabaseService } from '../../src/db';
import { createTestApp } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';

/**
 * Idempotency-Key middleware against the LOCAL Postgres (API-100-10). The routes below are
 * test-only (registered in this test app, never in the production app): they stand in for
 * `POST /v1/incidents` (required), `.../mark-safe` (required) and invite creation (optional).
 * Every test uses fresh user ids; the rows it creates are deleted in afterAll.
 */

const runs = new Map<string, number>();
const countRun = (label: string) => {
  const n = (runs.get(label) ?? 0) + 1;
  runs.set(label, n);
  return n;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface TestBody {
  label: string;
  delay_ms?: number;
  fail?: 'domain' | 'boom';
  [key: string]: unknown;
}

@Controller('test-idem')
class IdempotencyIntController {
  @Post('incidents')
  @Operation('submit_emergency_alert')
  @Idempotent('required')
  async submit(@Body() body: TestBody) {
    const run = countRun(body.label);
    if (body.delay_ms) await sleep(body.delay_ms);
    if (body.fail === 'domain') throw new DomainError('submit_emergency_alert:invalid_type');
    if (body.fail === 'boom') throw new Error('unexpected failure');
    return { run, label: body.label, created_at: new Date().toISOString() };
  }

  /** Sets its own status like E1's 200 "renotified" (passthrough reply). */
  @Post('incidents/:id/mark-safe')
  @Operation('mark_incident_safe')
  @Idempotent('required')
  markSafe(
    @Param('id') id: string,
    @Body() body: TestBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.status(200);
    return { id, run: countRun(body.label) };
  }

  @Post('invites')
  @Operation('create_circle_invite_link')
  @Idempotent('optional')
  invite(@Body() body: TestBody) {
    return { run: countRun(body.label) };
  }
}

describe('Idempotency-Key against local Postgres (API-100-10)', () => {
  let app: NestFastifyApplication;
  let database: DatabaseService;
  const usedUsers: string[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp({ controllers: [IdempotencyIntController] }));
    database = app.get(DatabaseService);
  });

  afterAll(async () => {
    if (usedUsers.length > 0) {
      await database.query('delete from public.idempotency_keys where user_id = any($1::uuid[])', [
        usedUsers,
      ]);
    }
    await app.close();
  });

  /** A fresh user with an auth header; its keys are cleaned up after the suite. */
  async function newUser() {
    const userId = randomUUID();
    usedUsers.push(userId);
    return { userId, auth: await authHeader(userId) };
  }

  const label = () => randomUUID();

  function post(url: string, headers: Record<string, string>, body: object) {
    return app.inject({ method: 'POST', url, headers, payload: body });
  }

  async function row(userId: string, key: string) {
    const rows = await database.query<{
      status: string;
      method: string;
      path: string;
      request_hash: string;
      response_status: number | null;
      response_body: unknown;
      ttl_hours: number;
    }>(
      `select status, method, path, request_hash, response_status, response_body,
              round(extract(epoch from (expires_at - created_at)) / 3600)::int as ttl_hours
         from public.idempotency_keys where user_id = $1 and key = $2`,
      [userId, key],
    );
    return rows[0];
  }

  it('AC1/AC4: first use runs the handler and stores status + body as completed (24 h)', async () => {
    const { userId, auth } = await newUser();
    const key = randomUUID();
    const body = { label: label(), emergency_type: 'fire' };
    const res = await post('/v1/test-idem/incidents', { ...auth, 'idempotency-key': key }, body);
    expect(res.statusCode).toBe(201);
    expect(await row(userId, key)).toEqual({
      status: 'completed',
      method: 'POST',
      path: '/v1/test-idem/incidents',
      request_hash: requestHash('POST', '/v1/test-idem/incidents', body),
      response_status: 201,
      response_body: res.json<unknown>(),
      ttl_hours: 24,
    });
  });

  it('AC5: replay returns the stored status and body with Idempotent-Replayed, no handler run', async () => {
    const { auth } = await newUser();
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    const body = { label: label(), b: 2, a: 1 };
    const first = await post('/v1/test-idem/incidents', headers, body);
    const replay = await post('/v1/test-idem/incidents', headers, {
      a: 1,
      label: body.label,
      b: 2,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(runs.get(body.label)).toBe(1);
  });

  it('AC5: a handler-chosen status (200) is replayed as 200', async () => {
    const { auth } = await newUser();
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    const body = { label: label() };
    const id = randomUUID();
    const first = await post(`/v1/test-idem/incidents/${id}/mark-safe`, headers, body);
    const replay = await post(`/v1/test-idem/incidents/${id}/mark-safe`, headers, body);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ id, run: 1 });
    expect(runs.get(body.label)).toBe(1);
  });

  it('AC6: same key with a different body, path or method → 422 idempotency:key_mismatch', async () => {
    const { auth } = await newUser();
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    const body = { label: label() };
    await post('/v1/test-idem/incidents', headers, body);

    const otherBody = await post('/v1/test-idem/incidents', headers, { ...body, extra: true });
    expect(otherBody.statusCode).toBe(422);
    expect(otherBody.json()).toMatchObject({ error: { code: 'idempotency:key_mismatch' } });

    const otherPath = await post(
      `/v1/test-idem/incidents/${randomUUID()}/mark-safe`,
      headers,
      body,
    );
    expect(otherPath.statusCode).toBe(422);
    expect(otherPath.json()).toMatchObject({ error: { code: 'idempotency:key_mismatch' } });
    expect(runs.get(body.label)).toBe(1);
  });

  it('keys are per user: the same key for two users runs twice', async () => {
    const a = await newUser();
    const b = await newUser();
    const key = randomUUID();
    const body = { label: label() };
    expect(
      (await post('/v1/test-idem/incidents', { ...a.auth, 'idempotency-key': key }, body))
        .statusCode,
    ).toBe(201);
    const second = await post(
      '/v1/test-idem/incidents',
      { ...b.auth, 'idempotency-key': key },
      body,
    );
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(runs.get(body.label)).toBe(2);
  });

  it('concurrency: two parallel requests with one key → exactly one handler run', async () => {
    const { auth } = await newUser();
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    const body = { label: label(), delay_ms: 400 };
    const [one, two] = await Promise.all([
      post('/v1/test-idem/incidents', headers, body),
      post('/v1/test-idem/incidents', headers, body),
    ]);
    expect(runs.get(body.label)).toBe(1);
    const statuses = [one.statusCode, two.statusCode].sort();
    expect(statuses).toEqual([201, 409]);
    const conflict = one.statusCode === 409 ? one : two;
    expect(conflict.headers['retry-after']).toBe('1');
    expect(conflict.json()).toMatchObject({ error: { code: 'idempotency:in_progress' } });

    // After completion the retry is a replay, still one run.
    const retry = await post('/v1/test-idem/incidents', headers, body);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(runs.get(body.label)).toBe(1);
  });

  it('concurrency: ten parallel requests with one key → one run', async () => {
    const { auth } = await newUser();
    const headers = { ...auth, 'idempotency-key': randomUUID() };
    const body = { label: label(), delay_ms: 300 };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post('/v1/test-idem/incidents', headers, body)),
    );
    expect(runs.get(body.label)).toBe(1);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
  });

  describe('AC7: in-progress claims', () => {
    async function seedInProgress(userId: string, key: string, ageSeconds: number, body: object) {
      await database.query(
        `insert into public.idempotency_keys
           (user_id, key, method, path, request_hash, status, created_at, expires_at)
         values ($1, $2, 'POST', '/v1/test-idem/incidents', $3, 'in_progress',
                 now() - make_interval(secs => $4), now() + interval '24 hours')`,
        [userId, key, requestHash('POST', '/v1/test-idem/incidents', body), ageSeconds],
      );
    }

    it('a claim younger than 60 s → 409 idempotency:in_progress, Retry-After: 1', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      const body = { label: label() };
      await seedInProgress(userId, key, IDEMPOTENCY_ABANDONED_AFTER_SECONDS - 5, body);
      const res = await post('/v1/test-idem/incidents', { ...auth, 'idempotency-key': key }, body);
      expect(res.statusCode).toBe(409);
      expect(res.headers['retry-after']).toBe('1');
      expect(runs.get(body.label)).toBeUndefined();
    });

    it('a claim older than 60 s is abandoned: the request runs again and completes', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      const body = { label: label() };
      await seedInProgress(userId, key, IDEMPOTENCY_ABANDONED_AFTER_SECONDS + 1, body);
      const res = await post('/v1/test-idem/incidents', { ...auth, 'idempotency-key': key }, body);
      expect(res.statusCode).toBe(201);
      expect(runs.get(body.label)).toBe(1);
      expect(await row(userId, key)).toMatchObject({ status: 'completed', response_status: 201 });
    });

    it('an abandoned claim with a different body is still a mismatch', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      await seedInProgress(userId, key, 120, { label: 'original' });
      const res = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        { label: label() },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: 'idempotency:key_mismatch' } });
    });
  });

  describe('AC8: what is stored', () => {
    it('a 4xx domain error is stored and replayed', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      const body = { label: label(), fail: 'domain' };
      const first = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        body,
      );
      expect(first.statusCode).toBe(422);
      expect(await row(userId, key)).toMatchObject({
        status: 'completed',
        response_status: 422,
        response_body: first.json<unknown>(),
      });
      const replay = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        body,
      );
      expect(replay.statusCode).toBe(422);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(runs.get(body.label)).toBe(1);
    });

    it('a 5xx is not stored: the key can be retried and runs again', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      const body = { label: label(), fail: 'boom' };
      const first = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        body,
      );
      expect(first.statusCode).toBe(500);
      expect(await row(userId, key)).toBeUndefined();
      const retry = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        body,
      );
      expect(retry.statusCode).toBe(500);
      expect(runs.get(body.label)).toBe(2);
    });
  });

  describe('AC9: expiry', () => {
    it('an expired key is unknown: the request runs again and the key is renewed', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      const body = { label: label() };
      await post('/v1/test-idem/incidents', { ...auth, 'idempotency-key': key }, body);
      await database.query(
        `update public.idempotency_keys set expires_at = now() - interval '1 second'
          where user_id = $1 and key = $2`,
        [userId, key],
      );
      const again = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        body,
      );
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBeUndefined();
      expect(runs.get(body.label)).toBe(2);
      expect(await row(userId, key)).toMatchObject({ status: 'completed', ttl_hours: 24 });
    });

    it('an expired key with a different body is not a mismatch (it is unknown)', async () => {
      const { userId, auth } = await newUser();
      const key = randomUUID();
      await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        { label: label() },
      );
      await database.query(
        `update public.idempotency_keys set expires_at = now() - interval '1 second'
          where user_id = $1 and key = $2`,
        [userId, key],
      );
      const other = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': key },
        { label: label() },
      );
      expect(other.statusCode).toBe(201);
    });

    it('the sweep deletes expired keys only', async () => {
      const { userId } = await newUser();
      const expired = randomUUID();
      const live = randomUUID();
      await database.query(
        `insert into public.idempotency_keys
           (user_id, key, method, path, request_hash, status, expires_at)
         values ($1, $2, 'POST', '/x', 'h', 'in_progress', now() - interval '1 minute'),
                ($1, $3, 'POST', '/x', 'h', 'in_progress', now() + interval '1 hour')`,
        [userId, expired, live],
      );
      const store = app.get(IdempotencyStore);
      expect(await store.deleteExpired()).toBeGreaterThanOrEqual(1);
      expect(await row(userId, expired)).toBeUndefined();
      expect(await row(userId, live)).toBeDefined();
    });
  });

  describe('AC2/AC3 headers', () => {
    it('required route without a key → 400 idempotency:key_required', async () => {
      const { auth } = await newUser();
      const res = await post('/v1/test-idem/incidents', auth, { label: label() });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'idempotency:key_required' } });
    });

    it('key not a UUID → 422 idempotency:invalid_key', async () => {
      const { auth } = await newUser();
      const res = await post(
        '/v1/test-idem/incidents',
        { ...auth, 'idempotency-key': 'retry-1' },
        { label: label() },
      );
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: { code: 'idempotency:invalid_key' } });
    });

    it('optional route: no key → runs every time; with a key → replayed', async () => {
      const { auth } = await newUser();
      const body = { label: label() };
      await post('/v1/test-idem/invites', auth, body);
      await post('/v1/test-idem/invites', auth, body);
      expect(runs.get(body.label)).toBe(2);
      const headers = { ...auth, 'idempotency-key': randomUUID() };
      await post('/v1/test-idem/invites', headers, body);
      const replay = await post('/v1/test-idem/invites', headers, body);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(runs.get(body.label)).toBe(3);
    });
  });
});
