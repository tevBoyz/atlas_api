import { Controller, Get } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { capacitySchema, ownCircleSchema } from './circle.schemas';
import type { CapacityJson } from './circles.repository';
import { CirclesService, type OwnCircleJson } from './circles.service';

/**
 * The caller's own circle (API-100-24). Read-only: default authenticated rate limit, no
 * Idempotency-Key, no location-sharing or profile check (as `circle_invite_capacity` and the
 * `safety_circles` SELECT).
 */
@Controller('me/circle')
export class MeCircleController {
  constructor(private readonly circles: CirclesService) {}

  /**
   * Spec §11.3 C1. Replaces the app's `safety_circles` SELECT (`fetchOwnCircle`), the owner's
   * `list_circle_members` and `circle_invite_capacity`. Prefix `safety_circles` (the table it
   * replaces, like `profiles:*` and `incident_events:*`); its only error is `not_authenticated`.
   */
  @Get()
  @Operation('safety_circles')
  @ApiContract({
    operationId: 'fetchOwnCircle',
    summary: 'The circle the caller owns, its members (owner view) and its capacity',
    tag: 'circles',
    responses: {
      200: {
        description:
          '`circle` and `capacity` are null and `members` is empty when the caller owns no circle. Never contains `invite_token`.',
        name: 'OwnCircle',
        schema: ownCircleSchema,
      },
    },
  })
  ownCircle(@CurrentUser() user: AuthenticatedUser): Promise<OwnCircleJson> {
    return this.circles.ownCircle(user);
  }

  /** Spec §11.3 C2, `circle_invite_capacity()`. */
  @Get('capacity')
  @Operation('circle_invite_capacity')
  @ApiContract({
    operationId: 'circleInviteCapacity',
    summary: 'How many trusted-member slots of the circle the caller owns are used and free',
    tag: 'circles',
    responses: {
      200: {
        description: 'Active members plus valid pending invites, owner excluded (limit 5)',
        name: 'Capacity',
        schema: capacitySchema,
      },
    },
    errors: ['circle_invite_capacity:not_owner'],
  })
  capacity(@CurrentUser() user: AuthenticatedUser): Promise<CapacityJson> {
    return this.circles.capacity(user);
  }
}
