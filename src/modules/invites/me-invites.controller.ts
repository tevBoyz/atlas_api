import { Controller, Get, Header } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { incomingInviteListSchema } from './invite.schemas';
import type { IncomingInviteJson } from './invitee-invites.repository';
import { InviteeInvitesService } from './invitee-invites.service';

/**
 * The invitations sent to the caller (API-100-31 AC1, spec §11.3 I10). A read route (default
 * authenticated rate limit) with the SQL function's side effect: pending invitations the caller may
 * accept are claimed (bound to the caller, still pending). It never activates a member row. The body
 * carries invite tokens: never cached (`no-store`) and never logged (request logs carry the route).
 */
@Controller('me/invites')
export class MeInvitesController {
  constructor(private readonly invites: InviteeInvitesService) {}

  /** I10, `list_my_circle_invites()`. */
  @Get()
  @Operation('list_my_circle_invites')
  @Header('cache-control', 'no-store')
  @ApiContract({
    operationId: 'listMyCircleInvites',
    summary: 'Invitations sent to me (pending, expired and canceled), newest first',
    tag: 'invites',
    responses: {
      200: {
        description:
          "Rows claimed by the caller, or unclaimed phone invitations to the caller's (normalized) phone. Accepted invitations are not listed. Pending invitations the caller may accept are claimed by this call (safe to repeat); `invite_token` is set only while pending.",
        schema: incomingInviteListSchema,
      },
    },
  })
  listMine(@CurrentUser() user: AuthenticatedUser): Promise<IncomingInviteJson[]> {
    return this.invites.listIncoming(user);
  }
}
