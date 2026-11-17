import { randomUUID } from 'node:crypto';

import { Body, Controller, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createTestApp } from '../../testing/test-app';
import { authHeader } from '../../testing/test-tokens';
import { DomainError } from '../errors/domain-error';
import { Operation } from '../errors/operation';
import { idempotencyKeyOf } from './idempotency.interceptor';
import {
  type ClaimOutcome,
  type IdempotencyClaim,
  type IdempotencyRequest,
  IdempotencyStore,
} from './idempotency.store';
import { Idempotent } from './idempotent.decorator';
import { canonicalJson, requestHash } from './request-hash';

describe('request hash (API-100-10 AC5, AC6)', () => {
  it('sorts object keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}',
    );
  });

  it('same method, path and body in any key order → same hash', () => {
    expect(requestHash('post', '/v1/incidents', { emergency_type: 'fire', x: 1 })).toBe(
      requestHash('POST', '/v1/incidents', { x: 1, emergency_type: 'fire' }),
    );
  });

  it.each([
    ['method', ['PUT', '/v1/incidents', { a: 1 }]],
    ['path', ['POST', '/v1/incidents/x/mark-safe', { a: 1 }]],
    ['query', ['POST', '/v1/incidents?x=1', { a: 1 }]],
    ['body value', ['POST', '/v1/incidents', { a: 2 }]],
    ['body type', ['POST', '/v1/incidents', { a: '1' }]],
    ['array order', ['POST', '/v1/incidents', { a: 1, l: [2, 1] }]],
  ] as const)('a different %s → a different hash', (_name, [method, path, body]) => {
    const base = requestHash('POST', '/v1/incidents', { a: 1, l: [1, 2] });
    expect(requestHash(method, path, { l: [1, 2], ...body })).not.toBe(base);
  });

  it('no body, empty body and null are the same request', () => {
    const none = requestHash('POST', '/p', undefined);
    expect(requestHash('POST', '/p', '')).toBe(none);
    expect(requestHash('POST', '/p', null)).toBe(none);
  });
});

describe('idempotencyKeyOf (API-100-10 AC3)', () => {
  it('accepts a UUID (any case, trimmed) and lower-cases it', () => {
    const key = randomUUID();
    expect(idempotencyKeyOf(` ${key.toUpperCase()} `)).toBe(key);
  });

  it('treats a missing or blank header as no key', () => {
    expect(idempotencyKeyOf(undefined)).toBeUndefined();
    expect(idempotencyKeyOf('  ')).toBeUndefined();
  });

  it.each([['not-a-uuid'], ['1234'], [`${randomUUID()}x`], [[randomUUID(), randomUUID()]]])(
    'refuses %j with 422 idempotency:invalid_key',
    (header) => {
      expect(() => idempotencyKeyOf(header)).toThrow(DomainError);
      try {
        idempotencyKeyOf(header);
      } catch (error) {
        expect(error).toMatchObject({ code: 'idempotency:invalid_key', status: 422 });
      }
    },
  );
});

let handlerRuns = 0;

/** Test-only routes (never registered in the production app). */
@Controller('test-idem')
class IdempotencyUnitController {
  @Post('required')
  @Operation('submit_emergency_alert')
  @Idempotent('required')
  required(@Body() body: { fail?: string }) {
    handlerRuns += 1;
    if (body?.fail === 'domain') throw new DomainError('submit_emergency_alert:invalid_type');
    if (body?.fail === 'boom') throw new Error('unexpected');
    return { run: handlerRuns };
  }

  @Post('optional')
  @Operation('create_circle_invite_link')
  @Idempotent('optional')
  optional() {
    handlerRuns += 1;
    return { run: handlerRuns };
  }
}

/** In-memory stand-in for the database store: scripted claim outcomes, recorded finishes. */
class FakeStore {
  next: ClaimOutcome | undefined;
  claims: IdempotencyRequest[] = [];
  completed: Array<{ status: number; body: string | null }> = [];
  released = 0;

  claim(request: IdempotencyRequest): Promise<ClaimOutcome> {
    this.claims.push(request);
    const outcome = this.next ?? {
      kind: 'claimed',
      claim: { userId: request.userId, key: request.key, claimedAt: 'now' },
    };
    return Promise.resolve(outcome);
  }

  complete(_claim: IdempotencyClaim, status: number, body: string | null): Promise<void> {
    this.completed.push({ status, body });
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.released += 1;
    return Promise.resolve();
  }
}

describe('IdempotencyInterceptor with a fake store (API-100-10)', () => {
  let app: NestFastifyApplication;
  const store = new FakeStore();
  const userId = randomUUID();
  let auth: { authorization: string };

  beforeAll(async () => {
    auth = await authHeader(userId);
    ({ app } = await createTestApp({ controllers: [IdempotencyUnitController] }, (builder) =>
      builder.overrideProvider(IdempotencyStore).useValue(store),
    ));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    store.next = undefined;
    store.claims = [];
    store.completed = [];
    store.released = 0;
    handlerRuns = 0;
  });

  const post = (url: string, headers: Record<string, string>, payload: object = {}) =>
    app.inject({ method: 'POST', url, headers, payload });

  it('AC3: missing key on a required route → 400 idempotency:key_required, no handler run', async () => {
    const res = await post('/v1/test-idem/required', auth);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency:key_required' } });
    expect(handlerRuns).toBe(0);
  });

  it('AC3: key not a UUID → 422 idempotency:invalid_key', async () => {
    const res = await post('/v1/test-idem/required', { ...auth, 'idempotency-key': 'abc' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency:invalid_key' } });
    expect(handlerRuns).toBe(0);
  });

  it('authentication runs first: no token → 401 even without a key', async () => {
    const res = await post('/v1/test-idem/required', {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      error: { code: 'submit_emergency_alert:not_authenticated' },
    });
  });

  it('AC2: optional route without a key runs normally and stores nothing', async () => {
    const res = await post('/v1/test-idem/optional', auth);
    expect(res.statusCode).toBe(201);
    expect(store.claims).toHaveLength(0);
    expect(store.completed).toHaveLength(0);
  });

  it('AC2: optional route honours a key when sent', async () => {
    const key = randomUUID();
    const res = await post('/v1/test-idem/optional', { ...auth, 'idempotency-key': key });
    expect(res.statusCode).toBe(201);
    expect(store.claims).toEqual([
      expect.objectContaining({ userId, key, method: 'POST', path: '/v1/test-idem/optional' }),
    ]);
    expect(store.completed).toEqual([{ status: 201, body: JSON.stringify({ run: 1 }) }]);
  });

  it('AC4: first use claims, runs, and stores the response actually sent', async () => {
    const res = await post('/v1/test-idem/required', { ...auth, 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(store.completed).toEqual([{ status: 201, body: res.body }]);
  });

  it('AC8: a 4xx error envelope from the handler is stored', async () => {
    const res = await post(
      '/v1/test-idem/required',
      { ...auth, 'idempotency-key': randomUUID() },
      { fail: 'domain' },
    );
    expect(res.statusCode).toBe(422);
    expect(store.completed).toEqual([{ status: 422, body: res.body }]);
    expect(JSON.parse(store.completed[0].body!)).toMatchObject({
      error: { code: 'submit_emergency_alert:invalid_type' },
    });
  });

  it('AC8: a 5xx is not stored; the claim is released', async () => {
    const res = await post(
      '/v1/test-idem/required',
      { ...auth, 'idempotency-key': randomUUID() },
      { fail: 'boom' },
    );
    expect(res.statusCode).toBe(500);
    expect(store.completed).toHaveLength(0);
    expect(store.released).toBe(1);
  });

  it('AC5: replay → stored status and body, Idempotent-Replayed: true, no handler run', async () => {
    store.next = { kind: 'replay', status: 200, body: { stored: true } };
    const res = await post('/v1/test-idem/required', { ...auth, 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stored: true });
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(handlerRuns).toBe(0);
    expect(store.completed).toHaveLength(0);
  });

  it('AC5: a stored 4xx envelope replays with its status', async () => {
    const envelope = {
      error: { code: 'submit_emergency_alert:invalid_type', message: 'x', details: {} },
    };
    store.next = { kind: 'replay', status: 422, body: envelope };
    const res = await post('/v1/test-idem/required', { ...auth, 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(envelope);
    expect(res.headers['idempotent-replayed']).toBe('true');
  });

  it('AC6: mismatch → 422 idempotency:key_mismatch', async () => {
    store.next = { kind: 'mismatch' };
    const res = await post('/v1/test-idem/required', { ...auth, 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency:key_mismatch' } });
    expect(handlerRuns).toBe(0);
  });

  it('AC7: in progress → 409 idempotency:in_progress with Retry-After: 1', async () => {
    store.next = { kind: 'in_progress' };
    const res = await post('/v1/test-idem/required', { ...auth, 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(409);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.json()).toMatchObject({ error: { code: 'idempotency:in_progress' } });
    expect(handlerRuns).toBe(0);
  });

  it('keys are per user and lower-cased; the hash covers method, path and body', async () => {
    const key = randomUUID();
    await post(
      '/v1/test-idem/required',
      { ...auth, 'idempotency-key': key.toUpperCase() },
      { a: 1 },
    );
    expect(store.claims[0]).toEqual({
      userId,
      key,
      method: 'POST',
      path: '/v1/test-idem/required',
      requestHash: requestHash('POST', '/v1/test-idem/required', { a: 1 }),
    });
  });
});
