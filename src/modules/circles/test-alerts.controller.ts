import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireTestAlertId } from './test-alert-input';
import { memberTestAlertSchema, testAlertIdParamsSchema } from './test-alert.schemas';
import { type MemberTestAlertJson, TestAlertsService } from './test-alerts.service';

/**
 * A recipient's side of a test alert (SCRUM-35, D68): only a member the test was sent to who is
 * still an active member of that circle; anyone else (the owner, a pending or ended member, an
 * outsider, an unknown id) gets 404 `test_alerts:not_found`. No Idempotency-Key on seen: idempotent
 * in the domain.
 */
@Controller('test-alerts')
export class TestAlertsController {
  constructor(private readonly testAlerts: TestAlertsService) {}

  @Get(':id')
  @Operation('test_alerts')
  @ApiContract({
    operationId: 'getTestAlert',
    summary: 'A test alert I received (who sent it and when; never an emergency)',
    tag: 'circles',
    params: testAlertIdParamsSchema,
    responses: {
      200: {
        description: 'The test alert',
        name: 'MemberTestAlert',
        schema: memberTestAlertSchema,
      },
    },
    errors: ['validation:invalid_request', 'test_alerts:not_found'],
  })
  read(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<MemberTestAlertJson> {
    return this.testAlerts.memberRead(user, requireTestAlertId(id));
  }

  @Post(':id/seen')
  @HttpCode(200)
  @Operation('test_alerts')
  @ApiContract({
    operationId: 'markTestAlertSeen',
    summary: 'Mark a test alert I received as seen (idempotent)',
    tag: 'circles',
    params: testAlertIdParamsSchema,
    responses: {
      200: {
        description: 'The test alert with `seen_at` (a repeat keeps the first time)',
        name: 'MemberTestAlert',
        schema: memberTestAlertSchema,
      },
    },
    errors: ['validation:invalid_request', 'test_alerts:not_found'],
  })
  seen(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: unknown,
  ): Promise<MemberTestAlertJson> {
    return this.testAlerts.markSeen(user, requireTestAlertId(id));
  }
}
