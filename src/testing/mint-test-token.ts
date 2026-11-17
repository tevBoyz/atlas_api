import { randomUUID } from 'node:crypto';

import { loadConfigOrExit } from '../config/bootstrap-config';
import { signTestToken } from './test-tokens';

/**
 * `npm run auth:test-token -- [--sub <uuid>] [--minutes <n>] [--expired] [--role <role>]
 *                              [--anonymous] [--audience <aud>]`
 *
 * Manual testing only (API-100-08). Mints a Supabase-shaped HS256 access token signed with THIS
 * machine's SUPABASE_JWT_SECRET (from the environment or `.env`), so it is accepted only by an API
 * configured with that same local secret. Use a random local value for the secret, never the real
 * project's JWT secret. Refuses NODE_ENV=production. Prints the token alone on stdout (nothing is
 * logged); keep it out of tickets and chats.
 */

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: npm run auth:test-token -- [--sub <uuid>] [--minutes <n>] [--expired] ' +
      '[--role <role>] [--anonymous] [--audience <aud>]\n',
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const options = {
    sub: randomUUID() as string,
    minutes: 60,
    expired: false,
    role: 'authenticated',
    anonymous: false,
    audience: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? usage(`${arg} needs a value`);
    switch (arg) {
      case '--sub':
        options.sub = value();
        break;
      case '--minutes': {
        const minutes = Number(value());
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
          usage('--minutes must be an integer from 1 to 1440');
        }
        options.minutes = minutes;
        break;
      }
      case '--expired':
        options.expired = true;
        break;
      case '--role':
        options.role = value();
        break;
      case '--anonymous':
        options.anonymous = true;
        break;
      case '--audience':
        options.audience = value();
        break;
      default:
        usage(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfigOrExit();
  if (config.NODE_ENV === 'production')
    usage('Refusing to mint test tokens with NODE_ENV=production.');
  const secret = config.SUPABASE_JWT_SECRET;
  const issuer = config.SUPABASE_JWT_ISSUER;
  if (!secret) usage('Set SUPABASE_JWT_SECRET (a random local value, 32+ characters) first.');
  if (!issuer) usage('Set SUPABASE_JWT_ISSUER first (the API refuses tokens without it).');

  const token = await signTestToken({
    secret,
    expiresInSeconds: options.expired ? -120 : options.minutes * 60,
    claims: {
      sub: options.sub,
      iss: issuer,
      aud: options.audience ?? config.SUPABASE_JWT_AUDIENCE,
      role: options.role,
      is_anonymous: options.anonymous,
    },
  });
  process.stderr.write(
    `Test token for sub ${options.sub} (${options.expired ? 'expired' : `valid ${options.minutes} min`}, ` +
      `role ${options.role}${options.anonymous ? ', anonymous' : ''}). Local API only.\n`,
  );
  process.stdout.write(`${token}\n`);
}

void main();
