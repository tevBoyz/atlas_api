import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import { auditSessionId } from '../incidents/incidents.service';
import { newInviteToken } from '../invites/invite-token';
import {
  InviteOperationFailedError,
  isTriggerCircleFull,
  sqlStateOf,
} from '../invites/owner-invites.service';
import {
  type ContactRow,
  ProfileSetupRepository,
  type ProfileSetupJson,
} from './profile-setup.repository';
import { ProfilesRepository, type ProfileTransaction } from './profiles.repository';

/**
 * `POST /v1/me/profile/complete` (API-100-36, spec §6.1 rules 4-6a, §7.1): `complete_profile_setup()`
 * (final: baseline 20261117120000) in one transaction (read committed, as the RPC), in its order:
 *
 * 1. lock the caller's profile `FOR UPDATE`: none → 404 `profile_not_found`; then 409
 *    `personal_info_incomplete`, `emergency_info_incomplete`, `preferences_incomplete` (rule 4);
 * 2. `profile_setup_completed_at = coalesce(existing, now())` (first success wins);
 * 3. location sharing off → `{..., location_sharing_enabled: false, circle_id: null, ...}`: no
 *    circle (deferred creation, rule 5); turned on later (P6) and completed again → step 4;
 * 4. lock (or create) the caller's circle, upsert the owner row (`membership.activate`, path
 *    `profile_setup_owner_row`; `activated_at` from its trigger), upsert the emergency contact's row
 *    (rule 6) in a savepoint: the capacity trigger's `circle_full` is swallowed (the row is left as it
 *    is and its stored status reported), as the function does since 2026-11-17.
 *
 * Lock order profile → circle → member rows (see `ProfileSetupRepository`): the same circle-first
 * order as every invite write and accept, so setup never deadlocks with them. Idempotent; the audit
 * row `profile.setup_completed` is written once, by the call that first completes setup. No SMS.
 */
@Injectable()
export class ProfileSetupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly profiles: ProfilesRepository,
    private readonly repository: ProfileSetupRepository,
    private readonly audit: AuditService,
  ) {}

  complete(user: AuthenticatedUser): Promise<ProfileSetupJson> {
    return this.run(async (tx) => {
      await this.profiles.useUtcTimestamps(tx);
      const profile = await this.repository.lockProfile(tx, user.id);
      if (!profile) throw new DomainError('complete_profile_setup:profile_not_found');
      if (profile.personal_incomplete) {
        throw new DomainError('complete_profile_setup:personal_info_incomplete');
      }
      if (profile.emergency_incomplete) {
        throw new DomainError('complete_profile_setup:emergency_info_incomplete');
      }
      if (profile.preferences_incomplete) {
        throw new DomainError('complete_profile_setup:preferences_incomplete');
      }

      const completedAt = await this.repository.markCompleted(tx, user.id);
      // `if not p.location_sharing_enabled` (the column is not null).
      if (profile.location_sharing_enabled === false) {
        // `deferred`: no circle until Location Sharing is on (the audit detail may not name it).
        await this.recordAudit(tx, user, profile.first_completion, {
          deferred: true,
          circle_created: false,
        });
        return this.repository.result(tx, completedAt, false, null, undefined);
      }

      const circle = await this.repository.lockOrCreateCircle(tx, user.id);
      await this.repository.upsertOwnerRow(tx, circle.id, user.id);
      const contact = await this.upsertContact(tx, circle.id, user.id);
      await this.recordAudit(tx, user, profile.first_completion, {
        deferred: false,
        circle_id: circle.id,
        circle_created: circle.created,
        member_status: contact?.status ?? null,
      });
      return this.repository.result(tx, completedAt, true, circle.id, contact);
    });
  }

  /**
   * The function's `begin ... exception when sqlstate 'P0001'` block: a savepoint around the upsert;
   * the trigger's raw `circle_full` rolls back to it and the row is read as it is.
   */
  private async upsertContact(
    tx: ProfileTransaction,
    circleId: string,
    callerId: string,
  ): Promise<ContactRow | undefined> {
    try {
      return await tx.transaction((sp) =>
        this.repository.upsertContactRow(sp, circleId, callerId, newInviteToken()),
      );
    } catch (error) {
      if (!isTriggerCircleFull(error)) throw error;
      return this.repository.contactRow(tx, circleId, callerId);
    }
  }

  private async recordAudit(
    tx: ProfileTransaction,
    user: AuthenticatedUser,
    firstCompletion: boolean,
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!firstCompletion) return;
    await this.audit.record(
      {
        action: 'profile.setup_completed',
        actor_user_id: user.id,
        actor_session_id: auditSessionId(user),
        target_type: 'profile',
        target_id: user.id,
        detail,
      },
      tx,
    );
  }

  /**
   * One transaction. A {@link DomainError} passes through; anything else is replaced by an error
   * carrying the operation and SQLSTATE only (a failing row can hold a phone or a name).
   */
  private async run<T>(work: (tx: ProfileTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction((tx) => work(tx));
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new InviteOperationFailedError('complete_profile_setup', sqlStateOf(error));
    }
  }
}
