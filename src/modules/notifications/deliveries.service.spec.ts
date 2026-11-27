import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import { JobFailedError, jobErrorCode, PermanentJobFailure } from '../../jobs/job-workers';
import type { ChannelSenders } from './channels/channel-senders';
import type { SendResult } from './channels/channel.types';
import type { DeliveriesRepository, DeliveryToSend } from './deliveries.repository';
import type { AlertDeliveryOutcomes } from './alert-delivery-outcomes';
import { DeliverySender } from './deliveries.service';
import type { ReceiptTokens } from './receipt-token';

const ID = '33333333-3333-4333-8333-333333333333';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'fake-unit-token-SHOULD-NOT-LEAK';
const MEMBER = '55555555-5555-4555-8555-555555555555';

/** What the status writes answer: the row as it became final. */
function outcome(status: string, error_code: string | null, attempts: number) {
  return {
    delivery_id: ID,
    recipient_user_id: MEMBER,
    channel: 'push',
    status,
    error_code,
    attempts,
  };
}

function delivery(overrides: Partial<DeliveryToSend> = {}): DeliveryToSend {
  return {
    id: ID,
    status: 'queued',
    channel: 'push',
    incident_id: 'i-1',
    recipient_user_id: MEMBER,
    device_id: DEVICE,
    topic: 'incident.created',
    payload: { incident_id: 'i-1', emergency_type: 'fire', resident_name: 'R', occurred_at: 't' },
    push_provider: 'fcm',
    push_token: TOKEN,
    place_name: null,
    delivered_at: null,
    phone: '12015550123',
    email: 'member@example.test',
    time_zone: 'Africa/Banjul',
    ...overrides,
  };
}

function setup(row: DeliveryToSend | undefined, answer: SendResult | Error, enabled = true) {
  const repository = {
    loadForSend: jest.fn().mockResolvedValue(row),
    markSent: jest.fn((_id: string, status: string) => Promise.resolve(outcome(status, null, 1))),
    markSkipped: jest.fn((_id: string, reason: string) =>
      Promise.resolve(outcome('skipped', reason, 0)),
    ),
    recordFailure: jest.fn((_id: string, code: string, final: boolean) =>
      Promise.resolve(final ? outcome('failed', code, 4) : undefined),
    ),
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
  /** The logger's info lines as `[fields, message]`. */
  const infoLines = () => logger.info.mock.calls as [Record<string, unknown>, string][];
  const alerts = { afterMemberOutcome: jest.fn().mockResolvedValue(undefined) };
  const sender = new DeliverySender(
    repository as unknown as DeliveriesRepository,
    channels as unknown as ChannelSenders,
    logger as unknown as Logger,
    alerts as unknown as AlertDeliveryOutcomes,
    { sign: (id: string) => `rt-${id}` } as unknown as ReceiptTokens,
  );
  const job = (attemptsMade = 0, attempts = 4) =>
    ({ data: { delivery_id: ID }, attemptsMade, opts: { attempts } }) as unknown as Job;
  /** The SCRUM-67 outcome lines. */
  const outcomeLines = () => infoLines().filter((call) => call[1] === 'delivery outcome');
  return { sender, repository, send, job, logger, infoLines, outcomeLines, alerts };
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

  it('push: the recipient time zone goes with the target (D54)', async () => {
    const { sender, send, job } = setup(delivery({ time_zone: 'America/Chicago' }), SENT);
    await sender.process(job());
    // Stage 2 [B7]: the push carries the signed receipt token of its delivery row.
    expect(send).toHaveBeenCalledWith(
      { provider: 'fcm', token: TOKEN, time_zone: 'America/Chicago', receipt_token: `rt-${ID}` },
      expect.objectContaining({ incident_id: 'i-1' }),
    );
  });

  it('Stage 2 [B7]: a row the phone already confirmed is written delivered without sending again', async () => {
    const { sender, send, repository, job } = setup(
      delivery({ delivered_at: '2026-11-26T10:00:00+00:00' }),
      SENT,
    );
    await sender.process(job());
    expect(send).not.toHaveBeenCalled();
    expect(repository.markSent).toHaveBeenCalledWith(ID, 'delivered', null);
  });

  it('Stage 2 [B7]: a failed answer after the phone confirmed receipt is delivered: no retry', async () => {
    const { sender, repository, job } = setup(delivery(), {
      provider_message_id: null,
      status: 'failed',
      error_code: 'timeout',
    });
    repository.recordFailure.mockResolvedValue(outcome('delivered', null, 1));
    await expect(sender.process(job())).resolves.toBeUndefined();
  });

  it('sms text carries the time in the recipient time zone (D54)', async () => {
    const at = '2026-11-20T22:48:00.000000+00:00';
    const { sender, send, job } = setup(
      delivery({
        channel: 'sms',
        device_id: null,
        time_zone: 'Asia/Tokyo',
        payload: {
          incident_id: 'i-1',
          emergency_type: 'fire',
          resident_name: 'R',
          occurred_at: at,
        },
      }),
      SENT,
    );
    await sender.process(job());
    // Stage 2 [B6]: no place known at send time.
    expect(send).toHaveBeenCalledWith(
      '+12015550123',
      'R: Emergency alert: Fire · Location unavailable · 7:48 AM',
    );
  });

  it('SCRUM-47 latency line: occurred_at to provider acceptance in ms, ids only (no personal data)', async () => {
    const occurredAt = new Date(Date.now() - 1500).toISOString();
    const { sender, job, logger, infoLines } = setup(
      delivery({
        payload: {
          incident_id: 'i-1',
          emergency_type: 'medical',
          resident_name: 'Rita Resident',
          occurred_at: occurredAt,
        },
      }),
      SENT,
    );
    await sender.process(job());
    const lines = infoLines().filter((call) => call[1] === 'delivery accepted by the provider');
    expect(lines).toHaveLength(1);
    const fields = lines[0][0];
    expect(Object.keys(fields).sort()).toEqual([
      'channel',
      'delivery_id',
      'incident_id',
      'latency_ms',
      'provider',
      'topic',
    ]);
    expect(fields).toMatchObject({
      delivery_id: ID,
      incident_id: 'i-1',
      topic: 'incident.created',
      channel: 'push',
      provider: 'fcm',
    });
    expect(fields.latency_ms).toBeGreaterThanOrEqual(1500);
    expect(fields.latency_ms).toBeLessThan(60_000);
    const text = JSON.stringify(logger.info.mock.calls);
    for (const secret of [TOKEN, 'Rita Resident', '12015550123', 'member@example.test']) {
      expect(text).not.toContain(secret);
    }
  });

  it('no latency line for a failed or skipped delivery; an unparseable time logs latency null', async () => {
    const failing = setup(delivery(), failedWith('timeout'));
    await failing.sender.process(failing.job(0)).catch(() => undefined);
    const skipped = setup(delivery({ push_token: null }), SENT);
    await skipped.sender.process(skipped.job());
    for (const { infoLines } of [failing, skipped]) {
      expect(infoLines().some((c) => c[1] === 'delivery accepted by the provider')).toBe(false);
    }
    const odd = setup(delivery(), SENT);
    await odd.sender.process(odd.job());
    expect(odd.infoLines()[0][0]).toMatchObject({ latency_ms: null });
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

  describe('SCRUM-67 (D73): one outcome line per final outcome', () => {
    const KEYS = [
      'delivery_id',
      'topic',
      'channel',
      'status',
      'error_code',
      'attempts',
      'incident_id',
    ];

    it('sent: exactly the seven keys, ids and codes only', async () => {
      const { sender, job, outcomeLines, logger } = setup(
        delivery({ payload: { incident_id: 'i-1', resident_name: 'Rita Resident' } }),
        SENT,
      );
      await sender.process(job());
      expect(outcomeLines()).toHaveLength(1);
      expect(Object.keys(outcomeLines()[0][0])).toEqual(KEYS);
      expect(outcomeLines()[0][0]).toEqual({
        delivery_id: ID,
        topic: 'incident.created',
        channel: 'push',
        status: 'sent',
        error_code: null,
        attempts: 1,
        incident_id: 'i-1',
      });
      const text = JSON.stringify(logger.info.mock.calls);
      for (const secret of [TOKEN, 'Rita Resident', '12015550123', 'member@example.test']) {
        expect(text).not.toContain(secret);
      }
    });

    it('failed after the retries, skipped, and a permanent failure each log one line', async () => {
      const last = setup(delivery(), failedWith('timeout'));
      await last.sender.process(last.job(3, 4)).catch(() => undefined);
      expect(last.outcomeLines().map((c) => c[0])).toEqual([
        expect.objectContaining({ status: 'failed', error_code: 'timeout', attempts: 4 }),
      ]);
      const skipped = setup(delivery({ push_token: null }), SENT);
      await skipped.sender.process(skipped.job());
      expect(skipped.outcomeLines().map((c) => c[0])).toEqual([
        expect.objectContaining({ status: 'skipped', error_code: 'no_device', attempts: 0 }),
      ]);
      const permanent = setup(delivery(), failedWith('unregistered'));
      await permanent.sender.process(permanent.job(0)).catch(() => undefined);
      expect(permanent.outcomeLines()).toHaveLength(1);
      for (const { outcomeLines } of [last, skipped, permanent]) {
        expect(Object.keys(outcomeLines()[0][0])).toEqual(KEYS);
      }
    });

    it('no line for an attempt that will be retried, nor for a row another job finished', async () => {
      const retry = setup(delivery(), failedWith('provider_unavailable'));
      await retry.sender.process(retry.job(0)).catch(() => undefined);
      expect(retry.outcomeLines()).toEqual([]);
      const raced = setup(delivery(), SENT);
      raced.repository.markSent.mockResolvedValue(undefined as never);
      await raced.sender.process(raced.job());
      expect(raced.outcomeLines()).toEqual([]);
      const repeat = setup(delivery({ status: 'failed' }), SENT);
      await repeat.sender.process(repeat.job());
      expect(repeat.outcomeLines()).toEqual([]);
    });
  });

  describe('SCRUM-65 / 71 (D73): an alert row that became final re-checks its member', () => {
    it.each(['incident.created', 'incident.renotified'])(
      '%s: sent, skipped, failed',
      async (topic) => {
        for (const [row, answer, attempt] of [
          [delivery({ topic }), SENT, 0],
          [delivery({ topic, push_token: null }), SENT, 0],
          [delivery({ topic }), failedWith('timeout'), 3],
        ] as const) {
          const { sender, job, alerts } = setup(row, answer);
          await sender.process(job(attempt, 4)).catch(() => undefined);
          expect(alerts.afterMemberOutcome).toHaveBeenCalledTimes(1);
          expect(alerts.afterMemberOutcome).toHaveBeenCalledWith('i-1', [MEMBER]);
        }
      },
    );

    it('not while a retry is still to come', async () => {
      const { sender, job, alerts } = setup(delivery(), failedWith('provider_unavailable'));
      await sender.process(job(0)).catch(() => undefined);
      expect(alerts.afterMemberOutcome).not.toHaveBeenCalled();
    });

    it.each(['incident.status_update', 'incident.resolved', 'incident.delivery_failed'])(
      'never for %s rows (not the alert)',
      async (topic) => {
        const { sender, job, alerts } = setup(
          delivery({
            topic,
            payload: { incident_id: 'i-1', preset: 'help_is_here', member_name: 'M' },
          }),
          SENT,
        );
        await sender.process(job());
        expect(alerts.afterMemberOutcome).not.toHaveBeenCalled();
      },
    );

    it('never for a test alert row (no incident)', async () => {
      const { sender, job, alerts } = setup(
        delivery({
          incident_id: null,
          topic: 'circle.test_alert',
          payload: { test_alert_id: 't' },
        }),
        SENT,
      );
      await sender.process(job());
      expect(alerts.afterMemberOutcome).not.toHaveBeenCalled();
    });

    it('a repeat of a final alert row re-runs the check (idempotent); a check error is retried', async () => {
      const repeat = setup(delivery({ status: 'failed' }), SENT);
      await repeat.sender.process(repeat.job());
      expect(repeat.alerts.afterMemberOutcome).toHaveBeenCalledWith('i-1', [MEMBER]);
      const broken = setup(delivery(), SENT);
      broken.alerts.afterMemberOutcome.mockRejectedValue(
        Object.assign(new Error('x'), { code: '40001' }),
      );
      const error = await broken.sender.process(broken.job()).catch((e: unknown) => e);
      expect(jobErrorCode(error)).toBe('sqlstate_40001');
    });
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
