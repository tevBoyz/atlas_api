import { Controller, Get } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from './common/auth';
import { Operation } from './common/errors';

/**
 * Scaffold-only route (API-100-01). It exists only to prove the `/v1` prefix works. No business
 * logic. Removed once the first real `/v1` route exists. (`GET /healthz` moved to the health
 * module in API-100-07.)
 *
 * Since API-100-08 it is authenticated like every other `/v1` route (scaffold code
 * `ping:not_authenticated`) and echoes the caller id, so a token can be checked end to end.
 */
@Controller()
export class ScaffoldController {
  @Get('ping')
  @Operation('ping')
  ping(@CurrentUser() user: AuthenticatedUser): { status: string; user_id: string } {
    return { status: 'ok', user_id: user.id };
  }
}
