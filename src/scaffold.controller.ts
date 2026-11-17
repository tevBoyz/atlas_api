import { Controller, Get } from '@nestjs/common';

/**
 * Scaffold-only route (API-100-01). It exists only to prove the `/v1` prefix works. No business
 * logic. Removed once the first real `/v1` route exists. (`GET /healthz` moved to the health
 * module in API-100-07.)
 */
@Controller()
export class ScaffoldController {
  @Get('ping')
  ping(): { status: string } {
    return { status: 'ok' };
  }
}
