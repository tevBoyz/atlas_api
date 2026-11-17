import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PinoLogger } from 'nestjs-pino';
import pino from 'pino';

import { createTestApp, LogCapture } from '../testing/test-app';
import { rootLoggerOptions } from './logger';

/** Fake values only. Distinctive so a leak anywhere in the log text is easy to detect. */
/** Fake JWT-shaped value, assembled at runtime so secret scanners do not flag the source. */
const TOKEN = [
  'eyJhbGciOiJIUzI1NiJ9',
  'eyJzdWIiOiJMRUFLLVRPS0VOIn0',
  'ZmFrZS1zaWduYXR1cmUtTEVBSw',
].join('.');
const PHONE = '+12015550188';
const PHONE_DIGITS = '2015550188';

@Controller('test-logging')
class LoggingTestController {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  /** A handler that (wrongly) logs everything it receives: the scrubber must still catch it. */
  @Post('careless/:id')
  careless(@Body() body: unknown, @Query() query: unknown) {
    this.logger.info({ body, query }, `handling request for ${PHONE}`);
    return { ok: true };
  }

  @Get('quiet')
  quiet() {
    this.logger.info('service log line');
    return { ok: true };
  }
}

/** Fastify runs onResponse hooks after inject() resolves: let them finish before reading logs. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Structured logging (API-100-06)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({ controllers: [LoggingTestController] }));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logs.raw.length = 0;
  });

  describe('DoD: a request with a token and a phone number logs neither', () => {
    it.each([
      ['an ordinary route', 'POST', '/v1/test-logging/careless/1'],
      ['an unknown route (404)', 'POST', '/v1/no-such-route'],
      // /healthz and /readyz log at debug only (API-100-07); see health.controller.spec.ts.
      ['an unknown unprefixed route (404)', 'GET', '/no-such-root-route'],
    ] as const)('%s', async (_label, method, path) => {
      const res = await app.inject({
        method,
        url: `${path}?phone=${encodeURIComponent(PHONE)}&access_token=${TOKEN}`,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'x-phone': PHONE,
          cookie: `sb-access-token=${TOKEN}`,
          'x-request-id': 'dod-request-1',
        },
        ...(method === 'POST'
          ? { payload: { phone: PHONE, password: 'Secret123', emergency_contact_phone: PHONE } }
          : {}),
      });
      await settle();
      expect(res.statusCode).toBeLessThan(500);

      const text = logs.text;
      expect(logs.lines.length).toBeGreaterThan(0);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(PHONE_DIGITS);
      expect(text).not.toContain('Secret123');
      expect(text.toLowerCase()).not.toContain('authorization');
    });
  });

  it('every line of a request carries its request id (given)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test-logging/careless/1',
      headers: { 'x-request-id': 'trace-me-42' },
      payload: {},
    });
    await settle();
    expect(res.headers['x-request-id']).toBe('trace-me-42');
    const lines = logs.lines;
    expect(lines.map((l) => l.msg)).toEqual(
      expect.arrayContaining(['handling request for ***88', 'request completed']),
    );
    for (const line of lines) expect(line.request_id).toBe('trace-me-42');
  });

  it('generates a request id when none is given and uses it in the header and logs', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/test-logging/quiet' });
    await settle();
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const lines = logs.lines;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.request_id).toBe(id);
  });

  it('replaces an invalid incoming request id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/test-logging/quiet',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    await settle();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs one completion line per request with route template, status and duration', async () => {
    await app.inject({ method: 'POST', url: '/v1/test-logging/careless/77', payload: {} });
    await settle();
    const done = logs.lines.filter((l) => l.msg === 'request completed');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      level: 'info',
      method: 'POST',
      route: '/v1/test-logging/careless/:id',
      status_code: 201,
      service: 'atlas-api',
    });
    expect(typeof done[0]?.duration_ms).toBe('number');
    expect(typeof done[0]?.time).toBe('string');
    expect(JSON.stringify(done[0])).not.toContain('/77');
  });

  it('logs a null route for unmatched requests (raw path not logged)', async () => {
    await app.inject({ method: 'GET', url: '/v1/invites/secret-invite-token-xyz' });
    await settle();
    const done = logs.lines.find((l) => l.msg === 'request completed');
    expect(done).toMatchObject({ route: null, status_code: 404 });
    expect(logs.text).not.toContain('secret-invite-token-xyz');
  });
});

describe('LOG_LEVEL', () => {
  function linesAt(level: Parameters<typeof rootLoggerOptions>[0]): string {
    const capture = new LogCapture();
    const logger = pino(rootLoggerOptions(level), capture);
    logger.debug('debug line');
    logger.info('info line');
    logger.warn('warn line');
    return capture.text;
  }

  it('info hides debug', () => {
    const text = linesAt('info');
    expect(text).not.toContain('debug line');
    expect(text).toContain('info line');
  });

  it('warn hides info', () => {
    const text = linesAt('warn');
    expect(text).not.toContain('info line');
    expect(text).toContain('warn line');
  });

  it('debug shows debug', () => {
    expect(linesAt('debug')).toContain('debug line');
  });

  it('silent writes nothing', () => {
    expect(linesAt('silent')).toBe('');
  });

  it('scrubs a leading Error argument and keeps it under err', () => {
    const capture = new LogCapture();
    pino(rootLoggerOptions('info'), capture).error(new Error(`boom ${PHONE}`), 'failed');
    const [line] = capture.lines;
    expect(line?.msg).toBe('failed');
    expect((line?.err as { message: string }).message).toBe('boom ***88');
  });
});
