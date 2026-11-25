import {
  CLIENT_EVENTS,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  SERVER_EVENTS,
  SESSION_EXPIRED_CODE,
} from './realtime.constants';

/**
 * The realtime contract (spec §11.5, API-100-39 to 43) as data, published in `openapi.json` under the
 * root extension `x-realtime` (OpenAPI has no Socket.IO vocabulary; the REST generator ignores `x-`
 * keys). `docs/phase4_handoff.md` explains it for the app. Payload keys are listed in the order the
 * server sends them.
 */
const TIMES = ['updated_at', 'occurred_at'];

export const REALTIME_CONTRACT = {
  transport: 'Socket.IO 4 (Engine.IO 4), websocket only, on the API host',
  namespace: REALTIME_NAMESPACE,
  path: REALTIME_PATH,
  handshake: {
    auth: { token: '<access token, the same as the REST bearer token>' },
    connect_error_codes: [SESSION_EXPIRED_CODE, 'internal:error'],
    note:
      'Missing, invalid or expired token: connect_error with message and data.code ' +
      `"${SESSION_EXPIRED_CODE}". The server disconnects the socket at the token's exp ` +
      `(after "${SERVER_EVENTS.sessionExpired}"); reconnect with a fresh token.`,
  },
  reconnect:
    'Events are never replayed and rooms are not restored: after any (re)connect the client ' +
    're-fetches over REST (open incident, delivery counts, details) and joins its incidents again.',
  client_events: {
    [CLIENT_EVENTS.join]: {
      payload: ['incident_id'],
      ack: [
        '{"ok": true}',
        '{"ok": false, "error": {"code": "get_incident_details:not_found"}}',
        '{"ok": false, "error": {"code": "validation:invalid_request"}}',
        '{"ok": false, "error": {"code": "rate_limit:exceeded"}}',
        '{"ok": false, "error": {"code": "internal:error"}}',
      ],
      note: 'Allowed for the resident, or a member passing incident.memberView inside the membership window; re-checked on every join.',
    },
    [CLIENT_EVENTS.leave]: { payload: ['incident_id'], ack: ['{"ok": true}'] },
  },
  server_events: {
    [SERVER_EVENTS.updated]: {
      room: 'incident:{id}',
      payload: ['incident_id', 'incident', ...TIMES],
      incident_keys: [
        'emergency_type',
        'status',
        'sent_at',
        'renotified_at',
        'resolved_at',
        'resolved_reason',
        'auto_closed',
        'location_lat',
        'location_lng',
        'location_accuracy_m',
        'location_captured_at',
        'location_source',
        'location_sharing_ended_at',
        'incident_notes',
        'incident_notes_updated_at',
        'share_payload',
        'closed_at',
        'location_unavailable_since',
      ],
    },
    [SERVER_EVENTS.location]: {
      room: 'incident:{id}',
      payload: [
        'incident_id',
        'location_source',
        'location_lat',
        'location_lng',
        'location_accuracy_m',
        'location_captured_at',
        'location_unavailable_since',
        ...TIMES,
      ],
      note:
        'SCRUM-68 (D74): location_unavailable_since is set (since when) while the phone of the resident ' +
        'reports live location unavailable; the location keys then keep the last known fix ' +
        '(label it "Last known · N min ago" from location_captured_at, with "Location unavailable"). ' +
        'With no fix ever stored, location_source is "unavailable" and the position keys are null. ' +
        'The next fix clears it.',
    },
    [SERVER_EVENTS.notes]: {
      room: 'incident:{id}',
      payload: ['incident_id', 'incident_notes', 'incident_notes_updated_at', ...TIMES],
    },
    [SERVER_EVENTS.renotified]: {
      room: 'incident:{id} and user:{id} of each delivery recipient',
      payload: ['incident_id', 'renotified_at', ...TIMES],
    },
    [SERVER_EVENTS.resolved]: {
      room: 'incident:{id}, user:{id} of each delivery recipient and user:{resident_id} (D48; once per socket)',
      payload: [
        'incident_id',
        'status',
        'resolved_at',
        'resolved_reason',
        'location_sharing_ended_at',
        ...TIMES,
      ],
    },
    [SERVER_EVENTS.update]: {
      room: 'incident:{id}',
      payload: ['incident_id', 'update', 'occurred_at'],
      update_keys: ['id', 'preset', 'text', 'created_at'],
      note:
        'SCRUM-44/59 (D70): sent after the resident sent a status update ' +
        '(POST /v1/incidents/{id}/updates), right after its incident.event (event_type ' +
        '"status_update"). update is the entry exactly as GET /v1/incidents/{id}/updates shows it: ' +
        'preset "situation_worsening" or "help_is_here" with text null, or text with preset null; ' +
        'created_at = occurred_at. No id of a person. Members also get a push (topic ' +
        'incident.status_update). After a reconnect, re-fetch the list over REST.',
    },
    [SERVER_EVENTS.closed]: {
      room: 'incident:{id}, user:{id} of each delivery recipient and user:{resident_id} (as incident.resolved; once per socket)',
      payload: [
        'incident_id',
        'status',
        'closed_at',
        'resolved_reason',
        'auto_closed',
        'occurred_at',
      ],
      note:
        'SCRUM-63 (D61, D62): sent after the close sweeper (worker, once a minute) closed the ' +
        'incident: Resolved (Safe) -> Closed after the wrap-up (resolved_reason "safe", auto_closed ' +
        'false), or Active -> Closed after the inactivity period (resolved_reason "ended", ' +
        'auto_closed true: "Closed automatically"). status is "closed"; the incident is final and ' +
        'read-only. No push, SMS or email is sent at the close. Followed by incident.updated and ' +
        'incident.event in the incident room.',
    },
    [SERVER_EVENTS.deliveryCounts]: {
      room: 'user:{resident_id}',
      payload: ['incident_id', 'delivered_count', 'acknowledged_count', 'status', ...TIMES],
    },
    [SERVER_EVENTS.event]: {
      room: 'incident:{id} (per receiver: recipient_ids only for the resident, actor_id masked for others except their own id)',
      payload: ['incident_id', 'event', 'occurred_at'],
      event_keys: ['id', 'event_type', 'occurred_at', 'actor_id', 'actor_name', 'detail'],
      note:
        'One per inserted incident_events row, as GET /v1/incidents/{id}/events shows it to that ' +
        'receiver. actor_name (D71) is the display name of the actor (null when actor_id is null), ' +
        'the same for every receiver: show it instead of any id. SCRUM-60/61 (D71) event types ' +
        'responder_acknowledged (detail {}) and responder_status (detail {status: "responding" | ' +
        '"unable"}) are sent when a member acknowledges or changes their response; no push.',
    },
    [SERVER_EVENTS.incoming]: {
      room: 'user:{id} of each delivery recipient',
      payload: [
        'incident_id',
        'resident_name',
        'emergency_type',
        'activated_at',
        'sent_at',
        ...TIMES,
      ],
    },
    [SERVER_EVENTS.sharedInfoUpdated]: {
      room: 'incident:{id}',
      payload: ['incident_id', 'share_payload', 'updated_at', 'occurred_at'],
      note:
        'SCRUM-21 (D53): sent after the resident changed their shared emergency info during an active ' +
        'incident. share_payload is the live view (only what is shared now; allergies and ' +
        'medical_conditions are arrays of strings); updated_at = when it last changed ' +
        '(live_share_updated_at). The activation snapshot never changes. SCRUM-52 (D59): ' +
        'turning share_phone on or off adds or removes resident_phone here.',
    },
    [SERVER_EVENTS.responders]: {
      room: 'incident:{id} (per receiver: user_id in full for the resident and for the member whose row it is, masked as incident.event actor_id for other members)',
      payload: ['incident_id', 'responder', 'occurred_at'],
      responder_keys: [
        'user_id',
        'display_name',
        'avatar_url',
        'status',
        'acknowledged_at',
        'status_at',
        'is_me',
      ],
      resident_responder_keys: [
        'user_id',
        'display_name',
        'avatar_url',
        'status',
        'acknowledged_at',
        'status_at',
        'is_me',
        'delivery_status',
        'delivery_at',
        'delivery_failed_reason',
      ],
      note:
        'SCRUM-49/50/51/55 (D56): sent after a member acknowledged for the first time or set or ' +
        'changed their response (responding / unable). responder is the row of that member exactly ' +
        'as GET /v1/incidents/{id}/responders shows it to the receiver; replace the row with the ' +
        'same user_id (the masked id is stable per member). Not sent for a repeat that changed ' +
        "nothing. After a reconnect, re-fetch the list over REST. SCRUM-65 (D73): the resident's " +
        'copy (room incident:{id}:resident) has resident_responder_keys (the 3 delivery keys after ' +
        'is_me); members get exactly responder_keys. The resident also gets it (alone) whenever a ' +
        "member's delivery status of the alert may have changed (sent / delivered / failed).",
    },
    [SERVER_EVENTS.deliveryFailed]: {
      room: "incident:{id}:resident (the resident's sockets of the incident only; never a member)",
      payload: ['incident_id', 'member', 'reason', 'occurred_at'],
      member_keys: ['user_id', 'display_name'],
      note:
        'SCRUM-71 (D73): a member did not receive the alert: every push attempt failed after the ' +
        'retries (reason "failed"), or nothing could be sent (reason "no_device": no device with ' +
        'notifications, or push switched off). Sent once per member per incident (a later failure ' +
        'after a re-notify is not reported again), only while the incident is active. member.user_id ' +
        "is the full id (as on the resident's responder list). The resident also gets a push " +
        '(topic incident.delivery_failed, title "Alert not delivered", body "<display name> ' +
        'didn\'t receive your alert"). Not replayed after a reconnect: the responder list ' +
        '(delivery_status) is the state.',
    },
    [SERVER_EVENTS.membershipEnded]: {
      room: 'user:{id} of the member who was removed or left (all their sockets; D49)',
      payload: ['circle_id', 'occurred_at'],
      note:
        'Sent after the commit, right after the sockets left the incident rooms of that circle (D20). ' +
        'No reason and no names: screens of that circle show the neutral "no longer available" state.',
    },
    [SERVER_EVENTS.testAlert]: {
      room: 'user:{id} of each recipient of the test alert (the active members of the circle when it was sent)',
      payload: ['test_alert_id', 'owner_name', 'created_at', 'occurred_at'],
      note:
        'SCRUM-35 (D67): sent by the API right after the circle owner sent a test alert ' +
        '(POST /v1/me/circle/test-alerts). Show the TEST ALERT — NOT AN EMERGENCY banner and open ' +
        'GET /v1/test-alerts/{test_alert_id}; never an SOS, never an incident. occurred_at = ' +
        'created_at (the send time). Pending, declined, removed or left members and outsiders never ' +
        'get it. Not replayed after a reconnect.',
    },
    [SERVER_EVENTS.sessionExpired]: { room: 'the socket', payload: ['code'] },
  },
} as const;
