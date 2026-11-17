import { randomUUID } from 'node:crypto';

import {
  generateSigningKey,
  LocalJwksServer,
  type LocalSigningKey,
} from '../../testing/local-jwks';
import {
  TEST_JWT_AUDIENCE,
  TEST_JWT_ISSUER,
  TEST_JWT_SECRET,
} from '../../testing/test-auth-config';
import { signTestToken, type TestTokenOptions } from '../../testing/test-tokens';
import {
  SupabaseTokenVerifier,
  type SupabaseTokenVerifierOptions,
} from './supabase-token-verifier';
import { TokenRejectedError, type TokenRejectionReason } from './token-verifier';

/**
 * API-100-08 AC2, AC3, AC6 against locally generated keys and a local JWKS server (127.0.0.1).
 * Nothing here talks to Supabase.
 */

const BASE: SupabaseTokenVerifierOptions = {
  issuer: TEST_JWT_ISSUER,
  audience: TEST_JWT_AUDIENCE,
  clockSkewSeconds: 30,
};

async function rejection(promise: Promise<unknown>): Promise<TokenRejectionReason> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TokenRejectedError) return error.reason;
    throw error;
  }
  throw new Error('expected the token to be rejected');
}

function signed(key: LocalSigningKey, options: TestTokenOptions = {}): Promise<string> {
  return signTestToken({ ...options, privateKey: key.privateKey, alg: key.alg, kid: key.kid });
}

describe('SupabaseTokenVerifier (API-100-08)', () => {
  const jwksServer = new LocalJwksServer();
  let jwksUrl: string;
  let key1: LocalSigningKey;
  let key2: LocalSigningKey;
  let rsaKey: LocalSigningKey;
  let stranger: LocalSigningKey;

  beforeAll(async () => {
    jwksUrl = await jwksServer.start();
    [key1, key2, rsaKey, stranger] = await Promise.all([
      generateSigningKey('key-1'),
      generateSigningKey('key-2'),
      generateSigningKey('rsa-1', 'RS256'),
      // Same kid as key1, different key material: a forged signature.
      generateSigningKey('key-1'),
    ]);
  });

  afterAll(async () => {
    await jwksServer.stop();
  });

  beforeEach(() => {
    jwksServer.keys = [key1.jwk, rsaKey.jwk];
    jwksServer.fetches = 0;
  });

  /** A verifier with its own JWKS cache; cooldown 0 unless given. */
  function jwksVerifier(extra: Partial<SupabaseTokenVerifierOptions> = {}) {
    return new SupabaseTokenVerifier({
      ...BASE,
      jwksUrl,
      jwks: { cooldownMs: 0, ...extra.jwks },
      ...extra,
    });
  }

  const secretVerifier = (extra: Partial<SupabaseTokenVerifierOptions> = {}) =>
    new SupabaseTokenVerifier({ ...BASE, secret: TEST_JWT_SECRET, ...extra });

  describe('valid tokens', () => {
    it('accepts an ES256 token from the JWKS; sub becomes the caller id (AC3)', async () => {
      const sub = randomUUID();
      const sessionId = randomUUID();
      const token = await signed(key1, {
        claims: { sub, session_id: sessionId, email: 'a@example.test', phone: '' },
      });
      await expect(jwksVerifier().verify(token)).resolves.toEqual({
        id: sub,
        issuer: 'supabase',
        sessionId,
        email: 'a@example.test',
        phone: null,
      });
    });

    it('accepts an RS256 token from the JWKS', async () => {
      const sub = randomUUID();
      const caller = await jwksVerifier().verify(await signed(rsaKey, { claims: { sub } }));
      expect(caller.id).toBe(sub);
    });

    it('accepts an HS256 token with the configured secret', async () => {
      const sub = randomUUID();
      const caller = await secretVerifier().verify(await signTestToken({ claims: { sub } }));
      expect(caller.id).toBe(sub);
    });

    it('accepts both kinds when both sources are configured', async () => {
      const verifier = jwksVerifier({ secret: TEST_JWT_SECRET });
      await expect(verifier.verify(await signTestToken())).resolves.toBeDefined();
      await expect(verifier.verify(await signed(key1))).resolves.toBeDefined();
    });

    it('lower-cases the caller id', async () => {
      const sub = randomUUID();
      const caller = await secretVerifier().verify(
        await signTestToken({ claims: { sub: sub.toUpperCase() } }),
      );
      expect(caller.id).toBe(sub);
    });
  });

  describe('expiry and clock skew (AC2)', () => {
    it('rejects an expired token', async () => {
      const token = await signTestToken({ expiresInSeconds: -60 });
      expect(await rejection(secretVerifier().verify(token))).toBe('expired');
    });

    it('accepts a token expired 10 s ago with 30 s skew, rejects it with 0 s skew', async () => {
      const token = await signTestToken({ expiresInSeconds: -10 });
      await expect(secretVerifier().verify(token)).resolves.toBeDefined();
      expect(await rejection(secretVerifier({ clockSkewSeconds: 0 }).verify(token))).toBe(
        'expired',
      );
    });

    it('rejects a token without exp', async () => {
      const token = await signTestToken({ claims: { exp: undefined } });
      expect(await rejection(secretVerifier().verify(token))).toBe('missing_claim');
    });

    it('rejects a token that is not valid yet (nbf beyond the skew)', async () => {
      const nbf = Math.floor(Date.now() / 1000) + 120;
      const token = await signTestToken({ claims: { nbf } });
      expect(await rejection(secretVerifier().verify(token))).toBe('not_yet_valid');
    });

    it.each([31, -1, 1.5])('refuses a clock skew of %s seconds', (clockSkewSeconds) => {
      expect(() => secretVerifier({ clockSkewSeconds })).toThrow(/clock skew/);
    });
  });

  describe('signature (AC6 bad signature)', () => {
    it('rejects a JWKS token signed by another key with the same kid', async () => {
      expect(await rejection(jwksVerifier().verify(await signed(stranger)))).toBe('bad_signature');
    });

    it('rejects an HS256 token signed with another secret', async () => {
      const token = await signTestToken({ secret: 'x'.repeat(40) });
      expect(await rejection(secretVerifier().verify(token))).toBe('bad_signature');
    });

    it('rejects a tampered payload', async () => {
      const [header, , signature] = (await signTestToken()).split('.');
      const payload = Buffer.from(
        JSON.stringify({ sub: randomUUID(), role: 'authenticated', exp: 9_999_999_999 }),
      ).toString('base64url');
      const token = `${header}.${payload}.${signature}`;
      expect(await rejection(secretVerifier().verify(token))).toBe('bad_signature');
    });

    it('rejects an HS256 token when only the JWKS is configured (no algorithm confusion)', async () => {
      expect(await rejection(jwksVerifier().verify(await signTestToken()))).toBe(
        'unsupported_algorithm',
      );
    });

    it('rejects an ES256 token when only the secret is configured', async () => {
      expect(await rejection(secretVerifier().verify(await signed(key1)))).toBe(
        'unsupported_algorithm',
      );
    });

    it('rejects alg "none"', async () => {
      const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({
        sub: randomUUID(),
        role: 'authenticated',
        aud: TEST_JWT_AUDIENCE,
        iss: TEST_JWT_ISSUER,
        exp: now + 600,
      })}.`;
      // (The bearer parser already refuses the empty signature; the verifier refuses `none` anyway.)
      expect(await rejection(secretVerifier().verify(token))).toBe('unsupported_algorithm');
      expect(await rejection(secretVerifier().verify(`${token}x`))).toBe('unsupported_algorithm');
    });

    it('rejects a token that is not a JWT', async () => {
      expect(await rejection(secretVerifier().verify('not.a.jwt'))).toBe('malformed');
    });
  });

  describe('claims (AC2, AC3)', () => {
    it('rejects the wrong audience', async () => {
      const token = await signTestToken({ claims: { aud: 'service' } });
      expect(await rejection(secretVerifier().verify(token))).toBe('wrong_audience');
    });

    it('rejects the wrong issuer', async () => {
      const token = await signTestToken({ claims: { iss: 'http://127.0.0.1:1/auth/v1' } });
      expect(await rejection(secretVerifier().verify(token))).toBe('wrong_issuer');
    });

    it('rejects an anon-role token', async () => {
      const token = await signTestToken({ claims: { role: 'anon' } });
      expect(await rejection(secretVerifier().verify(token))).toBe('anonymous');
    });

    it('rejects a Supabase anonymous sign-in (role authenticated, is_anonymous true)', async () => {
      const token = await signTestToken({ claims: { is_anonymous: true } });
      expect(await rejection(secretVerifier().verify(token))).toBe('anonymous');
    });

    it.each(['service_role', 'supabase_admin'])('rejects role %s', async (role) => {
      const token = await signTestToken({ claims: { role } });
      expect(await rejection(secretVerifier().verify(token))).toBe('wrong_role');
    });

    it('rejects a token without role', async () => {
      const token = await signTestToken({ claims: { role: undefined } });
      expect(await rejection(secretVerifier().verify(token))).toBe('missing_claim');
    });

    it.each(['not-a-uuid', '12345', ''])('rejects sub %j', async (sub) => {
      const token = await signTestToken({ claims: { sub } });
      expect(await rejection(secretVerifier().verify(token))).toMatch(
        /^(invalid_subject|missing_claim)$/,
      );
    });
  });

  describe('JWKS cache and key rotation (AC2, AC6 unknown kid)', () => {
    it('fetches the JWKS once and serves later tokens from the cache', async () => {
      const verifier = jwksVerifier();
      await verifier.verify(await signed(key1));
      await verifier.verify(await signed(key1));
      await verifier.verify(await signed(rsaKey));
      expect(jwksServer.fetches).toBe(1);
    });

    it('refetches the JWKS on an unknown kid and accepts the rotated key', async () => {
      const verifier = jwksVerifier();
      await verifier.verify(await signed(key1));
      expect(jwksServer.fetches).toBe(1);

      jwksServer.keys = [key1.jwk, key2.jwk]; // Supabase rotated in key-2
      const sub = randomUUID();
      const caller = await verifier.verify(await signed(key2, { claims: { sub } }));
      expect(caller.id).toBe(sub);
      expect(jwksServer.fetches).toBe(2);
    });

    it('rejects a kid that is still unknown after the refetch', async () => {
      const verifier = jwksVerifier();
      expect(await rejection(verifier.verify(await signed(key2)))).toBe('unknown_key');
    });

    it('does not refetch within the cooldown (junk kids cannot hammer the JWKS)', async () => {
      const verifier = jwksVerifier({ jwks: { cooldownMs: 60_000 } });
      await verifier.verify(await signed(key1));
      expect(await rejection(verifier.verify(await signed(key2)))).toBe('unknown_key');
      expect(await rejection(verifier.verify(await signed(key2)))).toBe('unknown_key');
      expect(jwksServer.fetches).toBe(1);
    });

    it('an unreachable JWKS is not a token problem (no 401: the error propagates)', async () => {
      const verifier = new SupabaseTokenVerifier({
        ...BASE,
        jwksUrl: 'http://127.0.0.1:1/auth/v1/.well-known/jwks.json',
        jwks: { timeoutMs: 1_000 },
      });
      const outcome = verifier.verify(await signed(key1));
      await expect(outcome).rejects.toBeDefined();
      await expect(outcome).rejects.not.toBeInstanceOf(TokenRejectedError);
    });
  });

  describe('configuration', () => {
    it('refuses every token without an issuer (fail closed)', async () => {
      const verifier = new SupabaseTokenVerifier({
        ...BASE,
        issuer: undefined,
        secret: 'x'.repeat(32),
      });
      expect(verifier.isConfigured).toBe(false);
      expect(await rejection(verifier.verify(await signTestToken()))).toBe('not_configured');
    });

    it('refuses every token without a key source', async () => {
      const verifier = new SupabaseTokenVerifier(BASE);
      expect(verifier.isConfigured).toBe(false);
      expect(await rejection(verifier.verify(await signTestToken()))).toBe('not_configured');
    });
  });
});
