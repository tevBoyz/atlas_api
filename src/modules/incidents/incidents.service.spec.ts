import type { Logger } from 'pino';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import type { IncidentNotificationsOutbox } from '../notifications/incident-notifications';
import type { IncidentEventService, RecordedIncidentEvent } from './incident-events.service';
import {
  type IncidentPostCommitHook,
  IncidentPostCommitRunner,
  type IncidentSubmittedEvent,
} from './incident-post-commit';
import { submitEmergencyAlertRequestSchema } from './incident.schemas';
import type { IncidentStateService } from './incident-state.service';
import type { IncidentsRepository } from './incidents.repository';
import {
  IncidentOperationFailedError,
  IncidentSubmitFailedError,
  IncidentsService,
} from './incidents.service';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: '99999999-9999-4999-8999-999999999999',
  email: null,
  phone: null,
};
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const SERVICES = [{ service: 'ambulance', label: 'Ambulance', number: '116' }];
const EVENT: IncidentSubmittedEvent = {
  incident_id: INCIDENT_ID,
  resident_id: USER.id,
  circle_id: null,
  submit_outcome: 'created',
  recipient_count: 0,
};

function serviceWith(
  // `closeSafe` stands for `IncidentStateService.resolveSafe` (SCRUM-63, D61: the state service owns
  // the status write since then).
  overrides: Partial<Record<keyof IncidentsRepository | 'closeSafe', jest.Mock>> = {},
  recorded: RecordedIncidentEvent[] = [],
) {
  const repository = {
    useUtcTimestamps: jest.fn().mockResolvedValue(undefined),
    lockProfile: jest.fn().mockResolvedValue({ setup_complete: true }),
    lockOpenIncident: jest.fn().mockResolvedValue(undefined),
    writePlace: jest.fn().mockResolvedValue(undefined),
    lockActiveIncident: jest.fn().mockResolvedValue(undefined),
    insertActiveIncident: jest.fn().mockResolvedValue({ id: INCIDENT_ID, circle_id: null }),
    promoteIncident: jest.fn(),
    insertDeliveries: jest.fn().mockResolvedValue(undefined),
    recordAlertSent: jest.fn().mockResolvedValue(undefined),
    recordLocationSharingStarted: jest.fn().mockResolvedValue(undefined),
    applyRenotify: jest.fn().mockResolvedValue(3),
    submitResult: jest.fn().mockResolvedValue({ circle_id: null, delivered_count: 0 }),
    lockOwnIncident: jest
      .fn()
      .mockResolvedValue({ id: INCIDENT_ID, status: 'active', sharing_ended: false }),
    setNotes: jest.fn().mockResolvedValue({ body: { circle_id: null }, cleared: false }),
    keyShareProfile: jest.fn().mockResolvedValue(undefined),
    sendResult: jest.fn().mockResolvedValue({ circle_id: null, delivered_count: 3 }),
    liveResult: jest
      .fn()
      .mockResolvedValue({ circle_id: null, delivered_count: 3, closed_at: null }),
    closeSafe: jest.fn().mockResolvedValue({ circle_id: null }),
    closureRecipientIds: jest.fn().mockResolvedValue(['a', 'b']),
    recordClosureEvents: jest.fn().mockResolvedValue(undefined),
    emergencyServices: jest.fn().mockResolvedValue(SERVICES),
    ...overrides,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const postCommit = {
    afterSubmit: jest.fn().mockResolvedValue(undefined),
    afterNotes: jest.fn().mockResolvedValue(undefined),
    afterRenotify: jest.fn().mockResolvedValue(undefined),
    afterResolved: jest.fn().mockResolvedValue(undefined),
    afterEvents: jest.fn().mockResolvedValue(undefined),
  };
  const events = { drain: jest.fn().mockReturnValue(recorded) };
  const notifications = {
    created: jest.fn().mockResolvedValue('outbox-created'),
    renotified: jest.fn().mockResolvedValue('outbox-renotified'),
    resolved: jest.fn().mockResolvedValue('outbox-resolved'),
  };
  const database = {
    db: { transaction: (run: (tx: object) => Promise<unknown>) => run({}) },
  };
  const service = new IncidentsService(
    database as unknown as DatabaseService,
    repository as unknown as IncidentsRepository,
    audit as unknown as AuditService,
    postCommit as unknown as IncidentPostCommitRunner,
    events as unknown as IncidentEventService,
    notifications as unknown as IncidentNotificationsOutbox,
    {
      resolveSafe: (...args: unknown[]) => repository.closeSafe(...args) as Promise<unknown>,
    } as unknown as IncidentStateService,
  );
  return { service, repository, audit, postCommit, events, notifications };
}

describe('IncidentsService.submit (API-100-15)', () => {
  it('a lost insert race re-notifies the open incident (200) and never inserts twice', async () => {
    const { service, repository, audit } = serviceWith({
      insertActiveIncident: jest.fn().mockResolvedValue(undefined),
      lockActiveIncident: jest.fn().mockResolvedValue({ id: INCIDENT_ID, status: 'active' }),
    });

    const result = await service.submit(USER, 'fire');

    expect(result.status).toBe(200);
    expect(repository.applyRenotify).toHaveBeenCalledWith({}, INCIDENT_ID, USER.id);
    expect(repository.submitResult).toHaveBeenCalledWith({}, INCIDENT_ID, 'renotified');
    expect(repository.recordAlertSent).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incident.renotified' }),
      {},
    );
  });

  it('a lost race with no active row fails like _incident_apply_renotify:not_open', async () => {
    const { service, postCommit } = serviceWith({
      insertActiveIncident: jest.fn().mockResolvedValue(undefined),
    });

    await expect(service.submit(USER, 'fire')).rejects.toBeInstanceOf(IncidentSubmitFailedError);
    expect(postCommit.afterSubmit).not.toHaveBeenCalled();
  });

  it('keeps the profile checks in order, before any incident is read', async () => {
    const missing = serviceWith({ lockProfile: jest.fn().mockResolvedValue(undefined) });
    await expect(missing.service.submit(USER, 'fire')).rejects.toMatchObject({
      code: 'submit_emergency_alert:profile_not_found',
    });
    expect(missing.repository.lockOpenIncident).not.toHaveBeenCalled();

    const incomplete = serviceWith({
      lockProfile: jest.fn().mockResolvedValue({ setup_complete: false }),
    });
    await expect(incomplete.service.submit(USER, 'fire')).rejects.toBeInstanceOf(DomainError);
    expect(incomplete.repository.lockOpenIncident).not.toHaveBeenCalled();
  });

  it('a database error loses its parameters and row values, keeping the SQLSTATE', async () => {
    const cause = Object.assign(new Error('failing row contains (Peanuts)'), { code: '23514' });
    const wrapped = new Error('Failed query: insert\nparams: domestic_violence', { cause });
    const { service } = serviceWith({ lockProfile: jest.fn().mockRejectedValue(wrapped) });

    const error = await service.submit(USER, 'domestic_violence').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IncidentSubmitFailedError);
    expect((error as IncidentSubmitFailedError).sqlState).toBe('23514');
    expect((error as Error).message).not.toContain('domestic_violence');
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('Peanuts');
  });

  it('answers without waiting for the post-commit hooks', async () => {
    const { service, postCommit } = serviceWith();
    postCommit.afterSubmit.mockReturnValue(new Promise(() => undefined));

    await expect(service.submit(USER, 'fire')).resolves.toMatchObject({ status: 201 });
    expect(postCommit.afterSubmit).toHaveBeenCalledTimes(1);
  });

  it('leaves a session id that is not a uuid out of the audit row', async () => {
    const { service, audit } = serviceWith();
    await service.submit({ ...USER, sessionId: 'not-a-uuid' }, 'fire');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actor_session_id: null }),
      {},
    );
  });
});

describe('IncidentsService.setNotes (API-100-18)', () => {
  it('runs the SQL checks in order: not_found, then not_open, then too_long', async () => {
    const missing = serviceWith({ lockOwnIncident: jest.fn().mockResolvedValue(undefined) });
    await expect(missing.service.setNotes(USER, INCIDENT_ID, 'x')).rejects.toMatchObject({
      code: 'set_incident_notes:not_found',
    });
    expect(missing.repository.setNotes).not.toHaveBeenCalled();

    for (const status of ['resolved', 'cancelled']) {
      const closed = serviceWith({
        lockOwnIncident: jest
          .fn()
          .mockResolvedValue({ id: INCIDENT_ID, status, sharing_ended: false }),
      });
      await expect(closed.service.setNotes(USER, INCIDENT_ID, 'x')).rejects.toMatchObject({
        code: 'set_incident_notes:not_open',
      });
      expect(closed.repository.setNotes).not.toHaveBeenCalled();
    }

    const long = serviceWith({ setNotes: jest.fn().mockResolvedValue(undefined) });
    await expect(long.service.setNotes(USER, INCIDENT_ID, 'x')).rejects.toMatchObject({
      code: 'set_incident_notes:too_long',
    });
    expect(long.audit.record).not.toHaveBeenCalled();
    expect(long.postCommit.afterNotes).not.toHaveBeenCalled();
  });

  it('accepts a legacy activating incident (rule 37)', async () => {
    const { service } = serviceWith({
      lockOwnIncident: jest
        .fn()
        .mockResolvedValue({ id: INCIDENT_ID, status: 'activating', sharing_ended: false }),
    });
    await expect(service.setNotes(USER, INCIDENT_ID, 'x')).resolves.toEqual({ circle_id: null });
  });

  it('audits without the note and hands the hook ids only', async () => {
    const { service, audit, postCommit } = serviceWith();
    await service.setNotes(USER, INCIDENT_ID, 'Gate code 1234');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incident.notes_set', detail: { cleared: false } }),
      {},
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('1234');
    expect(postCommit.afterNotes).toHaveBeenCalledWith({
      incident_id: INCIDENT_ID,
      resident_id: USER.id,
      circle_id: null,
      cleared: false,
    });
  });

  it('a database error loses the note, keeping the SQLSTATE', async () => {
    const cause = Object.assign(new Error('failing row contains (Gate code 1234)'), {
      code: '23514',
    });
    const { service } = serviceWith({
      setNotes: jest.fn().mockRejectedValue(new Error('params: Gate code 1234', { cause })),
    });
    const error = await service
      .setNotes(USER, INCIDENT_ID, 'Gate code 1234')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncidentOperationFailedError);
    expect(error).toMatchObject({ operation: 'set_incident_notes', sqlState: '23514' });
    expect(JSON.stringify(error)).not.toContain('1234');
    expect((error as Error).message).not.toContain('1234');
  });
});

describe('IncidentsService.renotify (API-100-18)', () => {
  it('not_found, then not_open for anything but active (sharing_ended does not matter)', async () => {
    const missing = serviceWith({ lockOwnIncident: jest.fn().mockResolvedValue(undefined) });
    await expect(missing.service.renotify(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'renotify_emergency_alert:not_found',
    });
    for (const status of ['resolved', 'activating', 'cancelled']) {
      const closed = serviceWith({
        lockOwnIncident: jest
          .fn()
          .mockResolvedValue({ id: INCIDENT_ID, status, sharing_ended: false }),
      });
      await expect(closed.service.renotify(USER, INCIDENT_ID)).rejects.toMatchObject({
        code: 'renotify_emergency_alert:not_open',
      });
      expect(closed.repository.applyRenotify).not.toHaveBeenCalled();
    }
  });

  it('reuses the submit re-notify (applyRenotify), answers IncidentLive, audits the count', async () => {
    const { service, repository, audit, postCommit } = serviceWith();
    await expect(service.renotify(USER, INCIDENT_ID)).resolves.toEqual({
      circle_id: null,
      delivered_count: 3,
      closed_at: null,
      emergency_services: SERVICES,
    });
    expect(repository.sendResult).not.toHaveBeenCalled();
    expect(repository.emergencyServices).toHaveBeenCalledWith({}, undefined);
    expect(repository.applyRenotify).toHaveBeenCalledWith({}, INCIDENT_ID, USER.id);
    expect(repository.submitResult).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'incident.renotified', detail: { recipient_count: 3 } }),
      {},
    );
    expect(postCommit.afterRenotify).toHaveBeenCalledWith({
      incident_id: INCIDENT_ID,
      resident_id: USER.id,
      circle_id: null,
      recipient_count: 3,
    });
  });
});

describe('IncidentsService.markSafe (API-100-19)', () => {
  const locked = (status: string, resolved_reason: string | null = null) =>
    jest.fn().mockResolvedValue({ id: INCIDENT_ID, status, resolved_reason, sharing_ended: false });

  it('takes the profile key-share lock before the incident row lock', async () => {
    const order: string[] = [];
    const { service } = serviceWith({
      keyShareProfile: jest.fn().mockImplementation(() => {
        order.push('profile');
        return Promise.resolve();
      }),
      lockOwnIncident: jest.fn().mockImplementation(() => {
        order.push('incident');
        return Promise.resolve({
          id: INCIDENT_ID,
          status: 'active',
          resolved_reason: null,
          sharing_ended: false,
        });
      }),
    });
    await service.markSafe(USER, INCIDENT_ID);
    expect(order).toEqual(['profile', 'incident']);
  });

  it('not_found first; nothing else runs', async () => {
    const { service, repository, audit, postCommit } = serviceWith({
      lockOwnIncident: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.markSafe(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'mark_incident_safe:not_found',
    });
    expect(repository.closeSafe).not.toHaveBeenCalled();
    expect(repository.sendResult).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(postCommit.afterResolved).not.toHaveBeenCalled();
  });

  it('already resolved as safe: the unchanged IncidentSend, no write, audit or hook', async () => {
    const { service, repository, audit, postCommit } = serviceWith({
      lockOwnIncident: locked('resolved', 'safe'),
    });
    await expect(service.markSafe(USER, INCIDENT_ID)).resolves.toEqual({
      circle_id: null,
      delivered_count: 3,
    });
    expect(repository.closeSafe).not.toHaveBeenCalled();
    expect(repository.closureRecipientIds).not.toHaveBeenCalled();
    expect(repository.recordClosureEvents).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(postCommit.afterResolved).not.toHaveBeenCalled();
  });

  it.each([
    ['resolved', 'ended'],
    ['resolved', null],
    ['activating', null],
    ['cancelled', null],
    // SCRUM-63 (D61): a closed alert is final, whatever its reason.
    ['closed', 'safe'],
    ['closed', 'ended'],
  ])('%s / %s is not_open, nothing written', async (status, reason) => {
    const { service, repository, postCommit } = serviceWith({
      lockOwnIncident: locked(status, reason),
    });
    await expect(service.markSafe(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'mark_incident_safe:not_open',
    });
    expect(repository.closeSafe).not.toHaveBeenCalled();
    expect(postCommit.afterResolved).not.toHaveBeenCalled();
  });

  it('closes, records the events with the recipients, audits the count, then the hook', async () => {
    const { service, repository, audit, postCommit } = serviceWith({
      lockOwnIncident: locked('active'),
      closeSafe: jest.fn().mockResolvedValue({ circle_id: 'c' }),
    });
    await expect(service.markSafe(USER, INCIDENT_ID)).resolves.toEqual({
      circle_id: null,
      delivered_count: 3,
    });
    expect(repository.recordClosureEvents).toHaveBeenCalledWith({}, INCIDENT_ID, USER.id, [
      'a',
      'b',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'incident.resolved',
        target_id: INCIDENT_ID,
        detail: { recipient_count: 2 },
      }),
      {},
    );
    expect(postCommit.afterResolved).toHaveBeenCalledWith({
      incident_id: INCIDENT_ID,
      resident_id: USER.id,
      circle_id: 'c',
      recipient_count: 2,
    });
  });

  it('a failure after the close rolls back and runs no hook', async () => {
    const { service, postCommit } = serviceWith({
      lockOwnIncident: locked('active'),
      recordClosureEvents: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { code: '23505' })),
    });
    await expect(service.markSafe(USER, INCIDENT_ID)).rejects.toMatchObject({
      operation: 'mark_incident_safe',
      sqlState: '23505',
    });
    expect(postCommit.afterResolved).not.toHaveBeenCalled();
  });

  it('answers without waiting for the hook', async () => {
    const { service, postCommit } = serviceWith({ lockOwnIncident: locked('active') });
    postCommit.afterResolved.mockReturnValue(new Promise(() => undefined));
    await expect(service.markSafe(USER, INCIDENT_ID)).resolves.toBeDefined();
  });
});

describe('IncidentPostCommitRunner (API-100-15)', () => {
  const logger = () => ({ warn: jest.fn() });

  it('runs every hook even when an earlier one throws or rejects, and never rejects', async () => {
    const log = logger();
    const lastHook = jest.fn();
    const last: IncidentPostCommitHook = { afterSubmit: lastHook };
    const runner = new IncidentPostCommitRunner(
      [
        {
          afterSubmit: () => {
            throw new Error('sync');
          },
        },
        { afterSubmit: () => Promise.reject(new Error('async')) },
        last,
      ],
      log as unknown as Logger,
    );

    await expect(runner.afterSubmit(EVENT)).resolves.toBeUndefined();

    expect(lastHook).toHaveBeenCalledWith(EVENT);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('runs only the hooks that implement an event', async () => {
    const log = logger();
    const afterLocation = jest.fn();
    const runner = new IncidentPostCommitRunner(
      [{ afterSubmit: jest.fn() }, { afterLocation }],
      log as unknown as Logger,
    );
    const location = { incident_id: INCIDENT_ID, resident_id: USER.id, circle_id: null };
    await expect(runner.afterLocation(location)).resolves.toBeUndefined();
    await expect(runner.afterNotes({ ...location, cleared: true })).resolves.toBeUndefined();
    await expect(
      runner.afterResolved({ ...location, recipient_count: 0 }),
    ).resolves.toBeUndefined();
    expect(afterLocation).toHaveBeenCalledWith(location);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does nothing without hooks', async () => {
    const log = logger();
    const runner = new IncidentPostCommitRunner([], log as unknown as Logger);
    await expect(runner.afterSubmit(EVENT)).resolves.toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('submitEmergencyAlertRequestSchema (API-100-15)', () => {
  it.each(['medical', 'domestic_violence', 'fire', 'burglary', 'other'])('accepts %s', (type) => {
    expect(submitEmergencyAlertRequestSchema.safeParse({ emergency_type: type }).success).toBe(
      true,
    );
  });

  it.each(['unspecified', 'crime_safety', 'accident', 'Medical', ' medical', '', null, 1])(
    'refuses %s',
    (type) => {
      expect(submitEmergencyAlertRequestSchema.safeParse({ emergency_type: type }).success).toBe(
        false,
      );
    },
  );
});

describe('incident.event post-commit hook (API-100-22)', () => {
  const RECORDED: RecordedIncidentEvent[] = [
    { id: 'e1', incident_id: INCIDENT_ID, event_type: 'alert_sent' },
    { id: 'e2', incident_id: INCIDENT_ID, event_type: 'location_sharing_started' },
  ];

  it('submit: the events the transaction inserted, after commit, with ids only', async () => {
    const { service, postCommit, events } = serviceWith({}, RECORDED);
    await service.submit(USER, 'fire');
    expect(events.drain).toHaveBeenCalledWith({});
    expect(postCommit.afterEvents).toHaveBeenCalledWith(
      { incident_id: INCIDENT_ID, resident_id: USER.id, circle_id: null },
      RECORDED,
    );
  });

  it('no inserted event (already-safe no-op, a repeat): no hook', async () => {
    const { service, postCommit } = serviceWith({
      lockOwnIncident: jest
        .fn()
        .mockResolvedValue({ id: INCIDENT_ID, status: 'resolved', resolved_reason: 'safe' }),
    });
    await service.markSafe(USER, INCIDENT_ID);
    expect(postCommit.afterEvents).not.toHaveBeenCalled();
  });

  it('a failed transaction runs no hook', async () => {
    const { service, postCommit } = serviceWith(
      { recordAlertSent: jest.fn().mockRejectedValue(new Error('boom')) },
      RECORDED,
    );
    await expect(service.submit(USER, 'fire')).rejects.toBeInstanceOf(IncidentSubmitFailedError);
    expect(postCommit.afterEvents).not.toHaveBeenCalled();
  });
});

describe('notification outbox rows (API-100-48)', () => {
  const tx = {};

  it('submit created: incident.created in the transaction', async () => {
    const { service, notifications } = serviceWith();
    await service.submit(USER, 'fire');
    expect(notifications.created).toHaveBeenCalledWith(tx, INCIDENT_ID);
    expect(notifications.renotified).not.toHaveBeenCalled();
  });

  it('submit on an active alert and explicit re-notify: incident.renotified', async () => {
    const active = serviceWith({
      lockOpenIncident: jest.fn().mockResolvedValue({ id: INCIDENT_ID, status: 'active' }),
    });
    await active.service.submit(USER, 'fire');
    expect(active.notifications.renotified).toHaveBeenCalledWith(tx, INCIDENT_ID);
    expect(active.notifications.created).not.toHaveBeenCalled();
    const explicit = serviceWith();
    await explicit.service.renotify(USER, INCIDENT_ID);
    expect(explicit.notifications.renotified).toHaveBeenCalledWith(tx, INCIDENT_ID);
  });

  it('mark safe: incident.resolved with the closure recipients; the already-safe no-op writes none', async () => {
    const closing = serviceWith();
    await closing.service.markSafe(USER, INCIDENT_ID);
    expect(closing.notifications.resolved).toHaveBeenCalledWith(tx, INCIDENT_ID, ['a', 'b']);
    const noOp = serviceWith({
      lockOwnIncident: jest
        .fn()
        .mockResolvedValue({ id: INCIDENT_ID, status: 'resolved', resolved_reason: 'safe' }),
    });
    await noOp.service.markSafe(USER, INCIDENT_ID);
    expect(noOp.notifications.resolved).not.toHaveBeenCalled();
  });

  it('an outbox write that fails fails the whole write (same transaction)', async () => {
    const { service, notifications, postCommit } = serviceWith();
    notifications.created.mockRejectedValue(new Error('outbox down'));
    await expect(service.submit(USER, 'fire')).rejects.toBeInstanceOf(IncidentSubmitFailedError);
    expect(postCommit.afterSubmit).not.toHaveBeenCalled();
  });
});
