import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../config';
import { ROOT_LOGGER } from '../../observability/logger';
import { AuthGuard } from '../guards/auth.guard';
import { RequestGuard } from '../guards/request.guard';
import { RouteContractCheck } from '../guards/route-contract';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { ATLAS_KEY_RING, AtlasKeyRing } from './atlas-key-ring';
import { AtlasTokenVerifier } from './atlas-token-verifier';
import { DualTokenVerifier, type TokenUsageRecorder } from './dual-token-verifier';
import {
  DatabaseSessionStatusReader,
  SESSION_STATUS_READER,
  type SessionStatusReader,
} from './session-status';
import { SupabaseTokenVerifier } from './supabase-token-verifier';
import { TOKEN_USAGE, TokenUsageMetrics } from './token-usage';
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

/** The dual-token verifier (API-100-51/59): own tokens, and Supabase tokens while accepted. */
export function dualVerifierFromConfig(
  config: ApiConfigService,
  ring: AtlasKeyRing,
  sessions: SessionStatusReader,
  usage?: TokenUsageRecorder,
): DualTokenVerifier {
  const until = config.get('SUPABASE_JWT_ACCEPT_UNTIL');
  return new DualTokenVerifier(
    ring.issuer,
    new AtlasTokenVerifier(ring, sessions, config.get('AUTH_JWT_CLOCK_SKEW_SECONDS')),
    supabaseVerifierFromConfig(config),
    {
      accept: config.get('SUPABASE_JWT_ACCEPT'),
      untilMs: until === undefined ? undefined : Date.parse(until),
    },
    usage,
  );
}

/**
 * Authentication for every route (API-100-08): the global {@link RequestGuard} (authentication,
 * then rate limiting, API-100-11), the active {@link TOKEN_VERIFIER} and the boot-time
 * {@link RouteContractCheck}.
 *
 * The verifier is the dual-token verifier (API-100-51/59): the API's own access tokens (keys from
 * AUTH_JWT_KEYS, {@link ATLAS_KEY_RING}) and, while SUPABASE_JWT_ACCEPT allows it, Supabase access
 * tokens. Production config requires both key sources (config.schema.ts). Elsewhere a missing one
 * is allowed, but then those tokens answer 401 (fail closed): logged once here.
 */
@Module({
  imports: [DiscoveryModule, RateLimitModule],
  providers: [
    {
      provide: ATLAS_KEY_RING,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => AtlasKeyRing.fromConfig(config),
    },
    { provide: SESSION_STATUS_READER, useClass: DatabaseSessionStatusReader },
    { provide: TOKEN_USAGE, useClass: TokenUsageMetrics },
    {
      provide: TOKEN_VERIFIER,
      inject: [ApiConfigService, ATLAS_KEY_RING, SESSION_STATUS_READER, TOKEN_USAGE, ROOT_LOGGER],
      useFactory: (
        config: ApiConfigService,
        ring: AtlasKeyRing,
        sessions: SessionStatusReader,
        usage: TokenUsageMetrics,
        logger: Logger,
      ) => {
        if (!supabaseVerifierFromConfig(config).isConfigured) {
          logger.warn(
            'Supabase access tokens are not accepted: set SUPABASE_JWT_ISSUER and ' +
              'SUPABASE_JWT_JWKS_URL or SUPABASE_JWT_SECRET',
          );
        }
        if (!ring.isConfigured) {
          logger.warn(
            'own access tokens are not accepted: set AUTH_JWT_KEYS and AUTH_JWT_ACTIVE_KID',
          );
        }
        return dualVerifierFromConfig(config, ring, sessions, usage);
      },
    },
    AuthGuard,
    { provide: APP_GUARD, useClass: RequestGuard },
    RouteContractCheck,
  ],
  exports: [TOKEN_VERIFIER, ATLAS_KEY_RING, TOKEN_USAGE],
})
export class AuthenticationModule {}
