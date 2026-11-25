import { sanitizeAuditDetail } from '../audit';
import {
  type DeliveryFinalRow,
  deliveryFailedNoticeAudit,
  deliveryOutcomeAudit,
  finalOutcomeOf,
} from './delivery-audit';

const INCIDENT = '11111111-1111-4111-8111-111111111111';
const DELIVERY = '22222222-2222-4222-8222-222222222222';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const RESIDENT = '44444444-4444-4444-8444-444444444444';

function row(overrides: Partial<DeliveryFinalRow> = {}): DeliveryFinalRow {
  return {
    delivery_id: DELIVERY,
    recipient_user_id: MEMBER,
    channel: 'push',
    status: 'failed',
    error_code: 'fake_unavailable',
    attempts: 4,
    incident_id: INCIDENT,
    topic: 'incident.created',
    ...overrides,
  };
}

describe('deliveryOutcomeAudit (SCRUM-74, D75)', () => {
  it.each([
    ['sent', null, 1],
    ['delivered', null, 1],
    ['failed', 'fake_unavailable', 4],
    ['failed', 'unregistered', 1],
    ['skipped', 'no_device', 0],
  ] as const)(
    'a final %s row of the alert -> incident.delivery_outcome',
    (status, code, attempts) => {
      expect(deliveryOutcomeAudit(row({ status, error_code: code, attempts }))).toEqual({
        action: 'incident.delivery_outcome',
        actor_user_id: null,
        target_type: 'incident',
        target_id: INCIDENT,
        detail: {
          delivery_id: DELIVERY,
          recipient_user_id: MEMBER,
          channel: 'push',
          status,
          attempts,
          error_code: code,
        },
      });
    },
  );

  it('a re-notify row is audited too', () => {
    expect(deliveryOutcomeAudit(row({ topic: 'incident.renotified' }))?.action).toBe(
      'incident.delivery_outcome',
    );
  });

  it.each([
    'incident.resolved',
    'incident.status_update',
    'incident.delivery_failed',
    'circle.test_alert',
  ])('a row of the %s notice is not audited', (topic) => {
    expect(deliveryOutcomeAudit(row({ topic }))).toBeUndefined();
  });

  it('a test alert row (no incident, SCRUM-35) is not audited', () => {
    expect(deliveryOutcomeAudit(row({ incident_id: null }))).toBeUndefined();
  });

  it('the detail is stored unchanged (nothing for the sanitizer to strip)', () => {
    const entry = deliveryOutcomeAudit(row())!;
    expect(sanitizeAuditDetail(entry.detail)).toEqual({ detail: entry.detail, stripped: [] });
    expect(Object.keys(entry.detail!).sort()).toEqual(
      ['attempts', 'channel', 'delivery_id', 'error_code', 'recipient_user_id', 'status'].sort(),
    );
  });

  it('finalOutcomeOf keeps the outcome keys only (the SCRUM-67 shape)', () => {
    expect(finalOutcomeOf(row())).toEqual({
      delivery_id: DELIVERY,
      recipient_user_id: MEMBER,
      channel: 'push',
      status: 'failed',
      error_code: 'fake_unavailable',
      attempts: 4,
    });
  });
});

describe('deliveryFailedNoticeAudit (SCRUM-74, D75)', () => {
  it.each(['no_device', 'failed'])(
    'reason %s -> incident.delivery_failed_notice, ids only',
    (reason) => {
      const entry = deliveryFailedNoticeAudit({
        incident_id: INCIDENT,
        resident_id: RESIDENT,
        member_user_id: MEMBER,
        reason,
      });
      expect(entry).toEqual({
        action: 'incident.delivery_failed_notice',
        actor_user_id: null,
        target_type: 'incident',
        target_id: INCIDENT,
        detail: { resident_id: RESIDENT, member_user_id: MEMBER, reason },
      });
      expect(sanitizeAuditDetail(entry.detail)).toEqual({ detail: entry.detail, stripped: [] });
    },
  );
});
