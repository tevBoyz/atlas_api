import { randomUUID } from 'node:crypto';

import { Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { createTestApp, type LogCapture } from '../../testing/test-app';
import { authHeader, signTestToken } from '../../testing/test-tokens';
import { type AuthenticatedUser, CurrentUser } from '../auth/authenticated-user';
import { TOKEN_VERIFIER, type TokenVerifier } from '../auth/token-verifier';
import { Operation } from '../errors/operation';
import { Public } from './route-access';

/** Test-only routes (never registered in the production app). */
@Controller('test-auth')
class AuthTestController {
  @Post('incidents')
  @Operation('submit_emergency_alert')
  submit(@CurrentUser() user: AuthenticatedUser) {
    return { user_id: user.id, session_id: user.sessionId };
  }

  @Get('open')
  @Operation('get_my_open_incident')
  open(@CurrentUser() user: AuthenticatedUser) {
    return { user_id: user.id };
  }

  @Get('public')
  @Public()
  open_status() {
    return { status: 'public' };
  }

  @Get('public-current-user')
  @Public()
  publicCurrentUser(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}

describe('AuthGuard (API-100-08)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({ controllers: [AuthTestController] }));
  });

  afterAll(async () => {
    await app.close();
  });

  const submit = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/v1/test-auth/incidents', headers });

  function expect401(res: Awaited<ReturnType<typeof submit>>, code: string) {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code, message: 'Sign in to continue.', details: {} } });
  }

  describe('valid token', () => {
    it('runs the handler with the caller from sub (AC3)', async () => {
      const sub = randomUUID();
      const sessionId = randomUUID();
      const res = await submit(await authHeader(sub, { claims: { session_id: sessionId } }));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ user_id: sub, session_id: sessionId });
    });

    it('does not need any database row (no auth.users / profiles lookup)', async () => {
      // Unit tests run without a database: a valid token for an unknown user still passes.
      const res = await submit(await authHeader(randomUUID()));
      expect(res.statusCode).toBe(201);
    });
  });

  describe('401 with the route parity code <fn>:not_authenticated (AC1, AC4, AC6)', () => {
    it('missing header', async () => {
      expect401(await submit(), 'submit_emergency_alert:not_authenticated');
    });

    it.each([
      ['wrong scheme', 'Basic dXNlcjpwYXNz'],
      ['no token', 'Bearer'],
      ['not a JWT', 'Bearer not-a-jwt'],
      ['empty', ''],
    ])('malformed header: %s', async (_name, authorization) => {
      expect401(await submit({ authorization }), 'submit_emergency_alert:not_authenticated');
    });

    it('expired token', async () => {
      const token = await signTestToken({ expiresInSeconds: -120 });
      expect401(
        await submit({ authorization: `Bearer ${token}` }),
        'submit_emergency_alert:not_authenticated',
      );
    });

    it('bad signature', async () => {
      const token = await signTestToken({ secret: 'y'.repeat(40) });
      expect401(
        await submit({ authorization: `Bearer ${token}` }),
        'submit_emergency_alert:not_authenticated',
      );
    });

    it('wrong audience', async () => {
      const token = await signTestToken({ claims: { aud: 'other' } });
      expect401(
        await submit({ authorization: `Bearer ${token}` }),
        'submit_emergency_alert:not_authenticated',
      );
    });

    it('anon role', async () => {
      const token = await signTestToken({ claims: { role: 'anon' } });
      expect401(
        await submit({ authorization: `Bearer ${token}` }),
        'submit_emergency_alert:not_authenticated',
      );
    });

    it('each route answers with its own operation code', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/test-auth/open' });
      expect401(res, 'get_my_open_incident:not_authenticated');
    });

    it('the emergency submit route is authenticated too', async () => {
      expect401(
        await app.inject({ method: 'POST', url: '/v1/incidents' }),
        'submit_emergency_alert:not_authenticated',
      );
    });

    it('never writes the token to the logs', async () => {
      const token = await signTestToken({ expiresInSeconds: -120 });
      await submit({ authorization: `Bearer ${token}` });
      const [, , signature] = token.split('.');
      expect(logs.text).not.toContain(signature);
    });
  });

  describe('public routes', () => {
    it('need no token', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/test-auth/public' });
      expect(res.statusCode).toBe(200);
    });

    it('ignore an invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/test-auth/public',
        headers: { authorization: 'Bearer junk' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/healthz stays public', async () => {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    });

    it('@CurrentUser() on a public route is a programming error (500)', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/test-auth/public-current-user' });
      expect(res.statusCode).toBe(500);
    });
  });
});

describe('AuthGuard when the verifier cannot check tokens (API-100-08)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const unavailable: TokenVerifier = {
      verify: () => Promise.reject(new Error('JWKS endpoint unreachable')),
    };
    ({ app } = await createTestApp({ controllers: [AuthTestController] }, (builder) =>
      builder.overrideProvider(TOKEN_VERIFIER).useValue(unavailable),
    ));
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 500 internal:error, not 401 (a key-server outage must not sign users out)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/test-auth/incidents',
      headers: await authHeader(randomUUID()),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('internal:error');
  });
});
