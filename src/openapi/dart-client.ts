import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { API_VERSION } from '../app.constants';

/**
 * The generated Dart client in `clients/dart/` (API-100-12 AC5).
 * - `npm run client:dart:generate`: regenerates `lib/src/generated` from `openapi.json`.
 * - `npm run client:dart:build`: resolves the locked dependencies and analyzes the package.
 *
 * The generator (swagger_parser) is pure Dart and pinned in `pubspec.yaml`; no Java is needed.
 */
const PACKAGE_DIR = resolve('clients/dart');
const GENERATED_DIR = join(PACKAGE_DIR, 'lib/src/generated');
const PUBSPEC = join(PACKAGE_DIR, 'pubspec.yaml');

function dart(...args: string[]): void {
  // A command line, because the Windows SDK ships `dart` as a batch file. Only fixed strings.
  const command = `dart ${args.join(' ')}`;
  process.stdout.write(`> ${command}\n`);
  execSync(command, { cwd: PACKAGE_DIR, stdio: 'inherit' });
}

/** The package version is the API version. */
function assertVersionMatches(): void {
  const match = /^version:\s*(\S+)\s*$/m.exec(readFileSync(PUBSPEC, 'utf8'));
  if (match?.[1] !== API_VERSION) {
    throw new Error(`clients/dart/pubspec.yaml version must be ${API_VERSION}.`);
  }
}

function dartFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return dartFiles(path);
    return name.endsWith('.dart') ? [path] : [];
  });
}

/** Generated files are byte-identical on every OS (the Windows SDK can write CRLF). */
function normalizeLineEndings(): void {
  for (const file of dartFiles(GENERATED_DIR)) {
    const text = readFileSync(file, 'utf8');
    const normalized = text.replace(/\r\n/g, '\n');
    if (normalized !== text) writeFileSync(file, normalized, 'utf8');
  }
}

function generate(): void {
  assertVersionMatches();
  dart('pub', 'get', '--enforce-lockfile');
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  dart('run', 'swagger_parser');
  dart('run', 'build_runner', 'build');
  dart('format', 'lib/src/generated');
  normalizeLineEndings();
}

function build(): void {
  assertVersionMatches();
  dart('pub', 'get', '--enforce-lockfile');
  dart('analyze', '--fatal-warnings');
  dart('test');
}

const commands: Record<string, () => void> = { generate, build };
const command = commands[process.argv[2] ?? ''];
if (!command) {
  process.stderr.write('Usage: tsx src/openapi/dart-client.ts <generate|build>\n');
  process.exit(2);
}
command();
