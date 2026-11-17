-- SCRUM-72: Duplicate Incident Prevention
-- Adds incidents.renotified_at (null until the first in-app re-notify).
-- Replaces the shared activation JSON so start / set_emergency_type /
-- attach_incident_location / cancel_emergency_activation / set_incident_notes /
-- send_emergency_alert include renotified_at (JSON null until set).
-- Adds renotify_emergency_alert(). Does not change start. Does not insert
-- a second incident or extra delivery rows. Refreshes delivered_at only.
-- Leaves acknowledged_at. In-app only: no FCM, no Twilio, no Edge Functions.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- public.incidents.renotified_at
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column renotified_at timestamptz null;

comment on column public.incidents.renotified_at is
  'SCRUM-72 last in-app re-notify; not a new incident; not sent_at.';

comment on table public.incidents is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39 / 72: Emergency loop. One open incident per resident (activating or active). 72 re-notifies the existing active incident in-app (renotified_at). Not a second incident. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- Shared activation JSON — add renotified_at (null until re-notify).
-- start / type / attach / cancel / notes / send keep the same writers.
-- ---------------------------------------------------------------------------

create or replace function public._incident_activation_json(rec public.incidents)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', rec.id,
    'resident_id', rec.resident_id,
    'circle_id', rec.circle_id,
    'status', rec.status,
    'activated_at', rec.activated_at,
    'emergency_type', rec.emergency_type,
    'location_lat', rec.location_lat,
    'location_lng', rec.location_lng,
    'location_accuracy_m', rec.location_accuracy_m,
    'location_captured_at', rec.location_captured_at,
    'location_source', rec.location_source,
    'cancelled_at', rec.cancelled_at,
    'sent_at', rec.sent_at,
    'share_payload', rec.share_payload,
    'incident_notes', rec.incident_notes,
    'incident_notes_updated_at', rec.incident_notes_updated_at,
    'renotified_at', rec.renotified_at
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: Shared start / set_emergency_type / attach_incident_location / cancel_emergency_activation / set_incident_notes return shape. Includes sent_at, share_payload, incident_notes, incident_notes_updated_at, and renotified_at (null until re-notify). Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

comment on function public._incident_send_json(public.incidents) is
  'Internal: Shared incident shape (including renotified_at) plus delivered_count and acknowledged_count. Clients must not call this.';

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39 / 72: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes renotified_at (null until re-notify). New inserts and idempotent retries do not set renotified_at. Does not notify, attach GPS, cancel, send, re-notify, or require a circle. One open row is incidents_one_open_per_resident_uidx.';

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 / 40 / 42 / 43 / 39 / 72: Set emergency_type on the caller''s activating or active incident. Does not change status, location, activated_at, circle_id, resident_id, cancelled_at, sent_at, share_payload, incident_notes, or renotified_at. Return includes renotified_at. Does not send or re-notify.';

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 42 / 43 / 39 / 72: Attach the activation location snapshot on the caller''s activating or active incident. Overwrite allowed. Does not change status, type, activated_at, circle_id, resident_id, cancelled_at, sent_at, share_payload, incident_notes, or renotified_at. Return includes renotified_at. Does not send or re-notify. Not live tracking.';

comment on function public.cancel_emergency_activation(uuid) is
  'SCRUM-42 / 43 / 39 / 72: Cancel the caller''s activating incident during grace. Idempotent if already cancelled. Does not set renotified_at. Does not notify, write active, or delete. Return includes renotified_at (null on cancel-before-re-notify). Timer-end send is send_emergency_alert().';

comment on function public.set_incident_notes(uuid, text) is
  'SCRUM-39 / 72: Set or clear the live incident note on the caller''s activating or active incident. Max 250 after trim. Whitespace/null stores null and still stamps incident_notes_updated_at. Does not change status, type, location, sent_at, share_payload, cancelled_at, or renotified_at. Does not write profiles.emergency_notes. Does not send or re-notify. In-app only.';

comment on function public.send_emergency_alert(uuid) is
  'SCRUM-43 / 39 / 72: Promote the caller''s activating incident to active, snapshot share_payload, insert in-app delivery rows for active members with user_id. Idempotent if already active. Does not set renotified_at. Does not notify FCM/SMS. Does not write cancelled/resolved. Zero deliveries is success. Re-notify is renotify_emergency_alert().';

-- ---------------------------------------------------------------------------
-- renotify_emergency_alert(p_incident_id) — in-app refresh of the same incident
-- ---------------------------------------------------------------------------

create or replace function public.renotify_emergency_alert(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('renotify_emergency_alert');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'renotify_emergency_alert:not_found';
  end if;

  -- Grace (activating), cancelled, and resolved are not a re-notify.
  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'renotify_emergency_alert:not_open';
  end if;

  -- Signal only. Do not change status, activated_at, sent_at, share_payload,
  -- type, location, notes, or cancelled_at. Do not insert an incident.
  update public.incidents
     set renotified_at = now()
   where id = rec.id
  returning * into rec;

  -- Same members. No new delivery rows. Ack history stays.
  -- Zero rows is success.
  update public.incident_deliveries
     set delivered_at = now()
   where incident_id = rec.id;

  return public._incident_send_json(rec);
end;
$$;

comment on function public.renotify_emergency_alert(uuid) is
  'SCRUM-72: Re-notify the caller''s active incident in-app. Sets only renotified_at and refreshes existing incident_deliveries.delivered_at. Leaves acknowledged_at. Does not insert an incident or delivery rows. Does not change status, sent_at, or share_payload. activating/cancelled/resolved raise not_open. Each call moves renotified_at forward. Zero deliveries is success. Not FCM/SMS.';

revoke all on function public.renotify_emergency_alert(uuid) from public;
revoke all on function public.renotify_emergency_alert(uuid) from anon;
grant execute on function public.renotify_emergency_alert(uuid) to authenticated;
