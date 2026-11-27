import type { Client } from 'pg';

import {
  type ManifestEntry,
  renameAvatars,
  type RenameOptions,
} from '../../scripts/avatars-rename';
import {
  avatarNameKey,
  isIssuedAvatarPath,
  isRandomAvatarPath,
} from '../../src/modules/profiles/avatar-names';
import { MemoryAvatarStorage } from '../../src/modules/profiles/memory-avatar-storage';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';

/**
 * D79 (Stage 3 [IDS]): `scripts/avatars-rename.ts` moves photos stored under `{user id}/...` to
 * random names: dry run writes nothing; --apply copies, checks the copy, points the profile at it
 * and records the move; --delete-old removes an old object only after the check (the profile points
 * at the new name, the new object exists, no profile uses the old name). Local storage (memory)
 * and the local test database only.
 */
describe('avatars-rename (D79)', () => {
  let client: Client;
  const key = avatarNameKey('test-avatar-key');

  beforeAll(async () => {
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
  });

  function memoryManifest(): RenameOptions['manifest'] & { entries: ManifestEntry[] } {
    const entries: ManifestEntry[] = [];
    return {
      entries,
      read: () => Promise.resolve([...entries]),
      append: (entry) => {
        entries.push(entry);
        return Promise.resolve();
      },
    };
  }

  const pathOf = async (id: string) =>
    (
      await client.query<{ p: string | null }>(
        'select avatar_path as p from public.profiles where id = $1',
        [id],
      )
    ).rows[0].p;

  it('dry run, apply, then delete-old after the check', async () => {
    const storage = new MemoryAvatarStorage('http://127.0.0.1:1', 'avatars');
    const ada = await createUser(client, { fullName: 'Ada Photo' });
    const ben = await createUser(client, { fullName: 'Ben Missing' });
    const old = `${ada.id}/avatar.png`;
    storage.put(old, { contentType: 'image/png', size: 10 });
    await client.query('update public.profiles set avatar_path = $2 where id = $1', [ada.id, old]);
    await client.query('update public.profiles set avatar_path = $2 where id = $1', [
      ben.id,
      `${ben.id}/avatar.jpg`,
    ]);
    const manifest = memoryManifest();
    const base = { db: client, storage, key, manifest };

    const dry = await renameAvatars({ ...base, apply: false, deleteOld: false });
    expect(dry.old_named).toBeGreaterThanOrEqual(2);
    expect(dry.missing_object).toBeGreaterThanOrEqual(1);
    expect(dry.copied).toBe(0);
    expect(await pathOf(ada.id)).toBe(old);

    const applied = await renameAvatars({ ...base, apply: true, deleteOld: false });
    expect(applied.failed).toBe(0);
    const fresh = (await pathOf(ada.id))!;
    expect(isRandomAvatarPath(fresh)).toBe(true);
    expect(isIssuedAvatarPath(key, fresh, ada.id)).toBe(true);
    expect(fresh).not.toContain(ada.id);
    expect(fresh.endsWith('.png')).toBe(true);
    expect(storage.get(fresh)).toEqual({ contentType: 'image/png', size: 10 });
    expect(await storage.exists(old)).toBe(true); // kept until --delete-old
    expect(await pathOf(ben.id)).toBe(`${ben.id}/avatar.jpg`); // no object: left alone
    expect(manifest.entries).toContainEqual({ user_id: ada.id, old_path: old, new_path: fresh });

    // A second apply finds nothing of Ada's to move.
    await renameAvatars({ ...base, apply: true, deleteOld: false });
    expect(await pathOf(ada.id)).toBe(fresh);

    const deleted = await renameAvatars({ ...base, apply: false, deleteOld: true });
    expect(deleted.deleted_old).toBeGreaterThanOrEqual(1);
    expect(await storage.exists(old)).toBe(false);
    expect(await storage.exists(fresh)).toBe(true);
  });

  it('delete-old keeps the old object when the check fails (another profile still uses it)', async () => {
    const storage = new MemoryAvatarStorage('http://127.0.0.1:1', 'avatars');
    const cara = await createUser(client, { fullName: 'Cara Photo' });
    const old = `${cara.id}/avatar.jpg`;
    storage.put(old);
    await client.query('update public.profiles set avatar_path = $2 where id = $1', [cara.id, old]);
    const manifest = memoryManifest();
    await renameAvatars({ db: client, storage, key, manifest, apply: true, deleteOld: false });
    const fresh = (await pathOf(cara.id))!;
    // The profile points back at the old object (e.g. restored by hand): the check fails.
    await client.query('update public.profiles set avatar_path = $2 where id = $1', [cara.id, old]);
    const report = await renameAvatars({
      db: client,
      storage,
      key,
      manifest,
      apply: false,
      deleteOld: true,
    });
    expect(report.kept_old).toBeGreaterThanOrEqual(1);
    expect(await storage.exists(old)).toBe(true);
    expect(await storage.exists(fresh)).toBe(true);
  });
});
