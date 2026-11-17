import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { Public, SkipRateLimit } from '../common/guards/route-access';
import { QuietRequestLog } from '../observability/http-hooks';
import type { ReadyBody, UnavailableBody } from './readiness';
import { ReadinessService } from './readiness.service';

/**
 * Liveness and readiness (API-100-07, spec §11.3 H1/H2). Served at the root, outside `/v1`
 * (`UNPREFIXED_ROUTES`). Public, never rate limited, and their completion log line is debug-level.
 */
@Controller()
@Public()
@SkipRateLimit()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** AC1: the process is up. No dependency checks. */
  @Get('healthz')
  @QuietRequestLog()
  @Header('cache-control', 'no-store')
  healthz(): ReadyBody {
    return { status: 'ok' };
  }

  /**
   * AC2: 200 `{"status":"ok"}` when DB, Redis and migrations pass, else 503
   * `{"status":"unavailable","failed":[...]}`.
   *
   * Documented exemption from the error envelope (API-100-05): the 503 is a normal return with
   * the status set here, never a thrown exception, so the global filter never sees it.
   */
  @Get('readyz')
  @QuietRequestLog()
  @Header('cache-control', 'no-store')
  async readyz(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReadyBody | UnavailableBody> {
    const report = await this.readiness.check();
    if (report.ready) return { status: 'ok' };
    void reply.status(503);
    return { status: 'unavailable', failed: report.failed };
  }
}
