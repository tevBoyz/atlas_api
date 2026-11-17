import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Written next to `main.js` by `npm run build` (postbuild), read at runtime. */
export const BUILD_INFO_FILE = join(__dirname, '..', 'build-info.json');

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export interface BuildInfo {
  git_commit: string | null;
}

/** A commit hash, lower-cased, or `undefined` when the value is not one. */
export function normalizeCommit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return COMMIT_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** The commit recorded at build time, or `undefined` (missing or unreadable file). */
export function readBuildInfoCommit(file = BUILD_INFO_FILE): string | undefined {
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>;
    return normalizeCommit(info.git_commit);
  } catch {
    return undefined;
  }
}

/**
 * Release name for Sentry and the OTel resource (story API-100-06 AC4: release = git commit).
 * `GIT_COMMIT` from the environment wins; else the commit recorded at build time; else none.
 */
export function resolveRelease(
  gitCommit: string | undefined,
  file = BUILD_INFO_FILE,
): string | undefined {
  return normalizeCommit(gitCommit) ?? readBuildInfoCommit(file);
}

/** `git rev-parse HEAD`, or `undefined` when git or the repository is not available. Build time only. */
export function gitHeadCommit(cwd = process.cwd()): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    return normalizeCommit(output);
  } catch {
    return undefined;
  }
}
