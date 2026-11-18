import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../config';
import { ROOT_LOGGER } from '../../observability/logger';
import { AuthGuard } from '../guards/auth.guard';
import { RequestGuard } from '../guards/request.guard';
import { RouteContractCheck } from '../guards/route-contract';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { SupabaseTokenVerifier } from './supabase-token-verifier';
import { TOKEN_VERIFIER } from './token-verifier';

/** The Supabase verifier from SUPABASE_JWT_* (API-100-08 AC2). */
export function supabaseVerifierFromConfig(config: ApiConfigService): SupabaseTokenVerifier {
  return new SupabaseTokenVerifier({
    jwksUrl: config.get('SUPABASE_JWT_JWKS_URL'),
    secret: config.get('SUPABASE_JWT_SECRET'),
    issuer: config.get('SUPABASE_JWT_ISSUER'),
    audience: config.get('SUPABASE_JWT_AUDIENCE'),
    clockSkewSeconds: config.get('SUPABASE_JWT_CLOCK_SKEW_SECONDS'),
  });
}

/**
 * Authentication for every route (API-100-08): the global {@link RequestGuard} (authentication,
 * then rate limiting, API-100-11), the active
 * {@link TOKEN_VERIFIER} (Supabase JWTs until own auth, API-100-51/59) and the boot-time
 * {@link RouteContractCheck}.
 *
 * Production config requires a key source and the issuer (config.schema.ts). Elsewhere a missing
 * one is allowed, but then every authenticated route answers 401 (fail closed): logged once here.
 */
@Module({
  imports: [DiscoveryModule, RateLimitModule],
  providers: [
    {
      provide: TOKEN_VERIFIER,
      inject: [ApiConfigService, ROOT_LOGGER],
      useFactory: (config: ApiConfigService, logger: Logger) => {
        const verifier = supabaseVerifierFromConfig(config);
        if (!verifier.isConfigured) {
          logger.warn(
            'access tokens are not accepted: set SUPABASE_JWT_ISSUER and SUPABASE_JWT_JWKS_URL ' +
              'or SUPABASE_JWT_SECRET (every authenticated route answers 401)',
          );
        }
        return verifier;
      },
    },
    AuthGuard,
    { provide: APP_GUARD, useClass: RequestGuard },
    RouteContractCheck,
  ],
  exports: [TOKEN_VERIFIER],
})
export class AuthenticationModule {}
