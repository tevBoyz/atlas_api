import type { MembershipEndedEvent } from '../modules/circles/membership-post-commit';
import { MembershipRevocationHook } from './membership-revocation.hook';
import { incidentIdOf } from './realtime.gateway';
import { REVOCATION_MEMORY_MS, RevocationLog } from './revocation-log';
import type { RealtimeGateway } from './realtime.gateway';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'cccccccc-1111-4111-8111-111111111111';
const C2 = 'cccccccc-2222-4222-8222-222222222222';

describe('RevocationLog (API-100-40 join/revocation race)', () => {
  let now = 1_000_000;
  const log = () => new RevocationLog(() => now);

  it('refuses a join whose check overlapped a revocation of the same user and circle', () => {
    const revocations = log();
    const mark = revocations.mark();
    revocations.record(U1, C1);
    expect(revocations.revokedSince(U1, C1, mark)).toBe(true);
  });

  it('allows a join that started after the revocation (the check saw the committed end)', () => {
    const revocations = log();
    revocations.record(U1, C1);
    const mark = revocations.mark();
    expect(revocations.revokedSince(U1, C1, mark)).toBe(false);
  });

  it('is per user and per circle', () => {
    const revocations = log();
    const mark = revocations.mark();
    revocations.record(U1, C1);
    expect(revocations.revokedSince(U2, C1, mark)).toBe(false);
    expect(revocations.revokedSince(U1, C2, mark)).toBe(false);
  });

  it('a repeated revocation moves the entry forward', () => {
    const revocations = log();
    revocations.record(U1, C1);
    const mark = revocations.mark();
    revocations.record(U1, C1);
    expect(revocations.revokedSince(U1, C1, mark)).toBe(true);
    expect(revocations.size).toBe(1);
  });

  it('forgets old entries and refuses a join check older than the memory', () => {
    const revocations = log();
    revocations.record(U1, C1);
    now += REVOCATION_MEMORY_MS + 1;
    revocations.record(U2, C2);
    expect(revocations.size).toBe(1);
    const stale = revocations.mark();
    now += REVOCATION_MEMORY_MS + 1;
    expect(revocations.revokedSince(U1, C1, stale)).toBe(true);
  });
});

describe('incidentIdOf (join/leave payload)', () => {
  it.each([
    [
      { incident_id: 'AAAAAAAA-1111-4111-8111-111111111111' },
      'aaaaaaaa-1111-4111-8111-111111111111',
    ],
    [{ incident_id: U1, extra: true }, U1],
  ])('accepts %j', (payload, expected) => {
    expect(incidentIdOf(payload)).toBe(expected);
  });

  it.each([
    [undefined],
    [null],
    ['11111111-1111-4111-8111-111111111111'],
    [{}],
    [{ incident_id: 42 }],
    [{ incident_id: 'not-a-uuid' }],
    [{ incident_id: `${U1} ` }],
    [[U1]],
  ])('refuses %j', (payload) => {
    expect(incidentIdOf(payload)).toBeUndefined();
  });
});

describe('MembershipRevocationHook (API-100-40 AC3)', () => {
  const event = (user_id: string | null): MembershipEndedEvent => ({
    reason: 'removed',
    circle_id: C1,
    member_id: C2,
    user_id,
    actor_user_id: U2,
  });

  it('revokes the user of the ended row from that circle', () => {
    const revokeMembership = jest.fn();
    const hook = new MembershipRevocationHook({ revokeMembership } as unknown as RealtimeGateway);
    hook.afterMembershipEnded(event(U1));
    expect(revokeMembership).toHaveBeenCalledWith(U1, C1);
  });

  it('does nothing for a row nobody claimed', () => {
    const revokeMembership = jest.fn();
    const hook = new MembershipRevocationHook({ revokeMembership } as unknown as RealtimeGateway);
    hook.afterMembershipEnded(event(null));
    expect(revokeMembership).not.toHaveBeenCalled();
  });
});
