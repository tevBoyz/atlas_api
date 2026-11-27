import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit';
import { avatarUrlBase, type AvatarUrlBase } from '../circles/circles.repository';
import { IncidentPostCommitRunner } from '../incidents/incident-post-commit';
import { auditSessionId } from '../incidents/incidents.service';
import { IncidentsRepository, type WrittenIncidentRow } from '../incidents/incidents.repository';
import { MEDICAL_ITEMS_MAX, type MedicalList, medicalItemTextFromBody } from './medical-items';
import {
  ProfileWriteFailedError,
  profileWriteError,
  sqlStateOfProfileError,
} from './profile-errors';
import { AvatarNames } from './avatar-names';
import {
  emergencyInfoFromBody,
  locationSharingFromBody,
  personalInfoFromBody,
  preferencesFromBody,
  sharingFlagsFromBody,
} from './profile-input';
import {
  type CompletionColumn,
  MedicalItemsRepository,
  type ProfileJson,
  ProfilesRepository,
  type ProfileTransaction,
} from './profiles.repository';

/** What a write that can change the share payload did: the Profile and the live views it changed. */
interface SharedWrite {
  profile: ProfileJson;
  liveViews: WrittenIncidentRow[];
}

/**
 * The caller's own profile (API-100-34/35): `GET /v1/me/profile` and the five writes that replace the
 * app's direct `profiles` UPSERT/UPDATEs (`upsertPersonalInfo`, `updateEmergencyInfo`,
 * `updatePreferences`, `updateIncidentSharingFlags`, `updateLocationSharingEnabled`, spec §7.8),
 * plus the medical item lists of SCRUM-21 (D51).
 *
 * - Authorization `profile.self`: no route takes a profile id; every statement is limited to the
 *   caller's row (and the caller's own items).
 * - The server owns the completion timestamps (spec §4.2 note, AC6): Personal Info, Emergency Info
 *   and Preferences set theirs to `now()` the first time and keep it afterwards; no request can write
 *   them or `profile_setup_completed_at`. It also owns `medical_info_updated_at` (D51): set on every
 *   item change and on a blood-type change.
 * - Each write is one transaction (read committed, as PostgREST) that locks only the caller's row
 *   (the UPDATE / upsert itself), in UTC, and returns the full Profile from that same statement.
 * - Live incident view (D53): a write that can change the share payload (Emergency Info, the share
 *   flags, the medical items) recomputes `live_share_payload` of the caller's active incident in the
 *   same transaction (after the profile row: lock order profile → incident, as submit) and, after the
 *   commit, sends `incident.shared_info_updated` to that incident's room (never after a rollback,
 *   never failing the request).
 * - Order: the body is checked first (`profile-input.ts`), then the row (404 for P3-P6).
 */
@Injectable()
export class ProfilesService {
  private readonly avatars: AvatarUrlBase;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProfilesRepository,
    private readonly items: MedicalItemsRepository,
    private readonly incidents: IncidentsRepository,
    private readonly postCommit: IncidentPostCommitRunner,
    private readonly audit: AuditService,
    private readonly avatarNames: AvatarNames,
    config: ApiConfigService,
  ) {
    this.avatars = avatarUrlBase(config);
  }

  /** P1. 404 `profiles:profile_not_found` when the caller has no profile row yet. */
  ownProfile(user: AuthenticatedUser): Promise<ProfileJson> {
    return this.database.db.transaction(
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        const profile = await this.repository.read(tx, user.id, this.avatars);
        if (!profile) throw new DomainError('profiles:profile_not_found');
        return profile;
      },
      { accessMode: 'read only' },
    );
  }

  /** P2. Creates the row when missing; `personal_info_completed_at` set once by the server. */
  upsertPersonalInfo(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    return this.write(async (tx) => {
      const current = await this.repository.lockAvatarPath(tx, user.id);
      const input = personalInfoFromBody(
        body,
        (path) => path === current || this.avatarNames.issuedTo(path, user.id),
        await this.repository.today(tx),
      );
      return this.repository.upsertPersonalInfo(tx, user.id, input, this.avatars);
    });
  }

  /**
   * P3. `emergency_info_completed_at` set once by the server; a blood-type change sets
   * `medical_info_updated_at`. Feeds the share payload (live view, D53).
   */
  updateEmergencyInfo(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const values = emergencyInfoFromBody(body);
    return this.updateOwn(user, values, 'emergency_info_completed_at', true);
  }

  /** P4. `preferences_completed_at` set once by the server. */
  updatePreferences(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const values = preferencesFromBody(body);
    return this.updateOwn(user, values, 'preferences_completed_at', false);
  }

  /** P5. Only the flags sent; values and completion timestamps untouched. Feeds the live view. */
  updateSharingFlags(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const values = sharingFlagsFromBody(body);
    return this.updateOwn(user, values, undefined, true);
  }

  /** P6. `location_sharing_enabled` only (no circle is created here: that is P7, rule 6a). */
  updateLocationSharing(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const enabled = locationSharingFromBody(body);
    return this.updateOwn(user, { location_sharing_enabled: enabled }, undefined, false);
  }

  /**
   * SCRUM-21 (D51) add: `{text}` trimmed, 1-100 characters (422 `profiles:invalid_medical_item`);
   * then the caller's profile (404 `profiles:profile_not_found`); at most 20 items (409
   * `profiles:medical_item_limit_reached`); no case-insensitive duplicate in the list (409
   * `profiles:duplicate_medical_item`). Returns the Profile.
   */
  addMedicalItem(user: AuthenticatedUser, list: MedicalList, body: unknown): Promise<ProfileJson> {
    const text = medicalItemTextFromBody(body);
    return this.sharedWrite(async (tx) => {
      await this.lockOwnProfile(tx, user.id);
      if ((await this.items.count(tx, user.id, list)) >= MEDICAL_ITEMS_MAX) {
        throw new DomainError('profiles:medical_item_limit_reached');
      }
      if (await this.items.hasDuplicate(tx, user.id, list, text)) {
        throw new DomainError('profiles:duplicate_medical_item', { details: { field: 'text' } });
      }
      const item = await this.items.insert(tx, user.id, list, text);
      await this.auditItem(tx, user, 'profile.medical_item.added', list, item.id);
      return this.items.syncProfile(tx, user.id, list, this.avatars);
    });
  }

  /**
   * Edit: the same text rules (an item may change only its own case); an id that is not one of the
   * caller's items of this list → 404 `profiles:medical_item_not_found`.
   */
  editMedicalItem(
    user: AuthenticatedUser,
    list: MedicalList,
    itemId: string,
    body: unknown,
  ): Promise<ProfileJson> {
    const text = medicalItemTextFromBody(body);
    return this.sharedWrite(async (tx) => {
      await this.lockOwnProfile(tx, user.id);
      if (await this.items.hasDuplicate(tx, user.id, list, text, itemId)) {
        throw new DomainError('profiles:duplicate_medical_item', { details: { field: 'text' } });
      }
      const item = await this.items.update(tx, user.id, list, itemId, text);
      if (!item) throw new DomainError('profiles:medical_item_not_found');
      await this.auditItem(tx, user, 'profile.medical_item.updated', list, item.id);
      return this.items.syncProfile(tx, user.id, list, this.avatars);
    });
  }

  /** Delete: 404 `profiles:medical_item_not_found` for an id that is not the caller's item. */
  deleteMedicalItem(
    user: AuthenticatedUser,
    list: MedicalList,
    itemId: string,
  ): Promise<ProfileJson> {
    return this.sharedWrite(async (tx) => {
      await this.lockOwnProfile(tx, user.id);
      const item = await this.items.delete(tx, user.id, list, itemId);
      if (!item) throw new DomainError('profiles:medical_item_not_found');
      await this.auditItem(tx, user, 'profile.medical_item.deleted', list, item.id);
      return this.items.syncProfile(tx, user.id, list, this.avatars);
    });
  }

  private async lockOwnProfile(tx: ProfileTransaction, callerId: string): Promise<void> {
    if (!(await this.items.lockProfile(tx, callerId))) {
      throw new DomainError('profiles:profile_not_found');
    }
  }

  /** The audit row of an item change: the list name and the item id, never the text. */
  private auditItem(
    tx: ProfileTransaction,
    user: AuthenticatedUser,
    action:
      | 'profile.medical_item.added'
      | 'profile.medical_item.updated'
      | 'profile.medical_item.deleted',
    list: MedicalList,
    itemId: string,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        actor_user_id: user.id,
        actor_session_id: auditSessionId(user),
        target_type: 'profile',
        target_id: user.id,
        detail: { list: list.name, item_id: itemId },
      },
      tx,
    );
  }

  private updateOwn(
    user: AuthenticatedUser,
    values: Record<string, string | boolean | null>,
    completed: CompletionColumn | undefined,
    feedsSharePayload: boolean,
  ): Promise<ProfileJson> {
    const work = async (tx: ProfileTransaction) => {
      const profile = await this.repository.update(tx, user.id, values, completed, this.avatars);
      if (!profile) throw new DomainError('profiles:profile_not_found');
      return profile;
    };
    return feedsSharePayload ? this.sharedWrite(work) : this.write(work);
  }

  /**
   * A write that can change the share payload: after `work`, the live view of the caller's active
   * incident is recomputed in the same transaction (D53); after the commit each changed incident's
   * room is told (not awaited; the runner never rejects).
   */
  private async sharedWrite(
    work: (tx: ProfileTransaction) => Promise<ProfileJson>,
  ): Promise<ProfileJson> {
    const result: SharedWrite = await this.write(async (tx) => {
      const profile = await work(tx);
      const liveViews = await this.incidents.refreshLiveSharePayload(tx, profile.id);
      return { profile, liveViews };
    });
    for (const incident of result.liveViews) {
      void this.postCommit.afterSharedInfo({
        incident_id: incident.id,
        resident_id: result.profile.id,
        circle_id: incident.circle_id,
      });
    }
    return result.profile;
  }

  /**
   * One transaction in UTC. A {@link DomainError} passes through; a table rule's error becomes its
   * `profiles:*` code (`profile-errors.ts`); anything else is replaced by
   * {@link ProfileWriteFailedError} (no personal data in logs).
   */
  private async write<T>(work: (tx: ProfileTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.database.db.transaction(async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        return work(tx);
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const mapped = profileWriteError(error);
      if (mapped) throw mapped;
      throw new ProfileWriteFailedError(sqlStateOfProfileError(error));
    }
  }
}
