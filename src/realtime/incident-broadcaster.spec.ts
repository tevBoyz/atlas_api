import {
  closedPayload,
  deliveryCountsPayload,
  eventPayload,
  IncidentBroadcaster,
  incomingPayload,
  locationPayload,
  notesPayload,
  renotifiedPayload,
  resolvedPayload,
  respondersPayload,
  sharedInfoPayload,
  updatedPayload,
  updatePayload,
} from './incident-broadcaster';
import { REALTIME_CONTRACT } from './realtime.contract';
import type {
  IncidentBroadcastState,
  IncidentEventRow,
  IncidentResponderState,
  IncidentSharedInfoState,
  RealtimeReadsRepository,
} from './realtime-reads.repository';

const INCIDENT = 'aaaaaaaa-0000-4000-8000-000000000001';
const RESIDENT = '4f3a1c2d-9e8b-4a7c-b6d5-1234567f9c2d';
const MEMBER = '5e4b2d3c-0f9a-4b8d-a7c6-2345678a0d3e';
const CIRCLE = 'cccccccc-0000-4000-8000-000000000001';
const T = '2026-11-20T10:00:00.123456+00:00';

const ref = { incident_id: INCIDENT, resident_id: RESIDENT, circle_id: CIRCLE };

function state(): IncidentBroadcastState {
  return {
    incident_id: INCIDENT,
    resident_id: RESIDENT,
    circle_id: CIRCLE,
    incident: { status: 'active' },
    status: 'active',
    emergency_type: 'medical',
    activated_at: T,
    sent_at: T,
    renotified_at: null,
    resolved_at: null,
    resolved_reason: null,
    closed_at: null,
    auto_closed: false,
    location_sharing_ended_at: null,
    location_source: 'current',
    location_lat: 1,
    location_lng: 2,
    location_accuracy_m: 3,
    location_captured_at: T,
    incident_notes: null,
    incident_notes_updated_at: null,
    updated_at: T,
    occurred_at: T,
    resident_name: 'Ada',
    delivered_count: 2,
    acknowledged_count: 0,
  };
}

function sharedInfo(): IncidentSharedInfoState {
  return {
    incident_id: INCIDENT,
    share_payload: { blood_type: 'O+', allergies: ['Peanuts', 'Dust'] },
    updated_at: T,
    occurred_at: T,
  };
}

function responderState(): IncidentResponderState {
  return {
    incident_id: INCIDENT,
    resident_id: RESIDENT,
    responder: {
      user_id: MEMBER,
      display_name: 'Milo',
      avatar_url: null,
      status: 'responding',
      acknowledged_at: T,
      status_at: T,
    },
    occurred_at: T,
  };
}

function eventRow(actor: string | null, detail: Record<string, unknown> = {}): IncidentEventRow {
  return {
    incident_id: INCIDENT,
    resident_id: RESIDENT,
    event: {
      id: 'eeeeeeee-0000-4000-8000-000000000001',
      event_type: 'closure_notified',
      occurred_at: T,
      actor_id: actor,
      actor_name: actor === null ? null : actor === RESIDENT ? 'Rita' : 'Milo',
      detail,
    },
  };
}

function setup(row?: IncidentEventRow) {
  const emit = jest.fn();
  const reads = {
    incidentState: jest.fn().mockResolvedValue(state()),
    recipientUserIds: jest.fn().mockResolvedValue([MEMBER]),
    event: jest.fn().mockResolvedValue(row),
    sharedInfo: jest.fn().mockResolvedValue(sharedInfo()),
    responder: jest.fn().mockResolvedValue(responderState()),
  };
  const broadcaster = new IncidentBroadcaster(
    { emit },
    reads as unknown as RealtimeReadsRepository,
  );
  /** `[rooms, event, except]` of every emit. */
  type Call = [string[], string, { event: { detail: unknown; actor_id: unknown } }, string[]?];
  const typed = () => emit.mock.calls as Call[];
  const calls = () => typed().map(([rooms, event, , except]) => [rooms, event, except ?? []]);
  /** The payload of the n-th emit. */
  const payload = (n: number) => typed()[n][2];
  return { broadcaster, emit, reads, calls, payload };
}

describe('eventPayload (D3, D11 per receiver)', () => {
  const detail = { recipient_count: 2, recipient_ids: [MEMBER, RESIDENT] };

  it('the resident gets the row as stored', () => {
    expect(eventPayload(eventRow(RESIDENT, detail), { resident: true })).toEqual({
      incident_id: INCIDENT,
      event: eventRow(RESIDENT, detail).event,
      occurred_at: T,
    });
  });

  it('a member gets no recipient_ids and the actor masked', () => {
    const payload = eventPayload(eventRow(RESIDENT, detail), { resident: false, viewerId: null });
    expect(payload.event.detail).toEqual({ recipient_count: 2 });
    expect(payload.event.actor_id).toBe('4f3a****-****-****-****-********9c2d');
  });

  it('a member who is the actor sees their own id; null stays null', () => {
    expect(
      eventPayload(eventRow(MEMBER), { resident: false, viewerId: MEMBER }).event.actor_id,
    ).toBe(MEMBER);
    expect(eventPayload(eventRow(null), { resident: false, viewerId: null }).event.actor_id).toBe(
      null,
    );
  });

  it('actor_name (D71) is the same for every receiver; null without an actor', () => {
    const row = eventRow(MEMBER);
    expect(eventPayload(row, { resident: true }).event.actor_name).toBe('Milo');
    expect(eventPayload(row, { resident: false, viewerId: null }).event.actor_name).toBe('Milo');
    expect(eventPayload(row, { resident: false, viewerId: MEMBER }).event.actor_name).toBe('Milo');
    expect(eventPayload(eventRow(null), { resident: true }).event.actor_name).toBeNull();
  });

  it('a member gets exactly the contract keys, in order (D71 actor_name)', () => {
    const payload = eventPayload(eventRow(MEMBER, detail), { resident: false, viewerId: null });
    expect(Object.keys(payload.event)).toEqual(
      REALTIME_CONTRACT.server_events['incident.event'].event_keys,
    );
    expect(Object.keys(payload.event)).toEqual([
      'id',
      'event_type',
      'occurred_at',
      'actor_id',
      'actor_name',
      'detail',
    ]);
  });

  it('does not change the row it was given', () => {
    const row = eventRow(RESIDENT, detail);
    eventPayload(row, { resident: false, viewerId: null });
    expect(row.event.detail).toEqual(detail);
  });
});

describe('IncidentBroadcaster incident.closed (SCRUM-63, D61/D62)', () => {
  const closedState = (): IncidentBroadcastState => ({
    ...state(),
    status: 'closed',
    resolved_at: T,
    resolved_reason: 'ended',
    closed_at: T,
    auto_closed: true,
    location_sharing_ended_at: T,
  });

  it('payload: exactly incident_id, status, closed_at, resolved_reason, auto_closed, occurred_at', () => {
    expect(closedPayload(closedState())).toEqual({
      incident_id: INCIDENT,
      status: 'closed',
      closed_at: T,
      resolved_reason: 'ended',
      auto_closed: true,
      occurred_at: T,
    });
  });

  it('one broadcast to the incident room, each recipient and the resident user room, then updated', async () => {
    const { broadcaster, calls, reads } = setup();
    reads.incidentState.mockResolvedValue(closedState());
    await broadcaster.afterClosed({ ...ref, from: 'active' });
    expect(calls()).toEqual([
      [[`incident:${INCIDENT}`, `user:${MEMBER}`, `user:${RESIDENT}`], 'incident.closed', []],
      [[`incident:${INCIDENT}`], 'incident.updated', []],
    ]);
  });

  it('nothing when the row is gone or not closed', async () => {
    const { broadcaster, calls, reads } = setup();
    await broadcaster.afterClosed({ ...ref, from: 'resolved' });
    reads.incidentState.mockResolvedValue(undefined);
    await broadcaster.afterClosed({ ...ref, from: 'resolved' });
    expect(calls()).toEqual([]);
  });
});

describe('IncidentBroadcaster rooms (API-100-41)', () => {
  it('location: incident.location then incident.updated to the incident room', async () => {
    const { broadcaster, calls } = setup();
    await broadcaster.afterLocation(ref);
    expect(calls()).toEqual([
      [[`incident:${INCIDENT}`], 'incident.location', []],
      [[`incident:${INCIDENT}`], 'incident.updated', []],
    ]);
  });

  it('acknowledge: counts to the resident user room only', async () => {
    const { broadcaster, calls } = setup();
    await broadcaster.afterDeliveryCounts({ ...ref, delivered_count: 2, acknowledged_count: 1 });
    expect(calls()).toEqual([[[`user:${RESIDENT}`], 'incident.delivery_counts', []]]);
  });

  it('resolved: resolved, updated, counts', async () => {
    const { broadcaster, calls } = setup();
    await broadcaster.afterResolved({ ...ref, recipient_count: 1 });
    expect(calls().map(([, event]) => event)).toEqual([
      'incident.resolved',
      'incident.updated',
      'incident.delivery_counts',
    ]);
  });

  it('resolved (D48): one broadcast to the incident room, each recipient and the resident user room', async () => {
    const { broadcaster, calls, payload } = setup();
    await broadcaster.afterResolved({ ...ref, recipient_count: 1 });
    expect(calls()[0]).toEqual([
      [`incident:${INCIDENT}`, `user:${MEMBER}`, `user:${RESIDENT}`],
      'incident.resolved',
      [],
    ]);
    expect(Object.keys(payload(0))).not.toContain('recipient_ids');
  });

  it('resolved (D48): no recipients still reaches the room and the resident', async () => {
    const { broadcaster, calls, reads } = setup();
    reads.recipientUserIds.mockResolvedValue([]);
    await broadcaster.afterResolved({ ...ref, recipient_count: 0 });
    expect(calls()[0]).toEqual([
      [`incident:${INCIDENT}`, `user:${RESIDENT}`],
      'incident.resolved',
      [],
    ]);
  });

  it('an event by the resident: full to the resident room, masked to the rest', async () => {
    const { broadcaster, calls, payload } = setup(eventRow(RESIDENT, { recipient_ids: [MEMBER] }));
    await broadcaster.afterEvent({ ...ref, event_id: 'x', event_type: 'closure_notified' });
    expect(calls()).toEqual([
      [[`incident:${INCIDENT}:resident`], 'incident.event', []],
      [[`incident:${INCIDENT}`], 'incident.event', [`incident:${INCIDENT}:resident`]],
    ]);
    expect(payload(1).event.detail).toEqual({});
  });

  it('an event by a member: that member sees their own id, others masked', async () => {
    const { broadcaster, calls, payload } = setup(eventRow(MEMBER));
    await broadcaster.afterEvent({ ...ref, event_id: 'x', event_type: 'closure_notified' });
    const own = `incident:${INCIDENT}:user:${MEMBER}`;
    expect(calls()).toEqual([
      [[`incident:${INCIDENT}:resident`], 'incident.event', []],
      [[`incident:${INCIDENT}`], 'incident.event', [`incident:${INCIDENT}:resident`, own]],
      [[own], 'incident.event', [`incident:${INCIDENT}:resident`]],
    ]);
    expect(payload(1).event.actor_id).toBe('5e4b****-****-****-****-********0d3e');
    expect(payload(2).event.actor_id).toBe(MEMBER);
  });

  it('created submit: incident.incoming to each recipient user room, updated, counts', async () => {
    const { broadcaster, calls, payload } = setup();
    await broadcaster.afterSubmit({ ...ref, submit_outcome: 'created', recipient_count: 1 });
    expect(calls()).toEqual([
      [[`user:${MEMBER}`], 'incident.incoming', []],
      [[`incident:${INCIDENT}`], 'incident.updated', []],
      [[`user:${RESIDENT}`], 'incident.delivery_counts', []],
    ]);
    expect(payload(0)).toEqual({
      incident_id: INCIDENT,
      resident_name: 'Ada',
      emergency_type: 'medical',
      activated_at: T,
      sent_at: T,
      updated_at: T,
      occurred_at: T,
    });
  });

  it('re-notify: incident.renotified to the room and the recipients in one broadcast', async () => {
    const { broadcaster, calls } = setup();
    await broadcaster.afterRenotify({ ...ref, recipient_count: 1 });
    expect(calls()[0]).toEqual([
      [`incident:${INCIDENT}`, `user:${MEMBER}`],
      'incident.renotified',
      [],
    ]);
  });

  it('no recipients: no incoming emit at all', async () => {
    const { broadcaster, calls, reads } = setup();
    reads.recipientUserIds.mockResolvedValue([]);
    await broadcaster.afterSubmit({ ...ref, submit_outcome: 'promoted', recipient_count: 0 });
    expect(calls().map(([, event]) => event)).toEqual([
      'incident.updated',
      'incident.delivery_counts',
    ]);
  });

  it('shared info (D53): incident.shared_info_updated to the incident room only, live payload', async () => {
    const { broadcaster, calls, payload, reads } = setup();
    await broadcaster.afterSharedInfo(ref);
    expect(reads.sharedInfo).toHaveBeenCalledWith(INCIDENT);
    expect(calls()).toEqual([[[`incident:${INCIDENT}`], 'incident.shared_info_updated', []]]);
    expect(payload(0)).toEqual({
      incident_id: INCIDENT,
      share_payload: { blood_type: 'O+', allergies: ['Peanuts', 'Dust'] },
      updated_at: T,
      occurred_at: T,
    });
  });

  it('shared info (D53): a gone incident emits nothing', async () => {
    const { broadcaster, emit, reads } = setup();
    reads.sharedInfo.mockResolvedValue(undefined);
    await broadcaster.afterSharedInfo(ref);
    expect(emit).not.toHaveBeenCalled();
  });

  it('responders (D56): resident full, the member their own row, every other member masked', async () => {
    const { broadcaster, calls, emit, reads } = setup();
    await broadcaster.afterResponders({ ...ref, member_user_id: MEMBER });
    expect(reads.responder).toHaveBeenCalledWith(INCIDENT, MEMBER);
    const residentRoom = `incident:${INCIDENT}:resident`;
    const memberRoom = `incident:${INCIDENT}:user:${MEMBER}`;
    expect(calls()).toEqual([
      [[residentRoom], 'incident.responders', []],
      [[`incident:${INCIDENT}`], 'incident.responders', [residentRoom, memberRoom]],
      [[memberRoom], 'incident.responders', [residentRoom]],
    ]);
    const sent = (n: number) =>
      (emit.mock.calls[n] as [string[], string, { responder: Record<string, unknown> }])[2]
        .responder;
    expect(sent(0)).toMatchObject({ user_id: MEMBER, is_me: false });
    expect(sent(1)).toMatchObject({
      user_id: '5e4b****-****-****-****-********0d3e',
      is_me: false,
    });
    expect(sent(2)).toMatchObject({ user_id: MEMBER, is_me: true });
  });

  it('responders (D56): a member no longer on the list emits nothing', async () => {
    const { broadcaster, emit, reads } = setup();
    reads.responder.mockResolvedValue(undefined);
    await broadcaster.afterResponders({ ...ref, member_user_id: MEMBER });
    expect(emit).not.toHaveBeenCalled();
  });

  it('a gone incident or event emits nothing', async () => {
    const { broadcaster, emit, reads } = setup(undefined);
    reads.incidentState.mockResolvedValue(undefined);
    await broadcaster.afterNotes({ ...ref, cleared: false });
    await broadcaster.afterEvent({ ...ref, event_id: 'x', event_type: 'renotified' });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('IncidentBroadcaster incident.update (SCRUM-44/59, D70)', () => {
  const update = (detail: Record<string, unknown>): IncidentEventRow => {
    const row = eventRow(RESIDENT, detail);
    return { ...row, event: { ...row.event, event_type: 'status_update' } };
  };

  it('payload: the update as the REST list shows it; no id of a person', () => {
    expect(updatePayload(update({ preset: 'help_is_here' }))).toEqual({
      incident_id: INCIDENT,
      update: {
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        preset: 'help_is_here',
        text: null,
        created_at: T,
      },
      occurred_at: T,
    });
    const text = updatePayload(update({ text: 'Door locked' }));
    expect(text.update).toMatchObject({ preset: null, text: 'Door locked' });
    expect(JSON.stringify(text)).not.toContain(RESIDENT);
  });

  it('after the incident.event emits, one incident.update to the incident room', async () => {
    const { broadcaster, calls, payload } = setup(update({ preset: 'situation_worsening' }));
    await broadcaster.afterEvent({ ...ref, event_id: 'x', event_type: 'status_update' });
    expect(calls()).toEqual([
      [[`incident:${INCIDENT}:resident`], 'incident.event', []],
      [[`incident:${INCIDENT}`], 'incident.event', [`incident:${INCIDENT}:resident`]],
      [[`incident:${INCIDENT}`], 'incident.update', []],
    ]);
    expect(payload(2)).toEqual(updatePayload(update({ preset: 'situation_worsening' })));
  });

  it('no incident.update for any other event type', async () => {
    const { broadcaster, calls } = setup(eventRow(RESIDENT));
    await broadcaster.afterEvent({ ...ref, event_id: 'x', event_type: 'closure_notified' });
    expect(calls().map(([, event]) => event)).toEqual(['incident.event', 'incident.event']);
  });
});

describe('the published contract (x-realtime) matches the payloads', () => {
  const events = REALTIME_CONTRACT.server_events;
  it.each([
    ['incident.updated', updatedPayload],
    ['incident.location', locationPayload],
    ['incident.notes', notesPayload],
    ['incident.renotified', renotifiedPayload],
    ['incident.resolved', resolvedPayload],
    ['incident.delivery_counts', deliveryCountsPayload],
    ['incident.incoming', incomingPayload],
    ['incident.closed', closedPayload],
  ] as const)('%s', (name, build) => {
    expect(Object.keys(build(state()))).toEqual(events[name].payload);
  });

  it('incident.shared_info_updated', () => {
    expect(Object.keys(sharedInfoPayload(sharedInfo()))).toEqual(
      events['incident.shared_info_updated'].payload,
    );
  });

  it('incident.responders', () => {
    const payload = respondersPayload(responderState(), { resident: true });
    expect(Object.keys(payload)).toEqual(events['incident.responders'].payload);
    expect(Object.keys(payload.responder)).toEqual(events['incident.responders'].responder_keys);
  });

  it('incident.update', () => {
    const payload = updatePayload(eventRow(RESIDENT, { text: 'x' }));
    expect(Object.keys(payload)).toEqual(events['incident.update'].payload);
    expect(Object.keys(payload.update)).toEqual(events['incident.update'].update_keys);
  });

  it('incident.event', () => {
    const payload = eventPayload(eventRow(RESIDENT), { resident: true });
    expect(Object.keys(payload)).toEqual(events['incident.event'].payload);
    expect(Object.keys(payload.event)).toEqual(events['incident.event'].event_keys);
  });
});
