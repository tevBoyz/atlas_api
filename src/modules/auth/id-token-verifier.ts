import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, errors, type JWTPayload, jwtVerify, type JWTVerifyGetKey } from 'jose';

import { ApiConfigService } from '../../config';

export type OAuthProvider = 'google' | 'apple';

/** What the API reads from a provider's ID token. */
export interface IdTokenClaims {
  sub: string;
  email: string | null;
  /** The provider asserts the email is verified (D6). */
  emailVerified: boolean;
  /** Apple: the nonce claim (SHA-256 hex of the app's raw nonce). */
  nonce: string | null;
}

/** The token is not acceptable (→ 401 `auth:oauth_invalid_token`). */
export class IdTokenInvalidError extends Error {
  constructor(readonly reason: string) {
    super(`id token rejected: ${reason}`);
    this.name = 'IdTokenInvalidError';
  }
}

/** The provider's keys could not be fetched (→ 503 `auth:provider_unavailable`). */
export class IdTokenUnavailableError extends Error {
  constructor() {
    super('id token keys unavailable');
    this.name = 'IdTokenUnavailableError';
  }
}

/** DI token of the {@link IdTokenVerifier}. */
export const ID_TOKEN_VERIFIER = Symbol('ID_TOKEN_VERIFIER');

/**
 * Verifies Google / Apple ID tokens server-side (API-100-55): signature against the provider's JWKS,
 * `iss`, `aud` ∈ the configured client ids, `exp`. Behind an interface so tests use a fake JWKS
 * endpoint (the JWKS URLs are config): no test ever calls Google or Apple.
 */
export interface IdTokenVerifier {
  /** Undefined when the provider is not enabled (→ 503 `auth:provider_disabled`). */
  isEnabled(provider: OAuthProvider): boolean;
  verify(provider: OAuthProvider, idToken: string): Promise<IdTokenClaims>;
}

const ISSUERS: Record<OAuthProvider, string[]> = {
  google: ['https://accounts.google.com', 'accounts.google.com'],
  apple: ['https://appleid.apple.com'],
};

/** Clock difference allowed on `exp` / `iat`. */
const CLOCK_TOLERANCE_SECONDS = 30;
/** JWKS fetch timeout: the whole social sign-in must fit in the app's 30 s cap (spec §8.5). */
const JWKS_TIMEOUT_MS = 5_000;

function verifiedFlag(value: unknown): boolean {
  return value === true || value === 'true';
}

@Injectable()
export class JoseIdTokenVerifier implements IdTokenVerifier {
  private readonly keys = new Map<OAuthProvider, JWTVerifyGetKey>();
  private readonly audiences: Record<OAuthProvider, string[] | undefined>;

  constructor(config: ApiConfigService) {
    this.audiences = {
      google: config.get('GOOGLE_CLIENT_IDS'),
      apple: config.get('APPLE_SIGN_IN_ENABLED') ? config.get('APPLE_CLIENT_IDS') : undefined,
    };
    const urls: Record<OAuthProvider, string> = {
      google: config.get('GOOGLE_JWKS_URL'),
      apple: config.get('APPLE_JWKS_URL'),
    };
    for (const provider of ['google', 'apple'] as const) {
      if (this.audiences[provider]) {
        this.keys.set(
          provider,
          createRemoteJWKSet(new URL(urls[provider]), {
            timeoutDuration: JWKS_TIMEOUT_MS,
            cooldownDuration: 30_000,
            cacheMaxAge: 10 * 60_000,
          }),
        );
      }
    }
  }

  isEnabled(provider: OAuthProvider): boolean {
    return this.keys.has(provider);
  }

  async verify(provider: OAuthProvider, idToken: string): Promise<IdTokenClaims> {
    const keys = this.keys.get(provider);
    if (!keys) throw new IdTokenInvalidError('provider_disabled');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: ISSUERS[provider],
        audience: this.audiences[provider],
        algorithms: ['RS256', 'ES256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'iat', 'sub', 'aud', 'iss'],
      }));
    } catch (error) {
      // The key set could not be fetched or read (a plain fetch error, a timeout, a broken JWKS):
      // the provider's fault, not the token's.
      if (
        !(error instanceof errors.JOSEError) ||
        error instanceof errors.JWKSTimeout ||
        error instanceof errors.JWKSInvalid
      ) {
        throw new IdTokenUnavailableError();
      }
      throw new IdTokenInvalidError(error.code);
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) {
      throw new IdTokenInvalidError('sub');
    }
    const rawEmail = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    const email =
      rawEmail && rawEmail.length <= 254 && /^[^@\s]+@[^@\s]+$/.test(rawEmail) ? rawEmail : null;
    return {
      sub: payload.sub,
      email,
      emailVerified: email !== null && verifiedFlag(payload.email_verified),
      nonce: typeof payload.nonce === 'string' ? payload.nonce : null,
    };
  }
}
