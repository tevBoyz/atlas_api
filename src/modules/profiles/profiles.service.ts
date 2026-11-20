import { Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { avatarUrlBase, type AvatarUrlBase } from '../circles/circles.repository';
import {
  ProfileWriteFailedError,
  profileWriteError,
  sqlStateOfProfileError,
} from './profile-errors';
import {
  emergencyInfoFromBody,
  locationSharingFromBody,
  personalInfoFromBody,
  preferencesFromBody,
  sharingFlagsFromBody,
} from './profile-input';
import {
  type CompletionColumn,
  type ProfileJson,
  ProfilesRepository,
  type ProfileTransaction,
} from './profiles.repository';

/**
 * The caller's own profile (API-100-34/35): `GET /v1/me/profile` and the five writes that replace the
 * app's direct `profiles` UPSERT/UPDATEs (`upsertPersonalInfo`, `updateEmergencyInfo`,
 * `updatePreferences`, `updateIncidentSharingFlags`, `updateLocationSharingEnabled`, spec §7.8).
 *
 * - Authorization `profile.self`: no route takes an id; every statement is limited to the caller's
 *   row.
 * - The server owns the completion timestamps (spec §4.2 note, AC6): Personal Info, Emergency Info
 *   and Preferences set theirs to `now()` the first time and keep it afterwards; no request can write
 *   them or `profile_setup_completed_at`.
 * - Each write is one transaction (read committed, as PostgREST) that locks only the caller's row
 *   (the UPDATE / upsert itself), in UTC, and returns the full Profile from that same statement.
 * - Order: the body is checked first (`profile-input.ts`), then the row (404 for P3-P6).
 */
@Injectable()
export class ProfilesService {
  private readonly avatars: AvatarUrlBase;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProfilesRepository,
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
      const input = personalInfoFromBody(body, user.id, await this.repository.today(tx));
      return this.repository.upsertPersonalInfo(tx, user.id, input, this.avatars);
    });
  }

  /** P3. `emergency_info_completed_at` set once by the server. */
  updateEmergencyInfo(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const values = emergencyInfoFromBody(body);
    return this.updateOwn(user, values, 'emergency_info_completed_at');
  }

  /** P4. `preferences_completed_at` set once by the server. */
  updatePreferences(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const values = preferencesFromBody(body);
    return this.updateOwn(user, values, 'preferences_completed_at');
  }

  /** P5. Only the flags sent; values and completion timestamps untouched. */
  updateSharingFlags(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const values = sharingFlagsFromBody(body);
    return this.updateOwn(user, values, undefined);
  }

  /** P6. `location_sharing_enabled` only (no circle is created here: that is P7, rule 6a). */
  updateLocationSharing(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const enabled = locationSharingFromBody(body);
    return this.updateOwn(user, { location_sharing_enabled: enabled }, undefined);
  }

  private updateOwn(
    user: AuthenticatedUser,
    values: Record<string, string | boolean | null>,
    completed: CompletionColumn | undefined,
  ): Promise<ProfileJson> {
    return this.write(async (tx) => {
      const profile = await this.repository.update(tx, user.id, values, completed, this.avatars);
      if (!profile) throw new DomainError('profiles:profile_not_found');
      return profile;
    });
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
