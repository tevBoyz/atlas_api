import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { OwnerInvitesController } from './owner-invites.controller';
import { OwnerInvitesRepository } from './owner-invites.repository';
import { OwnerInvitesService } from './owner-invites.service';

/**
 * Invitations (spec §11.3 invites module). API-100-26/27/28: the owner's side (invite by phone,
 * batch, link, resend, cancel). The invitee's side (lookup, preview, accept, decline, incoming list)
 * arrives with API-100-29 to 31. Capacity and invite status use the shared slot rules of the circles
 * module (`circles/invite-slots.ts`).
 */
@Module({
  imports: [AuditModule],
  controllers: [OwnerInvitesController],
  providers: [OwnerInvitesRepository, OwnerInvitesService],
})
export class InvitesModule {}
