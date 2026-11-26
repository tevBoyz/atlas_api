import { createHash, randomUUID } from 'node:crypto';

import { importJWK, type JWTPayload, SignJWT } from 'jose';

import type { TestingModuleBuilder } from '@nestjs/testing';

import { ACCESS_TOKEN_TYPE } from '../common/auth/atlas-token-verifier';
import { SESSION_STATUS_READER, type SessionStatusReader } from '../common/auth/session-status';
import { parseJwtKeys } from '../config/jwt-keys';

/**
 * Token factory for tests (API-100-08, API-100-13 AC3; own tokens only since D76). Signs the API's
 * OWN access tokens (`typ` at+jwt, claims `iss`, `aud`, `sub`, `sid`, `iat`, `exp`) with the
 * throwaway key set the test setup puts in AUTH_JWT_KEYS / AUTH_JWT_ACTIVE_KID
 * (`test-auth-keys.ts`), exactly as `AccessTokenSigner` does. Nothing here is real key material.
 *
 * The guard also checks the token's session (`device_sessions`, API-100-51 AC3). Every test user
 * gets one fixed session id ({@link testSessionId}); {@link authHeader} first asks the registered
 * {@link setTestSessionSeeder} hook (the integration suites register one that writes the
 * `users` / `device_sessions` rows into the worker's database) so the token is accepted. Unit tests
 * without a database replace the session reader instead.
 */
export interface TestTokenOptions {
  /** Claims to add or override (e.g. `sid`, `aud`). Set a claim to `undefined` to leave it out. */
  claims?: Record<string, unknown>;
  /** Seconds from now until `exp` (negative = already expired). Default 3600. */
  expiresInSeconds?: number;
  /** Sign with this private JWK (with `kid`) instead of the active test key, e.g. an unknown key. */
  jwk?: Record<string, string>;
  /** Header `typ`. Default at+jwt. */
  typ?: string;
}

/** The fixed test session id of a user: a uuid derived from the user id. */
export function testSessionId(userId: string): string {
  const hex = createHash('sha256')
    .update(`atlas-test-session:${userId.toLowerCase()}`)
    .digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Writes what the guard needs for a user's test session (the user row, the live session). */
export type TestSessionSeeder = (userId: string, sessionId: string) => Promise<void>;

let seeder: TestSessionSeeder | undefined;

/** Registers (or, with `undefined`, removes) the hook {@link authHeader} calls before signing. */
export function setTestSessionSeeder(hook: TestSessionSeeder | undefined): void {
  seeder = hook;
}

function activeKey(): { jwk: Record<string, string>; alg: string; kid: string } {
  const raw = process.env.AUTH_JWT_KEYS;
  const kid = process.env.AUTH_JWT_ACTIVE_KID;
  if (!raw || !kid) {
    throw new Error(
      'AUTH_JWT_KEYS / AUTH_JWT_ACTIVE_KID are not set (test-auth-keys.ts sets them)',
    );
  }
  const { active } = parseJwtKeys(raw, kid);
  return { jwk: active.privateJwk!, alg: active.alg, kid: active.kid };
}

function algOf(jwk: Record<string, string>): string {
  return jwk.kty === 'OKP' ? 'EdDSA' : 'ES256';
}

export async function signTestToken(options: TestTokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const sub = (options.claims?.sub as string | undefined) ?? randomUUID();
  const merged: Record<string, unknown> = {
    iss: process.env.AUTH_JWT_ISSUER ?? 'atlas-api',
    aud: process.env.AUTH_JWT_AUDIENCE ?? 'atlas-app',
    sub,
    sid: testSessionId(sub),
    iat: now,
    exp: now + (options.expiresInSeconds ?? 3600),
    ...options.claims,
  };
  const payload = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as JWTPayload;
  const signing = options.jwk
    ? { jwk: options.jwk, alg: algOf(options.jwk), kid: options.jwk.kid }
    : activeKey();
  const key = await importJWK(signing.jwk, signing.alg);
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: signing.alg,
      kid: signing.kid,
      typ: options.typ ?? ACCESS_TOKEN_TYPE,
    })
    .sign(key);
}

/**
 * `{ authorization: 'Bearer <token>' }` for a test user: seeds the user's test session first (when a
 * seeder is registered and the token uses the default `sid`), then signs.
 */
export async function authHeader(
  sub: string,
  options: TestTokenOptions = {},
): Promise<{ authorization: string }> {
  const sid = options.claims && 'sid' in options.claims ? options.claims.sid : testSessionId(sub);
  if (seeder && typeof sid === 'string' && sid === testSessionId(sub)) await seeder(sub, sid);
  const token = await signTestToken({ ...options, claims: { sub, ...options.claims } });
  return { authorization: `Bearer ${token}` };
}

/** Session reader for unit tests (no database): live exactly for each user's fixed test session. */
export const testSessionReader: SessionStatusReader = {
  stateOf: (sessionId, userId) =>
    Promise.resolve(sessionId === testSessionId(userId) ? 'live' : 'unknown'),
};

/** For `createTestApp`'s `override` in unit tests: the guard accepts {@link authHeader} tokens. */
export function withTestSessions(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(SESSION_STATUS_READER).useValue(testSessionReader);
}
