/**
 * Avatar object storage (API-100-37, spec §4.11, §11.1 "Files"). The API never stores photo bytes:
 * it hands the app a signed upload URL for the `avatars` bucket, checks that the uploaded object
 * exists before pointing the profile at it, and deletes the previous object afterwards. Everything
 * goes through this interface: Supabase Storage in deployments (`SupabaseAvatarStorage`), an
 * in-memory fake in tests and local manual testing (`MemoryAvatarStorage`).
 *
 * Implementations never log or return the service key, and their errors never carry an object path
 * or a signed URL (both identify a user).
 */

/** The bucket's settings today (spec §4.11): 5 MiB, JPEG / PNG / WebP. */
export const AVATAR_MAX_BYTES = 5_242_880;

/** Allowed content types and the file extension the app uses for each (`uploadAvatar`). */
export const AVATAR_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** How long a Supabase signed upload URL is accepted (fixed by Storage: 2 hours). */
export const SIGNED_UPLOAD_TTL_SECONDS = 7_200;

export interface SignedUpload {
  /** Where the app sends the bytes (`PUT`), once. */
  uploadUrl: string;
  /** Headers the app sends with the bytes. */
  headers: Record<string, string>;
  /** ISO-8601 UTC time after which the URL is refused. */
  expiresAt: string;
}

export interface AvatarStorage {
  /** A single-use signed URL to upload `objectPath` (no overwrite). */
  createSignedUpload(objectPath: string, contentType: string): Promise<SignedUpload>;
  /** Whether `objectPath` exists in the bucket. */
  exists(objectPath: string): Promise<boolean>;
  /** Deletes `objectPath` (no error when it is already gone). */
  remove(objectPath: string): Promise<void>;
}

/** Nest injection token of the {@link AvatarStorage} in use. */
export const AVATAR_STORAGE = Symbol('AVATAR_STORAGE');

/**
 * Storage is not configured (no service key / project URL) or did not answer as expected. Becomes
 * 503 `profiles:avatar_storage_unavailable`. `reason` is a fixed text (never a path, URL or key).
 */
export class AvatarStorageUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`avatar storage unavailable: ${reason}`);
    this.name = 'AvatarStorageUnavailableError';
  }
}
