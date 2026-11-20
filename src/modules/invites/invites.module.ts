import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { InviteeInvitesController } from './invitee-invites.controller';
import { InviteeInvitesRepository } from './invitee-invites.repository';
import { InviteeInvitesService } from './invitee-invites.service';
import { OwnerInvitesController } from './owner-invites.controller';
import { OwnerInvitesRepository } from './owner-invites.repository';
import { OwnerInvitesService } from './owner-invites.service';

/**
 * Invitations (spec §11.3 invites module). API-100-26/27/28: the owner's side (invite by phone,
 * batch, link, resend, cancel). API-100-29/30: the invitee's side (public status lookup, preview
 * with its claim, accept, decline). The incoming list arrives with API-100-31. Capacity and invite
 * status use the shared slot rules of the circles module (`circles/invite-slots.ts`).
 */
@Module({
  imports: [AuditModule],
  controllers: [OwnerInvitesController, InviteeInvitesController],
  providers: [
    OwnerInvitesRepository,
    OwnerInvitesService,
    InviteeInvitesRepository,
    InviteeInvitesService,
  ],
})
export class InvitesModule {}
