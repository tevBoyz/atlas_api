import { AvatarStorageUnavailableError, SIGNED_UPLOAD_TTL_SECONDS } from './avatar-storage';
import { FAKE_UPLOAD_PREFIX, MemoryAvatarStorage } from './memory-avatar-storage';
import { type FetchLike, SupabaseAvatarStorage } from './supabase-avatar-storage';

// Assembled at runtime so secret scanners do not flag a test-only value.
const KEY = ['test', 'only', 'storage', 'key', 'not', 'real'].join('-');
const PROJECT = 'https://example-project.supabase.co';
const UID = '4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d';
const PATH = `${UID}/avatar-0d4c5a1e-7d1c-4a9e-9b1d-3c2f1e0a9b8c.jpg`;

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch that records calls and answers `responses` in order. */
function fakeFetch(...responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected call');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const storageWith = (f: FetchLike, overrides: { key?: string; url?: string } = {}) =>
  new SupabaseAvatarStorage(
    {
      projectUrl: 'url' in overrides ? overrides.url : `${PROJECT}/`,
      serviceKey: 'key' in overrides ? overrides.key : KEY,
      bucket: 'avatars',
    },
    f,
  );

/** The error a promise rejects with (fails when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

describe('SupabaseAvatarStorage (API-100-37, no network)', () => {
  it('signs an upload URL with the server key; 2-hour expiry; content-type header for the upload', async () => {
    const { fetch, calls } = fakeFetch(
      Response.json({ url: `/object/upload/sign/avatars/${PATH}?token=signed` }),
    );
    const before = Date.now();
    const signed = await storageWith(fetch).createSignedUpload(PATH, 'image/jpeg');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROJECT}/storage/v1/object/upload/sign/avatars/${PATH}`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, apikey: KEY });
    expect(signed.uploadUrl).toBe(
      `${PROJECT}/storage/v1/object/upload/sign/avatars/${PATH}?token=signed`,
    );
    expect(signed.headers).toEqual({ 'content-type': 'image/jpeg' });
    const expires = Date.parse(signed.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + SIGNED_UPLOAD_TTL_SECONDS * 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + SIGNED_UPLOAD_TTL_SECONDS * 1000);
  });

  it('exists: HEAD, 200 → true, 400/404 → false, anything else → unavailable', async () => {
    const { fetch, calls } = fakeFetch(
      new Response(null, { status: 200 }),
      new Response(null, { status: 400 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 503 }),
    );
    const storage = storageWith(fetch);
    expect(await storage.exists(PATH)).toBe(true);
    expect(await storage.exists(PATH)).toBe(false);
    expect(await storage.exists(PATH)).toBe(false);
    expect(await rejection(storage.exists(PATH))).toBeInstanceOf(AvatarStorageUnavailableError);
    expect(calls[0].url).toBe(`${PROJECT}/storage/v1/object/avatars/${PATH}`);
    expect(calls[0].init.method).toBe('HEAD');
  });

  it('remove: DELETE of the bucket with the path as a prefix', async () => {
    const { fetch, calls } = fakeFetch(Response.json([]));
    await storageWith(fetch).remove(PATH);
    expect(calls[0].url).toBe(`${PROJECT}/storage/v1/object/avatars`);
    expect(calls[0].init.method).toBe('DELETE');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ prefixes: [PATH] });
  });

  it('not configured (no key or no project URL): unavailable without any call', async () => {
    for (const overrides of [{ key: undefined }, { url: undefined }]) {
      const { fetch, calls } = fakeFetch();
      const storage = storageWith(fetch, overrides);
      for (const call of [
        storage.createSignedUpload(PATH, 'image/png'),
        storage.exists(PATH),
        storage.remove(PATH),
      ]) {
        const error = await rejection(call);
        expect(error).toBeInstanceOf(AvatarStorageUnavailableError);
        expect((error as AvatarStorageUnavailableError).reason).toBe('not configured');
      }
      expect(calls).toHaveLength(0);
    }
  });

  it('errors never carry the key, the path or a URL (network failure, bad answers)', async () => {
    const { fetch } = fakeFetch(
      new Error(`connect failed ${PROJECT} ${KEY}`),
      new Response('nope', { status: 500 }),
      Response.json({ nothing: true }),
      new Response('not json', { status: 200 }),
    );
    const storage = storageWith(fetch);
    const errors = [
      await rejection(storage.createSignedUpload(PATH, 'image/jpeg')),
      await rejection(storage.createSignedUpload(PATH, 'image/jpeg')),
      await rejection(storage.createSignedUpload(PATH, 'image/jpeg')),
      await rejection(storage.createSignedUpload(PATH, 'image/jpeg')),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(AvatarStorageUnavailableError);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain(UID);
      expect(error.message).not.toContain('supabase.co');
      expect(JSON.stringify(error)).not.toContain(KEY);
    }
  });
});

describe('MemoryAvatarStorage (the fake of tests and the manual guide)', () => {
  const base = 'http://127.0.0.1:3000';
  const tokenOf = (url: string) => new URL(url).searchParams.get('token') ?? undefined;

  it('a signed URL uploads once; then the object exists and can be removed', async () => {
    const storage = new MemoryAvatarStorage(base, 'avatars');
    const signed = await storage.createSignedUpload(PATH, 'image/jpeg');
    expect(signed.uploadUrl.startsWith(`${base}${FAKE_UPLOAD_PREFIX}/avatars/${PATH}?token=`)).toBe(
      true,
    );
    const token = tokenOf(signed.uploadUrl);
    expect(await storage.exists(PATH)).toBe(false);
    expect(storage.receive('avatars', PATH, token, 'image/jpeg', 10).status).toBe(200);
    expect(await storage.exists(PATH)).toBe(true);
    expect(storage.get(PATH)).toEqual({ contentType: 'image/jpeg', size: 10 });
    expect(storage.receive('avatars', PATH, token, 'image/jpeg', 10).status).toBe(400);
    await storage.remove(PATH);
    expect(await storage.exists(PATH)).toBe(false);
  });

  it('refuses what the bucket refuses', async () => {
    let now = 1_000_000;
    const storage = new MemoryAvatarStorage(base, 'avatars', () => now);
    const token = tokenOf((await storage.createSignedUpload(PATH, 'image/png')).uploadUrl);
    expect(storage.receive('avatars', `${UID}/other.png`, token, 'image/png', 1).status).toBe(400);
    expect(storage.receive('other', PATH, token, 'image/png', 1).status).toBe(400);
    expect(storage.receive('avatars', PATH, 'wrong', 'image/png', 1).status).toBe(400);
    expect(storage.receive('avatars', PATH, token, 'image/gif', 1).status).toBe(415);
    expect(storage.receive('avatars', PATH, token, 'image/png', 5_242_881).status).toBe(413);
    storage.put(PATH);
    expect(storage.receive('avatars', PATH, token, 'image/png', 1).status).toBe(409);
    await storage.remove(PATH);
    now += SIGNED_UPLOAD_TTL_SECONDS * 1000;
    expect(storage.receive('avatars', PATH, token, 'image/png', 1).status).toBe(400);
  });
});
