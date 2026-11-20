import {
  type AvatarStorage,
  AvatarStorageUnavailableError,
  SIGNED_UPLOAD_TTL_SECONDS,
  type SignedUpload,
} from './avatar-storage';

/** What the implementation needs from config (`SUPABASE_URL`, `SUPABASE_STORAGE_SERVICE_KEY`, `AVATARS_BUCKET`). */
export interface SupabaseStorageSettings {
  /** The project URL, e.g. `https://<ref>.supabase.co`; undefined when not configured. */
  projectUrl: string | undefined;
  /** The server-side Storage key (secret). Undefined when not configured (development). */
  serviceKey: string | undefined;
  bucket: string;
  /** Per-call timeout. */
  timeoutMs?: number;
}

/** `fetch` (injectable so unit tests never reach the network). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 5_000;

/** Each path segment URL-encoded (paths are `{uid}/<name>`; the slash stays a separator). */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Supabase Storage through its REST API (the calls storage-js makes), authenticated with the
 * server-side key from config (`Authorization: Bearer <key>` and `apikey: <key>`):
 * - signed upload URL: `POST {project}/storage/v1/object/upload/sign/{bucket}/{path}` → `{url}`
 *   (relative to `/storage/v1`, carries the upload token); valid 2 hours; no upsert;
 * - exists: `HEAD {project}/storage/v1/object/{bucket}/{path}` → 200 yes, 400/404 no;
 * - remove: `DELETE {project}/storage/v1/object/{bucket}` with `{"prefixes": [path]}`.
 * The bucket's own rules (5 MiB, JPEG/PNG/WebP, spec §4.11) still apply to the upload itself.
 * Without a key or project URL every call fails with {@link AvatarStorageUnavailableError}: the key
 * is optional in development and required in production (config). The key is never logged, and no
 * error carries it, an object path or a signed URL.
 */
export class SupabaseAvatarStorage implements AvatarStorage {
  private readonly timeoutMs: number;

  constructor(
    private readonly settings: SupabaseStorageSettings,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.timeoutMs = settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createSignedUpload(objectPath: string, contentType: string): Promise<SignedUpload> {
    const { base, headers } = this.endpoint();
    const signedAt = Date.now();
    const res = await this.call(
      `${base}/object/upload/sign/${encodeURIComponent(this.settings.bucket)}/${encodePath(objectPath)}`,
      { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' },
      'sign',
    );
    if (!res.ok) throw new AvatarStorageUnavailableError(`sign answered ${res.status}`);
    let url: unknown;
    try {
      url = ((await res.json()) as { url?: unknown }).url;
    } catch {
      throw new AvatarStorageUnavailableError('sign answered an unreadable body');
    }
    if (typeof url !== 'string' || !url.startsWith('/')) {
      throw new AvatarStorageUnavailableError('sign answered without a url');
    }
    return {
      uploadUrl: `${base}${url}`,
      headers: { 'content-type': contentType },
      expiresAt: new Date(signedAt + SIGNED_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async exists(objectPath: string): Promise<boolean> {
    const { base, headers } = this.endpoint();
    const res = await this.call(
      `${base}/object/${encodeURIComponent(this.settings.bucket)}/${encodePath(objectPath)}`,
      { method: 'HEAD', headers },
      'exists',
    );
    if (res.status === 200) return true;
    if (res.status === 400 || res.status === 404) return false;
    throw new AvatarStorageUnavailableError(`exists answered ${res.status}`);
  }

  async remove(objectPath: string): Promise<void> {
    const { base, headers } = this.endpoint();
    const res = await this.call(
      `${base}/object/${encodeURIComponent(this.settings.bucket)}`,
      {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: [objectPath] }),
      },
      'remove',
    );
    if (!res.ok) throw new AvatarStorageUnavailableError(`remove answered ${res.status}`);
  }

  private endpoint(): { base: string; headers: Record<string, string> } {
    const { projectUrl, serviceKey } = this.settings;
    if (!projectUrl || !serviceKey) throw new AvatarStorageUnavailableError('not configured');
    return {
      base: `${projectUrl.replace(/\/+$/, '')}/storage/v1`,
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    };
  }

  private async call(url: string, init: RequestInit, step: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      // A network error or the timeout: the error text could quote the URL, so it is dropped.
      throw new AvatarStorageUnavailableError(`${step} did not answer`);
    }
  }
}
