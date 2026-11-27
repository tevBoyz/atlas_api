import { Inject, Injectable } from '@nestjs/common';

import { type ResponderViewer, responderView } from '../modules/incidents/incident-responder-view';
import { actorIdFor, HIDDEN_DETAIL_KEYS } from '../modules/incidents/incident-events.service';
import type { MemberDeliveryFailedReason } from '../modules/incidents/incident-delivery-status';
import type {
  IncidentClosedEvent,
  IncidentDeliveryCountsEvent,
  IncidentEventRecordedEvent,
  IncidentLocationEvent,
  IncidentNotesEvent,
  IncidentPostCommitHook,
  IncidentRenotifiedEvent,
  IncidentResolvedEvent,
  IncidentRespondersEvent,
  IncidentSharedInfoEvent,
  IncidentSubmittedEvent,
} from '../modules/incidents/incident-post-commit';
import {
  incidentResidentRoom,
  incidentRoom,
  incidentUserRoom,
  SERVER_EVENTS,
  userRoom,
} from './realtime.constants';
import { REALTIME_EMITTER, type RealtimeEmitter } from './realtime-emitter';
import {
  type IncidentBroadcastState,
  type IncidentEventRow,
  type IncidentResponderState,
  type IncidentSharedInfoState,
  RealtimeReadsRepository,
} from './realtime-reads.repository';

/** `incident.updated` (spec §11.5). */
export function updatedPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    incident: state.incident,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/** `incident.location`. */
export function locationPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    location_source: state.location_source,
    location_lat: state.location_lat,
    location_lng: state.location_lng,
    location_accuracy_m: state.location_accuracy_m,
    location_captured_at: state.location_captured_at,
    location_unavailable_since: state.location_unavailable_since,
    place_name: state.place_name,
    country_code: state.country_code,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/** `incident.notes`. */
export function notesPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    incident_notes: state.incident_notes,
    incident_notes_updated_at: state.incident_notes_updated_at,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/** `incident.renotified`. */
export function renotifiedPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    renotified_at: state.renotified_at,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/** `incident.incoming` (user rooms of the recipients, API-100-42). */
export function incomingPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    resident_name: state.resident_name,
    emergency_type: state.emergency_type,
    activated_at: state.activated_at,
    sent_at: state.sent_at,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/** `incident.resolved`. */
export function resolvedPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    status: state.status,
    resolved_at: state.resolved_at,
    resolved_reason: state.resolved_reason,
    location_sharing_ended_at: state.location_sharing_ended_at,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/**
 * `incident.closed` (SCRUM-63, D61/D62). No ids other than the incident's: the same for every
 * receiver (nothing to mask).
 */
export function closedPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    status: state.status,
    closed_at: state.closed_at,
    resolved_reason: state.resolved_reason,
    auto_closed: state.auto_closed,
    occurred_at: state.occurred_at,
  };
}

/** `incident.shared_info_updated` (SCRUM-21, D53): the live shared info and when it changed. */
export function sharedInfoPayload(state: IncidentSharedInfoState) {
  return {
    incident_id: state.incident_id,
    share_payload: state.share_payload,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/** `incident.delivery_counts` (the resident only), the REST DeliveryCounts keys plus the times. */
export function deliveryCountsPayload(state: IncidentBroadcastState) {
  return {
    incident_id: state.incident_id,
    delivered_count: state.delivered_count,
    acknowledged_count: state.acknowledged_count,
    status: state.status,
    updated_at: state.updated_at,
    occurred_at: state.occurred_at,
  };
}

/**
 * `incident.responders` (D56) as one receiver sees it: the changed member's row with the rules of
 * `GET /v1/incidents/{id}/responders` (the resident full ids; a member others' ids masked, D11).
 */
export function respondersPayload(state: IncidentResponderState, viewer: ResponderViewer) {
  return {
    incident_id: state.incident_id,
    responder: responderView(state.responder, viewer),
    occurred_at: state.occurred_at,
  };
}

/** SCRUM-71 (D73): what `incident.delivery_failed` reports (the resident is told once per member). */
export interface IncidentDeliveryFailedEvent {
  incident_id: string;
  resident_id: string;
  /** Internal only (never sent, D79). */
  member_user_id: string;
  /** D79: the member's membership row id (the responder row's `handle`). */
  member_handle: string;
  display_name: string;
  reason: MemberDeliveryFailedReason;
  occurred_at: string;
}

/**
 * `incident.delivery_failed` (SCRUM-71, D73), to the resident only: which member did not receive the
 * alert (D79: its `handle`, as on the resident's responder list, never a user id; and the display
 * name) and why.
 */
export function deliveryFailedPayload(event: IncidentDeliveryFailedEvent) {
  return {
    incident_id: event.incident_id,
    member: { handle: event.member_handle, display_name: event.display_name },
    reason: event.reason,
    occurred_at: event.occurred_at,
  };
}

/**
 * `incident.event` as one receiver sees it, with the rules of `GET /v1/incidents/{id}/events`
 * (D79): nobody gets `recipient_ids`; `actor_id` is the receiver's own id when they are the actor
 * (the resident's sockets: the resident; `viewerId` for a member's own sockets, null for any other
 * member), else null; `actor_handle` (the actor member's handle) and `actor_name` (D71) are the
 * same for every receiver. Keys in the contract's order.
 */
export function eventPayload(
  row: IncidentEventRow,
  view: { resident: true } | { resident: false; viewerId: string | null },
) {
  const { event } = row;
  const detail = { ...event.detail };
  for (const key of HIDDEN_DETAIL_KEYS) delete detail[key];
  const viewerId = view.resident ? row.resident_id : view.viewerId;
  return {
    incident_id: row.incident_id,
    event: {
      id: event.id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      actor_id: actorIdFor(event.actor_id, viewerId),
      actor_handle: event.actor_handle ?? null,
      actor_name: event.actor_name,
      detail,
    },
    occurred_at: event.occurred_at,
  };
}

/**
 * `incident.update` (SCRUM-44/59, D70) from a `status_update` event row: the update as
 * `GET /v1/incidents/{id}/updates` shows it. No actor, no id of a person: the same for every
 * receiver.
 */
export function updatePayload(row: IncidentEventRow) {
  const { event } = row;
  const value = (key: string) => {
    const found = event.detail[key];
    return typeof found === 'string' ? found : null;
  };
  return {
    incident_id: row.incident_id,
    update: {
      id: event.id,
      preset: value('preset'),
      text: value('text'),
      created_at: event.occurred_at,
    },
    occurred_at: event.occurred_at,
  };
}

/**
 * Incident broadcasts (API-100-41): the realtime post-commit hook of every committed incident write.
 * It runs only after the commit (the runner is called once the transaction has committed, never after
 * a rollback) and is not awaited by the request; a failed read or emit is logged by the runner and
 * never fails the HTTP request. Each broadcast reads the committed state (ids only travel through the
 * hook) and emits to the rooms of spec §11.5:
 *
 * - room `incident:{id}` (the resident and the members inside the window who joined):
 *   `incident.updated` after every write, plus `incident.location` / `incident.notes` /
 *   `incident.renotified` / `incident.resolved` for that write;
 * - `incident.incoming` (created/promoted submit) and `incident.renotified` (re-notify, also a submit
 *   on an active incident) to `user:{id}` of each delivery recipient still inside the window
 *   (API-100-42), so members with the app open learn of the alert without joining anything; and
 *   `incident.resolved` to those user rooms and the resident's (D48), so they learn it ended;
 * - `incident.delivery_counts` to the resident's own sockets (`user:{resident_id}`) on submit,
 *   re-notify, the first acknowledge and the close;
 * - `incident.shared_info_updated` to `incident:{id}` when the resident changed their shared info
 *   during the incident (D53): the live view, never the activation snapshot;
 * - `incident.event` per inserted event, per receiver role: the resident (`incident:{id}:resident`)
 *   the row as stored, the actor's own sockets their own id unmasked, every other member D3/D11;
 * - `incident.responders` (D56) after a member's first acknowledge or a response change, per
 *   receiver the same way: the resident full ids, the member's own sockets their own row in full,
 *   every other member the row with the user id masked;
 * - `incident.responders` again, to the resident's sockets only, when a member's delivery status of
 *   the alert may have changed (SCRUM-65, D73; from the worker), and `incident.delivery_failed` to the
 *   resident's sockets only when a member did not receive the alert (SCRUM-71, D73);
 * - `incident.update` (SCRUM-44/59, D70) to `incident:{id}` after the resident sent a status update
 *   (right after that event's `incident.event`);
 * - `incident.closed` (SCRUM-63) after the close sweeper closed the incident, to the audience of
 *   `incident.resolved`. The sweeper runs in the worker process, so there the emits go through
 *   `WorkerRealtimeEmitter` (Redis adapter) instead of the gateway.
 *
 * Every payload carries `incident_id` and `occurred_at` (database time); row events also carry the
 * row's `updated_at`.
 */
@Injectable()
export class IncidentBroadcaster implements IncidentPostCommitHook {
  constructor(
    @Inject(REALTIME_EMITTER) private readonly gateway: RealtimeEmitter,
    private readonly reads: RealtimeReadsRepository,
  ) {}

  async afterSubmit(event: IncidentSubmittedEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (!state) return;
    if (event.submit_outcome === 'renotified') await this.sendRenotified(state);
    else await this.sendIncoming(state);
    this.sendUpdated(state);
    this.sendCounts(state);
  }

  async afterLocation(event: IncidentLocationEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (!state) return;
    this.gateway.emit(
      [incidentRoom(state.incident_id)],
      SERVER_EVENTS.location,
      locationPayload(state),
    );
    this.sendUpdated(state);
  }

  async afterNotes(event: IncidentNotesEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (!state) return;
    this.gateway.emit([incidentRoom(state.incident_id)], SERVER_EVENTS.notes, notesPayload(state));
    this.sendUpdated(state);
  }

  async afterRenotify(event: IncidentRenotifiedEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (!state) return;
    await this.sendRenotified(state);
    this.sendUpdated(state);
    this.sendCounts(state);
  }

  /**
   * `incident.resolved` to the incident room AND (gap 17, D48) to `user:{id}` of every delivery
   * recipient still inside the window and of the resident, in ONE broadcast (a socket in several of
   * these rooms gets it once): a member who is not watching the alert (only `incident.incoming`
   * reached them) learns it ended, so "Active incident" clears live. Same payload as in the room (no
   * recipient ids, no actor, D3/D11); ordered by `occurred_at` (D21).
   */
  async afterResolved(event: IncidentResolvedEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (!state) return;
    const recipients = await this.reads.recipientUserIds(state.incident_id);
    const userRooms = [...new Set([...recipients, state.resident_id])].map(userRoom);
    this.gateway.emit(
      [incidentRoom(state.incident_id), ...userRooms],
      SERVER_EVENTS.resolved,
      resolvedPayload(state),
    );
    this.sendUpdated(state);
    this.sendCounts(state);
  }

  /**
   * `incident.closed` (SCRUM-63, D61/D62), from the close sweeper in the worker process: to the
   * incident room AND `user:{id}` of every delivery recipient still inside the window and of the
   * resident, in ONE broadcast (the audience of `incident.resolved`, D48), so a member or the resident
   * not watching the alert sees it become Closed. Then `incident.updated` to the incident room, as
   * after every write. Nothing when the row is gone or not closed (any more).
   */
  async afterClosed(event: IncidentClosedEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (state?.status !== 'closed') return;
    const recipients = await this.reads.recipientUserIds(state.incident_id);
    const userRooms = [...new Set([...recipients, state.resident_id])].map(userRoom);
    this.gateway.emit(
      [incidentRoom(state.incident_id), ...userRooms],
      SERVER_EVENTS.closed,
      closedPayload(state),
    );
    this.sendUpdated(state);
  }

  async afterDeliveryCounts(event: IncidentDeliveryCountsEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (state) this.sendCounts(state);
  }

  /**
   * `incident.shared_info_updated` (SCRUM-21, D53) to the incident room: the resident and the members
   * inside the window who joined it (the join is re-checked per join, D20; a removed member's sockets
   * were evicted). The live payload holds only what the resident shares now (a flag turned off
   * removes that key). No actor, no recipient ids (D3/D11).
   */
  async afterSharedInfo(event: IncidentSharedInfoEvent): Promise<void> {
    const state = await this.reads.sharedInfo(event.incident_id);
    if (!state) return;
    this.gateway.emit(
      [incidentRoom(state.incident_id)],
      SERVER_EVENTS.sharedInfoUpdated,
      sharedInfoPayload(state),
    );
  }

  /**
   * `incident.responders` (D56) to the incident room, one emit per receiver role (a socket gets it
   * once): the resident's sockets (`incident:{id}:resident`) the row with the full user id; the
   * member's own sockets (`incident:{id}:user:{uid}`) their row in full with `is_me` true; every other
   * joined member the row with the user id masked (D11). Nothing when the member is no longer on the
   * list (membership ended since the write).
   */
  async afterResponders(event: IncidentRespondersEvent): Promise<void> {
    const state = await this.reads.responder(event.incident_id, event.member_user_id);
    if (!state) return;
    const id = state.incident_id;
    const member = state.responder.user_id;
    const residentRoom = incidentResidentRoom(id);
    const memberRoom = incidentUserRoom(id, member);
    this.gateway.emit(
      [residentRoom],
      SERVER_EVENTS.responders,
      respondersPayload(state, { resident: true }),
    );
    this.gateway.emit(
      [incidentRoom(id)],
      SERVER_EVENTS.responders,
      // Every member who is not the row's member: masked (an empty viewer id matches no row).
      respondersPayload(state, { resident: false, viewerId: '' }),
      [residentRoom, memberRoom],
    );
    this.gateway.emit(
      [memberRoom],
      SERVER_EVENTS.responders,
      respondersPayload(state, { resident: false, viewerId: member }),
      [residentRoom],
    );
  }

  /**
   * SCRUM-65 (D73), from the worker: a member's alert push rows changed (one became final, or a
   * notice was fanned out), so their delivery status may have changed. The resident's sockets
   * (`incident:{id}:resident`) get the member's row as the resident sees it (with the delivery
   * keys). Members get nothing: their view of the row did not change. Nothing when the member is no
   * longer on the list.
   */
  async afterDeliveryStatus(event: { incident_id: string; member_user_id: string }): Promise<void> {
    const state = await this.reads.responder(event.incident_id, event.member_user_id);
    if (!state) return;
    this.gateway.emit(
      [incidentResidentRoom(state.incident_id)],
      SERVER_EVENTS.responders,
      respondersPayload(state, { resident: true }),
    );
  }

  /** SCRUM-71 (D73): `incident.delivery_failed` to the resident's sockets of the incident only. */
  afterDeliveryFailed(event: IncidentDeliveryFailedEvent): Promise<void> {
    this.gateway.emit(
      [incidentResidentRoom(event.incident_id)],
      SERVER_EVENTS.deliveryFailed,
      deliveryFailedPayload(event),
    );
    return Promise.resolve();
  }

  async afterEvent(event: IncidentEventRecordedEvent): Promise<void> {
    const row = await this.reads.event(event.event_id);
    if (!row) return;
    const id = row.incident_id;
    const actor = row.event.actor_id;
    this.gateway.emit(
      [incidentResidentRoom(id)],
      SERVER_EVENTS.event,
      eventPayload(row, { resident: true }),
    );
    const actorIsMember = actor !== null && actor !== row.resident_id;
    this.gateway.emit(
      [incidentRoom(id)],
      SERVER_EVENTS.event,
      eventPayload(row, { resident: false, viewerId: null }),
      actorIsMember
        ? [incidentResidentRoom(id), incidentUserRoom(id, actor)]
        : [incidentResidentRoom(id)],
    );
    if (actorIsMember) {
      this.gateway.emit(
        [incidentUserRoom(id, actor)],
        SERVER_EVENTS.event,
        eventPayload(row, { resident: false, viewerId: actor }),
        [incidentResidentRoom(id)],
      );
    }
    if (row.event.event_type === 'status_update') {
      this.gateway.emit([incidentRoom(id)], SERVER_EVENTS.update, updatePayload(row));
    }
  }

  private state(incidentId: string): Promise<IncidentBroadcastState | undefined> {
    return this.reads.incidentState(incidentId);
  }

  private sendUpdated(state: IncidentBroadcastState): void {
    this.gateway.emit(
      [incidentRoom(state.incident_id)],
      SERVER_EVENTS.updated,
      updatedPayload(state),
    );
  }

  private sendCounts(state: IncidentBroadcastState): void {
    this.gateway.emit(
      [userRoom(state.resident_id)],
      SERVER_EVENTS.deliveryCounts,
      deliveryCountsPayload(state),
    );
  }

  /**
   * `incident.renotified` to the incident room and to `user:{id}` of every recipient (API-100-42
   * AC2), in one broadcast: a socket in both gets it once.
   */
  private async sendRenotified(state: IncidentBroadcastState): Promise<void> {
    const recipients = await this.reads.recipientUserIds(state.incident_id);
    this.gateway.emit(
      [incidentRoom(state.incident_id), ...recipients.map(userRoom)],
      SERVER_EVENTS.renotified,
      renotifiedPayload(state),
    );
  }

  /**
   * `incident.incoming` to `user:{id}` of every recipient of a created/promoted submit (API-100-42
   * AC1, AC3): the delivery rows the submit wrote (D14) whose user still passes the window.
   */
  private async sendIncoming(state: IncidentBroadcastState): Promise<void> {
    const recipients = await this.reads.recipientUserIds(state.incident_id);
    if (recipients.length === 0) return;
    this.gateway.emit(recipients.map(userRoom), SERVER_EVENTS.incoming, incomingPayload(state));
  }
}
