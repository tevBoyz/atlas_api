import { type RecipientDeliveryCounts, recipientState } from './test-alert-status';

const NONE: RecipientDeliveryCounts = {
  seen_at: null,
  rows: 0,
  accepted: 0,
  queued: 0,
  provider_error: false,
  invalid_token: false,
  no_device: false,
  channel_disabled: false,
  not_eligible: false,
};

describe('SCRUM-35 (D68): a recipient state from its delivery rows and receipt', () => {
  it('no delivery row yet → pending', () => {
    expect(recipientState(NONE)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('a row still queued (sending or retrying) → pending, even after a failed device', () => {
    expect(recipientState({ ...NONE, rows: 2, queued: 1, invalid_token: true })).toEqual({
      status: 'pending',
      failure_reason: null,
    });
  });

  it('the provider accepted one device → delivered (another device may have failed)', () => {
    expect(recipientState({ ...NONE, rows: 2, accepted: 1, provider_error: true })).toEqual({
      status: 'delivered',
      failure_reason: null,
    });
  });

  it('opened in Atlas → seen, whatever the push did', () => {
    const seen = { ...NONE, seen_at: '2026-11-24T10:00:00+00:00' };
    expect(recipientState(seen).status).toBe('seen');
    expect(recipientState({ ...seen, rows: 1, provider_error: true }).status).toBe('seen');
    expect(recipientState({ ...seen, rows: 1, accepted: 1 }).status).toBe('seen');
  });

  it.each([
    [{ provider_error: true, invalid_token: true, no_device: true }, 'provider_error'],
    [{ invalid_token: true, no_device: true }, 'invalid_token'],
    [{ no_device: true }, 'no_device'],
    [{ channel_disabled: true }, 'channel_disabled'],
    [{ not_eligible: true }, 'not_eligible'],
    [{}, 'provider_error'],
  ])(
    'every row ended without acceptance → failed with the first reason (%j → %s)',
    (flags, reason) => {
      expect(recipientState({ ...NONE, rows: 1, ...flags })).toEqual({
        status: 'failed',
        failure_reason: reason,
      });
    },
  );
});
