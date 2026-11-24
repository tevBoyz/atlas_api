-- SCRUM-44 (Send Status Updates) + SCRUM-59 (Resident Status Updates, Broadcast), decision D70: a
-- resident's status update ("Situation worsening", "Help is here" or free text) is one
-- `incident_events` row of the new type `status_update`, detail `{preset}` or `{text}`, written only
-- by the API (`POST /v1/incidents/{id}/updates`).
--
-- Additive and backward compatible (AGENTS.md rule 4): the event-type check only grows (every
-- existing row and every existing writer stays valid). `status_update` may repeat, so it is NOT added
-- to `incident_events_once_per_incident_uidx`. Nothing else changes (the table keeps its lockdown,
-- its index and its other checks). Re-runnable on a fresh database after the baseline.

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
      'status_update'
    ));

comment on column public.incident_events.event_type is
  'alert_sent | renotified | location_sharing_started | location_sharing_ended | safe_recorded | '
  'incident_closed | closure_notified | status_update (SCRUM-44/59, D70: the resident''s status '
  'update, detail {preset} or {text}; may repeat).';
