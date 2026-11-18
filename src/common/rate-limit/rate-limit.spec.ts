import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type { ApiConfigService } from '../../config';
import { parseConfig } from '../../config';
import { routeContractProblems } from '../guards/route-contract';
import { clientIp, isTrustProxyOn } from '../http/client-ip';
import type { RedisService } from '../../redis/redis.service';
import { namedPolicy, scopeOfRule } from './rate-limit.policies';
import { RATE_LIMIT_OUTAGE_LOG_COOLDOWN_MS, RateLimiterService } from './rate-limiter.service';

const configFrom = (env: Record<string, string> = {}) => {
  const config = parseConfig(env);
  return { get: (key: keyof typeof config) => config[key] } as unknown as ApiConfigService;
};

function fakeLogger() {
  return { warn: jest.fn(), info: jest.fn() } as unknown as Logger & {
    warn: jest.Mock;
    info: jest.Mock;
  };
}

type Consume = (...args: unknown[]) => Promise<number[]>;

function limiterWith(consume: Consume, env: Record<string, string> = {}) {
  const logger = fakeLogger();
  const client = { defineCommand: jest.fn(), atlasRateLimitConsume: consume };
  const redis = { client } as unknown as RedisService;
  return { limiter: new RateLimiterService(redis, configFrom(env), logger), logger };
}

describe('Rate limit policies (API-100-11 AC2)', () => {
  it.each([
    ['authenticated', 300, 60, 'user'],
    ['public', 60, 300, 'ip'],
    ['location_ping', 30, 60, 'user_incident'],
    ['emergency_write', 30, 60, 'user'],
    ['auth_failure', 120, 60, 'ip'],
  ] as const)('%s defaults to %i per %i s, keyed by %s', (name, max, windowSeconds, scope) => {
    expect(namedPolicy(name, configFrom())).toEqual({ name, max, windowSeconds, scope });
  });

  it('every default is configurable', () => {
    const policy = namedPolicy(
      'emergency_write',
      configFrom({
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '7',
        RATE_LIMIT_EMERGENCY_WRITE_WINDOW_SECONDS: '9',
      }),
    );
    expect(policy).toMatchObject({ max: 7, windowSeconds: 9 });
  });

  it.each(['0', '-1', 'abc', '1.5'])('rejects %s as a limit, naming only the key', (value) => {
    expect(() => parseConfig({ RATE_LIMIT_PUBLIC_MAX: value })).toThrow(/RATE_LIMIT_PUBLIC_MAX/);
  });

  it('scope of a rule', () => {
    expect(scopeOfRule(undefined)).toBeUndefined();
    expect(scopeOfRule('location_ping')).toBe('user_incident');
    expect(scopeOfRule({ name: 'x', max: 1, windowSeconds: 1, scope: 'ip' })).toBe('ip');
  });
});

describe('Route contract for rate limits (API-100-11)', () => {
  const route = { name: 'C.m', operation: 'ping' as const };

  it('refuses a per-user limit on a public route', () => {
    const problems = routeContractProblems([
      { ...route, isPublic: true, rateLimitScope: 'user' },
      { ...route, isPublic: true, rateLimitScope: 'user_incident' },
    ]);
    expect(problems).toHaveLength(2);
  });

  it('refuses @RateLimit together with @SkipRateLimit', () => {
    expect(
      routeContractProblems([
        { ...route, isPublic: false, rateLimitScope: 'user', skipRateLimit: true },
      ]),
    ).toHaveLength(1);
  });

  it('accepts a per-IP limit on a public route', () => {
    expect(routeContractProblems([{ ...route, isPublic: true, rateLimitScope: 'ip' }])).toEqual([]);
  });
});

describe('Client IP (API-100-11 AC3)', () => {
  const request = (forwardedFor: string | undefined, socket = '203.0.113.9') =>
    ({
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
      raw: { socket: { remoteAddress: socket } },
    }) as unknown as FastifyRequest;

  it.each([
    [true, true],
    [1, true],
    [['10.0.0.0/8'], true],
    [false, false],
    [0, false],
  ])('TRUST_PROXY %j is on: %s', (value, on) => {
    expect(isTrustProxyOn(value as never)).toBe(on);
  });

  it('on: the first value only', () => {
    expect(clientIp(request('198.51.100.1, 10.0.0.1, 10.0.0.2'), true)).toBe('198.51.100.1');
  });

  it('on: IPv6, and IPv4-mapped addresses are normalized', () => {
    expect(clientIp(request('2001:DB8::1'), true)).toBe('2001:db8::1');
    expect(clientIp(request('::ffff:198.51.100.7'), true)).toBe('198.51.100.7');
  });

  it('on: no header or an invalid first value → socket address', () => {
    expect(clientIp(request(undefined), true)).toBe('203.0.113.9');
    expect(clientIp(request('garbage, 198.51.100.1'), true)).toBe('203.0.113.9');
  });

  it('off: the header is ignored', () => {
    expect(clientIp(request('198.51.100.1'), false)).toBe('203.0.113.9');
  });

  it('a mapped socket address is normalized', () => {
    expect(clientIp(request(undefined, '::ffff:203.0.113.5'), false)).toBe('203.0.113.5');
  });
});

describe('RateLimiterService failing open (API-100-11)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('maps the script reply', async () => {
    const { limiter } = limiterWith(() => Promise.resolve([0, 0, 1500]));
    expect(await limiter.consume('k', 1, 60)).toEqual({
      allowed: false,
      remaining: 0,
      retryAfterMs: 1500,
    });
  });

  it('passes the window in microseconds and a unique entry per request', async () => {
    const consume = jest.fn<Promise<number[]>, unknown[]>(() => Promise.resolve([1, 4, 0]));
    const { limiter } = limiterWith(consume);
    await limiter.consume('k', 5, 60);
    await limiter.consume('k', 5, 60);
    expect(consume.mock.calls[0].slice(0, 3)).toEqual(['k', 5, 60_000_000]);
    expect(consume.mock.calls[0][3]).not.toEqual(consume.mock.calls[1][3]);
  });

  it('a Redis error admits the request', async () => {
    const { limiter } = limiterWith(() => Promise.reject(new Error('Connection is closed.')));
    expect((await limiter.consume('k', 1, 60)).allowed).toBe(true);
  });

  it('Redis not configured admits the request', async () => {
    const redis = {
      get client(): never {
        throw new Error('REDIS_URL is not set');
      },
    } as unknown as RedisService;
    const limiter = new RateLimiterService(redis, configFrom(), fakeLogger());
    expect((await limiter.consume('k', 1, 60)).allowed).toBe(true);
  });

  it('a command slower than the timeout admits the request, and its late failure is handled', async () => {
    let rejectLate: (error: Error) => void = () => undefined;
    const { limiter } = limiterWith(
      () => new Promise((_resolve, reject) => (rejectLate = reject)),
      { RATE_LIMIT_REDIS_TIMEOUT_MS: '5' },
    );
    expect((await limiter.consume('k', 1, 60)).allowed).toBe(true);
    rejectLate(new Error('late'));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('logs one warning per outage and one line when it ends', async () => {
    let healthy = false;
    const { limiter, logger } = limiterWith(() =>
      healthy ? Promise.resolve([1, 0, 0]) : Promise.reject(new Error('down')),
    );
    await Promise.all(Array.from({ length: 50 }, () => limiter.consume('k', 1, 60)));
    await limiter.consume('k', 1, 60);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    healthy = true;
    await limiter.consume('k', 1, 60);
    await limiter.consume('k', 1, 60);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('a flapping Redis warns again only after the cooldown', async () => {
    let healthy = false;
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { limiter, logger } = limiterWith(() =>
      healthy ? Promise.resolve([1, 0, 0]) : Promise.reject(new Error('down')),
    );
    const flap = async () => {
      healthy = false;
      await limiter.consume('k', 1, 60);
      healthy = true;
      await limiter.consume('k', 1, 60);
    };
    await flap();
    await flap();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    now.mockReturnValue(1_000_000 + RATE_LIMIT_OUTAGE_LOG_COOLDOWN_MS);
    await flap();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
