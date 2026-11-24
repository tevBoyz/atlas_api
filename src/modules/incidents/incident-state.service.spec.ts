import { DomainError } from '../../common/errors';
import { httpStatusForCode } from '../../common/errors/http-status';
import type { IncidentCloseSettings } from './incident-close-settings';
import type { IncidentEventService } from './incident-events.service';
import {
  assertIncidentStateTransition,
  INCIDENT_STATE_TRANSITIONS,
  IncidentStateService,
  isIncidentStateTransition,
} from './incident-state.service';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SETTINGS: IncidentCloseSettings = { close_after_minutes: 30, auto_close_after_hours: 24 };
const STATUSES = ['active', 'resolved', 'closed', 'activating', 'cancelled'];

describe('incident states (SCRUM-63, D61)', () => {
  it('the defined transitions: active -> resolved, resolved -> closed, active -> closed', () => {
    expect(INCIDENT_STATE_TRANSITIONS).toEqual({
      active: ['resolved', 'closed'],
      resolved: ['closed'],
      closed: [],
    });
  });

  const allowed = new Set(['active>resolved', 'resolved>closed', 'active>closed']);
  it.each(STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)))(
    '%s -> %s',
    (from, to) => {
      const ok = allowed.has(`${from}>${to}`);
      expect(isIncidentStateTransition(from, to)).toBe(ok);
      let code: string | undefined;
      try {
        assertIncidentStateTransition(from, to);
      } catch (error) {
        code = (error as DomainError).code;
      }
      expect(code).toBe(ok ? undefined : 'incidents:invalid_state_transition');
    },
  );

  it('an unknown or inherited key is no state', () => {
    expect(isIncidentStateTransition('toString', 'closed')).toBe(false);
    expect(isIncidentStateTransition('__proto__', 'closed')).toBe(false);
  });

  it('the refusal is a 409 DomainError', () => {
    let error: unknown;
    try {
      assertIncidentStateTransition('closed', 'resolved');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(httpStatusForCode('incidents:invalid_state_transition')).toBe(409);
  });
});

function setup(rows: Record<string, unknown>[] = []) {
  const execute = jest.fn().mockResolvedValue({ rows });
  const record = jest.fn().mockResolvedValue(undefined);
  const service = new IncidentStateService({ record } as unknown as IncidentEventService);
  return { tx: { execute }, execute, record, service };
}

describe('IncidentStateService (SCRUM-63, D61)', () => {
  it.each(['resolved', 'closed', 'activating', 'cancelled'])(
    'resolveSafe from %s is refused before any SQL',
    async (from) => {
      const { tx, execute, service } = setup();
      await expect(service.resolveSafe(tx, ID, from)).rejects.toMatchObject({
        code: 'incidents:invalid_state_transition',
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('resolveSafe from active writes the mark safe row (only while still active)', async () => {
    const { tx, execute, service } = setup([{ circle_id: 'c' }]);
    await expect(service.resolveSafe(tx, ID, 'active')).resolves.toEqual({ circle_id: 'c' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('closeDue of a row claimed in another state is refused before any SQL', async () => {
    const { tx, execute, service } = setup();
    await expect(
      service.closeDue(tx, { id: ID, status: 'closed' as 'active' }, SETTINGS),
    ).rejects.toMatchObject({ code: 'incidents:invalid_state_transition' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolved -> closed: incident_closed {reason: safe, auto_closed: false}, no actor', async () => {
    const row = {
      id: ID,
      resident_id: 'r',
      circle_id: 'c',
      from: 'resolved',
      resolved_reason: 'safe',
      auto_closed: false,
    };
    const { tx, record, service } = setup([row]);
    await expect(service.closeDue(tx, { id: ID, status: 'resolved' }, SETTINGS)).resolves.toEqual(
      row,
    );
    expect(record.mock.calls).toEqual([
      [tx, ID, 'incident_closed', null, { reason: 'safe', auto_closed: false }],
    ]);
  });

  it('active -> closed: location_sharing_ended, then incident_closed {reason: ended, auto_closed: true}', async () => {
    const row = {
      id: ID,
      resident_id: 'r',
      circle_id: null,
      from: 'active',
      resolved_reason: 'ended',
      auto_closed: true,
    };
    const { tx, record, service } = setup([row]);
    await service.closeDue(tx, { id: ID, status: 'active' }, SETTINGS);
    expect(record.mock.calls).toEqual([
      [tx, ID, 'location_sharing_ended', null, {}],
      [tx, ID, 'incident_closed', null, { reason: 'ended', auto_closed: true }],
    ]);
  });

  it('no longer due (the re-check found nothing): undefined, no event', async () => {
    const { tx, record, service } = setup([]);
    await expect(
      service.closeDue(tx, { id: ID, status: 'active' }, SETTINGS),
    ).resolves.toBeUndefined();
    expect(record).not.toHaveBeenCalled();
  });

  it('claimDue: the active claim only takes what is left of the limit', async () => {
    const { tx, execute, service } = setup();
    execute
      .mockResolvedValueOnce({ rows: [{ id: 'a', status: 'resolved' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'b', status: 'active' }] });
    await expect(service.claimDue(tx, SETTINGS, 5)).resolves.toEqual([
      { id: 'a', status: 'resolved' },
      { id: 'b', status: 'active' },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('claimDue: a full resolved claim skips the active scan', async () => {
    const { tx, execute, service } = setup();
    execute.mockResolvedValueOnce({ rows: [{ id: 'a', status: 'resolved' }] });
    await service.claimDue(tx, SETTINGS, 1);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
