import { Backoffs, type JobsOptions, type MinimalJob } from 'bullmq';
import type { Logger } from 'pino';

import type { ApiConfigService } from '../../config';
import { NOTIFICATION_RETRY_WINDOW_MS, parseConfig } from '../../config/config.schema';
import type { JobQueues } from '../../jobs/job-queues.service';
import type { OutboxRow } from '../../jobs/outbox';
import type { ChannelSenders } from './channels/channel-senders';
import type { DeliveriesRepository } from './deliveries.repository';
import { DeliveryPlanner } from './deliveries.service';

/**
 * SCRUM-66 (Retry Failed Alerts), verified for D73: "failed deliveries retry with exponential backoff
 * (up to 3 retries within 60 seconds) before marking Failed". With the defaults
 * (NOTIFICATIONS_RETRY_ATTEMPTS = 3, NOTIFICATIONS_RETRY_BASE_DELAY_MS = 2000) each delivery job gets
 * 4 attempts (the first + 3 retries) with BullMQ's exponential backoff: 2 s, 4 s, 8 s. The last
 * attempt writes `failed` with the last error code (deliveries.service.spec.ts "the last attempt
 * writes failed"). Even when every attempt runs into the send timeout (NOTIFICATIONS_SEND_TIMEOUT_MS,
 * 10 s), the last attempt ends inside 60 s.
 */
describe('SCRUM-66: the delivery retry policy (defaults)', () => {
  const config = parseConfig({});

  async function jobOptions(): Promise<JobsOptions> {
    const add = jest.fn().mockResolvedValue(undefined);
    const planner = new DeliveryPlanner(
      {
        fanOut: jest.fn().mockResolvedValue([]),
        queuedIds: jest.fn().mockResolvedValue([{ id: 'd-1', channel: 'push' }]),
      } as unknown as DeliveriesRepository,
      { add } as unknown as JobQueues,
      { isEnabled: () => true } as unknown as ChannelSenders,
      { get: (key: keyof typeof config) => config[key] } as unknown as ApiConfigService,
      { info: jest.fn() } as unknown as Logger,
    );
    await planner.fanOut(
      { id: 'o-1', topic: 'incident.created' } as OutboxRow,
      'i-1',
      [{ user_id: 'u-1', eligible: true }],
      ['push'],
    );
    return (add.mock.calls[0] as unknown[])[3] as JobsOptions;
  }

  it('defaults: 3 retries, base delay 2 s, send timeout 10 s', () => {
    expect(config.NOTIFICATIONS_RETRY_ATTEMPTS).toBe(3);
    expect(config.NOTIFICATIONS_RETRY_BASE_DELAY_MS).toBe(2000);
    expect(config.NOTIFICATIONS_SEND_TIMEOUT_MS).toBe(10_000);
  });

  it('each delivery job: 4 attempts (1 + 3 retries), exponential backoff from 2 s', async () => {
    const options = await jobOptions();
    expect(options.attempts).toBe(4);
    expect(options.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('BullMQ waits 2 s, 4 s, 8 s before the retries; worst case (every send times out) < 60 s', async () => {
    const options = await jobOptions();
    const backoff = options.backoff as { type: string; delay: number };
    const delays: number[] = [];
    for (let made = 1; made < (options.attempts ?? 1); made++) {
      delays.push(
        (await Backoffs.calculate(backoff, made, new Error('x'), {} as MinimalJob)) as number,
      );
    }
    expect(delays).toEqual([2000, 4000, 8000]);
    const waits = delays.reduce((a, b) => a + b, 0);
    expect(waits).toBe(14_000);
    const worstCase = waits + (options.attempts ?? 1) * config.NOTIFICATIONS_SEND_TIMEOUT_MS;
    expect(worstCase).toBe(54_000);
    expect(worstCase).toBeLessThan(NOTIFICATION_RETRY_WINDOW_MS);
  });
});
