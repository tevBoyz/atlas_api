import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { Public, SkipRateLimit } from '../common/guards/route-access';
import { QuietRequestLog } from '../observability/http-hooks';
import { ApiContract } from '../openapi/api-contract.decorator';
import { READINESS_CHECKS, type ReadyBody, type UnavailableBody } from './readiness';
import { ReadinessService } from './readiness.service';

const healthOkSchema = z.object({ status: z.literal('ok') });
const readinessUnavailableSchema = z.object({
  status: z.literal('unavailable'),
  failed: z.array(z.enum(READINESS_CHECKS)),
});

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
  @ApiContract({
    operationId: 'getHealth',
    summary: 'Liveness: the process is up',
    tag: 'health',
    responses: { 200: { description: 'Up', name: 'HealthOk', schema: healthOkSchema } },
  })
  @QuietRequestLog()
  @Header('cache-control', 'no-store')
  healthz(): ReadyBody {
    return { status: 'ok' };
  }

  /**
   * AC2: 200 `{"status":"ok"}` when DB, Redis, migrations and the realtime adapter pass, else 503
   * `{"status":"unavailable","failed":[...]}`.
   *
   * Documented exemption from the error envelope (API-100-05): the 503 is a normal return with
   * the status set here, never a thrown exception, so the global filter never sees it.
   */
  @Get('readyz')
  @ApiContract({
    operationId: 'getReadiness',
    summary: 'Readiness: database, Redis, migrations and the realtime adapter',
    tag: 'health',
    responses: {
      200: { description: 'Ready', name: 'HealthOk', schema: healthOkSchema },
      503: {
        description: 'A dependency failed',
        name: 'ReadinessUnavailable',
        schema: readinessUnavailableSchema,
      },
    },
  })
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
