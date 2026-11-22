import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Client } from 'pg';

import type { ApiConfigService, ConfigKey } from '../../src/config';
import { parseConfig } from '../../src/config';
import { DatabaseService } from '../../src/db/database.service';
import { OUTBOX_TOPIC_HANDLERS, type OutboxTopicHandler } from '../../src/jobs/job-workers';
import { OutboxWriter } from '../../src/jobs/outbox';
import { OutboxRelay } from '../../src/jobs/outbox-relay.service';
import { ChannelSenders } from '../../src/modules/notifications/channels/channel-senders';
import { isPermanentFailure } from '../../src/modules/notifications/channels/channel.types';
import { SendGridEmailSender } from '../../src/modules/notifications/channels/real-senders';
import type { DeliveryRecipient } from '../../src/modules/notifications/deliveries.repository';
import { DeliveryPlanner } from '../../src/modules/notifications/deliveries.service';
import type { LogCapture } from '../../src/testing/test-app';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { createTestWorker } from '../../src/testing/test-worker';
import {
  authFakePhone,
  createAuthApp,
  DEVICE,
  fakeEmail,
  GOOD_PASSWORD,
  mailbox,
  post,
} from '../support/auth-api';
import { openTestClient } from '../support/database';
import { createUser } from '../support/fixtures';

/**
 * Stage 7.7a (D43): the SendGrid email adapter against a LOCAL fake SendGrid server (never the real
 * one). The real fetch transport, the request SendGrid expects, the answers (202 → sent with the
 * X-Message-Id; 400 → permanent; 429 / 5xx → retried; no answer in time → timeout), the three auth
 * emails through the selected adapter, and a notification email retried by the worker. Fake key,
 * fake addresses (example.test).
 */
const FAKE_KEY = `SG.fake-${randomUUID()}-SHOULD-NEVER-APPEAR`;
const FROM = 'alerts@example.test';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: {
    personalizations: { to: { email: string }[] }[];
    from: { email: string; name?: string };
    subject: string;
    content: { type: string; value: string }[];
    tracking_settings: unknown;
  };
}

interface Answer {
  status: number;
  body?: unknown;
  delayMs?: number;
}

/** A local stand-in for `POST /v3/mail/send`: records requests; answers per recipient (default 202). */
class FakeSendGrid {
  readonly received: Received[] = [];
  private readonly plans = new Map<string, Answer[]>();
  private server!: Server;
  private counter = 0;
  baseUrl = '';

  plan(to: string, ...answers: Answer[]): void {
    this.plans.set(to, answers);
  }

  to(address: string): Received[] {
    return this.received.filter((r) => r.body.personalizations[0]?.to[0]?.email === address);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Received['body'];
        this.received.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body,
        });
        const to = body.personalizations?.[0]?.to?.[0]?.email ?? '';
        const answer = this.plans.get(to)?.shift() ?? { status: 202 };
        const reply = () => {
          if (response.destroyed) return;
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          if (answer.status === 202) headers['x-message-id'] = `sg-fake-${++this.counter}`;
          response.writeHead(answer.status, headers);
          response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
        };
        if (answer.delayMs) setTimeout(reply, answer.delayMs);
        else reply();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

describe('SendGrid email adapter against a local fake SendGrid (stage 7.7a, D43)', () => {
  const sendgrid = new FakeSendGrid();
  const config = () => ({
    CHANNEL_EMAIL_ADAPTER: 'sendgrid',
    SENDGRID_API_KEY: FAKE_KEY,
    SENDGRID_API_BASE_URL: sendgrid.baseUrl,
    EMAIL_FROM_ADDRESS: FROM,
    EMAIL_FROM_NAME: 'Atlas',
  });

  beforeAll(() => sendgrid.start());
  afterAll(() => sendgrid.stop());

  describe('the adapter over the real fetch transport', () => {
    let senders: ChannelSenders;

    beforeAll(() => {
      const parsed = parseConfig({ ...config(), NOTIFICATIONS_SEND_TIMEOUT_MS: '300' });
      const service = { get: (key: ConfigKey) => parsed[key] } as unknown as ApiConfigService;
      const logger = { info: jest.fn(), warn: jest.fn() } as unknown as Logger;
      senders = new ChannelSenders(service, logger);
      expect(senders.email).toBeInstanceOf(SendGridEmailSender);
    });

    it('202 → sent with the X-Message-Id; the request SendGrid expects', async () => {
      const to = fakeEmail('sg');
      const result = await senders.email.send(to, 'Hello', 'Plain text body');
      expect(result).toEqual({
        provider_message_id: expect.stringMatching(/^sg-fake-\d+$/) as string,
        status: 'sent',
      });
      const [request] = sendgrid.to(to);
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v3/mail/send');
      expect(request.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.body).toEqual({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM, name: 'Atlas' },
        subject: 'Hello',
        content: [{ type: 'text/plain', value: 'Plain text body' }],
        tracking_settings: {
          click_tracking: { enable: false, enable_text: false },
          open_tracking: { enable: false },
        },
      });
    });

    it.each([
      [
        400,
        { errors: [{ field: 'personalizations.0.to.0.email', message: 'Invalid' }] },
        'invalid_recipient',
        true,
      ],
      [400, { errors: [{ field: 'from', message: 'not verified' }] }, 'invalid_request', true],
      [401, { errors: [{ message: 'bad key' }] }, 'auth_failed', false],
      [429, { errors: [{ message: 'too many' }] }, 'rate_limited', false],
      [500, {}, 'provider_unavailable', false],
    ])('HTTP %i → %s (permanent: %s)', async (status, body, code, permanent) => {
      const to = fakeEmail('sg');
      sendgrid.plan(to, { status, body });
      const result = await senders.email.send(to, 's', 't');
      expect(result).toEqual({ provider_message_id: null, status: 'failed', error_code: code });
      expect(isPermanentFailure(result.error_code)).toBe(permanent);
      expect(JSON.stringify(result)).not.toContain(FAKE_KEY);
    });

    it('no answer within NOTIFICATIONS_SEND_TIMEOUT_MS → timeout (retried)', async () => {
      const to = fakeEmail('sg');
      sendgrid.plan(to, { status: 202, delayMs: 2000 });
      const started = Date.now();
      const result = await senders.email.send(to, 's', 't');
      expect(result).toEqual({
        provider_message_id: null,
        status: 'failed',
        error_code: 'timeout',
      });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(isPermanentFailure(result.error_code)).toBe(false);
    });

    it('a closed port → transport_error (retried)', async () => {
      const parsed = parseConfig({ ...config(), SENDGRID_API_BASE_URL: 'http://127.0.0.1:1' });
      const service = { get: (key: ConfigKey) => parsed[key] } as unknown as ApiConfigService;
      const logger = { info: jest.fn(), warn: jest.fn() } as unknown as Logger;
      const result = await new ChannelSenders(service, logger).email.send(fakeEmail(), 's', 't');
      expect(result.error_code).toBe('transport_error');
    });
  });

  describe('the auth emails go through the selected adapter', () => {
    let app: NestFastifyApplication;
    let logs: LogCapture;

    beforeAll(async () => {
      ({ app, logs } = await createAuthApp(config()));
    });

    afterAll(() => app.close());

    const linkOf = (request: Received) =>
      /login-callback\/\?type=(\w+)&token=([\w-]+)/.exec(request.body.content[0].value);

    const signUp = (email: string) =>
      post(app, '/v1/auth/signup', {
        email,
        password: GOOD_PASSWORD,
        phone: authFakePhone(),
        full_name: 'SendGrid Example',
        device: DEVICE,
      });

    it('sign-up verification: one SendGrid request, a working link, nothing in the fake mailbox', async () => {
      const email = fakeEmail('sg-signup');
      expect((await signUp(email)).statusCode).toBe(202);
      await waitFor(() => sendgrid.to(email).length === 1);
      const [request] = sendgrid.to(email);
      expect(request.body.subject).toBe('Confirm your Atlas account');
      expect(request.body.from).toEqual({ email: FROM, name: 'Atlas' });
      const link = linkOf(request);
      expect(link?.[1]).toBe('signup');
      expect(mailbox(app, email)).toEqual([]);
      const verified = await post(app, '/v1/auth/email/verify', {
        token: link![2],
        device: DEVICE,
      });
      expect(verified.statusCode).toBe(200);
    });

    it('magic link and password reset go to SendGrid too', async () => {
      const email = fakeEmail('sg-links');
      await signUp(email);
      await waitFor(() => sendgrid.to(email).length === 1);
      const signupLink = linkOf(sendgrid.to(email)[0])!;
      expect(
        (await post(app, '/v1/auth/email/verify', { token: signupLink[2], device: DEVICE }))
          .statusCode,
      ).toBe(200);
      expect(
        (await post(app, '/v1/auth/email/resend', { email, purpose: 'magic_link' })).statusCode,
      ).toBe(202);
      expect((await post(app, '/v1/auth/password/forgot', { email })).statusCode).toBe(202);
      await waitFor(() => sendgrid.to(email).length === 3);
      const sent = sendgrid.to(email).slice(1);
      expect(sent.map((r) => r.body.subject).sort()).toEqual(
        ['Reset your Atlas password', 'Your Atlas sign-in link'].sort(),
      );
      expect(sent.map((r) => linkOf(r)?.[1]).sort()).toEqual(['magiclink', 'recovery']);
      expect(mailbox(app, email)).toEqual([]);
    });

    it('a SendGrid failure never fails the request; the log has the kind and code only', async () => {
      const email = fakeEmail('sg-fail');
      sendgrid.plan(email, { status: 500 });
      expect((await signUp(email)).statusCode).toBe(202);
      await waitFor(() =>
        logs.lines.some((line) => line.msg === 'auth email not sent' && line.kind === 'signup'),
      );
      const all = JSON.stringify(logs.lines);
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toContain(email);
      expect(all).not.toMatch(/token=[\w-]{20,}/);
      expect(all).toContain('mail=sendgrid');
    });
  });

  describe('notification emails through the worker', () => {
    let app: NestFastifyApplication;
    let worker: TestingModule;
    let workerLogs: LogCapture;
    let client: Client;

    const handler: OutboxTopicHandler = {
      topics: ['incident.created'],
      async handle(row) {
        const payload = row.payload as { recipients: DeliveryRecipient[]; incident_id: string };
        await worker
          .get(DeliveryPlanner)
          .fanOut(row, payload.incident_id, payload.recipients, ['email']);
      },
    };

    beforeAll(async () => {
      const values = {
        ...config(),
        CHANNEL_EMAIL_ENABLED: 'true',
        OUTBOX_RELAY_INTERVAL_MS: '60000',
        NOTIFICATIONS_RETRY_BASE_DELAY_MS: '50',
      };
      ({ app } = await createTestApp({}, withTestConfig(values)));
      ({ worker, logs: workerLogs } = await createTestWorker((builder) =>
        withTestConfig(values)(builder).overrideProvider(OUTBOX_TOPIC_HANDLERS).useValue([handler]),
      ));
      client = await openTestClient();
    });

    afterAll(async () => {
      await client.end();
      await worker.close();
      await app.close();
    });

    async function notify(userId: string): Promise<string> {
      const incidentId = randomUUID();
      const id = await app.get(DatabaseService).db.transaction((tx) =>
        app.get(OutboxWriter).insert(tx, {
          topic: 'incident.created',
          aggregateId: incidentId,
          payload: sql`${JSON.stringify({
            incident_id: incidentId,
            emergency_type: 'medical',
            resident_name: 'Resident Example',
            occurred_at: '2026-11-20T10:00:00+00:00',
            recipients: [{ user_id: userId, eligible: true }],
          })}::jsonb`,
        }),
      );
      await app.get(OutboxRelay).flush();
      return id;
    }

    interface EmailDelivery {
      status: string;
      attempts: number;
      error_code: string | null;
      provider_message_id: string | null;
    }

    async function settled(outboxId: string): Promise<EmailDelivery> {
      let row: EmailDelivery | undefined;
      await waitFor(async () => {
        const { rows } = await client.query<EmailDelivery>(
          `select status, attempts, error_code, provider_message_id
             from public.notification_deliveries where outbox_id = $1 and channel = 'email'`,
          [outboxId],
        );
        row = rows[0];
        return row !== undefined && row.status !== 'queued';
      });
      return row!;
    }

    it('429 then 500 then 202 → retried, then sent with the SendGrid message id', async () => {
      const user = await createUser(client);
      sendgrid.plan(user.email, { status: 429 }, { status: 500 });
      const row = await settled(await notify(user.id));
      expect(row).toMatchObject({ status: 'sent', attempts: 3, error_code: null });
      expect(row.provider_message_id).toMatch(/^sg-fake-\d+$/);
      expect(sendgrid.to(user.email)).toHaveLength(3);
      expect(sendgrid.to(user.email)[0].body.subject).toMatch(/^Emergency alert: /);
    });

    it('400 → failed at once (permanent), no retry', async () => {
      const user = await createUser(client);
      sendgrid.plan(user.email, {
        status: 400,
        body: { errors: [{ field: 'personalizations.0.to.0.email', message: 'Invalid' }] },
      });
      const row = await settled(await notify(user.id));
      expect(row).toMatchObject({ status: 'failed', attempts: 1, error_code: 'invalid_recipient' });
      await sleep(300);
      expect(sendgrid.to(user.email)).toHaveLength(1);
    });

    it('no key and no address in the worker log', () => {
      const all = JSON.stringify(workerLogs.lines);
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toMatch(/user-[0-9a-f-]{36}@example\.test/);
    });
  });
});
