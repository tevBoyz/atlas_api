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
import {
  DatabaseSessionStatusReader,
  SESSION_STATUS_READER,
  type SessionStatusReader,
} from './session-status';
import { TOKEN_VERIFIER } from './token-verifier';

/** The guard's verifier: the API's own access tokens (API-100-51). */
export function tokenVerifierFromConfig(
  config: ApiConfigService,
  ring: AtlasKeyRing,
  sessions: SessionStatusReader,
): AtlasTokenVerifier {
  return new AtlasTokenVerifier(ring, sessions, config.get('AUTH_JWT_CLOCK_SKEW_SECONDS'));
}

/**
 * Authentication for every route (API-100-08): the global {@link RequestGuard} (authentication,
 * then rate limiting, API-100-11), the active {@link TOKEN_VERIFIER} and the boot-time
 * {@link RouteContractCheck}.
 *
 * The verifier accepts only the API's own access tokens (keys from AUTH_JWT_KEYS,
 * {@link ATLAS_KEY_RING}); Supabase access tokens were retired with the old backend (D76).
 * Production config requires the keys (config.schema.ts). Elsewhere they may be missing, but then
 * every token answers 401 (fail closed): logged once here.
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
    {
      provide: TOKEN_VERIFIER,
      inject: [ApiConfigService, ATLAS_KEY_RING, SESSION_STATUS_READER, ROOT_LOGGER],
      useFactory: (
        config: ApiConfigService,
        ring: AtlasKeyRing,
        sessions: SessionStatusReader,
        logger: Logger,
      ) => {
        if (!ring.isConfigured) {
          logger.warn(
            'own access tokens are not accepted: set AUTH_JWT_KEYS and AUTH_JWT_ACTIVE_KID',
          );
        }
        return tokenVerifierFromConfig(config, ring, sessions);
      },
    },
    AuthGuard,
    { provide: APP_GUARD, useClass: RequestGuard },
    RouteContractCheck,
  ],
  exports: [TOKEN_VERIFIER, ATLAS_KEY_RING],
})
export class AuthenticationModule {}
