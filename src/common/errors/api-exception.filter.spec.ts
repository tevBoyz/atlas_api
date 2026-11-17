import { Body, Controller, Get, Post, ServiceUnavailableException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';

import { setErrorReporter } from '../../observability/error-reporter';
import { createTestApp, type LogCapture } from '../../testing/test-app';
import { DomainError } from './domain-error';
import { Operation } from './operation';
import { ZodBody, ZodParam, ZodQuery } from './validation';

/** A node-postgres `raise exception` error (SQLSTATE P0001). Fake, no database needed. */
function pgRaise(message: string): Error {
  return Object.assign(new Error(message), { code: 'P0001' });
}

const LOCATION_SOURCES = ['gps', 'network', 'unavailable'] as const;
const locationBody = z.object({
  location_source: z.enum(LOCATION_SOURCES),
  location_lat: z.number().min(-90).max(90).optional(),
  location_lng: z.number().min(-180).max(180).optional(),
});

@Controller('test-errors')
class ErrorsTestController {
  @Get('domain')
  domain(): never {
    throw new DomainError('submit_emergency_alert:invalid_type');
  }

  @Get('rate-limited')
  rateLimited(): never {
    throw new DomainError('login_lockout:rate_limited', { retryAfterSeconds: 30 });
  }

  @Get('locked')
  locked(): never {
    throw new DomainError('login_lockout:locked', {
      details: { locked: true, locked_until: '2026-11-17T10:15:00Z', failed_attempts: 5 },
    });
  }

  @Get('boom')
  boom(): never {
    throw new Error(
      'insert into profiles values (+12015550101) failed; header Bearer abc.def.ghi; ada@example.test',
    );
  }

  @Get('service-unavailable')
  serviceUnavailable(): never {
    throw new ServiceUnavailableException('down');
  }

  @Post('raw-trigger')
  @Operation('invite_circle_member_by_phone')
  rawTrigger(): never {
    throw pgRaise('circle_full');
  }

  @Post('raw-trigger-wrapped')
  @Operation('create_circle_invite_link')
  rawTriggerWrapped(): never {
    throw new Error('Failed query', { cause: pgRaise('circle_full') });
  }

  @Post('raw-trigger-no-operation')
  rawTriggerNoOperation(): never {
    throw pgRaise('circle_full');
  }

  @Post('raw-trigger-other-operation')
  @Operation('remove_circle_member')
  rawTriggerOtherOperation(): never {
    throw pgRaise('circle_full');
  }

  @Post('sql-code')
  sqlCode(): never {
    throw pgRaise('accept_circle_invite:expired');
  }

  @Post('locations')
  @Operation('attach_incident_location')
  locations(
    @ZodBody(locationBody, {
      fields: {
        location_source: 'attach_incident_location:invalid_source',
        location_lat: 'attach_incident_location:invalid_location',
        location_lng: 'attach_incident_location:invalid_location',
      },
    })
    body: z.output<typeof locationBody>,
  ) {
    return body;
  }

  @Post('invites')
  @Operation('invite_circle_members_by_phone')
  invites(
    @ZodBody(z.array(z.object({ phone: z.string(), display_name: z.string() })), {
      fallback: 'invite_circle_members_by_phone:invalid_invites',
    })
    body: unknown,
  ) {
    return { count: Array.isArray(body) ? body.length : 0 };
  }

  @Get('query')
  query(
    @ZodQuery(z.object({ limit: z.coerce.number().int().min(1).max(20) })) q: { limit: number },
  ) {
    return q;
  }

  @Get('param/:id')
  param(@ZodParam('id', z.uuid()) id: string) {
    return { id };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { received: body !== undefined };
  }
}

interface Envelope {
  error: { code: string; message: string; details: Record<string, unknown> };
}

describe('Error envelope (API-100-05)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  const reported: { error: unknown; context: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({ controllers: [ErrorsTestController] }));
    setErrorReporter((error, context) => reported.push({ error, context: { ...context } }));
  });

  afterAll(async () => {
    setErrorReporter(undefined);
    await app.close();
  });

  beforeEach(() => {
    reported.length = 0;
  });

  async function call(method: 'GET' | 'POST', url: string, init: Record<string, unknown> = {}) {
    const res = await app.inject({ method, url, ...init });
    return { res, body: res.json<Envelope>() };
  }

  function expectEnvelope(body: Envelope, code: string, details: Record<string, unknown> = {}) {
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['code', 'message', 'details']);
    expect(body.error.code).toBe(code);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.details).toEqual(details);
  }

  describe('AC1: framework errors use the envelope', () => {
    it('unknown route under /v1 → 404 http:not_found (URL not echoed)', async () => {
      const { res, body } = await call('GET', '/v1/no-such-route?phone=%2B12015550101');
      expect(res.statusCode).toBe(404);
      expectEnvelope(body, 'http:not_found');
      expect(res.body).not.toContain('no-such-route');
      expect(res.headers['content-type']).toContain('application/json');
    });

    it('unknown route outside /v1 → 404 http:not_found', async () => {
      const { res, body } = await call('GET', '/nope');
      expect(res.statusCode).toBe(404);
      expectEnvelope(body, 'http:not_found');
    });

    it('wrong method on an existing path → 404 http:not_found (Fastify has no 405)', async () => {
      const { res, body } = await call('DELETE' as 'GET', '/v1/ping');
      expect(res.statusCode).toBe(404);
      expectEnvelope(body, 'http:not_found');
    });

    it('malformed JSON body → 400 http:bad_request', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/echo', {
        headers: { 'content-type': 'application/json' },
        payload: '{"phone": "+1201555',
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(body, 'http:bad_request');
      expect(res.body).not.toContain('+1201555');
    });

    it('empty JSON body with a JSON content type → 400 http:bad_request', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/echo', {
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expect(res.statusCode).toBe(400);
      expectEnvelope(body, 'http:bad_request');
    });

    it('unsupported content type → 415 http:unsupported_media_type', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/echo', {
        headers: { 'content-type': 'application/xml' },
        payload: '<a/>',
      });
      expect(res.statusCode).toBe(415);
      expectEnvelope(body, 'http:unsupported_media_type');
    });

    it('body over the limit → 413 http:payload_too_large', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/echo', {
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) }),
      });
      expect(res.statusCode).toBe(413);
      expectEnvelope(body, 'http:payload_too_large');
    });
  });

  describe('AC2: domain errors map through the §11.2 table', () => {
    it('invalid_* → 422 with the parity code', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/domain');
      expect(res.statusCode).toBe(422);
      expectEnvelope(body, 'submit_emergency_alert:invalid_type');
      expect(body.error.message).toBe('Choose a valid emergency type.');
    });

    it('rate_limited → 429 with Retry-After', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/rate-limited');
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('30');
      expectEnvelope(body, 'login_lockout:rate_limited');
    });

    it('login_lockout:locked → 423 with LockoutStatus details', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/locked');
      expect(res.statusCode).toBe(423);
      expectEnvelope(body, 'login_lockout:locked', {
        locked: true,
        locked_until: '2026-11-17T10:15:00Z',
        failed_attempts: 5,
      });
    });

    it('a `fn:code` raised by an SQL function maps as-is (accept expired → 410)', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/sql-code');
      expect(res.statusCode).toBe(410);
      expectEnvelope(body, 'accept_circle_invite:expired');
    });
  });

  describe('AC3: raw trigger circle_full gets the operation prefix', () => {
    it('maps to <fn>:circle_full (409) for the @Operation of the route', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/raw-trigger');
      expect(res.statusCode).toBe(409);
      expectEnvelope(body, 'invite_circle_member_by_phone:circle_full');
    });

    it('also when the database error is wrapped (e.g. a Drizzle query error cause)', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/raw-trigger-wrapped');
      expect(res.statusCode).toBe(409);
      expectEnvelope(body, 'create_circle_invite_link:circle_full');
    });

    it('is a 500 when the route declares no operation', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/raw-trigger-no-operation');
      expect(res.statusCode).toBe(500);
      expectEnvelope(body, 'internal:error');
    });

    it('is a 500 when the operation has no circle_full code', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/raw-trigger-other-operation');
      expect(res.statusCode).toBe(500);
      expectEnvelope(body, 'internal:error');
    });
  });

  describe('AC4: request validation → 422', () => {
    it('uses the operation parity code for a declared field', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/locations', {
        payload: { location_source: 'satellite' },
      });
      expect(res.statusCode).toBe(422);
      expectEnvelope(body, 'attach_incident_location:invalid_source', {
        field: 'location_source',
      });
      expect(res.body).not.toContain('satellite');
    });

    it('maps another field of the same operation to its own code', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/locations', {
        payload: { location_source: 'gps', location_lat: 123 },
      });
      expect(res.statusCode).toBe(422);
      expectEnvelope(body, 'attach_incident_location:invalid_location', { field: 'location_lat' });
    });

    it('uses the fallback code when the whole body is wrong', async () => {
      const { res, body } = await call('POST', '/v1/test-errors/invites', {
        payload: { not: 'an array' },
      });
      expect(res.statusCode).toBe(422);
      expectEnvelope(body, 'invite_circle_members_by_phone:invalid_invites', { field: 'body' });
    });

    it('falls back to validation:invalid_request with details.field (query)', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/query?limit=0');
      expect(res.statusCode).toBe(422);
      expectEnvelope(body, 'validation:invalid_request', { field: 'limit' });
    });

    it('names a path parameter in details.field', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/param/not-a-uuid');
      expect(res.statusCode).toBe(422);
      expectEnvelope(body, 'validation:invalid_request', { field: 'id' });
    });

    it('passes valid input through, parsed', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/test-errors/query?limit=5',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ limit: 5 });
    });
  });

  describe('AC5: unexpected errors → 500 internal:error', () => {
    it('hides the message, stack and SQL from the client', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/boom', {
        headers: { 'x-request-id': 'req-boom-1' },
      });
      expect(res.statusCode).toBe(500);
      expectEnvelope(body, 'internal:error');
      expect(res.body).not.toMatch(/insert into|profiles|stack|Bearer|at /);
    });

    it('logs the error with the request id, scrubbed', async () => {
      await call('GET', '/v1/test-errors/boom', { headers: { 'x-request-id': 'req-boom-2' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const line = logs.lines.find(
        (l) => l.msg === 'unexpected error' && l.request_id === 'req-boom-2',
      );
      expect(line).toBeDefined();
      expect(line?.level).toBe('error');
      expect(line?.route).toBe('/v1/test-errors/boom');
      const text = JSON.stringify(line);
      expect(text).toContain('insert into profiles');
      expect((line?.err as { type?: string }).type).toBe('Error');
      expect(text).not.toContain('+12015550101');
      expect(text).not.toContain('abc.def.ghi');
      expect(text).not.toContain('ada@example.test');
    });

    it('reports it to the error reporter (Sentry) with the request id', async () => {
      await call('GET', '/v1/test-errors/boom', { headers: { 'x-request-id': 'req-boom-3' } });
      expect(reported).toHaveLength(1);
      expect(reported[0]?.context).toMatchObject({
        request_id: 'req-boom-3',
        route: '/v1/test-errors/boom',
        method: 'GET',
      });
    });

    it('treats a deliberate 5xx HttpException as internal:error too', async () => {
      const { res, body } = await call('GET', '/v1/test-errors/service-unavailable');
      expect(res.statusCode).toBe(500);
      expectEnvelope(body, 'internal:error');
    });

    it('does not report expected (4xx) errors', async () => {
      await call('GET', '/v1/test-errors/domain');
      await call('GET', '/v1/missing');
      expect(reported).toHaveLength(0);
    });
  });

  it('keeps the request id header on error responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/missing',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });
});
