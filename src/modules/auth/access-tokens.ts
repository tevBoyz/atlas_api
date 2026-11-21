import { Inject, Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';

import { ACCESS_TOKEN_TYPE, ATLAS_KEY_RING, type AtlasKeyRing } from '../../common/auth';
import { ApiConfigService } from '../../config';

export interface IssuedAccessToken {
  token: string;
  /** ISO-8601 UTC. */
  expiresAt: string;
}

/**
 * Signs the API's own access tokens (API-100-51 AC1): asymmetric (EdDSA or ES256, by the active
 * key), lifetime AUTH_ACCESS_TOKEN_TTL_SECONDS (15 min), header `kid` + `typ: at+jwt`, claims `iss`,
 * `aud`, `sub` (user id), `sid` (device session id), `iat`, `exp`. Nothing else: no email, phone or
 * role (the guard reads the session, each route reads what it needs).
 */
@Injectable()
export class AccessTokenSigner {
  constructor(
    @Inject(ATLAS_KEY_RING) private readonly ring: AtlasKeyRing,
    private readonly config: ApiConfigService,
  ) {}

  get isConfigured(): boolean {
    return this.ring.isConfigured;
  }

  async issue(
    userId: string,
    sessionId: string,
    now: number = Date.now(),
  ): Promise<IssuedAccessToken> {
    const key = this.ring.activeKey;
    const iat = Math.floor(now / 1000);
    const exp = iat + this.config.get('AUTH_ACCESS_TOKEN_TTL_SECONDS');
    const token = await new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: ACCESS_TOKEN_TYPE })
      .setIssuer(this.ring.issuer)
      .setAudience(this.ring.audience)
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key.privateKey);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }
}
