import {
  capacityFromCounts,
  CIRCLE_MEMBER_LIMIT,
  holdsSlot,
  inviteLookupStatus,
  type SlotRow,
  shownMemberStatus,
} from './invite-slots';

/**
 * The TypeScript forms of the slot rules (API-100-24 AC3). Their SQL twins are compared against the
 * baseline helpers `_circle_invite_holds_slot` / `_circle_invite_lookup_status` on a real database in
 * test/int/circles-capacity.int-spec.ts.
 */
const NOW = '2026-11-19 10:00:00.500000+00';

const pending = (overrides: Partial<SlotRow> = {}): SlotRow => ({
  role: 'member',
  status: 'pending',
  invitedAt: '2026-11-18 10:00:00+00',
  inviteExpiresAt: '2026-11-25 10:00:00+00',
  inviteCanceledAt: null,
  inviteConsumedAt: null,
  ...overrides,
});

describe('holdsSlot (spec "valid pending", _circle_invite_holds_slot)', () => {
  it('active members hold a slot; the owner row never does', () => {
    expect(holdsSlot(pending({ status: 'active' }), NOW)).toBe(true);
    expect(holdsSlot(pending({ role: 'owner', status: 'active' }), NOW)).toBe(false);
  });

  it('a pending invite holds a slot until it expires, compared in microseconds', () => {
    expect(holdsSlot(pending(), NOW)).toBe(true);
    expect(holdsSlot(pending({ inviteExpiresAt: '2026-11-19 10:00:00.500001+00' }), NOW)).toBe(
      true,
    );
    // expiry == now: no longer valid (`> now()`).
    expect(holdsSlot(pending({ inviteExpiresAt: NOW }), NOW)).toBe(false);
    expect(holdsSlot(pending({ inviteExpiresAt: '2026-11-19 10:00:00.499999+00' }), NOW)).toBe(
      false,
    );
  });

  it('without invite_expires_at, invited_at + 7 days decides', () => {
    expect(
      holdsSlot(
        pending({ inviteExpiresAt: null, invitedAt: '2026-11-12 10:00:00.500001+00' }),
        NOW,
      ),
    ).toBe(true);
    expect(
      holdsSlot(pending({ inviteExpiresAt: null, invitedAt: '2026-11-12 10:00:00.5+00' }), NOW),
    ).toBe(false);
  });

  it('canceled, consumed and declined rows hold no slot', () => {
    expect(holdsSlot(pending({ inviteCanceledAt: NOW }), NOW)).toBe(false);
    expect(holdsSlot(pending({ inviteConsumedAt: NOW }), NOW)).toBe(false);
    expect(holdsSlot(pending({ status: 'declined' }), NOW)).toBe(false);
  });
});

describe('inviteLookupStatus (_circle_invite_lookup_status) and the shown member status', () => {
  it('first match wins: canceled, consumed, expired, pending', () => {
    expect(inviteLookupStatus(pending({ status: 'declined', inviteConsumedAt: NOW }), NOW)).toBe(
      'canceled',
    );
    expect(inviteLookupStatus(pending({ inviteCanceledAt: NOW }), NOW)).toBe('canceled');
    expect(inviteLookupStatus(pending({ status: 'active', inviteExpiresAt: NOW }), NOW)).toBe(
      'consumed',
    );
    expect(inviteLookupStatus(pending({ inviteExpiresAt: NOW }), NOW)).toBe('expired');
    expect(inviteLookupStatus(pending(), NOW)).toBe('pending');
  });

  it('only a stored pending row is shown as expired', () => {
    expect(shownMemberStatus(pending({ inviteExpiresAt: NOW }), NOW)).toBe('expired');
    expect(shownMemberStatus(pending({ inviteExpiresAt: NOW, inviteCanceledAt: NOW }), NOW)).toBe(
      'pending',
    );
    expect(shownMemberStatus(pending(), NOW)).toBe('pending');
    expect(shownMemberStatus(pending({ status: 'declined', inviteExpiresAt: NOW }), NOW)).toBe(
      'declined',
    );
    expect(shownMemberStatus(pending({ status: 'active', inviteExpiresAt: NOW }), NOW)).toBe(
      'active',
    );
  });
});

describe('capacityFromCounts (spec §7.0 Capacity)', () => {
  it('used = active + pending; available never below 0', () => {
    expect(CIRCLE_MEMBER_LIMIT).toBe(5);
    expect(capacityFromCounts(2, 2)).toEqual({
      limit: 5,
      active_count: 2,
      pending_count: 2,
      used: 4,
      available: 1,
    });
    expect(capacityFromCounts(5, 1).available).toBe(0);
  });
});
