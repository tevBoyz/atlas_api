import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import { authHeader, setTestSessionSeeder } from '../../src/testing/test-tokens';
import { testDatabaseUrl } from './database';

/**
 * The integration suites' session seeder (own tokens, D76): before `authHeader(userId)` signs a
 * token, the user's fixed test session (`testSessionId`) must exist and be live in THIS worker's
 * database, or the guard answers 401. Writes a bare `users` row when the user has none yet (a
 * fixture may add the rest later: `createUser` upserts) and the session row, once per user per test
 * file (the database is re-cloned before each file, which clears the cache). Never un-revokes a
 * session a test revoked.
 *
 * One connection per test file, opened on first use and closed after the file
 * ({@link closeTestSessionClient}), so many concurrent first calls never exhaust the database's
 * connection slots.
 */
const seeded = new Map<string, Promise<void>>();
let connection: Promise<Client> | undefined;

function sharedClient(): Promise<Client> {
  connection ??= (async () => {
    const client = new Client({
      connectionString: testDatabaseUrl(),
      application_name: 'atlas-test-session',
    });
    // The worker database is dropped (with force) between files: never an unhandled error.
    client.on('error', () => undefined);
    await client.connect();
    return client;
  })();
  return connection;
}

export function clearSeededTestSessions(): void {
  seeded.clear();
}

export async function closeTestSessionClient(): Promise<void> {
  const pending = connection;
  connection = undefined;
  seeded.clear();
  if (pending) await (await pending).end().catch(() => undefined);
}

async function write(userId: string, sessionId: string): Promise<void> {
  const client = await sharedClient();
  await client.query(`insert into public.users (id) values ($1) on conflict (id) do nothing`, [
    userId,
  ]);
  await client.query(
    `insert into public.device_sessions (id, user_id, auth_method)
     values ($1, $2, 'password') on conflict (id) do nothing`,
    [sessionId, userId],
  );
}

function seed(userId: string, sessionId: string): Promise<void> {
  let done = seeded.get(userId);
  if (!done) {
    done = write(userId, sessionId);
    seeded.set(userId, done);
    done.catch(() => seeded.delete(userId));
  }
  return done;
}

export function registerTestSessionSeeder(): void {
  setTestSessionSeeder(seed);
}

/**
 * A user id whose test session was seeded and whose account was then deleted (the session goes
 * with it, ON DELETE CASCADE): `authHeader(id)` still signs a well-formed token, which the guard
 * refuses (401 `<fn>:not_authenticated`). Stands for "a valid token whose user no longer exists".
 */
export async function goneUser(client: Pick<Client, 'query'>): Promise<string> {
  const id = randomUUID();
  await authHeader(id);
  await client.query('delete from public.users where id = $1', [id]);
  return id;
}
