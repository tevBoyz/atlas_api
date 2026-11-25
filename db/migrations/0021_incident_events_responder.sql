-- SCRUM-60 (Incident Activity Feed) + SCRUM-61 (Live Incident Timeline), decision D71: a member's
-- acknowledge and each change of their response status are recorded as `incident_events` rows of
-- two new types, written only by the API, actor = that member:
-- - `responder_acknowledged` (detail `{}`): `POST /v1/incidents/{id}/acknowledge`, or the implicit
--   acknowledge of the first `POST /v1/incidents/{id}/response`; only when `acknowledged_at` is set
--   for the first time;
-- - `responder_status` (detail `{status: "responding" | "unable"}`): `POST /v1/incidents/{id}/response`
--   when the stored status actually changes.
--
-- Additive and backward compatible (AGENTS.md rule 4): the event-type check only grows (every
-- existing row and every existing writer stays valid). Both types repeat per incident (one per member,
-- one per change), so neither is added to `incident_events_once_per_incident_uidx`. Nothing else
-- changes (the table keeps its lockdown, its index and its other checks). Re-runnable on a fresh
-- database after the baseline.

alter table public.incident_events
  drop constraint if exists incident_events_type_allowed,
  add constraint incident_events_type_allowed
    check (event_type in (
      'alert_sent',
      'renotified',
      'location_sharing_started',
      'location_sharing_ended',
      'safe_recorded',
      'incident_closed',
      'closure_notified',
      'status_update',
      'responder_acknowledged',
      'responder_status'
    ));

comment on column public.incident_events.event_type is
  'alert_sent | renotified | location_sharing_started | location_sharing_ended | safe_recorded | '
  'incident_closed | closure_notified | status_update (SCRUM-44/59, D70: the resident''s status '
  'update, detail {preset} or {text}; may repeat) | responder_acknowledged (SCRUM-60/61, D71: a '
  'member''s first acknowledge, detail {}; once per member) | responder_status (SCRUM-60/61, D71: a '
  'member''s response status change, detail {status}; may repeat).';
