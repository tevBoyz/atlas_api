import 'reflect-metadata';
// Must stay before the app module import.
import './cli-env';

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AppModule } from '../app.module';
import { buildOpenApiDocument, serializeOpenApiDocument } from './openapi.document';
import { collectControllers, discoverRoutes } from './route-discovery';

/**
 * `npm run openapi:generate` writes `openapi.json`; `npm run openapi:check` regenerates it in memory
 * and fails on any byte difference from the committed file (API-100-12, CI step of API-100-04).
 *
 * Needs no database, no Redis and no `.env`: routes are read from decorators, nothing is started.
 */
const SPEC_FILE = resolve('openapi.json');

function generate(): string {
  return serializeOpenApiDocument(
    buildOpenApiDocument(discoverRoutes(collectControllers(AppModule))),
  );
}

function main(command: string | undefined): number {
  const generated = generate();
  if (command === 'write') {
    writeFileSync(SPEC_FILE, generated, 'utf8');
    process.stdout.write(`Wrote openapi.json (${generated.length} bytes).\n`);
    return 0;
  }
  if (command === 'check') {
    const committed = existsSync(SPEC_FILE) ? readFileSync(SPEC_FILE, 'utf8') : '';
    if (committed === generated) {
      process.stdout.write('openapi.json is up to date.\n');
      return 0;
    }
    process.stderr.write(
      'openapi.json differs from the code. Run "npm run openapi:generate" and commit the result.\n',
    );
    return 1;
  }
  process.stderr.write('Usage: tsx src/openapi/cli.ts <write|check>\n');
  return 2;
}

process.exit(main(process.argv[2]));
