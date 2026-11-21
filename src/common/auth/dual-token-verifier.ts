import { decodeJwt } from 'jose';

import type { AuthenticatedUser } from './authenticated-user';
import { TokenRejectedError, type TokenVerifier } from './token-verifier';

/** Whether Supabase access tokens are still accepted (dual-token window, API-100-51/59). */
export interface SupabaseAcceptance {
  /** SUPABASE_JWT_ACCEPT. */
  accept: boolean;
  /** SUPABASE_JWT_ACCEPT_UNTIL (epoch ms): refused from this instant on. */
  untilMs?: number;
}

/** Told about every accepted token (the share of Supabase tokens, API-100-59). Never throws. */
export interface TokenUsageRecorder {
  record(issuer: AuthenticatedUser['issuer'], userId: string): void;
}

/**
 * The guard's verifier during the dual-token window (API-100-51 AC3, API-100-59 AC2). A token whose
 * `iss` is the API's own issuer is checked by the own verifier (signature, claims, live session);
 * any other token by the Supabase verifier, and only while Supabase tokens are accepted
 * (SUPABASE_JWT_ACCEPT=true and before SUPABASE_JWT_ACCEPT_UNTIL). The issuer only picks the
 * verifier: each verifier checks it again with the signature, so a forged `iss` gains nothing.
 */
export class DualTokenVerifier implements TokenVerifier {
  constructor(
    private readonly ownIssuer: string,
    private readonly own: TokenVerifier,
    private readonly supabase: TokenVerifier,
    private readonly acceptance: SupabaseAcceptance,
    private readonly usage?: TokenUsageRecorder,
    private readonly now: () => number = Date.now,
  ) {}

  /** True while Supabase access tokens are accepted. */
  acceptsSupabaseTokens(): boolean {
    return (
      this.acceptance.accept &&
      (this.acceptance.untilMs === undefined || this.now() < this.acceptance.untilMs)
    );
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    let issuer: unknown;
    try {
      issuer = decodeJwt(token).iss;
    } catch {
      throw new TokenRejectedError('malformed');
    }
    let user: AuthenticatedUser;
    if (issuer === this.ownIssuer) {
      user = await this.own.verify(token);
    } else {
      if (!this.acceptsSupabaseTokens()) throw new TokenRejectedError('supabase_not_accepted');
      user = await this.supabase.verify(token);
    }
    this.usage?.record(user.issuer, user.id);
    return user;
  }
}
