/**
 * Realtime contract (spec §11.5, API-100-39 to 42): the Socket.IO namespace, the engine path, the room
 * names and the event names. The mobile client and the hand-off note (`docs/phase4_handoff.md`) use
 * exactly these strings.
 */

/** The one Socket.IO namespace (API-100-39 AC1). Every other namespace is refused. */
export const REALTIME_NAMESPACE = '/v1/realtime';

/** The engine.io HTTP path on the API's own server (Socket.IO's default). */
export const REALTIME_PATH = '/socket.io';

/** `connect_error` code of a missing, invalid or expired handshake token (API-100-39 AC2). */
export const SESSION_EXPIRED_CODE = 'auth:session_expired';

/** `connect_error` code when the token could not be checked at all (e.g. JWKS unreachable). */
export const AUTH_UNAVAILABLE_CODE = 'internal:error';

/** Largest client packet accepted (joins and leaves only carry an incident id). */
export const REALTIME_MAX_PACKET_BYTES = 16 * 1024;

/** Joins allowed per socket per {@link JOIN_RATE_WINDOW_MS}; more answer `rate_limit:exceeded`. */
export const JOIN_RATE_MAX = 60;
export const JOIN_RATE_WINDOW_MS = 60_000;

/** Client → server events. */
export const CLIENT_EVENTS = {
  join: 'incident.join',
  leave: 'incident.leave',
} as const;

/** Server → client events (spec §11.5). */
export const SERVER_EVENTS = {
  updated: 'incident.updated',
  location: 'incident.location',
  notes: 'incident.notes',
  renotified: 'incident.renotified',
  resolved: 'incident.resolved',
  deliveryCounts: 'incident.delivery_counts',
  event: 'incident.event',
  incoming: 'incident.incoming',
  /** The resident changed their shared info during the incident: the live view (SCRUM-21, D53). */
  sharedInfoUpdated: 'incident.shared_info_updated',
  /** One member's responder row changed: acknowledged, responding or unable (D56). */
  responders: 'incident.responders',
  /** The incident became Closed: after the wrap-up, or automatically after inactivity (D61, D62). */
  closed: 'incident.closed',
  /** To `user:{id}` of a member whose membership was removed or who left (D49). */
  membershipEnded: 'circle.membership_ended',
  /** Sent just before the server disconnects a socket whose token reached `exp` (API-100-39 AC4). */
  sessionExpired: 'session.expired',
} as const;

/** Every authorized socket of one incident: the resident and the members inside the window. */
export function incidentRoom(incidentId: string): string {
  return `incident:${incidentId}`;
}

/** The resident's sockets in the incident room (full event details, D3/D11). */
export function incidentResidentRoom(incidentId: string): string {
  return `incident:${incidentId}:resident`;
}

/** One user's sockets in the incident room (an event they acted in shows their own id, D11). */
export function incidentUserRoom(incidentId: string, userId: string): string {
  return `incident:${incidentId}:user:${userId}`;
}

/** Every socket of one user; each socket joins its own on connect (API-100-39 AC3). */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}
