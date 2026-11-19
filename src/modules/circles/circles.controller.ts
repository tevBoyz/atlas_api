import { Controller, Get, Param } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { invalidRequest, isPostgresUuidInput } from '../incidents/incident-input';
import { circleIdParamsSchema, circleMemberListSchema } from './circle.schemas';
import type { CircleMemberJson } from './circles.repository';
import { CirclesService } from './circles.service';

/** The `{circle_id}` path parameter: valid uuid input, else 422 on field `circle_id`. */
export function requireCircleId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('circle_id');
  return value;
}

/** Circle routes by id (API-100-25). Read-only: default authenticated rate limit. */
@Controller('circles')
export class CirclesController {
  constructor(private readonly circles: CirclesService) {}

  /**
   * Spec §11.3 C3, `list_circle_members(circle_id)`: the owner or an active member. Unknown circle →
   * 404 `list_circle_members:not_found`; anyone else → 403 `list_circle_members:not_authorized`.
   */
  @Get(':circle_id/members')
  @Operation('list_circle_members')
  @ApiContract({
    operationId: 'listCircleMembers',
    summary: 'Who is in the circle, by their current names',
    tag: 'circles',
    params: circleIdParamsSchema,
    responses: {
      200: {
        description:
          'Owner first, then active, pending, expired, declined, then by name. The owner sees every row with contact and invite fields; a member sees active rows only, without them.',
        schema: circleMemberListSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'list_circle_members:not_found',
      'list_circle_members:not_authorized',
    ],
  })
  members(
    @CurrentUser() user: AuthenticatedUser,
    @Param('circle_id') circleId: unknown,
  ): Promise<CircleMemberJson[]> {
    return this.circles.members(user, requireCircleId(circleId));
  }
}
