import { generatePrivateJwk, JWT_KID_PATTERN } from '../../../config/jwt-keys';

/**
 * `npm run -s auth:keygen -- --kid <kid> [--p256]` (API-100-51): prints ONE new private JWK (Ed25519
 * by default, P-256 with `--p256`) for AUTH_JWT_KEYS, to stdout only. The output is a SECRET: put it
 * straight into the host's secret store (or a local `.env`), never into the repository, a ticket or a
 * log. Nothing is written to disk.
 */
function main(argv: string[]): number {
  const kidIndex = argv.indexOf('--kid');
  const kid = kidIndex >= 0 ? argv[kidIndex + 1] : undefined;
  if (!kid || !JWT_KID_PATTERN.test(kid)) {
    process.stderr.write('usage: npm run -s auth:keygen -- --kid <kid> [--p256]\n');
    return 2;
  }
  process.stdout.write(
    `${JSON.stringify(generatePrivateJwk(kid, argv.includes('--p256') ? 'p256' : 'ed25519'))}\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
