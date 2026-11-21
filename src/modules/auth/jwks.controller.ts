import { Controller, Get, Header, Inject } from '@nestjs/common';

import { ATLAS_KEY_RING, type AtlasKeyRing, type PublishedJwk } from '../../common/auth';
import { Public, SkipRateLimit } from '../../common/guards/route-access';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { jwksSchema } from './auth.schemas';

/**
 * The public keys of the API's own access tokens (API-100-51 AC1/AC2): every key of
 * AUTH_JWT_KEYS, the active one first. A new key is published here before it signs anything, and an
 * old key stays until every token it signed has expired. Public parts only. Static and cacheable,
 * so it is not rate limited (as the health routes).
 */
@Controller('auth/.well-known')
@Public()
@SkipRateLimit()
export class JwksController {
  constructor(@Inject(ATLAS_KEY_RING) private readonly ring: AtlasKeyRing) {}

  @Get('jwks.json')
  @Header('cache-control', 'public, max-age=300')
  @ApiContract({
    operationId: 'getAuthJwks',
    summary: 'Public keys that verify the API access tokens (JWKS)',
    tag: 'auth',
    responses: {
      200: {
        description:
          'The key set: `kid` in a token header names its key. Empty when own tokens are not configured.',
        name: 'Jwks',
        schema: jwksSchema,
      },
    },
  })
  jwks(): { keys: PublishedJwk[] } {
    return this.ring.jwks;
  }
}
