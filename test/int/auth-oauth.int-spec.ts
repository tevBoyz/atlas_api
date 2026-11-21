import { createHash, randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT } from 'jose';
import type { Client } from 'pg';

import {
  generateSigningKey,
  LocalJwksServer,
  type LocalSigningKey,
} from '../../src/testing/local-jwks';
import {
  createAuthApp,
  DEVICE,
  errorOf,
  fakeEmail,
  post,
  type SessionBody,
  signedUpUser,
} from '../support/auth-api';
import { openTestClient } from '../support/database';

/**
 * API-100-55: Google and Apple sign-in with ID tokens verified against a FAKE JWKS endpoint on
 * 127.0.0.1 (the JWKS URLs are config; no test ever calls Google or Apple). Linking by
 * `(provider, sub)`, D6 auto-link only for a verified email, `is_new_user`, Google clearing the
 * lockout, Apple disabled by default (503) and its nonce, the error codes and the response time.
 */
const GOOGLE_IDS = 'web.apps.example,ios.apps.example';
const APPLE_IDS = 'test.example.atlas';

interface OAuthBody extends SessionBody {
  is_new_user: boolean;
}

async function idToken(
  key: LocalSigningKey,
  claims: Record<string, unknown>,
  options: { kid?: string; expiresIn?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.fromEntries(
    Object.entries({
      iss: 'https://accounts.google.com',
      aud: 'web.apps.example',
      iat: now,
      exp: now + (options.expiresIn ?? 600),
      ...claims,
    }).filter(([, v]) => v !== undefined),
  );
  return new SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: options.kid ?? key.kid, typ: 'JWT' })
    .sign(key.privateKey);
}

describe('Google and Apple sign-in (API-100-55)', () => {
  const jwks = new LocalJwksServer();
  let jwksUrl: string;
  let key: LocalSigningKey;
  let other: LocalSigningKey;
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    key = await generateSigningKey('google-test-1', 'RS256');
    other = await generateSigningKey('google-test-1', 'RS256');
    jwks.keys = [key.jwk];
    jwksUrl = await jwks.start();
    ({ app } = await createAuthApp({ GOOGLE_CLIENT_IDS: GOOGLE_IDS, GOOGLE_JWKS_URL: jwksUrl }));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
    await jwks.stop();
  });

  const google = (token: string) =>
    post(app, '/v1/auth/oauth/google', {
      id_token: token,
      access_token: 'ignored',
      device: DEVICE,
    });

  it('a new Google user → 200 is_new_user, email confirmed when Google verified it, identity google', async () => {
    const email = fakeEmail('google');
    const sub = `g-${randomUUID()}`;
    const started = Date.now();
    const res = await google(await idToken(key, { sub, email, email_verified: true }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.statusCode).toBe(200);
    const body = res.json<OAuthBody>();
    expect(body.is_new_user).toBe(true);
    expect(body.user.email).toBe(email);
    expect(body.user.email_confirmed_at).toEqual(expect.any(String));
    expect((body.user.identities as { provider: string }[]).map((i) => i.provider)).toEqual([
      'google',
    ]);
    const again = await google(await idToken(key, { sub, email, email_verified: true }));
    expect(again.json<OAuthBody>()).toMatchObject({
      is_new_user: false,
      user: { id: body.user.id },
    });
    const { rows } = await client.query<{ auth_method: string }>(
      'select auth_method from public.device_sessions where id = $1',
      [body.session_id],
    );
    expect(rows[0].auth_method).toBe('google');
  });

  it('D6: an existing account with the same email is linked when the email is verified; lockout cleared', async () => {
    const { email, session } = await signedUpUser(app);
    await client.query(
      `insert into public.login_lockouts (email, failed_attempts, last_failed_at) values ($1, 3, now())`,
      [email],
    );
    const res = await google(
      await idToken(key, { sub: `g-${randomUUID()}`, email, email_verified: 'true' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json<OAuthBody>();
    expect(body).toMatchObject({ is_new_user: false, user: { id: session.user.id } });
    expect((body.user.identities as { provider: string }[]).map((i) => i.provider).sort()).toEqual([
      'email',
      'google',
    ]);
    const { rows } = await client.query('select 1 from public.login_lockouts where email = $1', [
      email,
    ]);
    expect(rows).toHaveLength(0);
    const { rows: audit } = await client.query<{ n: number }>(
      `select count(*)::int as n from public.audit_log where action = 'auth.identity.linked' and target_id = $1`,
      [session.user.id],
    );
    expect(audit[0].n).toBe(1);
  });

  it('D6: an unverified email of an existing account → 409 auth:identity_conflict, nothing linked', async () => {
    const { email, session } = await signedUpUser(app);
    for (const verified of [false, undefined]) {
      const res = await google(
        await idToken(key, { sub: `g-${randomUUID()}`, email, email_verified: verified }),
      );
      expect([res.statusCode, errorOf(res).code]).toEqual([409, 'auth:identity_conflict']);
      expect(errorOf(res).message).not.toContain('exist');
    }
    const { rows } = await client.query(
      `select 1 from public.user_identities where user_id = $1 and provider = 'google'`,
      [session.user.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('accepts any configured client id as aud (Web / iOS); a token without email still signs in', async () => {
    const res = await google(
      await idToken(key, { sub: `g-${randomUUID()}`, aud: 'ios.apps.example' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json<OAuthBody>()).toMatchObject({ is_new_user: true, user: { email: null } });
  });

  it.each<[string, () => Promise<string>]>([
    ['another audience', () => idToken(key, { sub: 's', aud: 'someone-else' })],
    ['another issuer', () => idToken(key, { sub: 's', iss: 'https://evil.example' })],
    ['an expired token', () => idToken(key, { sub: 's' }, { expiresIn: -120 })],
    ['an unknown key id', () => idToken(key, { sub: 's' }, { kid: 'nope' })],
    ['a forged signature', () => idToken(other, { sub: 's' })],
    ['no sub', () => idToken(key, { sub: undefined })],
    ['garbage', () => Promise.resolve('not-a-token')],
  ])('%s → 401 auth:oauth_invalid_token', async (_label, make) => {
    const res = await google(await make());
    expect([res.statusCode, errorOf(res).code]).toEqual([401, 'auth:oauth_invalid_token']);
  });

  it('Apple is disabled by default → 503 auth:provider_disabled', async () => {
    const res = await post(app, '/v1/auth/oauth/apple', { id_token: 'x', device: DEVICE });
    expect([res.statusCode, errorOf(res).code]).toEqual([503, 'auth:provider_disabled']);
  });

  describe('other configurations', () => {
    let off: NestFastifyApplication;
    let unreachable: NestFastifyApplication;
    let apple: NestFastifyApplication;

    beforeAll(async () => {
      ({ app: off } = await createAuthApp());
      ({ app: unreachable } = await createAuthApp({
        GOOGLE_CLIENT_IDS: GOOGLE_IDS,
        GOOGLE_JWKS_URL: 'http://127.0.0.1:9/certs',
      }));
      ({ app: apple } = await createAuthApp({
        APPLE_SIGN_IN_ENABLED: 'true',
        APPLE_CLIENT_IDS: APPLE_IDS,
        APPLE_JWKS_URL: jwksUrl,
      }));
    });

    afterAll(async () => {
      await Promise.all([off.close(), unreachable.close(), apple.close()]);
    });

    it('Google without client ids → 503 auth:provider_disabled', async () => {
      const res = await post(off, '/v1/auth/oauth/google', { id_token: 'x', device: DEVICE });
      expect([res.statusCode, errorOf(res).code]).toEqual([503, 'auth:provider_disabled']);
    });

    it('Google keys unreachable → 503 auth:provider_unavailable (not a sign-out reason)', async () => {
      const res = await post(unreachable, '/v1/auth/oauth/google', {
        id_token: await idToken(key, { sub: 's' }),
        device: DEVICE,
      });
      expect([res.statusCode, errorOf(res).code]).toEqual([503, 'auth:provider_unavailable']);
    });

    it('Apple when enabled: nonce = SHA-256 of the raw nonce; full name kept for a new user; no lockout clear', async () => {
      const raw = randomUUID();
      const hashed = createHash('sha256').update(raw).digest('hex');
      const email = fakeEmail('apple');
      const appleToken = (claims: Record<string, unknown>) =>
        idToken(key, { iss: 'https://appleid.apple.com', aud: APPLE_IDS, ...claims });
      const sub = `a-${randomUUID()}`;
      await client.query(
        `insert into public.login_lockouts (email, failed_attempts, last_failed_at) values ($1, 2, now())`,
        [email],
      );
      const ok = await post(apple, '/v1/auth/oauth/apple', {
        id_token: await appleToken({ sub, email, email_verified: 'true', nonce: hashed }),
        nonce: raw,
        full_name: 'Apple Example',
        device: DEVICE,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<OAuthBody>().is_new_user).toBe(true);
      const { rows } = await client.query<{ metadata: Record<string, unknown> }>(
        'select metadata from public.users where email = $1',
        [email],
      );
      expect(rows[0].metadata).toMatchObject({ full_name: 'Apple Example', provider: 'apple' });
      const { rows: lock } = await client.query(
        'select 1 from public.login_lockouts where email = $1',
        [email],
      );
      expect(lock).toHaveLength(1);

      for (const [tokenNonce, bodyNonce] of [
        [hashed, 'wrong'],
        [hashed, undefined],
        [undefined, raw],
      ] as const) {
        const res = await post(apple, '/v1/auth/oauth/apple', {
          id_token: await appleToken({ sub, nonce: tokenNonce }),
          nonce: bodyNonce,
          device: DEVICE,
        });
        expect([res.statusCode, errorOf(res).code]).toEqual([401, 'auth:oauth_invalid_token']);
      }
      const googleIssuer = await post(apple, '/v1/auth/oauth/apple', {
        id_token: await idToken(key, { sub, aud: APPLE_IDS }),
        device: DEVICE,
      });
      expect(googleIssuer.statusCode).toBe(401);
    });
  });
});
