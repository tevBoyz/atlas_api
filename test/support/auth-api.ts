import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import bcrypt from 'bcryptjs';

import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import { type MailboxMessage, mailboxFor } from '../../src/modules/auth/test-mailbox.route';
import { createTestApp, type TestApp, withTestConfig } from '../../src/testing/test-app';
import { openTestClient } from './database';
import { createUser, type Queryable } from './fixtures';

/**
 * Helpers of the own-auth suites (Phase 6). Every app built here sends email and SMS through the
 * FAKE adapters (channels on, nothing leaves the process); tests read what was "sent" from the
 * fakes (the same data the test-only mailbox route serves). Addresses are fake (`example.test`,
 * the fictional +1 201 555-01xx range).
 */
export const DEVICE = { platform: 'android', app_version: '1.0.0' } as const;
/** A password that meets the policy (D5a). Test-only. */
export const GOOD_PASSWORD = ['Test', 'Pass', 'word', '123'].join('');

export function fakeEmail(label = 'auth'): string {
  return `${label}-${randomUUID()}@example.test`;
}

/**
 * An app with the email and SMS channels on (fake adapters) plus `config`. It trusts
 * `x-forwarded-for`, and {@link post} sends a random client address unless one is given, so the
 * per-IP limits of the public auth routes only apply where a test means them to.
 */
export async function createAuthApp(config: Record<string, string> = {}): Promise<TestApp> {
  const created = await createTestApp(
    {},
    withTestConfig({
      CHANNEL_EMAIL_ENABLED: 'true',
      CHANNEL_SMS_ENABLED: 'true',
      TRUST_PROXY: 'true',
      // Suites here start several apps; small pools keep the shared test database under its
      // connection limit when many files run in parallel.
      DATABASE_POOL_MAX: '5',
      ...config,
    }),
  );
  await untilReady(created.app);
  return created;
}

/**
 * Waits for `/readyz` (database, Redis, migrations, the realtime adapter's connections, jobs), so a
 * suite that closes its app right away never closes Redis connections that are still subscribing.
 */
export async function untilReady(app: NestFastifyApplication, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await app.inject({ method: 'GET', url: '/readyz' })).statusCode === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('the app did not become ready');
}

/** A random private client address (TEST-NET-like 10.x space), for `x-forwarded-for`. */
export function randomIp(): string {
  const n = () => Math.floor(Math.random() * 254) + 1;
  return `10.${n()}.${n()}.${n()}`;
}

export function mailbox(app: NestFastifyApplication, to: string): MailboxMessage[] {
  return mailboxFor(app.get(ChannelSenders, { strict: false }), to);
}

/** `type` and `token` of the newest emailed link to `to` (undefined when none). */
export function latestLink(
  app: NestFastifyApplication,
  to: string,
): { type: string; token: string; url: string } | undefined {
  const emails = mailbox(app, to).filter((m) => m.channel === 'email');
  const text = emails[emails.length - 1]?.text;
  const match = text
    ? /(io\.supabase\.atlasmobile:\/\/login-callback\/\?type=(\w+)&token=([\w-]+))/.exec(text)
    : null;
  return match ? { url: match[1], type: match[2], token: match[3] } : undefined;
}

/** The newest 6-digit code texted to `phone`. */
export function latestCode(app: NestFastifyApplication, phone: string): string | undefined {
  const texts = mailbox(app, phone).filter((m) => m.channel === 'sms');
  return /\b(\d{6})\b/.exec(texts[texts.length - 1]?.text ?? '')?.[1];
}

export async function post(
  app: NestFastifyApplication,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': randomIp(), ...headers },
    payload: JSON.stringify(body),
  });
}

export interface SessionBody {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  session_id: string;
  user: { id: string; email: string | null; phone: string | null; [key: string]: unknown };
}

let phoneCounter = Math.floor(Math.random() * 1_000_000);
/**
 * A fictional UK drama number (+44 7700 900xxx, reserved by Ofcom for fiction) with three more
 * random digits (15 digits, still E.164): a range `fixtures.ts` (+1 201 555-01xx) never uses, so
 * both can be mixed in one file. Wide on purpose: since D78 a duplicate phone is a 409 at sign-up,
 * so numbers must not repeat across runs on the same local database.
 */
export function authFakePhone(): string {
  return `+447700900${String(phoneCounter++ % 1_000_000).padStart(6, '0')}`;
}

/**
 * Signs up and confirms the email; returns the session and the credentials used. The account gets
 * its phone stored unconfirmed, as before D78: the sign-up goes in with the email only (so no code
 * is texted and the number's OTP counters stay untouched for the suites that count them), then the
 * phone is written on the row. Sign-up with a phone itself is covered by auth-signup.int-spec.ts.
 */
export async function signedUpUser(
  app: NestFastifyApplication,
  options: { email?: string; phone?: string; password?: string } = {},
): Promise<{ email: string; phone: string; password: string; session: SessionBody }> {
  const email = options.email ?? fakeEmail();
  const phone = options.phone ?? authFakePhone();
  const password = options.password ?? GOOD_PASSWORD;
  const signup = await post(app, '/v1/auth/signup', {
    email,
    password,
    full_name: 'Auth Example',
    device: DEVICE,
  });
  if (signup.statusCode !== 202) throw new Error(`signup answered ${signup.statusCode}`);
  const client = await openTestClient();
  try {
    await client.query('update public.users set phone = $1 where email = $2', [phone, email]);
  } finally {
    await client.end();
  }
  const link = latestLink(app, email);
  if (!link) throw new Error('no verification link was sent');
  const verified = await post(app, '/v1/auth/email/verify', { token: link.token, device: DEVICE });
  if (verified.statusCode !== 200) throw new Error(`verify answered ${verified.statusCode}`);
  return { email, phone, password, session: verified.json<SessionBody>() };
}

export const errorOf = (reply: { json: <T>() => T }) =>
  reply.json<{ error: { code: string; message: string; details: Record<string, unknown> } }>()
    .error;

/**
 * An imported account (moved from the old backend, API-100-58): a `users` row with a complete
 * profile whose password credential is still a bcrypt hash, signed in through the API. The sign-in
 * re-hashes the password to argon2id.
 */
export async function legacyUser(
  app: NestFastifyApplication,
  q: Queryable,
  password: string = GOOD_PASSWORD,
): Promise<{ id: string; email: string; password: string; session: SessionBody }> {
  const user = await createUser(q, {
    phone: true,
    encryptedPassword: await bcrypt.hash(password, 10),
  });
  const res = await post(app, '/v1/auth/login', { email: user.email, password, device: DEVICE });
  if (res.statusCode !== 200) throw new Error(`legacy login answered ${res.statusCode}`);
  return { id: user.id, email: user.email, password, session: res.json<SessionBody>() };
}
