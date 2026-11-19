import { FULLY_MASKED_UUID, maskActorId } from './incident-actor-mask';

const ACTOR = '4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d';
const CALLER = '11111111-1111-4111-8111-111111111111';
const MASKED_SHAPE = /^[0-9a-f]{4}\*{4}-\*{4}-\*{4}-\*{4}-\*{8}[0-9a-f]{4}$/;

describe('maskActorId (epic §18 D11)', () => {
  it('keeps the first and last 4 hex characters, masks the rest, keeps hyphens and length', () => {
    const masked = maskActorId(ACTOR, CALLER);
    expect(masked).toBe('4f3a****-****-****-****-********9c2d');
    expect(masked).toHaveLength(36);
    expect(masked).toMatch(MASKED_SHAPE);
  });

  it('uppercase input is normalised to lowercase, as Postgres writes a uuid', () => {
    expect(maskActorId(ACTOR.toUpperCase(), CALLER)).toBe('4f3a****-****-****-****-********9c2d');
  });

  it('null (and a missing value) stays null', () => {
    expect(maskActorId(null, CALLER)).toBeNull();
    expect(maskActorId(undefined, CALLER)).toBeNull();
  });

  it('the caller’s own id is shown in full, in lowercase, whatever the case of either side', () => {
    expect(maskActorId(ACTOR, ACTOR)).toBe(ACTOR);
    expect(maskActorId(ACTOR.toUpperCase(), ACTOR)).toBe(ACTOR);
    expect(maskActorId(ACTOR, ACTOR.toUpperCase())).toBe(ACTOR);
  });

  it('malformed input never throws and never leaks: fully masked', () => {
    const malformed: unknown[] = [
      '',
      'not-a-uuid',
      ACTOR.slice(0, 35),
      `${ACTOR}0`,
      ACTOR.replace(/-/g, ''),
      `{${ACTOR}}`,
      ` ${ACTOR}`,
      '4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2g',
      42,
      {},
      ['x'],
    ];
    for (const value of malformed) {
      expect(() => maskActorId(value, CALLER)).not.toThrow();
      expect(maskActorId(value, CALLER)).toBe(FULLY_MASKED_UUID);
    }
    // Even when it equals the caller's id: only a real UUID is ever shown in full.
    expect(maskActorId('not-a-uuid', 'not-a-uuid')).toBe(FULLY_MASKED_UUID);
    expect(FULLY_MASKED_UUID).toHaveLength(36);
  });
});
