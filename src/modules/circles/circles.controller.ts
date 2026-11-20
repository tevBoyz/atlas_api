import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { invalidRequest, isPostgresUuidInput } from '../incidents/incident-input';
import {
  circleIdParamsSchema,
  circleMemberListSchema,
  circleMemberParamsSchema,
  leftCircleSchema,
  removedMemberSchema,
} from './circle.schemas';
import type { CircleMemberJson } from './circles.repository';
import { CirclesService } from './circles.service';
import {
  type LeftCircleJson,
  MembershipService,
  type RemovedMemberJson,
} from './membership.service';

/** The `{circle_id}` path parameter: valid uuid input, else 422 on field `circle_id`. */
export function requireCircleId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('circle_id');
  return value;
}

/** The `{member_id}` path parameter: valid uuid input, else 422 on field `member_id`. */
function requireCircleMemberId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('member_id');
  return value;
}

/**
 * Circle routes by id: the member list (API-100-25), remove and leave (API-100-32). Default
 * authenticated rate limit. Remove and leave end a membership through `MembershipService.end`
 * (parity: the member row is deleted); neither takes an `Idempotency-Key` (as the RPCs, a repeat is
 * their own business rule: `not_found` / `not_authorized`). No route here can make a member row
 * `active`.
 */
@Controller('circles')
export class CirclesController {
  constructor(
    private readonly circles: CirclesService,
    private readonly memberships: MembershipService,
  ) {}

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

  /**
   * Spec §11.3 C4, `remove_circle_member(member_id)`: the circle owner removes a member row (active,
   * pending or declined). `{member_id}` must be a row of `{circle_id}`; a row of another circle is
   * 404, as an unknown one. Checks in the SQL order: 404 `not_found`, 403 `not_authorized`, 409
   * `cannot_remove_owner`.
   */
  @Delete(':circle_id/members/:member_id')
  @Operation('remove_circle_member')
  @ApiContract({
    operationId: 'removeCircleMember',
    summary: 'Remove a member or invitation from the circle I own (access ends at once)',
    tag: 'circles',
    params: circleMemberParamsSchema,
    responses: {
      200: {
        description:
          'The member row is deleted (with its alert deliveries), as today. The person loses every incident of the circle at once, history included.',
        name: 'RemovedMember',
        schema: removedMemberSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'remove_circle_member:not_found',
      'remove_circle_member:not_authorized',
      'remove_circle_member:cannot_remove_owner',
    ],
  })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('circle_id') circleId: unknown,
    @Param('member_id') memberId: unknown,
  ): Promise<RemovedMemberJson> {
    return this.memberships.remove(
      user,
      requireCircleId(circleId),
      requireCircleMemberId(memberId),
    );
  }

  /**
   * Spec §11.3 C5, `leave_safety_circle(circle_id)`: an active member leaves. Checks in the SQL
   * order: 404 `not_found`, 409 `is_owner`, 403 `not_authorized`.
   */
  @Post(':circle_id/leave')
  @HttpCode(200)
  @Operation('leave_safety_circle')
  @ApiContract({
    operationId: 'leaveSafetyCircle',
    summary: 'Leave a circle I am a member of (access ends at once)',
    tag: 'circles',
    params: circleIdParamsSchema,
    responses: {
      200: {
        description:
          "The caller's member row is deleted (with its alert deliveries), as today. The owner cannot leave.",
        name: 'LeftCircle',
        schema: leftCircleSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'leave_safety_circle:not_found',
      'leave_safety_circle:is_owner',
      'leave_safety_circle:not_authorized',
    ],
  })
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('circle_id') circleId: unknown,
  ): Promise<LeftCircleJson> {
    return this.memberships.leave(user, requireCircleId(circleId));
  }
}
