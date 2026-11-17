import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaselineError, verifyBaselineFiles, writeBaselineManifest } from './baseline';
import {
  computeBaselineChecksums,
  diffManifest,
  formatManifest,
  isCleanDiff,
  listSqlFiles,
  manifestFingerprint,
  parseManifest,
  sha256Normalized,
} from './checksums';

describe('baseline checksums (API-100-03)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-baseline-'));
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, '20261015184500_b.sql'), 'create table b ();\n');
    writeFileSync(join(dir, '20261015000000_a.sql'), 'create table a ();\n');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    writeFileSync(join(dir, 'tests', 'a_test.sql'), 'do $$ begin end $$;\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists SQL files in file-name order and ignores other files', () => {
    expect(listSqlFiles(dir)).toEqual(['20261015000000_a.sql', '20261015184500_b.sql']);
  });

  it('hashes CRLF and LF checkouts identically', () => {
    expect(sha256Normalized('a\r\nb\r\n')).toBe(sha256Normalized('a\nb\n'));
    expect(sha256Normalized('a\nb\n')).not.toBe(sha256Normalized('a\nb'));
  });

  it('covers migrations and tests, and round-trips through the manifest format', () => {
    const entries = computeBaselineChecksums(dir);
    expect(entries.map((e) => e.path)).toEqual([
      '20261015000000_a.sql',
      '20261015184500_b.sql',
      'tests/a_test.sql',
    ]);
    expect(parseManifest(formatManifest(entries))).toEqual(entries);
  });

  it('rejects a malformed manifest line', () => {
    expect(() => parseManifest('not-a-hash  file.sql\n')).toThrow(/line 1 is malformed/);
  });

  it('reports changed, missing and unexpected files', () => {
    const expected = computeBaselineChecksums(dir);
    writeFileSync(join(dir, '20261015184500_b.sql'), 'create table b (id int);\n');
    rmSync(join(dir, 'tests', 'a_test.sql'));
    writeFileSync(join(dir, '20261116000000_c.sql'), 'select 1;\n');

    const diff = diffManifest(expected, computeBaselineChecksums(dir));
    expect(diff).toEqual({
      changed: ['20261015184500_b.sql'],
      missing: ['tests/a_test.sql'],
      unexpected: ['20261116000000_c.sql'],
    });
    expect(isCleanDiff(diff)).toBe(false);
  });

  it('verifies a clean tree and returns a stable fingerprint', () => {
    writeBaselineManifest(dir);
    const fingerprint = verifyBaselineFiles(dir);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(manifestFingerprint(computeBaselineChecksums(dir)));
  });

  it('still verifies after a CRLF re-checkout', () => {
    writeBaselineManifest(dir);
    writeFileSync(join(dir, '20261015000000_a.sql'), 'create table a ();\r\n');
    expect(() => verifyBaselineFiles(dir)).not.toThrow();
  });

  it('refuses an edited file, naming it', () => {
    writeBaselineManifest(dir);
    writeFileSync(join(dir, 'tests', 'a_test.sql'), 'do $$ begin perform 1; end $$;\n');
    expect(() => verifyBaselineFiles(dir)).toThrow(BaselineError);
    expect(() => verifyBaselineFiles(dir)).toThrow(/changed: {4}tests\/a_test\.sql/);
  });

  it('refuses when the manifest is missing', () => {
    expect(() => verifyBaselineFiles(dir)).toThrow(/checksums\.sha256 not found/);
  });
});
