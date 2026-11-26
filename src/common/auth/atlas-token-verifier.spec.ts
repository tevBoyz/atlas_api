import { randomUUID } from 'node:crypto';

import { decodeJwt, decodeProtectedHeader, importJWK, SignJWT } from 'jose';

import { AccessTokenSigner } from '../../modules/auth/access-tokens';
import { throwawayJwk } from '../../testing/test-auth-keys';
import { AtlasKeyRing } from './atlas-key-ring';
import { ACCESS_TOKEN_TYPE, AtlasTokenVerifier } from './atlas-token-verifier';
import type { SessionState, SessionStatusReader } from './session-status';
import { TokenRejectedError } from './token-verifier';

/**
 * API-100-51: own access tokens (AC1), key rotation (AC2), what the guard refuses (AC3) and keys only
 * from config (AC4). Keys are generated at runtime; nothing here is real key material.
 */
const ISSUER = 'atlas-api';
const AUDIENCE = 'atlas-app';

function ring(keys: Record<string, string>[], activeKid: string): AtlasKeyRing {
  return new AtlasKeyRing({
    keys: JSON.stringify(keys),
    activeKid,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

class FakeSessions implements SessionStatusReader {
  state: SessionState = 'live';
  calls: [string, string][] = [];
  failWith?: Error;
  stateOf(sessionId: string, userId: string): Promise<SessionState> {
    this.calls.push([sessionId, userId]);
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve(this.state);
  }
}

function signer(keyRing: AtlasKeyRing, ttl = 900): AccessTokenSigner {
  const config = {
    get: (key: string) => (key === 'AUTH_ACCESS_TOKEN_TTL_SECONDS' ? ttl : undefined),
  };
  return new AccessTokenSigner(keyRing, config as never);
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TokenRejectedError) return error.reason;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('own access tokens (API-100-51)', () => {
  const k1 = throwawayJwk('k1');
  const k2 = throwawayJwk('k2');
  const p256 = throwawayJwk('p1', 'p256');
  const user = randomUUID();
  const session = randomUUID();

  describe('AC1: signed token shape', () => {
    it('EdDSA, kid + typ header, claims iss aud sub sid iat exp (15 min), nothing else', async () => {
      const { token, expiresAt } = await signer(ring([k1], 'k1')).issue(
        user,
        session,
        1_700_000_000_000,
      );
      expect(decodeProtectedHeader(token)).toEqual({
        alg: 'EdDSA',
        kid: 'k1',
        typ: ACCESS_TOKEN_TYPE,
      });
      expect(decodeJwt(token)).toEqual({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: user,
        sid: session,
        iat: 1_700_000_000,
        exp: 1_700_000_900,
      });
      expect(expiresAt).toBe(new Date(1_700_000_900_000).toISOString());
    });

    it('ES256 with a P-256 key', async () => {
      const { token } = await signer(ring([p256], 'p1')).issue(user, session);
      expect(decodeProtectedHeader(token).alg).toBe('ES256');
      const sessions = new FakeSessions();
      await expect(
        new AtlasTokenVerifier(ring([p256], 'p1'), sessions, 30).verify(token),
      ).resolves.toMatchObject({ id: user, sessionId: session });
    });

    it('the key ring publishes public parts only, active key first', () => {
      const keys = ring([{ ...k1, d: undefined } as never, k2], 'k2').jwks.keys;
      expect(keys.map((k) => k.kid)).toEqual(['k2', 'k1']);
      for (const key of keys) {
        expect(key).not.toHaveProperty('d');
        expect(key).toMatchObject({ alg: 'EdDSA', use: 'sig', kty: 'OKP', crv: 'Ed25519' });
      }
      expect(JSON.stringify(ring([k1], 'k1'))).toBe('"[AtlasKeyRing]"');
    });

    it('without keys nothing is signed or accepted (not_configured)', async () => {
      const empty = new AtlasKeyRing({ issuer: ISSUER, audience: AUDIENCE });
      expect(empty.isConfigured).toBe(false);
      expect(empty.jwks).toEqual({ keys: [] });
      await expect(signer(empty).issue(user, session)).rejects.toThrow('not configured');
      const { token } = await signer(ring([k1], 'k1')).issue(user, session);
      expect(
        await rejection(new AtlasTokenVerifier(empty, new FakeSessions(), 30).verify(token)),
      ).toBe('not_configured');
    });
  });

  describe('AC2: key rotation', () => {
    it('a new key is published (and verifies) before it signs; the old key still verifies its tokens', async () => {
      // Step 1: k2 added, k1 still active.
      const step1 = ring([k1, k2], 'k1');
      expect(step1.jwks.keys.map((k) => k.kid)).toEqual(['k1', 'k2']);
      const oldToken = (await signer(step1).issue(user, session)).token;
      // Step 2: k2 active; k1 kept (public part only) until its tokens expire.
      const step2 = ring([{ ...k1, d: undefined } as never, k2], 'k2');
      const newToken = (await signer(step2).issue(user, session)).token;
      expect(decodeProtectedHeader(newToken).kid).toBe('k2');
      const verifier = new AtlasTokenVerifier(step2, new FakeSessions(), 30);
      await expect(verifier.verify(oldToken)).resolves.toMatchObject({ id: user });
      await expect(verifier.verify(newToken)).resolves.toMatchObject({ id: user });
      // Step 3: k1 removed: its tokens are refused.
      const step3 = new AtlasTokenVerifier(ring([k2], 'k2'), new FakeSessions(), 30);
      expect(await rejection(step3.verify(oldToken))).toBe('unknown_key');
      await expect(step3.verify(newToken)).resolves.toMatchObject({ id: user });
    });
  });

  describe('AC3: what the guard refuses', () => {
    const keyRing = ring([k1], 'k1');
    let sessions: FakeSessions;
    let verifier: AtlasTokenVerifier;

    beforeEach(() => {
      sessions = new FakeSessions();
      verifier = new AtlasTokenVerifier(keyRing, sessions, 30);
    });

    async function craft(
      claims: Record<string, unknown>,
      header: Record<string, unknown> = { alg: 'EdDSA', kid: 'k1', typ: ACCESS_TOKEN_TYPE },
      key: Record<string, string> = k1,
    ): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: user,
        sid: session,
        iat: now,
        exp: now + 900,
        ...claims,
      };
      const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
      const privateKey = await importJWK(
        { ...key, alg: header.alg as string },
        header.alg as string,
      );
      return new SignJWT(clean).setProtectedHeader(header as never).sign(privateKey);
    }

    it('accepts a live session and reads it once', async () => {
      await expect(verifier.verify(await craft({}))).resolves.toEqual({
        id: user,
        sessionId: session,
        email: null,
        phone: null,
      });
      expect(sessions.calls).toEqual([[session, user]]);
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['expired', { exp: Math.floor(Date.now() / 1000) - 60 }, 'expired'],
      ['another issuer', { iss: 'someone-else' }, 'wrong_issuer'],
      ['another audience', { aud: 'other-app' }, 'wrong_audience'],
      ['no sid', { sid: undefined }, 'missing_claim'],
      ['a sid that is not a uuid', { sid: 'abc' }, 'malformed'],
      ['a sub that is not a uuid', { sub: 'abc' }, 'invalid_subject'],
      ['no iat', { iat: undefined }, 'missing_claim'],
    ])('refuses %s', async (_label, claims, reason) => {
      expect(await rejection(verifier.verify(await craft(claims)))).toBe(reason);
      expect(sessions.calls).toEqual([]);
    });

    it('allows the configured clock skew on exp (30 s)', async () => {
      const token = await craft({ exp: Math.floor(Date.now() / 1000) - 10 });
      await expect(verifier.verify(token)).resolves.toMatchObject({ id: user });
    });

    it('refuses a token without typ at+jwt, an unknown kid, a wrong alg, and a forged signature', async () => {
      expect(await rejection(verifier.verify(await craft({}, { alg: 'EdDSA', kid: 'k1' })))).toBe(
        'malformed',
      );
      expect(
        await rejection(
          verifier.verify(await craft({}, { alg: 'EdDSA', kid: 'zz', typ: ACCESS_TOKEN_TYPE })),
        ),
      ).toBe('unknown_key');
      expect(
        await rejection(
          verifier.verify(
            await craft({}, { alg: 'ES256', kid: 'k1', typ: ACCESS_TOKEN_TYPE }, p256),
          ),
        ),
      ).toBe('unsupported_algorithm');
      // Signed with another key under kid k1.
      expect(
        await rejection(
          verifier.verify(await craft({}, { alg: 'EdDSA', kid: 'k1', typ: ACCESS_TOKEN_TYPE }, k2)),
        ),
      ).toBe('bad_signature');
      expect(await rejection(verifier.verify('not.a.jwt'))).toBe('malformed');
    });

    it.each<SessionState>(['revoked', 'unknown'])(
      'refuses a %s session (revoked_at set, deleted, or user disabled)',
      async (state) => {
        sessions.state = state;
        expect(await rejection(verifier.verify(await craft({})))).toBe('session_revoked');
      },
    );

    it('a session read that fails is not a rejection (→ 500, never a sign-out)', async () => {
      sessions.failWith = new Error('database down');
      await expect(verifier.verify(await craft({}))).rejects.toThrow('database down');
    });
  });

  describe('AC3: Supabase access tokens are retired (D76)', () => {
    it('a Supabase-shaped HS256 token is refused as malformed', async () => {
      const verifier = new AtlasTokenVerifier(ring([k1], 'k1'), new FakeSessions(), 30);
      const supabaseLike = await new SignJWT({ role: 'authenticated', session_id: randomUUID() })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer('http://127.0.0.1:54321/auth/v1')
        .setAudience('authenticated')
        .setSubject(user)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode('x'.repeat(40)));
      expect(await rejection(verifier.verify(supabaseLike))).toBe('malformed');
    });
  });
});
