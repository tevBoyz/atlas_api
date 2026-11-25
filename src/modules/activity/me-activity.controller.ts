import { Controller, Get } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation, ZodQuery } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { activityPageSchema, type ActivityQuery, activityQuerySchema } from './activity.schemas';
import { type ActivityPage, ActivityService } from './activity.service';

/**
 * SCRUM-82 (View Emergency Activity Log), D72: the caller's activity log across all their alerts and
 * circle alerts. Read-only: default authenticated rate limit, no Idempotency-Key.
 */
@Controller('me/activity')
export class MeActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @Operation('activity')
  @ApiContract({
    operationId: 'listMyActivity',
    summary: "The caller's emergency activity log (My Emergencies and Circle Alerts), newest first",
    tag: 'activity',
    query: activityQuerySchema,
    responses: {
      200: {
        description:
          'One page, newest first (`occurred_at`, then `id`, descending). Circle entries only for alerts of circles the caller is an active member of, inside the access window. No user ids.',
        name: 'ActivityPage',
        schema: activityPageSchema,
      },
    },
    errors: ['validation:invalid_request'],
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @ZodQuery(activityQuerySchema) query: ActivityQuery,
  ): Promise<ActivityPage> {
    return this.activity.list(user, query);
  }
}
