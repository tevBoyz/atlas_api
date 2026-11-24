import { Controller, Get, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireTestAlertId } from './test-alert-input';
import {
  latestTestAlertSchema,
  testAlertIdParamsSchema,
  testAlertSentSchema,
  testAlertStatusSchema,
} from './test-alert.schemas';
import type { SentTestAlert } from './test-alerts.repository';
import { TestAlertsService, type TestAlertStatusJson } from './test-alerts.service';

/**
 * The circle owner's test alerts (SCRUM-35, D66-D68). The routes use the default authenticated rate
 * limit; the send also has its own per-owner limit (D66: 1 per 5 minutes, 10 per 24 hours).
 */
@Controller('me/circle/test-alerts')
export class MeTestAlertsController {
  constructor(private readonly testAlerts: TestAlertsService) {}

  /**
   * D66: to the ACTIVE members only. No active member (or no circle) → 409
   * `test_alerts:no_eligible_recipients`, nothing stored or sent; over the limit → 429
   * `test_alerts:rate_limited` with `Retry-After` and `details {retry_after_seconds, next_allowed_at,
   * reason}`. Idempotency-Key required (a retry of the same request answers the stored response).
   */
  @Post()
  @Operation('test_alerts')
  @Idempotent('required')
  @ApiContract({
    operationId: 'sendCircleTestAlert',
    summary: 'Send a test alert (TEST ALERT — NOT AN EMERGENCY) to the active members of my circle',
    tag: 'circles',
    responses: {
      201: {
        description:
          'Submitted: stored and queued for each active member. Delivery is confirmed later by the status (`delivered` / `seen`).',
        name: 'TestAlertSent',
        schema: testAlertSentSchema,
      },
    },
    errors: ['test_alerts:no_eligible_recipients', 'test_alerts:rate_limited'],
  })
  send(@CurrentUser() user: AuthenticatedUser): Promise<SentTestAlert> {
    return this.testAlerts.send(user);
  }

  /** D68: only the latest test is shown to the owner (plan assumption 5). */
  @Get('latest')
  @Operation('test_alerts')
  @ApiContract({
    operationId: 'latestCircleTestAlert',
    summary: 'The status of my latest test alert',
    tag: 'circles',
    responses: {
      200: {
        description: '`test_alert` is null when I never sent one.',
        name: 'LatestTestAlert',
        schema: latestTestAlertSchema,
      },
    },
  })
  latest(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ test_alert: TestAlertStatusJson | null }> {
    return this.testAlerts.latest(user);
  }

  /** D68: one of the caller's own tests; any other id → 404 `test_alerts:not_found`. */
  @Get(':id')
  @Operation('test_alerts')
  @ApiContract({
    operationId: 'getCircleTestAlertStatus',
    summary: 'The delivery status of one of my test alerts, per member',
    tag: 'circles',
    params: testAlertIdParamsSchema,
    responses: {
      200: {
        description: 'Counts and per-member states',
        name: 'TestAlertStatus',
        schema: testAlertStatusSchema,
      },
    },
    errors: ['validation:invalid_request', 'test_alerts:not_found'],
  })
  status(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<TestAlertStatusJson> {
    return this.testAlerts.status(user, requireTestAlertId(id));
  }
}
