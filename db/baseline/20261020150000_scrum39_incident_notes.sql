-- SCRUM-39: Optional Emergency Notes (live incident note)
-- Adds incidents.incident_notes + incident_notes_updated_at.
-- Replaces the shared activation JSON so start / set_emergency_type /
-- attach_incident_location / cancel_emergency_activation / send_emergency_alert
-- include both keys (JSON null until set).
-- Adds set_incident_notes(). Does not write profiles.emergency_notes.
-- Does not copy incident_notes into share_payload. Send still succeeds
-- with null notes. In-app only: members already SELECT the active row.
-- No FCM, no Twilio, no Edge Functions.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- public.incidents.incident_notes + incident_notes_updated_at
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column incident_notes text null,
  add column incident_notes_updated_at timestamptz null;

alter table public.incidents
  add constraint incidents_incident_notes_length
    check (
      incident_notes is null
      or char_length(incident_notes) <= 250
    );

comment on column public.incidents.incident_notes is
  'SCRUM-39 live incident note; not profiles.emergency_notes. Max 250. Null until set. Members see it on SELECT of status = active. Not copied into share_payload.';
comment on column public.incidents.incident_notes_updated_at is
  'SCRUM-39: Set whenever set_incident_notes() writes, including a clear to null. Null if never set. Not a send.';
comment on table public.incidents is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39: Emergency loop. One open incident per resident (activating or active). 39 is the live incident note (max 250), not profiles.emergency_notes. 43 send is in-app delivery rows + status active. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- Shared activation JSON — add incident_notes + incident_notes_updated_at.
-- start / type / attach / cancel / send keep the same writers and pick these up.
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
    'incident_notes_updated_at', rec.incident_notes_updated_at
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: Shared start / set_emergency_type / attach_incident_location / cancel_emergency_activation / set_incident_notes return shape. Includes sent_at, share_payload, incident_notes, and incident_notes_updated_at (null until set). Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes emergency_type, location keys, cancelled_at, sent_at, share_payload, incident_notes, and incident_notes_updated_at (null until set). New inserts omit those (defaults/null). Does not notify, attach GPS, cancel, send, or require a circle.';

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 / 40 / 42 / 43 / 39: Set emergency_type on the caller''s activating or active incident. Does not change status, location, activated_at, circle_id, resident_id, cancelled_at, sent_at, share_payload, or incident_notes. Return includes incident_notes. Does not send.';

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 42 / 43 / 39: Attach the activation location snapshot on the caller''s activating or active incident. Overwrite allowed. Does not change status, type, activated_at, circle_id, resident_id, cancelled_at, sent_at, share_payload, or incident_notes. Return includes incident_notes. Does not send. Not live tracking.';

comment on function public.cancel_emergency_activation(uuid) is
  'SCRUM-42 / 43 / 39: Cancel the caller''s activating incident during grace. Idempotent if already cancelled. Does not notify, write active, or delete. Return includes sent_at, share_payload, incident_notes, and incident_notes_updated_at. Timer-end send is send_emergency_alert().';

comment on function public.send_emergency_alert(uuid) is
  'SCRUM-43 / 39: Promote the caller''s activating incident to active, snapshot share_payload from profiles (SCRUM-22 emergency_notes if shareable), insert in-app delivery rows for active members with user_id. Idempotent if already active. Does not require incident_notes. Does not copy incident_notes into share_payload. Does not notify FCM/SMS. Does not write cancelled/resolved. Zero deliveries is success.';

comment on function public._incident_share_payload(public.profiles) is
  'Internal: SCRUM-43 share snapshot. Nine emergency-profile fields gated by SCRUM-24 / 22 flags. Off, null, or blank keys are omitted. No personal-info full_name/DOB. Does not include incidents.incident_notes (SCRUM-39). Clients must not call this.';

-- send_emergency_alert already updates only status, sent_at, share_payload.
-- Null incident_notes still send. Live notes stay on the incident row.

-- ---------------------------------------------------------------------------
-- set_incident_notes(p_incident_id, p_incident_notes) — live note only
-- ---------------------------------------------------------------------------

create or replace function public.set_incident_notes(
  p_incident_id uuid,
  p_incident_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
  v_notes text;
begin
  uid := public._require_auth_uid('set_incident_notes');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'set_incident_notes:not_found';
  end if;

  if rec.status not in ('activating', 'active') then
    raise exception using
      errcode = 'P0001',
      message = 'set_incident_notes:not_open';
  end if;

  -- null / all-whitespace → store null. Else btrim.
  v_notes := nullif(btrim(coalesce(p_incident_notes, '')), '');

  if v_notes is not null and char_length(v_notes) > 250 then
    raise exception using
      errcode = 'P0001',
      message = 'set_incident_notes:too_long';
  end if;

  -- Stamp incident_notes_updated_at even when clearing to null (48 can see a clear).
  -- Do not change status, type, location, sent_at, share_payload, cancelled_at.
  update public.incidents
     set incident_notes = v_notes,
         incident_notes_updated_at = now()
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.set_incident_notes(uuid, text) is
  'SCRUM-39: Set or clear the live incident note on the caller''s activating or active incident. Max 250 after trim. Whitespace/null stores null and still stamps incident_notes_updated_at. Does not change status, type, location, sent_at, share_payload, or cancelled_at. Does not write profiles.emergency_notes. Does not send. In-app only.';

revoke all on function public.set_incident_notes(uuid, text) from public;
revoke all on function public.set_incident_notes(uuid, text) from anon;
grant execute on function public.set_incident_notes(uuid, text) to authenticated;
