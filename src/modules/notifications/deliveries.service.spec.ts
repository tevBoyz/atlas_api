import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import { JobFailedError, jobErrorCode, PermanentJobFailure } from '../../jobs/job-workers';
import type { ChannelSenders } from './channels/channel-senders';
import type { SendResult } from './channels/channel.types';
import type { DeliveriesRepository, DeliveryToSend } from './deliveries.repository';
import { DeliverySender } from './deliveries.service';

const ID = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'fake-unit-token-SHOULD-NOT-LEAK';

function delivery(overrides: Partial<DeliveryToSend> = {}): DeliveryToSend {
  return {
    id: ID,
    status: 'queued',
    channel: 'push',
    device_id: DEVICE,
    topic: 'incident.created',
    payload: { incident_id: 'i-1', emergency_type: 'fire', resident_name: 'R', occurred_at: 't' },
    push_provider: 'fcm',
    push_token: TOKEN,
    phone: '12015550123',
    email: 'member@example.test',
    ...overrides,
  };
}

function setup(row: DeliveryToSend | undefined, answer: SendResult | Error, enabled = true) {
  const repository = {
    loadForSend: jest.fn().mockResolvedValue(row),
    markSent: jest.fn().mockResolvedValue(undefined),
    markSkipped: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    clearPushToken: jest.fn().mockResolvedValue(undefined),
  };
  const send = jest.fn(() =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
  );
  const channels = {
    isEnabled: jest.fn(() => enabled),
    push: { send },
    sms: { send },
    email: { send },
  };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const sender = new DeliverySender(
    repository as unknown as DeliveriesRepository,
    channels as unknown as ChannelSenders,
    logger as unknown as Logger,
  );
  const job = (attemptsMade = 0, attempts = 4) =>
    ({ data: { delivery_id: ID }, attemptsMade, opts: { attempts } }) as unknown as Job;
  return { sender, repository, send, job, logger };
}

const SENT: SendResult = { provider_message_id: 'fake-1', status: 'sent' };
const failedWith = (error_code: SendResult['error_code']): SendResult => ({
  provider_message_id: null,
  status: 'failed',
  error_code,
});

describe('DeliverySender (API-100-47)', () => {
  it('a row that is no longer queued is left alone (idempotent repeat)', async () => {
    const { sender, send, repository } = setup(delivery({ status: 'sent' }), SENT);
    await sender.process(setup(undefined, SENT).job());
    await sender.process(setup(undefined, SENT).job());
    expect(send).not.toHaveBeenCalled();
    expect(repository.markSent).not.toHaveBeenCalled();
  });

  it('a channel disabled at send time: skipped channel_disabled, no adapter call', async () => {
    const { sender, send, repository, job } = setup(delivery(), SENT, false);
    await sender.process(job());
    expect(repository.markSkipped).toHaveBeenCalledWith(ID, 'channel_disabled');
    expect(send).not.toHaveBeenCalled();
  });

  it('push without a token now: skipped no_device; sms without a phone: no_address', async () => {
    const push = setup(delivery({ push_token: null }), SENT);
    await push.sender.process(push.job());
    expect(push.repository.markSkipped).toHaveBeenCalledWith(ID, 'no_device');
    const sms = setup(delivery({ channel: 'sms', device_id: null, phone: null }), SENT);
    await sms.sender.process(sms.job());
    expect(sms.repository.markSkipped).toHaveBeenCalledWith(ID, 'no_address');
  });

  it('sent and delivered are stored with the provider id', async () => {
    const { sender, repository, job } = setup(delivery(), SENT);
    await sender.process(job());
    expect(repository.markSent).toHaveBeenCalledWith(ID, 'sent', 'fake-1');
    const receipt = setup(delivery(), { provider_message_id: 'p', status: 'delivered' });
    await receipt.sender.process(receipt.job());
    expect(receipt.repository.markSent).toHaveBeenCalledWith(ID, 'delivered', 'p');
  });

  it('sms goes to the E.164 form of the account phone', async () => {
    const { sender, send, job } = setup(delivery({ channel: 'sms', device_id: null }), SENT);
    await sender.process(job());
    expect(send).toHaveBeenCalledWith('+12015550123', expect.any(String));
  });

  it('a transient failure before the last attempt stays queued and is retried', async () => {
    const { sender, repository, job } = setup(delivery(), failedWith('provider_unavailable'));
    await expect(sender.process(job(0))).rejects.toBeInstanceOf(JobFailedError);
    expect(repository.recordFailure).toHaveBeenCalledWith(ID, 'provider_unavailable', false);
  });

  it('the last attempt writes failed', async () => {
    const { sender, repository, job } = setup(delivery(), failedWith('timeout'));
    await expect(sender.process(job(3, 4))).rejects.toBeInstanceOf(JobFailedError);
    expect(repository.recordFailure).toHaveBeenCalledWith(ID, 'timeout', true);
  });

  it('unregistered clears the token and fails at once without retries', async () => {
    const { sender, repository, job, logger } = setup(delivery(), failedWith('unregistered'));
    const error = await sender.process(job(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PermanentJobFailure);
    expect(jobErrorCode(error)).toBe('unregistered');
    expect(repository.clearPushToken).toHaveBeenCalledWith(DEVICE, TOKEN);
    expect(repository.recordFailure).toHaveBeenCalledWith(ID, 'unregistered', true);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);
  });

  it('an adapter that throws counts as transport_error (its message is dropped)', async () => {
    const { sender, repository, job } = setup(delivery(), new Error(`boom ${TOKEN}`));
    const error = await sender.process(job(0)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailedError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect(repository.recordFailure).toHaveBeenCalledWith(ID, 'transport_error', false);
  });

  it('a payload without an incident id fails permanently (invalid_request)', async () => {
    const { sender, repository, job } = setup(delivery({ payload: {} }), SENT);
    await expect(sender.process(job())).rejects.toBeInstanceOf(PermanentJobFailure);
    expect(repository.recordFailure).toHaveBeenCalledWith(ID, 'invalid_request', true);
  });

  it('a database error becomes a code-only job error', async () => {
    const { sender, repository, job } = setup(delivery(), SENT);
    repository.markSent.mockRejectedValue(
      Object.assign(new Error(`Failed query params: ${TOKEN}`), { code: '57P01' }),
    );
    const error = await sender.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailedError);
    expect(jobErrorCode(error)).toBe('sqlstate_57P01');
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
