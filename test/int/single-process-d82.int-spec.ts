import { randomUUID } from 'node:crypto';

import type { Worker } from 'bullmq';
import type { Client } from 'pg';

import type * as BootstrapModule from '../../src/bootstrap';
import type { HttpAndWorkers } from '../../src/bootstrap';
import { parseConfig } from '../../src/config/config.schema';
import type * as JobWorkersModule from '../../src/jobs/job-workers';
import type * as ChannelSendersModule from '../../src/modules/notifications/channels/channel-senders';
import type { FakePushSender } from '../../src/modules/notifications/channels/fake-senders';
import { processMode } from '../../src/process-mode';
import { openTestClient } from '../support/database';
import { fakePushToken, registerDevice } from '../support/device-api';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import { submitAlert } from '../support/incident-api';

/**
 * Single-process mode (D82): with RUN_WORKERS=true the HTTP API and the job workers run in ONE
 * process (`startHttpAndWorkers`, what main.ts starts). An SOS submitted over HTTP is relayed,
 * fanned out and delivered (fake push) by the workers of the same process, with no separate
 * `WORKER=1` process. Then one close stops both.
 *
 * ApiConfigModule reads the environment once, when imported, so the bootstrap (and the classes the
 * test looks up in it) are loaded fresh after the settings are in the environment.
 */
const SETTINGS: Record<string, string> = {
  RUN_WORKERS: 'true',
  CHANNEL_PUSH_ENABLED: 'true',
  LOG_LEVEL: 'warn',
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(50);
  }
}

interface Loaded {
  bootstrap: typeof BootstrapModule;
  jobWorkers: typeof JobWorkersModule;
  channelSenders: typeof ChannelSendersModule;
}

function loadFresh(): Loaded {
  let loaded: Loaded | undefined;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    loaded = {
      bootstrap: require('../../src/bootstrap') as typeof BootstrapModule,
      jobWorkers: require('../../src/jobs/job-workers') as typeof JobWorkersModule,
      channelSenders:
        require('../../src/modules/notifications/channels/channel-senders') as typeof ChannelSendersModule,
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  if (!loaded) throw new Error('modules did not load');
  return loaded;
}

describe('single-process mode: HTTP + job workers in one process (D82)', () => {
  const saved = new Map<string, string | undefined>();
  let loaded: Loaded;
  let running: HttpAndWorkers | undefined;
  let client: Client | undefined;
  let resident: UserFixture;
  let member: UserFixture;
  const token = fakePushToken('single-process');

  const started = (): HttpAndWorkers => {
    if (!running) throw new Error('not started');
    return running;
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(SETTINGS)) {
      saved.set(key, process.env[key]);
      process.env[key] = value;
    }
    const config = parseConfig(process.env);
    expect(processMode(config)).toBe('http+workers');
    loaded = loadFresh();
    running = await loaded.bootstrap.startHttpAndWorkers(config, { listen: false, signals: false });

    client = await openTestClient();
    resident = await createUser(client);
    const circle = await createCircle(client, resident);
    member = await createUser(client);
    await addActiveMember(client, circle, member);
    const reply = await registerDevice(running.http, member.id, randomUUID(), {
      platform: 'android',
      app_version: '1.0.0',
      push_provider: 'fcm',
      push_token: token,
    });
    expect(reply.statusCode).toBe(200);
  });

  afterAll(async () => {
    await client?.end();
    await running?.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('an SOS submitted over HTTP is delivered by the workers of the same process', async () => {
    const { http, worker } = started();
    const reply = await submitAlert(http, resident.id, 'medical');
    expect(reply.statusCode).toBe(201);
    const incidentId = reply.json<{ id: string }>().id;

    let delivery: { status: string; provider_message_id: string | null } | undefined;
    await waitFor(async () => {
      const { rows } = await client!.query<{ status: string; provider_message_id: string | null }>(
        `select d.status, d.provider_message_id
           from public.notification_deliveries d
           join public.notification_outbox o on o.id = d.outbox_id
          where o.aggregate_id = $1 and o.topic = 'incident.created'
            and d.recipient_user_id = $2`,
        [incidentId, member.id],
      );
      delivery = rows[0];
      return delivery?.status === 'sent';
    }, 10_000);

    // The fake push adapter of THIS process's worker context made the send.
    const push = worker.get(loaded.channelSenders.ChannelSenders).push as FakePushSender;
    const sent = push.sent.find((s) => s.provider_message_id === delivery?.provider_message_id);
    expect(sent?.to).toMatchObject({ provider: 'fcm', token });
    expect(sent?.content).toMatchObject({ incident_id: incidentId, topic: 'incident.created' });
  });

  it('one close stops the HTTP API and the job workers', async () => {
    const { http, worker, close } = started();
    const jobWorkers = worker.get(loaded.jobWorkers.JobWorkers);
    const bullWorkers = (jobWorkers as unknown as { workers: Worker[] }).workers;
    // The outbox, delivery and close-sweep queues each have a running BullMQ worker.
    expect(bullWorkers.length).toBeGreaterThanOrEqual(3);
    expect(bullWorkers.every((w) => w.isRunning())).toBe(true);
    expect((await http.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

    await close();

    expect(bullWorkers.every((w) => !w.isRunning())).toBe(true);
    // Closing again (afterAll, a second signal) returns the same close.
    await expect(close()).resolves.toBeUndefined();
  });
});
