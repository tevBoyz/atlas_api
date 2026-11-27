/**
 * D79 (Gaps_Adressed Stage 3 [IDS]): one-time move of the profile photos stored under the old
 * `{user id}/...` object names to random names (`a/<nonce><tag>.<ext>`, `avatar-names.ts`), so no
 * `avatar_url` carries a user id any more.
 *
 *   npx tsx scripts/avatars-rename.ts --storage <driver> [--apply] [--delete-old] [--manifest <file>]
 *
 * - Default: DRY RUN. Counts the profiles whose `avatar_path` is an old name (and whether each object
 *   exists); nothing is written.
 * - `--apply`: for each such profile: copy the object to a new random name, check the copy exists,
 *   then `update profiles set avatar_path = <new> where id = <user> and avatar_path = <old>` (a photo
 *   changed meanwhile is left alone). Each move is appended to the manifest (JSON lines, default
 *   `avatars-rename-manifest.jsonl` in the working directory). The old objects stay.
 * - `--delete-old`: for each manifest entry, deletes the OLD object only after the check: the profile
 *   now points at the new name, the new object exists, and no profile still points at the old name.
 *   May be combined with `--apply` (the check then runs right after the copy).
 * - `--storage dir:<folder>`: a local folder standing in for the bucket (objects are files at
 *   `<folder>/<object path>`), for local runs and tests. `--storage supabase`: the Supabase Storage
 *   bucket (`SUPABASE_URL`, `SUPABASE_STORAGE_SERVICE_KEY`, `AVATARS_BUCKET` default `avatars`).
 * - `DATABASE_URL` must be the local docker database unless `--allow-remote` is given (staging is
 *   run by hand, after a backup). Nothing reads `.env`. Output: counts only (no paths, no ids).
 * - The name key comes from `AUTH_JWT_KEYS` (as the API; a development key without it). A renamed
 *   path is accepted back from the app because it is the stored path (P2 / P9 "unchanged").
 */
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Client } from 'pg';

import {
  AVATAR_NAME_DEVELOPMENT_KEY_MATERIAL,
  avatarNameKey,
  isRandomAvatarPath,
  newAvatarObjectPath,
} from '../src/modules/profiles/avatar-names';
import { SupabaseAvatarStorage } from '../src/modules/profiles/supabase-avatar-storage';

/** What the move needs from a bucket. */
export interface RenameStorage {
  exists(objectPath: string): Promise<boolean>;
  copy(from: string, to: string): Promise<void>;
  remove(objectPath: string): Promise<void>;
}

/** A local folder as the bucket (`--storage dir:<folder>`). */
export class DirectoryStorage implements RenameStorage {
  constructor(private readonly root: string) {}

  private file(objectPath: string): string {
    const full = resolve(this.root, objectPath);
    if (!full.startsWith(resolve(this.root))) throw new Error('object path leaves the folder');
    return full;
  }

  exists(objectPath: string): Promise<boolean> {
    return Promise.resolve(existsSync(this.file(objectPath)));
  }

  async copy(from: string, to: string): Promise<void> {
    if (existsSync(this.file(to))) throw new Error('copy target exists');
    await mkdir(dirname(this.file(to)), { recursive: true });
    await copyFile(this.file(from), this.file(to));
  }

  async remove(objectPath: string): Promise<void> {
    await rm(this.file(objectPath), { force: true });
  }
}

export interface ManifestEntry {
  user_id: string;
  old_path: string;
  new_path: string;
}

export interface RenameOptions {
  db: Pick<Client, 'query'>;
  storage: RenameStorage;
  apply: boolean;
  deleteOld: boolean;
  /** HMAC key of the new names. */
  key: Buffer;
  /** Earlier moves (the manifest) and where new ones are recorded. */
  manifest: { read(): Promise<ManifestEntry[]>; append(entry: ManifestEntry): Promise<void> };
}

export interface RenameReport {
  old_named: number;
  missing_object: number;
  copied: number;
  updated: number;
  skipped_changed: number;
  deleted_old: number;
  kept_old: number;
  failed: number;
}

const EXTENSIONS = new Set(['jpg', 'png', 'webp']);

function extensionOf(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  return ext && EXTENSIONS.has(ext) ? ext : 'jpg';
}

/** The move (see the file comment). Returns counts only. */
export async function renameAvatars(options: RenameOptions): Promise<RenameReport> {
  const { db, storage } = options;
  const report: RenameReport = {
    old_named: 0,
    missing_object: 0,
    copied: 0,
    updated: 0,
    skipped_changed: 0,
    deleted_old: 0,
    kept_old: 0,
    failed: 0,
  };
  const { rows } = await db.query<{ id: string; avatar_path: string }>(
    `select id::text as id, avatar_path from public.profiles
      where nullif(btrim(coalesce(avatar_path, '')), '') is not null order by id`,
  );
  const old = rows.filter((row) => !isRandomAvatarPath(row.avatar_path.trim()));
  report.old_named = old.length;

  for (const row of old) {
    const from = row.avatar_path.trim();
    let present: boolean;
    try {
      present = await storage.exists(from);
    } catch {
      report.failed += 1;
      continue;
    }
    if (!present) {
      report.missing_object += 1;
      continue;
    }
    if (!options.apply) continue;
    const to = newAvatarObjectPath(options.key, row.id, extensionOf(from));
    try {
      await storage.copy(from, to);
      if (!(await storage.exists(to))) throw new Error('copy not found');
      report.copied += 1;
      const updated = await db.query(
        `update public.profiles set avatar_path = $3, updated_at = now()
          where id = $1::uuid and avatar_path = $2`,
        [row.id, row.avatar_path, to],
      );
      if ((updated.rowCount ?? 0) === 1) {
        report.updated += 1;
        await options.manifest.append({ user_id: row.id, old_path: from, new_path: to });
      } else {
        report.skipped_changed += 1;
        await storage.remove(to);
      }
    } catch {
      report.failed += 1;
    }
  }

  if (options.deleteOld) {
    for (const entry of await options.manifest.read()) {
      try {
        const { rows: now } = await db.query<{ points_new: boolean; old_used: boolean }>(
          `select exists (select 1 from public.profiles
                           where id = $1::uuid and btrim(avatar_path) = $3) as points_new,
                  exists (select 1 from public.profiles where btrim(avatar_path) = $2) as old_used`,
          [entry.user_id, entry.old_path, entry.new_path],
        );
        const safe =
          now[0]?.points_new === true &&
          now[0]?.old_used === false &&
          (await storage.exists(entry.new_path));
        if (!safe) {
          report.kept_old += 1;
          continue;
        }
        if (await storage.exists(entry.old_path)) {
          await storage.remove(entry.old_path);
          report.deleted_old += 1;
        }
      } catch {
        report.failed += 1;
      }
    }
  }
  return report;
}

/** A JSON-lines manifest file. */
export function fileManifest(path: string): RenameOptions['manifest'] {
  return {
    async read() {
      if (!existsSync(path)) return [];
      return (await readFile(path, 'utf8'))
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as ManifestEntry);
    },
    async append(entry) {
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}

const LOCAL_DB = /@(127\.0\.0\.1|localhost|\[::1\]):\d+\//;

async function main(argv: string[]): Promise<number> {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const storageArg = value('--storage');
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  if (!LOCAL_DB.test(url) && !flag('--allow-remote')) {
    console.error('DATABASE_URL is not a local database; pass --allow-remote to run elsewhere');
    return 2;
  }
  let storage: RenameStorage;
  if (storageArg?.startsWith('dir:')) {
    storage = new DirectoryStorage(resolve(storageArg.slice(4)));
  } else if (storageArg === 'supabase') {
    storage = new SupabaseAvatarStorage({
      projectUrl: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_STORAGE_SERVICE_KEY,
      bucket: process.env.AVATARS_BUCKET ?? 'avatars',
    });
  } else {
    console.error('--storage dir:<folder> or --storage supabase is required');
    return 2;
  }
  const apply = flag('--apply');
  const deleteOld = flag('--delete-old');
  const manifestPath = resolve(
    value('--manifest') ?? join(process.cwd(), 'avatars-rename-manifest.jsonl'),
  );
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const report = await renameAvatars({
      db: client,
      storage,
      apply,
      deleteOld,
      key: avatarNameKey(process.env.AUTH_JWT_KEYS ?? AVATAR_NAME_DEVELOPMENT_KEY_MATERIAL),
      manifest: fileManifest(manifestPath),
    });
    const mode = apply ? 'apply' : 'dry-run';
    console.log(
      `avatars-rename (${mode}${deleteOld ? ', delete-old' : ''}): ${JSON.stringify(report)}`,
    );
    return report.failed > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => {
      console.error('avatars-rename failed');
      process.exit(1);
    },
  );
}
