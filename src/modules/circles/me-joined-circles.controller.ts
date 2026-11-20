import { Controller, Get } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { joinedCircleListSchema } from './circle.schemas';
import type { JoinedCircleJson } from './circles.repository';
import { CirclesService } from './circles.service';

/** The circles the caller belongs to (API-100-31 AC2). Read-only: default authenticated limit. */
@Controller('me/joined-circles')
export class MeJoinedCirclesController {
  constructor(private readonly circles: CirclesService) {}

  /** Spec §11.3 C6, `list_my_joined_circles()`. */
  @Get()
  @Operation('list_my_joined_circles')
  @ApiContract({
    operationId: 'listMyJoinedCircles',
    summary: 'The circles the caller is an active member of (the own circle included)',
    tag: 'circles',
    responses: {
      200: {
        description:
          'Newest `joined_at` first. Includes the circle the caller owns (`role: owner`), as today. No phone, email, emergency or medical field.',
        schema: joinedCircleListSchema,
      },
    },
  })
  joinedCircles(@CurrentUser() user: AuthenticatedUser): Promise<JoinedCircleJson[]> {
    return this.circles.joinedCircles(user);
  }
}
