import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { ROOT_LOGGER } from '../../observability/logger';
import { avatarUrlBase, type AvatarUrlBase } from '../circles/circles.repository';
import { invalidRequest, isPostgresText, requireJsonObject } from '../incidents/incident-input';
import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  AVATAR_STORAGE,
  type AvatarStorage,
  AvatarStorageUnavailableError,
} from './avatar-storage';
import { isOwnAvatarPath } from './profile-input';
import { type ProfileJson, ProfilesRepository } from './profiles.repository';

/** The body of `POST /v1/me/avatar/upload-url` (spec §11.3 P8). */
export interface AvatarUploadUrlJson {
  upload_url: string;
  method: 'PUT';
  headers: Record<string, string>;
  object_path: string;
  expires_at: string;
}

/**
 * P8 body in field order: `content_type` (missing, null or not JPEG/PNG/WebP → 422
 * `profiles:invalid_content_type`; not a string → 422 `validation:invalid_request`), then
 * `content_length` (a positive JSON integer, else `validation:invalid_request`; more than 5,242,880
 * bytes → 422 `profiles:file_too_large`).
 */
export function uploadRequestFromBody(raw: unknown): {
  contentType: string;
  contentLength: number;
} {
  const body = requireJsonObject(raw);
  const type = body.content_type;
  if (type !== undefined && type !== null && typeof type !== 'string') {
    throw invalidRequest('content_type');
  }
  if (typeof type !== 'string' || !(type in AVATAR_CONTENT_TYPES)) {
    throw new DomainError('profiles:invalid_content_type', { details: { field: 'content_type' } });
  }
  const length = body.content_length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1) {
    throw invalidRequest('content_length');
  }
  if (length > AVATAR_MAX_BYTES) {
    throw new DomainError('profiles:file_too_large', { details: { field: 'content_length' } });
  }
  return { contentType: type, contentLength: length };
}

/**
 * P9 body: `{object_path}` — a string (a path in the caller's own folder, else 422
 * `profiles:invalid_avatar_path`) or null (remove the photo). Missing or another JSON type → 422
 * `validation:invalid_request`.
 */
export function objectPathFromBody(raw: unknown, callerId: string): string | null {
  const body = requireJsonObject(raw);
  const value = body.object_path;
  if (value === null) return null;
  if (typeof value !== 'string' || !isPostgresText(value)) throw invalidRequest('object_path');
  if (!isOwnAvatarPath(value, callerId)) {
    throw new DomainError('profiles:invalid_avatar_path', { details: { field: 'object_path' } });
  }
  return value;
}

/**
 * Profile photos through signed Storage URLs (API-100-37, spec §11.3 P8/P9), replacing the app's
 * direct `avatars.uploadBinary('{uid}/avatar.{ext}', upsert)` and `getPublicUrl`:
 * 1. `POST /v1/me/avatar/upload-url` → a single-use signed URL for a NEW object
 *    `{uid}/avatar-{uuid}.{ext}` (a new name per photo: no cache of the old photo is ever served);
 * 2. the app `PUT`s the bytes there (the bucket enforces 5 MiB and the 3 types again);
 * 3. `PUT /v1/me/profile/avatar {object_path}` checks the object exists, points
 *    `profiles.avatar_path` at it and, after the commit, deletes the previous object of the caller's
 *    folder (best effort: a failure is logged without the path, the request still succeeds).
 * `avatar_url` everywhere stays `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}`;
 * existing `{uid}/avatar.{ext}` paths stay valid (AC3/AC4). Storage calls happen outside the
 * database transaction, so no row lock is held while Storage answers.
 */
@Injectable()
export class AvatarsService {
  private readonly avatars: AvatarUrlBase;

  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ProfilesRepository,
    @Inject(AVATAR_STORAGE) private readonly storage: AvatarStorage,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    config: ApiConfigService,
  ) {
    this.avatars = avatarUrlBase(config);
  }

  /** P8. No profile needed (onboarding uploads the photo before the profile exists). */
  async createUploadUrl(user: AuthenticatedUser, body: unknown): Promise<AvatarUploadUrlJson> {
    const { contentType } = uploadRequestFromBody(body);
    const objectPath = `${user.id.toLowerCase()}/avatar-${randomUUID()}.${AVATAR_CONTENT_TYPES[contentType]}`;
    const signed = await this.storageCall(() =>
      this.storage.createSignedUpload(objectPath, contentType),
    );
    return {
      upload_url: signed.uploadUrl,
      method: 'PUT',
      headers: signed.headers,
      object_path: objectPath,
      expires_at: signed.expiresAt,
    };
  }

  /**
   * P9, in order: the body (path in the caller's folder), the profile (404 `profile_not_found`),
   * the object (404 `avatar_not_found`), then one transaction that sets `avatar_path` on the
   * caller's row, then the old object's deletion.
   */
  async setAvatar(user: AuthenticatedUser, body: unknown): Promise<ProfileJson> {
    const objectPath = objectPathFromBody(body, user.id);
    const current = await this.database.db.transaction(
      async (tx) => {
        await this.repository.useUtcTimestamps(tx);
        return this.repository.read(tx, user.id, this.avatars);
      },
      { accessMode: 'read only' },
    );
    if (!current) throw new DomainError('profiles:profile_not_found');
    if (objectPath !== null && !(await this.storageCall(() => this.storage.exists(objectPath)))) {
      throw new DomainError('profiles:avatar_not_found', { details: { field: 'object_path' } });
    }

    const { profile, previous } = await this.database.db.transaction(async (tx) => {
      await this.repository.useUtcTimestamps(tx);
      const before = await this.repository.lockAvatarPath(tx, user.id);
      if (before === undefined) throw new DomainError('profiles:profile_not_found');
      const updated = await this.repository.update(
        tx,
        user.id,
        { avatar_path: objectPath },
        undefined,
        this.avatars,
      );
      if (!updated) throw new DomainError('profiles:profile_not_found');
      return { profile: updated, previous: before };
    });

    if (previous && previous !== objectPath && isOwnAvatarPath(previous, user.id)) {
      await this.removeOld(previous);
    }
    return profile;
  }

  /** Deletes the replaced object; never fails the request. Logs carry no path. */
  private async removeOld(objectPath: string): Promise<void> {
    try {
      await this.storage.remove(objectPath);
      this.logger.info({ event: 'avatar.previous_deleted' }, 'avatar: previous object deleted');
    } catch (err) {
      const reason = err instanceof AvatarStorageUnavailableError ? err.reason : 'unexpected error';
      this.logger.warn(
        { event: 'avatar.previous_delete_failed', reason },
        'avatar: previous object could not be deleted',
      );
    }
  }

  private async storageCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof AvatarStorageUnavailableError) {
        this.logger.warn(
          { event: 'avatar.storage_unavailable', reason: err.reason },
          'avatar storage unavailable',
        );
        throw new DomainError('profiles:avatar_storage_unavailable');
      }
      throw err;
    }
  }
}
