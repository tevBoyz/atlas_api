import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { assertSafeTarget } from '../db/tooling/target-guard';
import { signTestToken, testSessionId } from './test-tokens';

/**
 * `npm run auth:test-token -- [--sub <uuid>] [--minutes <n> | --seconds <n>] [--expired] [--audience <aud>]`
 *
 * Manual testing only (API-100-08; own tokens since D76). Mints one of the API's OWN access tokens
 * for `sub`, signed with AUTH_JWT_KEYS / AUTH_JWT_ACTIVE_KID from the ENVIRONMENT (a throwaway key,
 * e.g. from `npm run auth:keygen`; `.env` is never read). The guard also needs a live session, so the
 * user's fixed test session (`device_sessions`, and a bare `users` row when the user has none) is
 * written first into DATABASE_URL, which must be a LOCAL database (the target guard refuses any
 * other). Refuses NODE_ENV=production. Prints the token alone on stdout (nothing is logged); keep it
 * out of tickets and chats.
 */

function usage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'Usage: npm run auth:test-token -- [--sub <uuid>] [--minutes <n> | --seconds <n>] [--expired] ' +
      '[--audience <aud>]\n',
  );
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const options = {
    sub: randomUUID() as string,
    minutes: 60,
    seconds: undefined as number | undefined,
    expired: false,
    audience: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? usage(`${arg} needs a value`);
    switch (arg) {
      case '--sub':
        options.sub = value().toLowerCase();
        break;
      case '--minutes': {
        const minutes = Number(value());
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
          usage('--minutes must be an integer from 1 to 1440');
        }
        options.minutes = minutes;
        break;
      }
      case '--seconds': {
        const seconds = Number(value());
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
          usage('--seconds must be an integer from 1 to 86400');
        }
        options.seconds = seconds;
        break;
      }
      case '--expired':
        options.expired = true;
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

/** The user's fixed test session, live (a bare `users` row is added when the user has none). */
export async function seedTestSession(url: string, userId: string): Promise<string> {
  assertSafeTarget(url, false);
  const sessionId = testSessionId(userId);
  const client = new Client({ connectionString: url, application_name: 'atlas-test-token' });
  await client.connect();
  try {
    await client.query(`insert into public.users (id) values ($1) on conflict (id) do nothing`, [
      userId,
    ]);
    await client.query(
      `insert into public.device_sessions (id, user_id, auth_method)
       values ($1, $2, 'password')
       on conflict (id) do update set revoked_at = null, revoke_reason = null`,
      [sessionId, userId],
    );
  } finally {
    await client.end();
  }
  return sessionId;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.env.NODE_ENV === 'production') {
    usage('Refusing to mint test tokens with NODE_ENV=production.');
  }
  if (!process.env.AUTH_JWT_KEYS || !process.env.AUTH_JWT_ACTIVE_KID) {
    usage(
      'Set AUTH_JWT_KEYS and AUTH_JWT_ACTIVE_KID (a throwaway key, npm run auth:keygen) first.',
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) usage('Set DATABASE_URL (the LOCAL database) first.');
  await seedTestSession(url, options.sub);

  const token = await signTestToken({
    expiresInSeconds: options.expired ? -120 : (options.seconds ?? options.minutes * 60),
    claims: {
      sub: options.sub,
      ...(options.audience ? { aud: options.audience } : {}),
    },
  });
  const validity = options.expired
    ? 'expired'
    : options.seconds
      ? `valid ${options.seconds} s`
      : `valid ${options.minutes} min`;
  process.stderr.write(
    `Test token for sub ${options.sub} (${validity}). Local API only.
`,
  );
  process.stdout.write(`${token}\n`);
}

if (require.main === module) void main();
