import { writeFileSync } from 'node:fs';

import { BUILD_INFO_FILE, type BuildInfo, gitHeadCommit, normalizeCommit } from './release';

/**
 * Build step (`postbuild`): records the git commit in `dist/build-info.json` for the Sentry release.
 * Source: the `GIT_COMMIT` build environment variable (Docker: `--build-arg GIT_COMMIT=...`), else
 * `git rev-parse HEAD`. Never fails the build: without either, the commit is recorded as null.
 */
function main(): void {
  // Build-time only: the running API reads GIT_COMMIT through the validated config instead.
  const commit = normalizeCommit(process.env.GIT_COMMIT) ?? gitHeadCommit() ?? null;
  const info: BuildInfo = { git_commit: commit };
  writeFileSync(BUILD_INFO_FILE, `${JSON.stringify(info)}\n`);
  process.stdout.write(`build-info: git commit ${commit ? 'recorded' : 'not available'}\n`);
}

main();
