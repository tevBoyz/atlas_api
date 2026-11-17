import { Controller, Get } from '@nestjs/common';

/**
 * Scaffold-only routes (API-100-01). They exist only to prove the `/v1` prefix and
 * its health exclusion work. No dependency checks, no business logic.
 * - `GET /healthz` is replaced by the real health module in API-100-07.
 * - `GET /v1/ping` is removed once the first real `/v1` route exists.
 */
@Controller()
export class ScaffoldController {
  @Get('healthz')
  healthz(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ping')
  ping(): { status: string } {
    return { status: 'ok' };
  }
}
