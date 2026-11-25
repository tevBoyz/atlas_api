import type { AuthenticatedUser } from '../../common/auth';
import type { ApiConfigService } from '../../config';
import type { DatabaseService } from '../../db/database.service';
import type { AuditService } from '../audit';
import type { IncidentDeliveriesRepository } from './incident-deliveries.repository';
import type { IncidentEventService } from './incident-events.service';
import type { IncidentPostCommitRunner } from './incident-post-commit';
import { responderView } from './incident-responder-view';
import type { ResponderRow } from './incident-responders.repository';
import { IncidentRespondersService, responseStatusFromBody } from './incident-responders.service';

const INCIDENT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const ME = '5e4b2d3c-0f9a-4b8d-a7c6-2345678a0d3e';
const OTHER = '4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d';
const USER = { id: ME } as AuthenticatedUser;
const T = '2026-11-23T10:00:00+00:00';

const row = (userId: string, status: ResponderRow['status'] = 'responding'): ResponderRow => ({
  user_id: userId,
  display_name: 'Milo',
  avatar_url: null,
  status,
  acknowledged_at: T,
  status_at: T,
  delivery_status: 'failed',
  delivery_at: T,
  delivery_failed_reason: 'no_device',
});

const MEMBER_KEYS = [
  'user_id',
  'display_name',
  'avatar_url',
  'status',
  'acknowledged_at',
  'status_at',
  'is_me',
];

describe('responseStatusFromBody (D56)', () => {
  it.each(['responding', 'unable'])('accepts %s', (status) => {
    expect(responseStatusFromBody({ status })).toBe(status);
  });

  it.each([undefined, null, '', 'RESPONDING', 'acknowledged', 'no_response', 'arrived', 1, true])(
    'refuses %p with incident_response:invalid_status on field status',
    (status) => {
      expect(() => responseStatusFromBody({ status })).toThrow(
        expect.objectContaining({
          code: 'incident_response:invalid_status',
          details: { field: 'status' },
        }) as Error,
      );
    },
  );

  it.each([null, 'responding', [], 3])('a body that is not an object (%p) is 422 on body', (b) => {
    expect(() => responseStatusFromBody(b)).toThrow(
      expect.objectContaining({
        code: 'validation:invalid_request',
        details: { field: 'body' },
      }) as Error,
    );
  });
});

describe('responderView (D56 masking, as D11)', () => {
  it('the resident sees full ids, is_me false and (D73) the 3 delivery keys after is_me', () => {
    const view = responderView(row(OTHER), { resident: true });
    expect(view).toEqual({ ...row(OTHER), is_me: false });
    expect(Object.keys(view)).toEqual([
      ...MEMBER_KEYS,
      'delivery_status',
      'delivery_at',
      'delivery_failed_reason',
    ]);
  });

  it('a member sees another member masked; exactly the 7 keys in order (no delivery keys, D73)', () => {
    const view = responderView(row(OTHER), { resident: false, viewerId: ME });
    expect(Object.keys(view)).toEqual(MEMBER_KEYS);
    expect(Object.keys(responderView(row(ME), { resident: false, viewerId: ME }))).toEqual(
      MEMBER_KEYS,
    );
    expect(view.user_id).toBe('4f3a****-****-****-****-********9c2d');
    expect(view.is_me).toBe(false);
  });

  it('a member sees their own row in full with is_me (any case of the viewer id)', () => {
    const view = responderView(row(ME), { resident: false, viewerId: ME.toUpperCase() });
    expect(view.user_id).toBe(ME);
    expect(view.is_me).toBe(true);
  });
});

function serviceWith(overrides: Record<string, jest.Mock> = {}) {
  const repository = {
    lockOwnDelivery: jest
      .fn()
      .mockResolvedValue({ id: 'd1', acknowledged: false, response_status: null }),
    responseIncident: jest.fn().mockResolvedValue({
      id: INCIDENT_ID,
      status: 'active',
      resident_id: 'r1',
      circle_id: 'c1',
      member_view: true,
    }),
    setResponse: jest.fn().mockResolvedValue(undefined),
    ownRow: jest.fn().mockResolvedValue(row(ME)),
    visibleResponders: jest.fn(),
    ...overrides,
  };
  const deliveries = {
    keyShareCallerAndIncident: jest.fn().mockResolvedValue(undefined),
    counts: jest.fn().mockResolvedValue({ delivered_count: 2, acknowledged_count: 1 }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const postCommit = {
    afterResponders: jest.fn().mockResolvedValue(undefined),
    afterDeliveryCounts: jest.fn().mockResolvedValue(undefined),
    afterEvents: jest.fn().mockResolvedValue(undefined),
  };
  const recorded: { id: string; incident_id: string; event_type: string }[] = [];
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
  const tx = { execute: jest.fn().mockResolvedValue({ rows: [] }) };
  const database = {
    db: { transaction: (run: (t: object) => Promise<unknown>) => run(tx) },
  };
  const config = { get: (key: string) => (key === 'AVATARS_BUCKET' ? 'avatars' : undefined) };
  const service = new IncidentRespondersService(
    database as unknown as DatabaseService,
    repository,
    deliveries as unknown as IncidentDeliveriesRepository,
    audit as unknown as AuditService,
    postCommit as unknown as IncidentPostCommitRunner,
    config as unknown as ApiConfigService,
    events as unknown as IncidentEventService,
  );
  return { service, repository, deliveries, audit, postCommit, tx, events };
}

describe('IncidentRespondersService.respond (D56)', () => {
  it('no delivery row → not_found before the incident is read', async () => {
    const { service, repository } = serviceWith({
      lockOwnDelivery: jest.fn().mockResolvedValue(undefined),
    });
    await expect(service.respond(USER, INCIDENT_ID, 'responding')).rejects.toMatchObject({
      code: 'incident_response:not_found',
    });
    expect(repository.responseIncident).not.toHaveBeenCalled();
  });

  it('outside memberView → not_found even when closed; nothing written', async () => {
    const { service, repository, audit } = serviceWith({
      responseIncident: jest.fn().mockResolvedValue({ status: 'resolved', member_view: false }),
    });
    await expect(service.respond(USER, INCIDENT_ID, 'unable')).rejects.toMatchObject({
      code: 'incident_response:not_found',
    });
    expect(repository.setResponse).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('not active → not_open, nothing written', async () => {
    const { service, repository } = serviceWith({
      responseIncident: jest.fn().mockResolvedValue({ status: 'resolved', member_view: true }),
    });
    await expect(service.respond(USER, INCIDENT_ID, 'responding')).rejects.toMatchObject({
      code: 'incident_response:not_open',
    });
    expect(repository.setResponse).not.toHaveBeenCalled();
  });

  it('first response: writes, audits ids only, responders + counts hooks (it acknowledged)', async () => {
    const { service, repository, audit, postCommit } = serviceWith();
    // A member's own row: the 7 keys, never the resident-only delivery keys (D73).
    const { delivery_status, delivery_at, delivery_failed_reason, ...memberRow } = row(ME);
    expect([delivery_status, delivery_at, delivery_failed_reason]).toEqual([
      'failed',
      T,
      'no_device',
    ]);
    await expect(service.respond(USER, INCIDENT_ID, 'responding')).resolves.toEqual({
      ...memberRow,
      is_me: true,
    });
    expect(repository.setResponse).toHaveBeenCalledWith(expect.anything(), 'd1', 'responding');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'incident.response_set',
        actor_user_id: ME,
        target_type: 'incident',
        target_id: INCIDENT_ID,
        detail: {
          delivery_id: 'd1',
          status: 'responding',
          previous_status: null,
          acknowledged_now: true,
        },
      }),
      expect.anything(),
    );
    const ref = { incident_id: INCIDENT_ID, resident_id: 'r1', circle_id: 'c1' };
    expect(postCommit.afterResponders).toHaveBeenCalledWith({ ...ref, member_user_id: ME });
    expect(postCommit.afterDeliveryCounts).toHaveBeenCalledWith({
      ...ref,
      delivered_count: 2,
      acknowledged_count: 1,
    });
  });

  it('first response: responder_acknowledged, then responder_status {status}, in order (D71)', async () => {
    const { service, events, postCommit, deliveries, repository } = serviceWith();
    await service.respond(USER, INCIDENT_ID, 'responding');
    expect(deliveries.keyShareCallerAndIncident).toHaveBeenCalledWith(
      expect.anything(),
      INCIDENT_ID,
      ME,
    );
    expect(deliveries.keyShareCallerAndIncident.mock.invocationCallOrder[0]).toBeLessThan(
      repository.lockOwnDelivery.mock.invocationCallOrder[0],
    );
    expect(events.record.mock.calls.map((c: unknown[]) => c.slice(1))).toEqual([
      [INCIDENT_ID, 'responder_acknowledged', ME],
      [INCIDENT_ID, 'responder_status', ME, { status: 'responding' }, { afterEarlierEvents: true }],
    ]);
    expect(postCommit.afterEvents).toHaveBeenCalledWith(
      { incident_id: INCIDENT_ID, resident_id: 'r1', circle_id: 'c1' },
      [
        { id: 'e1', incident_id: INCIDENT_ID, event_type: 'responder_acknowledged' },
        { id: 'e2', incident_id: INCIDENT_ID, event_type: 'responder_status' },
      ],
    );
  });

  it('a switch on an acknowledged row: only responder_status (D71)', async () => {
    const { service, events } = serviceWith({
      lockOwnDelivery: jest
        .fn()
        .mockResolvedValue({ id: 'd1', acknowledged: true, response_status: 'responding' }),
    });
    await service.respond(USER, INCIDENT_ID, 'unable');
    expect(events.record.mock.calls.map((c: unknown[]) => c.slice(1))).toEqual([
      [INCIDENT_ID, 'responder_status', ME, { status: 'unable' }, { afterEarlierEvents: false }],
    ]);
  });

  it('the same status again or not active: no event (D71)', async () => {
    const same = serviceWith({
      lockOwnDelivery: jest
        .fn()
        .mockResolvedValue({ id: 'd1', acknowledged: true, response_status: 'unable' }),
    });
    await same.service.respond(USER, INCIDENT_ID, 'unable');
    expect(same.events.record).not.toHaveBeenCalled();
    expect(same.postCommit.afterEvents).not.toHaveBeenCalled();
    const closed = serviceWith({
      responseIncident: jest.fn().mockResolvedValue({ status: 'resolved', member_view: true }),
    });
    await expect(closed.service.respond(USER, INCIDENT_ID, 'unable')).rejects.toMatchObject({
      code: 'incident_response:not_open',
    });
    expect(closed.events.record).not.toHaveBeenCalled();
  });

  it('a switch on an acknowledged row: no counts hook', async () => {
    const { service, postCommit, deliveries } = serviceWith({
      lockOwnDelivery: jest
        .fn()
        .mockResolvedValue({ id: 'd1', acknowledged: true, response_status: 'responding' }),
    });
    await service.respond(USER, INCIDENT_ID, 'unable');
    expect(postCommit.afterResponders).toHaveBeenCalledTimes(1);
    expect(postCommit.afterDeliveryCounts).not.toHaveBeenCalled();
    expect(deliveries.counts).not.toHaveBeenCalled();
  });

  it('the same status again: nothing written, no audit, no hook, the row answered', async () => {
    const { service, repository, audit, postCommit } = serviceWith({
      lockOwnDelivery: jest
        .fn()
        .mockResolvedValue({ id: 'd1', acknowledged: true, response_status: 'unable' }),
    });
    await expect(service.respond(USER, INCIDENT_ID, 'unable')).resolves.toMatchObject({
      is_me: true,
    });
    expect(repository.setResponse).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(postCommit.afterResponders).not.toHaveBeenCalled();
  });
});

describe('IncidentRespondersService.list (D56)', () => {
  it('hidden or unknown → incident_responders:not_found', async () => {
    const { service } = serviceWith({ visibleResponders: jest.fn().mockResolvedValue(undefined) });
    await expect(service.list(USER, INCIDENT_ID)).rejects.toMatchObject({
      code: 'incident_responders:not_found',
    });
  });

  it('a member: others masked, own row full', async () => {
    const { service } = serviceWith({
      visibleResponders: jest
        .fn()
        .mockResolvedValue({ is_resident: false, rows: [row(OTHER), row(ME, 'unable')] }),
    });
    const list = await service.list(USER, INCIDENT_ID);
    expect(list.map((r) => [r.user_id, r.is_me])).toEqual([
      ['4f3a****-****-****-****-********9c2d', false],
      [ME, true],
    ]);
  });

  it('the resident: full ids', async () => {
    const { service } = serviceWith({
      visibleResponders: jest.fn().mockResolvedValue({ is_resident: true, rows: [row(OTHER)] }),
    });
    expect((await service.list({ id: OTHER } as AuthenticatedUser, INCIDENT_ID))[0]).toMatchObject({
      user_id: OTHER,
      is_me: false,
    });
  });
});
