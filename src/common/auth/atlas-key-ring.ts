import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

import type { ApiConfigService } from '../../config';
import { type JwtKeyAlgorithm, parseJwtKeys } from '../../config/jwt-keys';

/** A public key that verifies own access tokens. */
export interface VerificationKey {
  kid: string;
  alg: JwtKeyAlgorithm;
  key: KeyObject;
}

/** The key that signs new access tokens. Never logged, never serialized. */
export interface SigningKey {
  kid: string;
  alg: JwtKeyAlgorithm;
  privateKey: KeyObject;
}

/** One entry of the published key set (public parts only). */
export interface PublishedJwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  y?: string;
  alg: JwtKeyAlgorithm;
  use: 'sig';
}

/** DI token of the {@link AtlasKeyRing}. */
export const ATLAS_KEY_RING = Symbol('ATLAS_KEY_RING');

/**
 * The API's own access-token keys (API-100-51), from AUTH_JWT_KEYS / AUTH_JWT_ACTIVE_KID (validated
 * at startup, `config/jwt-keys.ts`). Without them (development and tests only; production requires
 * them) own tokens can be neither signed nor accepted. The private key stays inside this object: no
 * method returns it and it has no JSON form.
 */
export class AtlasKeyRing {
  readonly issuer: string;
  readonly audience: string;
  private readonly signing?: SigningKey;
  private readonly verifiers = new Map<string, VerificationKey>();
  private readonly published: PublishedJwk[] = [];

  constructor(options: { keys?: string; activeKid?: string; issuer: string; audience: string }) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    if (!options.keys || !options.activeKid) return;
    const parsed = parseJwtKeys(options.keys, options.activeKid);
    for (const entry of parsed.keys) {
      const key = createPublicKey({ key: entry.publicJwk, format: 'jwk' });
      this.verifiers.set(entry.kid, { kid: entry.kid, alg: entry.alg, key });
      this.published.push({
        ...(entry.publicJwk as Omit<PublishedJwk, 'kid' | 'alg' | 'use'>),
        kid: entry.kid,
        alg: entry.alg,
        use: 'sig',
      });
    }
    this.signing = {
      kid: parsed.active.kid,
      alg: parsed.active.alg,
      privateKey: createPrivateKey({ key: parsed.active.privateJwk!, format: 'jwk' }),
    };
  }

  static fromConfig(config: ApiConfigService): AtlasKeyRing {
    return new AtlasKeyRing({
      keys: config.get('AUTH_JWT_KEYS'),
      activeKid: config.get('AUTH_JWT_ACTIVE_KID'),
      issuer: config.get('AUTH_JWT_ISSUER'),
      audience: config.get('AUTH_JWT_AUDIENCE'),
    });
  }

  /** True when own tokens can be signed and verified. */
  get isConfigured(): boolean {
    return this.signing !== undefined;
  }

  /** The active signing key. Throws when not configured. */
  get activeKey(): SigningKey {
    if (!this.signing) throw new Error('own access tokens are not configured (AUTH_JWT_KEYS)');
    return this.signing;
  }

  /** The verification key of `kid`, if it is in the ring. */
  verificationKey(kid: string): VerificationKey | undefined {
    return this.verifiers.get(kid);
  }

  /** The public key set (`GET /v1/auth/.well-known/jwks.json`), active key first. */
  get jwks(): { keys: PublishedJwk[] } {
    const active = this.signing?.kid;
    const keys = [...this.published].sort(
      (a, b) => Number(b.kid === active) - Number(a.kid === active),
    );
    return { keys };
  }

  toJSON(): string {
    return '[AtlasKeyRing]';
  }
}
