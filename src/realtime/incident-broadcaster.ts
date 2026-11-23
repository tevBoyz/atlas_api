import { Injectable } from '@nestjs/common';

import { maskActorId } from '../modules/incidents/incident-actor-mask';
import { RESIDENT_ONLY_DETAIL_KEYS } from '../modules/incidents/incident-events.service';
import type {
  IncidentDeliveryCountsEvent,
  IncidentEventRecordedEvent,
  IncidentLocationEvent,
  IncidentNotesEvent,
  IncidentPostCommitHook,
  IncidentRenotifiedEvent,
  IncidentResolvedEvent,
  IncidentSubmittedEvent,
} from '../modules/incidents/incident-post-commit';
import {
  incidentResidentRoom,
  incidentRoom,
  incidentUserRoom,
  SERVER_EVENTS,
  userRoom,
} from './realtime.constants';
import { RealtimeGateway } from './realtime.gateway';
import {
  type IncidentBroadcastState,
  type IncidentEventRow,
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
 * `incident.event` as one receiver sees it, with the rules of `GET /v1/incidents/{id}/events`:
 * the resident gets the row as stored; anyone else never gets `recipient_ids` (D3) and gets
 * `actor_id` masked (D11) unless it is their own id (`viewerId`; null = a member who is not the
 * actor).
 */
export function eventPayload(
  row: IncidentEventRow,
  view: { resident: true } | { resident: false; viewerId: string | null },
) {
  const { event } = row;
  if (view.resident) {
    return { incident_id: row.incident_id, event, occurred_at: event.occurred_at };
  }
  const detail = { ...event.detail };
  for (const key of RESIDENT_ONLY_DETAIL_KEYS) delete detail[key];
  return {
    incident_id: row.incident_id,
    event: { ...event, actor_id: maskActorId(event.actor_id, view.viewerId ?? ''), detail },
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
 * - `incident.event` per inserted event, per receiver role: the resident (`incident:{id}:resident`)
 *   the row as stored, the actor's own sockets their own id unmasked, every other member D3/D11.
 *
 * Every payload carries `incident_id` and `occurred_at` (database time); row events also carry the
 * row's `updated_at`.
 */
@Injectable()
export class IncidentBroadcaster implements IncidentPostCommitHook {
  constructor(
    private readonly gateway: RealtimeGateway,
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

  async afterDeliveryCounts(event: IncidentDeliveryCountsEvent): Promise<void> {
    const state = await this.state(event.incident_id);
    if (state) this.sendCounts(state);
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
