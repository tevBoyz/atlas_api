/**
 * SCRUM-35 (D68): the delivery state of one recipient of a test alert, from its push delivery rows
 * (`notification_deliveries` with `test_alert_id`) and its receipt (`seen_at`).
 */

export const TEST_ALERT_MEMBER_STATES = ['pending', 'delivered', 'seen', 'failed'] as const;
export type TestAlertMemberState = (typeof TEST_ALERT_MEMBER_STATES)[number];

/**
 * Why a test did not reach a member (D68):
 * - `no_device`: no Atlas installation with notifications registered (no push token);
 * - `invalid_token`: the push provider says the token is no longer valid (the app was removed or
 *   its token changed);
 * - `provider_error`: the push provider did not accept it after the retries;
 * - `channel_disabled`: push is switched off on the server;
 * - `not_eligible`: no longer an active member when the notices were sent.
 */
export const TEST_ALERT_FAILURE_REASONS = [
  'no_device',
  'invalid_token',
  'provider_error',
  'channel_disabled',
  'not_eligible',
] as const;
export type TestAlertFailureReason = (typeof TEST_ALERT_FAILURE_REASONS)[number];

/** The push delivery rows of one recipient, as counted by the status read. */
export interface RecipientDeliveryCounts {
  seen_at: string | null;
  /** Delivery rows of this recipient (0 = the worker has not fanned out yet). */
  rows: number;
  /** Rows the provider accepted (`sent` / `delivered`). */
  accepted: number;
  /** Rows still `queued` (first attempt or a retry still to come). */
  queued: number;
  provider_error: boolean;
  invalid_token: boolean;
  no_device: boolean;
  channel_disabled: boolean;
  not_eligible: boolean;
}

export interface RecipientState {
  status: TestAlertMemberState;
  failure_reason: TestAlertFailureReason | null;
}

/**
 * - `seen`: the member opened the test in Atlas (whatever the push did);
 * - `delivered`: the push provider accepted it for at least one of the member's devices;
 * - `pending`: no delivery row yet, or a row is still queued (being sent or retried);
 * - `failed`: every row ended without acceptance; the reason is the first present of
 *   provider_error, invalid_token, no_device, channel_disabled, not_eligible.
 */
export function recipientState(counts: RecipientDeliveryCounts): RecipientState {
  if (counts.seen_at !== null) return { status: 'seen', failure_reason: null };
  if (counts.accepted > 0) return { status: 'delivered', failure_reason: null };
  if (counts.rows === 0 || counts.queued > 0) return { status: 'pending', failure_reason: null };
  const reason: TestAlertFailureReason = counts.provider_error
    ? 'provider_error'
    : counts.invalid_token
      ? 'invalid_token'
      : counts.no_device
        ? 'no_device'
        : counts.channel_disabled
          ? 'channel_disabled'
          : counts.not_eligible
            ? 'not_eligible'
            : 'provider_error';
  return { status: 'failed', failure_reason: reason };
}
