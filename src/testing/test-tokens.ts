import { randomUUID } from 'node:crypto';

import { type CryptoKey, type JWTPayload, type KeyObject, SignJWT } from 'jose';

import type { LocalSigningKey } from './local-jwks';
import { TEST_JWT_AUDIENCE, TEST_JWT_ISSUER, TEST_JWT_SECRET } from './test-auth-config';

/**
 * Token factory for tests (API-100-08, API-100-13 AC3). Signs Supabase-shaped access tokens with a
 * LOCAL key: the HS256 test secret by default, or a generated asymmetric key (`privateKey` + `alg` +
 * `kid`) for JWKS tests. {@link createTokenFactory} binds one key for a whole suite.
 */
export interface TestTokenOptions {
  /** Claims to add or override. Set a claim to `undefined` to leave it out. */
  claims?: Record<string, unknown>;
  /** Seconds from now until `exp` (negative = already expired). Default 3600. */
  expiresInSeconds?: number;
  /** HS256 secret. Default the test secret. Ignored when `privateKey` is given. */
  secret?: string;
  privateKey?: CryptoKey | KeyObject;
  /** Algorithm for `privateKey` (e.g. ES256, RS256). */
  alg?: string;
  kid?: string;
}

/** Default Supabase access-token claims for a user (role authenticated). */
export function supabaseClaims(sub: string = randomUUID()): Record<string, unknown> {
  return {
    sub,
    aud: TEST_JWT_AUDIENCE,
    iss: TEST_JWT_ISSUER,
    role: 'authenticated',
    aal: 'aal1',
    session_id: randomUUID(),
    is_anonymous: false,
  };
}

export async function signTestToken(options: TestTokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const merged: Record<string, unknown> = {
    ...supabaseClaims(),
    iat: now,
    exp: now + (options.expiresInSeconds ?? 3600),
    ...options.claims,
  };
  const payload = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as JWTPayload;
  const jwt = new SignJWT(payload);
  if (options.privateKey) {
    jwt.setProtectedHeader({ alg: options.alg ?? 'ES256', kid: options.kid, typ: 'JWT' });
    return jwt.sign(options.privateKey);
  }
  jwt.setProtectedHeader({ alg: 'HS256', kid: options.kid, typ: 'JWT' });
  return jwt.sign(new TextEncoder().encode(options.secret ?? TEST_JWT_SECRET));
}

/** `{ authorization: 'Bearer <token>' }` for a test user. */
export async function authHeader(
  sub: string,
  options: TestTokenOptions = {},
): Promise<{ authorization: string }> {
  const token = await signTestToken({ ...options, claims: { sub, ...options.claims } });
  return { authorization: `Bearer ${token}` };
}

/** Signs tokens for any user with one fixed key. */
export interface TokenFactory {
  token(sub: string, options?: TestTokenOptions): Promise<string>;
  header(sub: string, options?: TestTokenOptions): Promise<{ authorization: string }>;
}

/**
 * A {@link TokenFactory} for one key. Default: the HS256 test secret the guard trusts in tests.
 * Pass a `generateSigningKey()` result (`src/testing/local-jwks.ts`) for an asymmetric JWKS key.
 */
export function createTokenFactory(
  key?: Pick<LocalSigningKey, 'privateKey' | 'alg' | 'kid'>,
): TokenFactory {
  const signing: TestTokenOptions = key
    ? { privateKey: key.privateKey, alg: key.alg, kid: key.kid }
    : {};
  return {
    token: (sub, options = {}) =>
      signTestToken({ ...signing, ...options, claims: { sub, ...options.claims } }),
    header: (sub, options = {}) => authHeader(sub, { ...signing, ...options }),
  };
}
