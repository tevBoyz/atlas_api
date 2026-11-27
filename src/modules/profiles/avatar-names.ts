import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { ApiConfigService } from '../../config';

/**
 * D79 (Stage 3 [IDS]): avatar objects are stored under a RANDOM name with no user id in it, so the
 * public `avatar_url` other users see never carries a user id.
 *
 * Name (the bucket-relative object path): `a/<nonce><tag>.<ext>`:
 * - `nonce`: 16 random bytes, 32 lowercase hex;
 * - `tag`: the first 12 bytes (24 lowercase hex) of HMAC-SHA256(key, "v1:" + user id + ":" + nonce):
 *   proves the API issued the name to THAT user (checked when the app points its profile at it),
 *   without any stored state and without revealing the user id (the key is secret);
 * - `ext`: `jpg` | `png` | `webp` (the upload's content type).
 * The key is derived (HKDF-SHA256, info {@link AVATAR_NAME_KEY_INFO}) from `AUTH_JWT_KEYS`, as the
 * receipt tokens (D77): no new secret. Without `AUTH_JWT_KEYS` (development and tests only) a fixed
 * development key is used. Legacy `{user id}/...` paths written before D79 stay readable until
 * `scripts/avatars-rename.ts` moves them.
 */
export const AVATAR_NAME_KEY_INFO = 'atlas:avatar-object-name:v1';

/** Used only when AUTH_JWT_KEYS is unset (never in production: the config refuses that). */
export const AVATAR_NAME_DEVELOPMENT_KEY_MATERIAL = 'atlas-development-avatar-name-key';

/** The folder of D79 names (no user id anywhere in the path). */
export const AVATAR_NAME_FOLDER = 'a';

const NAME = /^a\/([0-9a-f]{32})([0-9a-f]{24})\.(jpg|png|webp)$/;
const TAG_BYTES = 12;

/** The HMAC key from its secret material. */
export function avatarNameKey(material: string): Buffer {
  return Buffer.from(hkdfSync('sha256', material, '', AVATAR_NAME_KEY_INFO, 32));
}

function tag(key: Buffer, userId: string, nonce: string): Buffer {
  return createHmac('sha256', key)
    .update(`v1:${userId.toLowerCase()}:${nonce}`)
    .digest()
    .subarray(0, TAG_BYTES);
}

/** True when `path` has the shape of a D79 name (any user). */
export function isRandomAvatarPath(path: string): boolean {
  return NAME.test(path);
}

/** A new D79 object path for `userId` with extension `ext`. */
export function newAvatarObjectPath(key: Buffer, userId: string, ext: string): string {
  const nonce = randomBytes(16).toString('hex');
  return `${AVATAR_NAME_FOLDER}/${nonce}${tag(key, userId, nonce).toString('hex')}.${ext}`;
}

/** True when `path` is a D79 name the API issued to `userId` (with this key). */
export function isIssuedAvatarPath(key: Buffer, path: string, userId: string): boolean {
  const match = NAME.exec(path);
  if (!match) return false;
  const [, nonce, given] = match;
  const expected = tag(key, userId, nonce);
  const actual = Buffer.from(given, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The name key of this process, from the configuration. */
@Injectable()
export class AvatarNames {
  private readonly key: Buffer;

  constructor(config: ApiConfigService) {
    this.key = avatarNameKey(config.get('AUTH_JWT_KEYS') ?? AVATAR_NAME_DEVELOPMENT_KEY_MATERIAL);
  }

  /** A new random object path for the caller's next photo. */
  newPath(userId: string, ext: string): string {
    return newAvatarObjectPath(this.key, userId, ext);
  }

  /** The API issued `path` to `userId`. */
  issuedTo(path: string, userId: string): boolean {
    return isIssuedAvatarPath(this.key, path, userId);
  }
}
