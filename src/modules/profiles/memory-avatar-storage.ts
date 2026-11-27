import { randomBytes } from 'node:crypto';

import {
  AVATAR_CONTENT_TYPES,
  AVATAR_MAX_BYTES,
  type AvatarStorage,
  SIGNED_UPLOAD_TTL_SECONDS,
  type SignedUpload,
  AvatarStorageUnavailableError,
} from './avatar-storage';

/** Path of the fake's upload endpoint (only registered when `AVATAR_STORAGE=memory`). */
export const FAKE_UPLOAD_PREFIX = '/__fake-storage/upload/sign';

interface PendingUpload {
  objectPath: string;
  expiresAt: number;
}

export interface StoredObject {
  contentType: string;
  size: number;
}

/** The outcome of an upload to the fake, as an HTTP status and a fixed message. */
export interface FakeUploadResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * An in-memory {@link AvatarStorage} for tests and local manual testing (`AVATAR_STORAGE=memory`,
 * refused when `NODE_ENV=production`). It behaves like the Supabase bucket the app uses:
 * - `createSignedUpload` returns `PUT {baseUrl}/__fake-storage/upload/sign/{bucket}/{path}?token=`
 *   (served by the API process itself, `fake-storage.route.ts`), single use, valid 2 hours;
 * - the upload is refused with the bucket's rules: unknown/expired/used token or another path (400),
 *   a content type outside JPEG/PNG/WebP (415), more than 5 MiB (413), an existing object (409,
 *   no upsert);
 * - `exists` / `remove` work on the uploaded objects; {@link put} seeds one (e.g. a path the app
 *   uploaded directly before the switch, `{uid}/avatar.jpg`).
 * Nothing leaves the process.
 */
export class MemoryAvatarStorage implements AvatarStorage {
  private readonly objects = new Map<string, StoredObject>();
  private readonly pending = new Map<string, PendingUpload>();

  constructor(
    private readonly baseUrl: string,
    readonly bucket: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  createSignedUpload(objectPath: string, contentType: string): Promise<SignedUpload> {
    const token = randomBytes(24).toString('hex');
    const expiresAt = this.now() + SIGNED_UPLOAD_TTL_SECONDS * 1000;
    this.pending.set(token, { objectPath, expiresAt });
    return Promise.resolve({
      uploadUrl: `${this.baseUrl}${FAKE_UPLOAD_PREFIX}/${this.bucket}/${objectPath}?token=${token}`,
      headers: { 'content-type': contentType },
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  exists(objectPath: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(objectPath));
  }

  copy(from: string, to: string): Promise<void> {
    const object = this.objects.get(from);
    if (!object) return Promise.reject(new AvatarStorageUnavailableError('copy source missing'));
    if (this.objects.has(to)) {
      return Promise.reject(new AvatarStorageUnavailableError('copy target exists'));
    }
    this.objects.set(to, { ...object });
    return Promise.resolve();
  }

  remove(objectPath: string): Promise<void> {
    this.objects.delete(objectPath);
    return Promise.resolve();
  }

  /** Seeds an object (tests, and the manual guide's "photo uploaded before the switch"). */
  put(objectPath: string, object: StoredObject = { contentType: 'image/jpeg', size: 1 }): void {
    this.objects.set(objectPath, object);
  }

  /** The stored object, if any (tests). */
  get(objectPath: string): StoredObject | undefined {
    return this.objects.get(objectPath);
  }

  /** An upload to a signed URL (the fake endpoint calls this). */
  receive(
    bucket: string,
    objectPath: string,
    token: string | undefined,
    contentType: string | undefined,
    size: number,
  ): FakeUploadResult {
    const pending = token ? this.pending.get(token) : undefined;
    if (
      !token ||
      !pending ||
      bucket !== this.bucket ||
      pending.objectPath !== objectPath ||
      pending.expiresAt <= this.now()
    ) {
      return { status: 400, body: { error: 'InvalidSignature', message: 'invalid signature' } };
    }
    const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
    if (!(type in AVATAR_CONTENT_TYPES)) {
      return {
        status: 415,
        body: { error: 'invalid_mime_type', message: 'mime type not supported' },
      };
    }
    if (size > AVATAR_MAX_BYTES) {
      return {
        status: 413,
        body: { error: 'Payload too large', message: 'object exceeded the maximum allowed size' },
      };
    }
    if (this.objects.has(objectPath)) {
      return { status: 409, body: { error: 'Duplicate', message: 'the resource already exists' } };
    }
    this.pending.delete(token);
    this.objects.set(objectPath, { contentType: type, size });
    return { status: 200, body: { Key: `${bucket}/${objectPath}` } };
  }
}
