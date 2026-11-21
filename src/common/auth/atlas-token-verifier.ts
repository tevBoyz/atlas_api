import {
  decodeProtectedHeader,
  errors,
  type JWTHeaderParameters,
  type JWTPayload,
  jwtVerify,
} from 'jose';

import type { AtlasKeyRing } from './atlas-key-ring';
import type { AuthenticatedUser } from './authenticated-user';
import type { SessionStatusReader } from './session-status';
import {
  TokenRejectedError,
  type TokenRejectionReason,
  type TokenVerifier,
} from './token-verifier';

/** `typ` header of own access tokens (RFC 9068), so no other JWT can pass for one. */
export const ACCESS_TOKEN_TYPE = 'at+jwt';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reasonOf(error: unknown): TokenRejectionReason | undefined {
  if (error instanceof errors.JWTExpired) return 'expired';
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.reason === 'missing') return 'missing_claim';
    if (error.claim === 'aud') return 'wrong_audience';
    if (error.claim === 'iss') return 'wrong_issuer';
    if (error.claim === 'nbf' || error.claim === 'iat') return 'not_yet_valid';
    return 'malformed';
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return 'bad_signature';
  if (error instanceof errors.JOSEAlgNotAllowed || error instanceof errors.JOSENotSupported) {
    return 'unsupported_algorithm';
  }
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) return 'malformed';
  return undefined;
}

/**
 * Verifies the API's own access tokens (API-100-51): signature with the key named by `kid` (only
 * keys of the ring, EdDSA or ES256), `typ` at+jwt, `iss`, `aud`, `exp` (with the configured clock
 * skew), `sub` and `sid` uuids, then the session: a revoked or unknown session (or a disabled user)
 * is refused (AC3). The session read failing (database down) is not the token's fault: it rejects
 * with that error (→ 500, never a sign-out).
 */
export class AtlasTokenVerifier implements TokenVerifier {
  constructor(
    private readonly ring: AtlasKeyRing,
    private readonly sessions: SessionStatusReader,
    private readonly clockSkewSeconds: number,
  ) {}

  async verify(token: string): Promise<AuthenticatedUser> {
    if (!this.ring.isConfigured) throw new TokenRejectedError('not_configured');
    let header: JWTHeaderParameters;
    try {
      header = decodeProtectedHeader(token) as JWTHeaderParameters;
    } catch {
      throw new TokenRejectedError('malformed');
    }
    if (header.typ !== ACCESS_TOKEN_TYPE) throw new TokenRejectedError('malformed');
    const key = typeof header.kid === 'string' ? this.ring.verificationKey(header.kid) : undefined;
    if (!key) throw new TokenRejectedError('unknown_key');
    if (header.alg !== key.alg) throw new TokenRejectedError('unsupported_algorithm');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key.key, {
        algorithms: [key.alg],
        issuer: this.ring.issuer,
        audience: this.ring.audience,
        clockTolerance: this.clockSkewSeconds,
        typ: ACCESS_TOKEN_TYPE,
        requiredClaims: ['exp', 'iat', 'sub', 'sid'],
      }));
    } catch (error) {
      const reason = reasonOf(error);
      if (reason) throw new TokenRejectedError(reason);
      throw error;
    }
    const sub = payload.sub;
    const sid = payload.sid;
    if (typeof sub !== 'string' || !UUID.test(sub)) throw new TokenRejectedError('invalid_subject');
    if (typeof sid !== 'string' || !UUID.test(sid)) throw new TokenRejectedError('malformed');
    const userId = sub.toLowerCase();
    const sessionId = sid.toLowerCase();
    const state = await this.sessions.stateOf(sessionId, userId);
    if (state !== 'live') throw new TokenRejectedError('session_revoked');
    return { id: userId, issuer: 'atlas', sessionId, email: null, phone: null };
  }
}
