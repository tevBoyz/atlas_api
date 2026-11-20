import { Controller, Get, Header, HttpCode, Param, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { Public } from '../../common/guards/route-access';
import { RateLimit } from '../../common/rate-limit';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { requireInviteToken } from './invite-input';
import {
  acceptedInviteSchema,
  declinedInviteSchema,
  inviteLookupSchema,
  invitePreviewSchema,
  inviteTokenParamsSchema,
} from './invite.schemas';
import type {
  InviteDecisionJson,
  InviteLookupJson,
  InvitePreviewJson,
} from './invitee-invites.repository';
import { InviteeInvitesService } from './invitee-invites.service';

/**
 * The invitee's side of an invitation (API-100-29/30, spec §11.3 I6-I9). The token is a path
 * parameter: request logs carry the route template only (`/v1/invites/:token/...`), and traces and
 * free text scrub `invites/<token>`. The status lookup is public and limited per IP (`public`
 * policy, API-100-11); the other three need a caller and use the default per-user limit. Accept is
 * the only route of the API that makes a member row `active` (`membership.activate`). No SMS.
 */
@Controller('invites/:token')
export class InviteeInvitesController {
  constructor(private readonly invites: InviteeInvitesService) {}

  /** I6, `lookup_circle_invite(token)`. Public; rate limited per IP. */
  @Get('status')
  @Public()
  @RateLimit('public')
  @Header('cache-control', 'no-store')
  @ApiContract({
    operationId: 'lookupCircleInvite',
    summary: 'Is this invitation still valid? (no sign-in; status only)',
    tag: 'invites',
    params: inviteTokenParamsSchema,
    responses: {
      200: {
        description:
          'The lookup status and expiry only: never a name, phone or id. A blank or unknown token is `not_found`.',
        name: 'InviteLookup',
        schema: inviteLookupSchema,
      },
    },
    errors: ['validation:invalid_request'],
  })
  lookup(@Param('token') token: unknown): Promise<InviteLookupJson> {
    return this.invites.lookup(requireInviteToken(token));
  }

  /** I7, `preview_circle_invite(token)`. POST because it can claim the invitation. */
  @Post('preview')
  @HttpCode(200)
  @Operation('preview_circle_invite')
  @ApiContract({
    operationId: 'previewCircleInvite',
    summary: 'Who invited me, and can I accept? (claims the invitation for the caller)',
    tag: 'invites',
    params: inviteTokenParamsSchema,
    responses: {
      200: {
        description:
          'Status and what the caller may see. A pending invitation the caller may accept is claimed (bound to the caller, still pending). The owner previewing their own invitation never claims it. Safe to repeat.',
        name: 'InvitePreview',
        schema: invitePreviewSchema,
      },
    },
    errors: ['validation:invalid_request', 'preview_circle_invite:duplicate_membership'],
  })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: unknown,
  ): Promise<InvitePreviewJson> {
    return this.invites.preview(user, requireInviteToken(token));
  }

  /** I8, `accept_circle_invite(token)`. */
  @Post('accept')
  @HttpCode(200)
  @Operation('accept_circle_invite')
  @ApiContract({
    operationId: 'acceptCircleInvite',
    summary: 'Join the circle of this invitation under my own name',
    tag: 'invites',
    params: inviteTokenParamsSchema,
    responses: {
      200: {
        description:
          'The caller is an active member. Repeating it returns the same body without a second write. No profile or location sharing is needed; no circle is created for the caller.',
        name: 'AcceptedInvite',
        schema: acceptedInviteSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'accept_circle_invite:not_found',
      'accept_circle_invite:expired',
      'accept_circle_invite:consumed',
      'accept_circle_invite:canceled',
      'accept_circle_invite:not_recipient',
      'accept_circle_invite:own_circle',
      'accept_circle_invite:already_member',
      'accept_circle_invite:circle_full',
      'accept_circle_invite:duplicate_membership',
    ],
  })
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: unknown,
  ): Promise<InviteDecisionJson> {
    return this.invites.accept(user, requireInviteToken(token));
  }

  /** I9, `decline_circle_invite(token)`. */
  @Post('decline')
  @HttpCode(200)
  @Operation('decline_circle_invite')
  @ApiContract({
    operationId: 'declineCircleInvite',
    summary: 'Decline this invitation (frees its place)',
    tag: 'invites',
    params: inviteTokenParamsSchema,
    responses: {
      200: {
        description:
          'The invitation is declined and its token looks up as `canceled`. Not repeatable: a second decline is `canceled`.',
        name: 'DeclinedInvite',
        schema: declinedInviteSchema,
      },
    },
    errors: [
      'validation:invalid_request',
      'decline_circle_invite:not_found',
      'decline_circle_invite:expired',
      'decline_circle_invite:consumed',
      'decline_circle_invite:canceled',
      'decline_circle_invite:not_recipient',
    ],
  })
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('token') token: unknown,
  ): Promise<InviteDecisionJson> {
    return this.invites.decline(user, requireInviteToken(token));
  }
}
