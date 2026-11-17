import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Checksum manifest for `db/baseline/` (API-100-03): the 37 migrations and the 7 SQL tests are
 * stored unchanged, and any edit, addition or removal is detected before anything runs.
 *
 * Format (like `sha256sum`): one `<sha256-hex>  <relative/path>` line per file, sorted by path.
 * Line endings are normalized (CRLF -> LF) before hashing so a Windows checkout with
 * `core.autocrlf=true` hashes the same as the committed LF files.
 */

export const MANIFEST_FILE = 'checksums.sha256';

export interface ChecksumEntry {
  /** Path relative to the baseline directory, with forward slashes. */
  path: string;
  sha256: string;
}

export interface ManifestDiff {
  changed: string[];
  missing: string[];
  unexpected: string[];
}

/** SHA-256 of the content with CRLF normalized to LF. */
export function sha256Normalized(content: string | Buffer): string {
  const text = typeof content === 'string' ? content : content.toString('utf8');
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Lists `*.sql` files directly in `dir`, sorted by file name (byte order). */
export function listSqlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort(compareNames);
}

/** Plain code-unit ordering, so the order never depends on the machine's locale. */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Hashes the baseline migrations and the SQL tests (`tests/*.sql`). */
export function computeBaselineChecksums(baselineDir: string): ChecksumEntry[] {
  const migrations = listSqlFiles(baselineDir).map((name) => name);
  const tests = listSqlFiles(join(baselineDir, 'tests')).map((name) => `tests/${name}`);
  return [...migrations, ...tests]
    .map((path) => ({ path, sha256: sha256Normalized(readFileSync(join(baselineDir, path))) }))
    .sort((a, b) => compareNames(a.path, b.path));
}

export function formatManifest(entries: readonly ChecksumEntry[]): string {
  return entries.map((e) => `${e.sha256}  ${e.path}\n`).join('');
}

export function parseManifest(text: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!match) {
      throw new Error(`${MANIFEST_FILE} line ${index + 1} is malformed.`);
    }
    entries.push({ sha256: match[1], path: match[2] });
  });
  return entries;
}

export function diffManifest(
  expected: readonly ChecksumEntry[],
  actual: readonly ChecksumEntry[],
): ManifestDiff {
  const want = new Map(expected.map((e) => [e.path, e.sha256]));
  const have = new Map(actual.map((e) => [e.path, e.sha256]));
  return {
    changed: [...want].filter(([p, h]) => have.has(p) && have.get(p) !== h).map(([p]) => p),
    missing: [...want.keys()].filter((p) => !have.has(p)),
    unexpected: [...have.keys()].filter((p) => !want.has(p)),
  };
}

export function isCleanDiff(diff: ManifestDiff): boolean {
  return diff.changed.length + diff.missing.length + diff.unexpected.length === 0;
}

/** One SHA-256 over the whole manifest: identifies exactly which baseline was applied. */
export function manifestFingerprint(entries: readonly ChecksumEntry[]): string {
  return sha256Normalized(formatManifest(entries));
}

/** Human-readable diff for error output. */
export function describeDiff(diff: ManifestDiff): string {
  const lines: string[] = [];
  for (const p of diff.changed) lines.push(`  changed:    ${p}`);
  for (const p of diff.missing) lines.push(`  missing:    ${p}`);
  for (const p of diff.unexpected) lines.push(`  not listed: ${p}`);
  return lines.join('\n');
}
