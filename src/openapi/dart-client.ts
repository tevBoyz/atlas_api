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

/** Replaces every match of `pattern` in `text`; throws if there is none (a generator change). */
function replaceRequired(file: string, text: string, pattern: RegExp, replacement: string): string {
  pattern.lastIndex = 0;
  if (!pattern.test(text)) {
    throw new Error(`patchUnknownEnums: ${pattern} not found in ${file}; check the generator.`);
  }
  pattern.lastIndex = 0;
  return text.replace(pattern, replacement);
}

const ENUM_TO_JSON =
  /String toJson\(\) \{\s*final value = json;\s*if \(value == null\) \{\s*throw StateError\([^;]*\);\s*\}\s*return value as String;\s*\}/g;
const MODEL_FROM_JSON =
  /factory (\w+)\.fromJson\(Map<String, Object\?> json\)\s*=>\s*_\$(\w+)FromJson\(json\);/g;
const MODEL_TO_JSON = /Map<String, Object\?> toJson\(\)\s*=>\s*_\$(\w+)ToJson\(this\);/g;
const HELPER_IMPORT = "import 'package:atlas_api_client/src/unknown_enum_values.dart';";

/**
 * Unknown enum values never throw and round-trip the original string (see
 * `clients/dart/lib/src/unknown_enum_values.dart`). swagger_parser 1.46 has no option for this: with
 * `unknown_enum_value` a new server value becomes `$unknown`, whose `toJson()` throws. Runs on the
 * swagger_parser output before build_runner; plain text replacement, so it is deterministic, and it
 * fails if the generated shape it expects is missing.
 * - Every enum: `String toJson()` that throws on `$unknown` becomes `String? toJson() => json;`.
 * - Every model with an enum field: `fromJson` remembers the parsed strings, and `toJson` writes
 *   each enum field as a string: the one it was parsed from (so `$unknown` keeps the server's
 *   value), else the enum's JSON value.
 */
function patchUnknownEnums(): void {
  const modelsDir = join(GENERATED_DIR, 'models');
  const files = dartFiles(modelsDir);
  const enumNames = new Set<string>();
  for (const file of files) {
    let text = readFileSync(file, 'utf8');
    const name = /^enum (\w+) \{/m.exec(text)?.[1];
    if (!name) continue;
    enumNames.add(name);
    text = replaceRequired(file, text, ENUM_TO_JSON, 'String? toJson() => json;');
    writeFileSync(file, text, 'utf8');
  }
  if (enumNames.size === 0) throw new Error('patchUnknownEnums: no generated enums found.');

  for (const file of files) {
    let text = readFileSync(file, 'utf8');
    if (!/^class \w+ \{/m.test(text)) continue;
    const fieldTypes = [...text.matchAll(/^\s*final (\w+)\??\s+\w+;/gm)].map((m) => m[1]);
    if (!fieldTypes.some((type) => enumNames.has(type))) continue;
    text = replaceRequired(
      file,
      text,
      MODEL_FROM_JSON,
      'factory $1.fromJson(Map<String, Object?> json) => keepRawJson(_$$$2FromJson(json), json);',
    );
    text = replaceRequired(
      file,
      text,
      MODEL_TO_JSON,
      'Map<String, Object?> toJson() => enumValuesAsStrings(this, _$$$1ToJson(this));',
    );
    text = replaceRequired(
      file,
      text,
      /^(import 'package:json_annotation\/json_annotation\.dart';)$/m,
      `$1\n\n${HELPER_IMPORT}`,
    );
    writeFileSync(file, text, 'utf8');
  }
}

function generate(): void {
  assertVersionMatches();
  dart('pub', 'get', '--enforce-lockfile');
  rmSync(GENERATED_DIR, { recursive: true, force: true });
  dart('run', 'swagger_parser');
  patchUnknownEnums();
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
