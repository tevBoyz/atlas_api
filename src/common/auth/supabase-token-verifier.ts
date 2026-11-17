import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

import type { AuthenticatedUser } from './authenticated-user';
import {
  TokenRejectedError,
  type TokenRejectionReason,
  type TokenVerifier,
} from './token-verifier';

/** Asymmetric algorithms accepted from the JWKS (Supabase signing keys: ECC P-256 or RSA). */
export const JWKS_ALGORITHMS: readonly string[] = ['ES256', 'RS256'];
/** The only algorithm accepted with the shared secret. */
export const SECRET_ALGORITHM = 'HS256';

/** Upper bound of SUPABASE_JWT_CLOCK_SKEW_SECONDS (API-100-08 AC2). */
export const MAX_CLOCK_SKEW_SECONDS = 30;

/** JWKS caching (jose remote key set). */
export interface JwksOptions {
  /** Keys are refetched after this long even when every `kid` is known. Default 10 min. */
  cacheMaxAgeMs: number;
  /**
   * Minimum time between two fetches. A token with an unknown `kid` triggers a refetch only when
   * the last fetch is older than this, so a flood of junk `kid`s cannot hammer Supabase. Default 30 s.
   */
  cooldownMs: number;
  /** Fetch timeout. Default 5 s. */
  timeoutMs: number;
}

export const DEFAULT_JWKS_OPTIONS: JwksOptions = {
  cacheMaxAgeMs: 10 * 60_000,
  cooldownMs: 30_000,
  timeoutMs: 5_000,
};

export interface SupabaseTokenVerifierOptions {
  /** SUPABASE_JWT_JWKS_URL: verifies ES256/RS256 tokens. */
  jwksUrl?: string;
  /** SUPABASE_JWT_SECRET: verifies HS256 tokens. */
  secret?: string;
  /** SUPABASE_JWT_ISSUER: required; without it every token is refused. */
  issuer?: string;
  /** SUPABASE_JWT_AUDIENCE. */
  audience: string;
  /** SUPABASE_JWT_CLOCK_SKEW_SECONDS (0-30). */
  clockSkewSeconds: number;
  jwks?: Partial<JwksOptions>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps a jose verification error to a rejection reason; undefined = not the token's fault. */
function rejectionReasonOf(error: unknown): TokenRejectionReason | undefined {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.reason === 'missing') return 'missing_claim';
    switch (error.claim) {
      case 'aud':
        return 'wrong_audience';
      case 'iss':
        return 'wrong_issuer';
      case 'nbf':
        return 'not_yet_valid';
      default:
        return 'malformed';
    }
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'bad_signature';
  if (error instanceof errors.JWKSNoMatchingKey) return 'unknown_key';
  if (error instanceof errors.JWKSMultipleMatchingKeys) return 'bad_signature';
  if (error instanceof errors.JOSEAlgNotAllowed) return 'unsupported_algorithm';
  if (error instanceof errors.JOSENotSupported) return 'unsupported_algorithm';
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) return 'malformed';
  // JWKS unreachable / timed out / invalid JWKS document, or anything unexpected: not a 401.
  return undefined;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Accepts Supabase-issued access tokens during the transition period (API-100-08, spec §11.1).
 *
 * - `alg` ES256/RS256 → the project's JWKS (cached; an unknown `kid` refetches, with a cooldown).
 * - `alg` HS256 → the shared secret. Only when SUPABASE_JWT_SECRET is set.
 * - Anything else (including `none`) → refused. The key type is chosen from the configured source,
 *   never from the token, so an HS256 token can never be checked against a public key.
 * - Checks `exp` (required) and `nbf` with the configured clock skew, `aud`, `iss`,
 *   `role = 'authenticated'`, not anonymous (`is_anonymous`), and `sub` is a uuid.
 * - Without an issuer or any key source it refuses every token (fail closed).
 */
export class SupabaseTokenVerifier implements TokenVerifier {
  private readonly jwks?: JWTVerifyGetKey;
  private readonly secret?: Uint8Array;
  private readonly issuer?: string;
  private readonly audience: string;
  private readonly clockSkewSeconds: number;

  constructor(options: SupabaseTokenVerifierOptions) {
    if (
      !Number.isInteger(options.clockSkewSeconds) ||
      options.clockSkewSeconds < 0 ||
      options.clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS
    ) {
      throw new Error(`clock skew must be an integer from 0 to ${MAX_CLOCK_SKEW_SECONDS} seconds`);
    }
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.clockSkewSeconds = options.clockSkewSeconds;
    if (options.secret) this.secret = new TextEncoder().encode(options.secret);
    if (options.jwksUrl) {
      const jwks = { ...DEFAULT_JWKS_OPTIONS, ...options.jwks };
      this.jwks = createRemoteJWKSet(new URL(options.jwksUrl), {
        cacheMaxAge: jwks.cacheMaxAgeMs,
        cooldownDuration: jwks.cooldownMs,
        timeoutDuration: jwks.timeoutMs,
      });
    }
  }

  /** True when tokens can be accepted at all (an issuer and at least one key source). */
  get isConfigured(): boolean {
    return this.issuer !== undefined && (this.jwks !== undefined || this.secret !== undefined);
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    if (!this.isConfigured) throw new TokenRejectedError('not_configured');

    let alg: unknown;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      throw new TokenRejectedError('malformed');
    }

    let payload: JWTPayload;
    try {
      payload = await this.verifySignatureAndClaims(token, alg);
    } catch (error) {
      if (error instanceof TokenRejectedError) throw error;
      const reason = rejectionReasonOf(error);
      if (reason) throw new TokenRejectedError(reason);
      throw error;
    }
    return this.callerFrom(payload);
  }

  private async verifySignatureAndClaims(token: string, alg: unknown): Promise<JWTPayload> {
    const options = {
      issuer: this.issuer,
      audience: this.audience,
      clockTolerance: this.clockSkewSeconds,
      requiredClaims: ['exp', 'sub', 'role'],
    };
    if (alg === SECRET_ALGORITHM && this.secret) {
      const { payload } = await jwtVerify(token, this.secret, {
        ...options,
        algorithms: [SECRET_ALGORITHM],
      });
      return payload;
    }
    if (typeof alg === 'string' && JWKS_ALGORITHMS.includes(alg) && this.jwks) {
      const { payload } = await jwtVerify(token, this.jwks, {
        ...options,
        algorithms: [...JWKS_ALGORITHMS],
      });
      return payload;
    }
    throw new TokenRejectedError('unsupported_algorithm');
  }

  private callerFrom(payload: JWTPayload): AuthenticatedUser {
    const role = payload.role;
    if (role === 'anon') throw new TokenRejectedError('anonymous');
    if (role !== 'authenticated') throw new TokenRejectedError('wrong_role');
    // Supabase anonymous sign-ins carry role `authenticated` with `is_anonymous: true`.
    if (payload.is_anonymous === true) throw new TokenRejectedError('anonymous');
    const sub = payload.sub;
    if (typeof sub !== 'string' || !UUID.test(sub)) throw new TokenRejectedError('invalid_subject');
    return {
      id: sub.toLowerCase(),
      issuer: 'supabase',
      sessionId: optionalString(payload.session_id),
      email: optionalString(payload.email),
      phone: optionalString(payload.phone),
    };
  }
}
