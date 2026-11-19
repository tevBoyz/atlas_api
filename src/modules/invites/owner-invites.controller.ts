import { Body, Controller, HttpCode, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { Idempotent } from '../../common/idempotency';
import { ApiContract } from '../../openapi/api-contract.decorator';
import {
  batchInvitesFromBody,
  linkInviteFromBody,
  phoneInviteFromBody,
  requireMemberId,
} from './invite-input';
import {
  batchInviteRequestSchema,
  batchInviteResultSchema,
  canceledInviteSchema,
  linkInviteRequestSchema,
  memberIdParamsSchema,
  memberInvitePayloadSchema,
  phoneInviteRequestSchema,
} from './invite.schemas';
import type { CanceledInviteJson, MemberInvitePayload } from './owner-invites.repository';
import { type BatchInviteResult, OwnerInvitesService } from './owner-invites.service';

const OWNER_PRECONDITION =
  'The caller must have a profile with location sharing on and own a circle.';

/**
 * The owner's invitations (API-100-26/27/28, spec §11.3 I1-I5). Default authenticated rate limit.
 * The three creating routes honour an optional `Idempotency-Key` (spec §11.2: recommended on invite
 * creation); resend and cancel take none (as the RPCs, repeating them is their own business rule).
 * No route here can make a member row `active` (spec §4.4 "known bypass"). No SMS is sent.
 */
@Controller('me/circle/invites')
export class OwnerInvitesController {
  constructor(private readonly invites: OwnerInvitesService) {}

  /** I1, `invite_circle_member_by_phone(display_name, phone, relationship)`. */
  @Post('phone')
  @Operation('invite_circle_member_by_phone')
  @Idempotent('optional')
  @ApiContract({
    operationId: 'inviteCircleMemberByPhone',
    summary: 'Invite one person by phone, or refresh the invitation of that phone',
    tag: 'invites',
    body: { name: 'PhoneInviteRequest', schema: phoneInviteRequestSchema },
    responses: {
      200: {
        description: `The phone's existing invitation was refreshed: same \`member_id\`, new token and expiry, \`resent: true\`. ${OWNER_PRECONDITION}`,
        name: 'MemberInvitePayload',
        schema: memberInvitePayloadSchema,
      },
      201: {
        description: `A new pending invitation (\`resent: false\`). ${OWNER_PRECONDITION}`,
        name: 'MemberInvitePayload',
        schema: memberInvitePayloadSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'invite_circle_member_by_phone:profile_not_found',
      'invite_circle_member_by_phone:location_sharing_disabled',
      'invite_circle_member_by_phone:circle_not_found',
      'invite_circle_member_by_phone:invalid_display_name',
      'invite_circle_member_by_phone:invalid_phone',
      'invite_circle_member_by_phone:invalid_relationship',
      'invite_circle_member_by_phone:already_active',
      'invite_circle_member_by_phone:circle_full',
      'invite_circle_member_by_phone:duplicate_membership',
    ],
  })
  async invitePhone(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MemberInvitePayload> {
    const result = await this.invites.invitePhone(user, phoneInviteFromBody(body));
    void reply.status(result.status);
    return result.body;
  }

  /** I2, `invite_circle_members_by_phone(p_invites)`. */
  @Post('phone/batch')
  @HttpCode(200)
  @Operation('invite_circle_members_by_phone')
  @Idempotent('optional')
  @ApiContract({
    operationId: 'inviteCircleMembersByPhone',
    summary: 'Invite several people by phone in one go, with an outcome per person',
    tag: 'invites',
    body: { name: 'BatchInviteRequest', schema: batchInviteRequestSchema },
    responses: {
      200: {
        description: `Each item is \`created\`, \`skipped\` or \`not_created\`, in array order. ${OWNER_PRECONDITION}`,
        name: 'BatchInviteResult',
        schema: batchInviteResultSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'invite_circle_members_by_phone:profile_not_found',
      'invite_circle_members_by_phone:location_sharing_disabled',
      'invite_circle_members_by_phone:circle_not_found',
      'invite_circle_members_by_phone:invalid_invites',
    ],
  })
  inviteBatch(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<BatchInviteResult> {
    return this.invites.inviteBatch(user, batchInvitesFromBody(body));
  }

  /** I3, `create_circle_invite_link(display_name)`. Each call reserves a slot. */
  @Post('link')
  @Operation('create_circle_invite_link')
  @Idempotent('optional')
  @ApiContract({
    operationId: 'createCircleInviteLink',
    summary: 'Create a single-use invitation link (reserves one slot)',
    tag: 'invites',
    body: { name: 'LinkInviteRequest', schema: linkInviteRequestSchema },
    responses: {
      201: {
        description: `A new pending invitation without a phone (\`phone: null\`, \`resent: false\`). Every call creates one: send an \`Idempotency-Key\` to make a retry safe. ${OWNER_PRECONDITION}`,
        name: 'MemberInvitePayload',
        schema: memberInvitePayloadSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'create_circle_invite_link:profile_not_found',
      'create_circle_invite_link:location_sharing_disabled',
      'create_circle_invite_link:circle_not_found',
      'create_circle_invite_link:circle_full',
    ],
  })
  createLink(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<MemberInvitePayload> {
    return this.invites.createLink(user, linkInviteFromBody(body));
  }

  /** I4, `resend_circle_invite(member_id)`. */
  @Post(':member_id/resend')
  @HttpCode(200)
  @Operation('resend_circle_invite')
  @ApiContract({
    operationId: 'resendCircleInvite',
    summary: 'Resend a pending, expired or declined invitation with a new token',
    tag: 'invites',
    params: memberIdParamsSchema,
    responses: {
      200: {
        description: `Same \`member_id\`, new token (the old one stops working) and 7-day expiry, \`resent: true\`. An expired or declined invitation needs a free slot. ${OWNER_PRECONDITION}`,
        name: 'MemberInvitePayload',
        schema: memberInvitePayloadSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'resend_circle_invite:profile_not_found',
      'resend_circle_invite:location_sharing_disabled',
      'resend_circle_invite:circle_not_found',
      'resend_circle_invite:member_not_found',
      'resend_circle_invite:not_invitable',
      'resend_circle_invite:already_active',
      'resend_circle_invite:circle_full',
    ],
  })
  resend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('member_id') memberId: unknown,
  ): Promise<MemberInvitePayload> {
    return this.invites.resend(user, requireMemberId(memberId));
  }

  /** I5, `cancel_circle_invite(member_id)`. No location-sharing or profile check. */
  @Post(':member_id/cancel')
  @HttpCode(200)
  @Operation('cancel_circle_invite')
  @ApiContract({
    operationId: 'cancelCircleInvite',
    summary: 'Cancel a pending or expired invitation and free its place',
    tag: 'invites',
    params: memberIdParamsSchema,
    responses: {
      200: {
        description:
          'The invitation is declined and its token looks up as `canceled`. Owner of the circle only.',
        name: 'CanceledInvite',
        schema: canceledInviteSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'cancel_circle_invite:not_found',
      'cancel_circle_invite:not_authorized',
      'cancel_circle_invite:cannot_cancel_owner',
      'cancel_circle_invite:not_pending',
    ],
  })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('member_id') memberId: unknown,
  ): Promise<CanceledInviteJson> {
    return this.invites.cancel(user, requireMemberId(memberId));
  }
}
