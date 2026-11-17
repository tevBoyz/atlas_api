import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitHeadCommit, normalizeCommit, readBuildInfoCommit, resolveRelease } from './release';

describe('release = git commit (API-100-06 AC4)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-build-info-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildInfo(content: string): string {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, content);
    return file;
  }

  it('normalizes commit hashes and rejects anything else', () => {
    expect(normalizeCommit(' ABCDEF1234 ')).toBe('abcdef1234');
    expect(normalizeCommit('main')).toBeUndefined();
    expect(normalizeCommit(undefined)).toBeUndefined();
  });

  it('prefers GIT_COMMIT from the environment', () => {
    const file = buildInfo('{"git_commit":"1111111"}');
    expect(resolveRelease('2222222', file)).toBe('2222222');
  });

  it('falls back to the commit recorded at build time', () => {
    const file = buildInfo('{"git_commit":"1111111"}');
    expect(resolveRelease(undefined, file)).toBe('1111111');
  });

  it('is undefined (never fails) when nothing is known', () => {
    expect(resolveRelease(undefined, join(dir, 'missing.json'))).toBeUndefined();
    expect(readBuildInfoCommit(buildInfo('not json'))).toBeUndefined();
    expect(readBuildInfoCommit(buildInfo('{"git_commit":null}'))).toBeUndefined();
  });

  it('gitHeadCommit returns undefined outside a repository instead of throwing', () => {
    expect(gitHeadCommit(dir)).toBeUndefined();
  });
});
