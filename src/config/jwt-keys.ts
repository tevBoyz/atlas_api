import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

/**
 * Signing keys of the API's own access tokens (API-100-51), from secret config only:
 *
 * - `AUTH_JWT_KEYS`: a JSON array of JWKs, each with a `kid`. Ed25519 (`kty` OKP, alg EdDSA) or
 *   P-256 (`kty` EC, alg ES256). A key with its private part (`d`) can sign; a key without it can
 *   only verify. Every key's PUBLIC part is published at `GET /v1/auth/.well-known/jwks.json`.
 * - `AUTH_JWT_ACTIVE_KID`: the key that signs new tokens (it must have `d`).
 *
 * Rotation (AC2): add the new key (not active) and deploy, so it is published before use; once
 * clients' key caches have refreshed, make it active; keep the old key (its public part is enough)
 * until every token it signed has expired (access token lifetime + clock skew), then remove it.
 *
 * Validation messages never contain key material: they name the problem and at most a `kid`.
 */

export const JWT_KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export type JwtKeyAlgorithm = 'EdDSA' | 'ES256';

/** One parsed key: its public JWK (always) and private JWK (when `d` was given). */
export interface ParsedJwtKey {
  kid: string;
  alg: JwtKeyAlgorithm;
  publicJwk: Record<string, string>;
  privateJwk?: Record<string, string>;
}

export interface ParsedJwtKeys {
  keys: ParsedJwtKey[];
  active: ParsedJwtKey;
}

/** Raised for an unusable key set; the message never carries key material. */
export class JwtKeysError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'JwtKeysError';
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function stringField(jwk: Record<string, unknown>, name: string): string | undefined {
  const value = jwk[name];
  return typeof value === 'string' && value.length > 0 && BASE64URL.test(value) ? value : undefined;
}

/** The key must load, and its private part must belong to its public part. */
function checkLoads(key: ParsedJwtKey): ParsedJwtKey {
  try {
    const publicKey = createPublicKey({ key: key.publicJwk, format: 'jwk' });
    if (key.privateJwk) {
      const derived = createPublicKey(createPrivateKey({ key: key.privateJwk, format: 'jwk' }));
      const a = derived.export({ format: 'jwk' });
      const b = publicKey.export({ format: 'jwk' });
      if (a.x !== b.x || a.y !== b.y) throw new Error('mismatch');
    }
  } catch {
    throw new JwtKeysError(`key ${key.kid} is not a valid key (or d does not match x)`);
  }
  return key;
}

function parseOne(entry: unknown, index: number): ParsedJwtKey {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new JwtKeysError(`entry ${index} is not a JWK object`);
  }
  const jwk = entry as Record<string, unknown>;
  const kid = jwk.kid;
  if (typeof kid !== 'string' || !JWT_KID_PATTERN.test(kid)) {
    throw new JwtKeysError(`entry ${index} needs a kid of 1-64 letters, digits, ".", "_" or "-"`);
  }
  const x = stringField(jwk, 'x');
  const d = jwk.d === undefined ? undefined : stringField(jwk, 'd');
  if (jwk.d !== undefined && d === undefined) {
    throw new JwtKeysError(`key ${kid}: d is not base64url`);
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519' && x) {
    const publicJwk = { kty: 'OKP', crv: 'Ed25519', x };
    return {
      kid,
      alg: 'EdDSA',
      publicJwk,
      ...(d ? { privateJwk: { ...publicJwk, d } } : {}),
    };
  }
  const y = stringField(jwk, 'y');
  if (jwk.kty === 'EC' && jwk.crv === 'P-256' && x && y) {
    const publicJwk = { kty: 'EC', crv: 'P-256', x, y };
    return {
      kid,
      alg: 'ES256',
      publicJwk,
      ...(d ? { privateJwk: { ...publicJwk, d } } : {}),
    };
  }
  throw new JwtKeysError(`key ${kid}: only Ed25519 (OKP) or P-256 (EC) keys are accepted`);
}

/** Parses and checks `AUTH_JWT_KEYS` + `AUTH_JWT_ACTIVE_KID`. Throws {@link JwtKeysError}. */
export function parseJwtKeys(raw: string, activeKid: string): ParsedJwtKeys {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new JwtKeysError('is not valid JSON (a JSON array of JWKs)');
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new JwtKeysError('must be a non-empty JSON array of JWKs');
  }
  const keys = list.map((entry, index) => checkLoads(parseOne(entry, index)));
  const kids = new Set<string>();
  for (const key of keys) {
    if (kids.has(key.kid)) throw new JwtKeysError(`kid ${key.kid} appears twice`);
    kids.add(key.kid);
  }
  const active = keys.find((key) => key.kid === activeKid);
  if (!active) throw new JwtKeysError('AUTH_JWT_ACTIVE_KID names no key of AUTH_JWT_KEYS');
  if (!active.privateJwk) {
    throw new JwtKeysError(`the active key ${active.kid} has no private part (d)`);
  }
  return { keys, active };
}

/** A NEW private JWK with `kid` (Ed25519 by default, or P-256). Key material: treat as a secret. */
export function generatePrivateJwk(
  kid: string,
  type: 'ed25519' | 'p256' = 'ed25519',
): Record<string, string> {
  const { privateKey } =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...(privateKey.export({ format: 'jwk' }) as Record<string, string>), kid };
}
