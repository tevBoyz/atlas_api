import type { AuthenticatedUser } from './authenticated-user';

/**
 * Verifies a bearer access token and returns the caller (API-100-08 AC5).
 *
 * Behind an interface so own tokens (API-100-51) and the dual-token window (API-100-59) can be
 * added without touching the guard: a composite verifier picks the implementation per token.
 *
 * Contract:
 * - resolves with the caller for a valid token;
 * - rejects with {@link TokenRejectedError} when the token itself is not acceptable (missing
 *   claims, bad signature, expired, wrong audience/issuer/role, unknown key, ...) → 401;
 * - rejects with any other error when the token could not be checked at all (e.g. the JWKS
 *   endpoint is unreachable) → 500, so a key-server outage never signs users out.
 */
export interface TokenVerifier {
  verify(token: string): Promise<AuthenticatedUser>;
}

/** DI token for the active {@link TokenVerifier}. */
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** Why a token was refused. For logs and tests only: the client always gets `<fn>:not_authenticated`. */
export type TokenRejectionReason =
  | 'not_configured'
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_audience'
  | 'wrong_issuer'
  | 'missing_claim'
  | 'wrong_role'
  | 'anonymous'
  | 'invalid_subject';

/** The token is not acceptable (→ 401 `<fn>:not_authenticated`). Never carries the token. */
export class TokenRejectedError extends Error {
  constructor(readonly reason: TokenRejectionReason) {
    super(`access token rejected: ${reason}`);
    this.name = 'TokenRejectedError';
  }
}
