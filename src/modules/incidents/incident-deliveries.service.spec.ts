import type { AuthenticatedUser } from '../../common/auth';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import type { IncidentDeliveriesRepository } from './incident-deliveries.repository';
import { IncidentDeliveriesService } from './incident-deliveries.service';
import type { IncidentEventService } from './incident-events.service';
import type { IncidentPostCommitRunner } from './incident-post-commit';

const USER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  issuer: 'supabase',
  sessionId: null,
  email: null,
  phone: null,
};
const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const COUNTS = {
  incident_id: INCIDENT_ID,
  delivered_count: 2,
  acknowledged_count: 1,
  status: 'active',
};

function serviceWith(overrides: Partial<Record<keyof IncidentDeliveriesRepository, jest.Mock>>) {
  const repository = {
    keyShareCallerAndIncident: jest.fn().mockResolvedValue(undefined),
    visibleCounts: jest.fn().mockResolvedValue(COUNTS),
    lockOwnDelivery: jest
      .fn()
      .mockResolvedValue({ id: 'd1', delivered: true, acknowledged: false }),
    ackIncident: jest.fn().mockResolvedValue({
      id: INCIDENT_ID,
      status: 'active',
      resident_id: 'r1',
      circle_id: 'c1',
      inside_window: true,
    }),
    acknowledge: jest.fn().mockResolvedValue(undefined),
    counts: jest.fn().mockResolvedValue(COUNTS),
    ...overrides,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const postCommit = {
    afterDeliveryCounts: jest.fn().mockResolvedValue(undefined),
    afterResponders: jest.fn().mockResolvedValue(undefined),
    afterEvents: jest.fn().mockResolvedValue(undefined),
  };
  const recorded: { id: string; event_type: string }[] = [];
  const events = {
    record: jest.fn((_tx: object, incidentId: string, eventType: string) => {
      const event = {
        id: `e${recorded.length + 1}`,
        incident_id: incidentId,
        event_type: eventType,
      };
      recorded.push(event);
      return Promise.resolve(event);
    }),
    drain: jest.fn(() => recorded.splice(0)),
  };
  const database = {
    db: { transaction: (run: (tx: object) => Promise<unknown>) => run({}) },
  };
  const service = new IncidentDeliveriesService(
    database as unknown as DatabaseService,
    repository as unknown as IncidentDeliveriesRepository,
    audit as unknown as AuditService,
    postCommit as unknown as IncidentPostCommitRunner,
    events as unknown as IncidentEventService,
  );
  return { service, repository, audit, postCommit, events };
}

describe('IncidentDeliveriesService (API-100-20)', () => {
  it('counts: no visible row is incident_delivery_counts:not_found', async () => {
    const { service } = serviceWith({ visibleCounts: jest.fn().mockResolvedValue(undefined) });
    await expect(service.counts(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'incident_delivery_counts:not_found',
    });
  });

  it('acknowledge: no delivery row → not_found before the incident is read', async () => {
    const { service, repository } = serviceWith({
      lockOwnDelivery: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.acknowledge(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'acknowledge_incident:not_found',
    });
    expect(repository.ackIncident).not.toHaveBeenCalled();
  });

  it('acknowledge: outside the window → not_found, even when the incident is closed', async () => {
    const { service, repository } = serviceWith({
      ackIncident: jest.fn().mockResolvedValue({ status: 'resolved', inside_window: false }),
    });
    await expect(service.acknowledge(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'acknowledge_incident:not_found',
    });
    expect(repository.acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledge: not active → not_open, nothing written', async () => {
    const { service, repository, audit } = serviceWith({
      ackIncident: jest.fn().mockResolvedValue({ status: 'resolved', inside_window: true }),
    });
    await expect(service.acknowledge(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'acknowledge_incident:not_open',
    });
    expect(repository.acknowledge).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('acknowledge: key-shares the profile and the incident before the delivery lock (D71)', async () => {
    const { service, repository } = serviceWith({});
    await service.acknowledge(USER, INCIDENT_ID);
    expect(repository.keyShareCallerAndIncident).toHaveBeenCalledWith({}, INCIDENT_ID, USER.id);
    expect(repository.keyShareCallerAndIncident.mock.invocationCallOrder[0]).toBeLessThan(
      repository.lockOwnDelivery.mock.invocationCallOrder[0],
    );
  });

  it('acknowledge: first time writes, audits with counts only, then the hook', async () => {
    const { service, repository, audit, postCommit, events } = serviceWith({});
    await expect(service.acknowledge(USER, INCIDENT_ID)).resolves.toEqual(COUNTS);
    expect(repository.acknowledge).toHaveBeenCalledWith({}, 'd1');
    // SCRUM-60/61 (D71): one responder_acknowledged event, actor = the member, detail {}.
    expect(events.record).toHaveBeenCalledTimes(1);
    expect(events.record).toHaveBeenCalledWith({}, INCIDENT_ID, 'responder_acknowledged', USER.id);
    expect(postCommit.afterEvents).toHaveBeenCalledWith(
      { incident_id: INCIDENT_ID, resident_id: 'r1', circle_id: 'c1' },
      [{ id: 'e1', incident_id: INCIDENT_ID, event_type: 'responder_acknowledged' }],
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'incident.acknowledged',
        actor_user_id: USER.id,
        target_id: INCIDENT_ID,
        detail: { delivered_count: 2, acknowledged_count: 1 },
      }),
      {},
    );
    expect(postCommit.afterDeliveryCounts).toHaveBeenCalledWith({
      incident_id: INCIDENT_ID,
      resident_id: 'r1',
      circle_id: 'c1',
      delivered_count: 2,
      acknowledged_count: 1,
    });
    // D56: the member's responder row changed (acknowledged).
    expect(postCommit.afterResponders).toHaveBeenCalledWith({
      incident_id: INCIDENT_ID,
      resident_id: 'r1',
      circle_id: 'c1',
      member_user_id: USER.id,
    });
  });

  it('acknowledge: a repeat writes nothing, no event, no audit and no hook', async () => {
    const { service, repository, audit, postCommit, events } = serviceWith({
      lockOwnDelivery: jest
        .fn()
        .mockResolvedValue({ id: 'd1', delivered: true, acknowledged: true }),
    });
    await expect(service.acknowledge(USER, INCIDENT_ID)).resolves.toEqual(COUNTS);
    expect(repository.acknowledge).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(postCommit.afterDeliveryCounts).not.toHaveBeenCalled();
    expect(postCommit.afterResponders).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
    expect(postCommit.afterEvents).not.toHaveBeenCalled();
  });

  it('acknowledge: not active → no event', async () => {
    const { service, events } = serviceWith({
      ackIncident: jest.fn().mockResolvedValue({ status: 'resolved', inside_window: true }),
    });
    await expect(service.acknowledge(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'acknowledge_incident:not_open',
    });
    expect(events.record).not.toHaveBeenCalled();
  });
});
