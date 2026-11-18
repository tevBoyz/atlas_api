import type { Logger } from 'pino';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import {
  type IncidentPostCommitHook,
  IncidentPostCommitRunner,
  type IncidentSubmittedEvent,
} from './incident-post-commit';
import { submitEmergencyAlertRequestSchema } from './incident.schemas';
import type { IncidentsRepository } from './incidents.repository';
import { IncidentSubmitFailedError, IncidentsService } from './incidents.service';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  issuer: 'supabase',
  sessionId: null,
  email: null,
  phone: null,
};
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const EVENT: IncidentSubmittedEvent = {
  incident_id: INCIDENT_ID,
  resident_id: USER.id,
  circle_id: null,
  submit_outcome: 'created',
  recipient_count: 0,
};

function serviceWith(overrides: Partial<Record<keyof IncidentsRepository, jest.Mock>> = {}) {
  const repository = {
    useUtcTimestamps: jest.fn().mockResolvedValue(undefined),
    lockProfile: jest.fn().mockResolvedValue({ setup_complete: true }),
    lockOpenIncident: jest.fn().mockResolvedValue(undefined),
    lockActiveIncident: jest.fn().mockResolvedValue(undefined),
    insertActiveIncident: jest.fn().mockResolvedValue({ id: INCIDENT_ID, circle_id: null }),
    promoteIncident: jest.fn(),
    insertDeliveries: jest.fn().mockResolvedValue(undefined),
    recordAlertSent: jest.fn().mockResolvedValue(undefined),
    recordLocationSharingStarted: jest.fn().mockResolvedValue(undefined),
    applyRenotify: jest.fn().mockResolvedValue(3),
    submitResult: jest.fn().mockResolvedValue({ circle_id: null, delivered_count: 0 }),
    ...overrides,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const postCommit = { afterSubmit: jest.fn().mockResolvedValue(undefined) };
  const database = {
    db: { transaction: (run: (tx: object) => Promise<unknown>) => run({}) },
  };
  const service = new IncidentsService(
    database as unknown as DatabaseService,
    repository as unknown as IncidentsRepository,
    audit as unknown as AuditService,
    postCommit as unknown as IncidentPostCommitRunner,
  );
  return { service, repository, audit, postCommit };
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
