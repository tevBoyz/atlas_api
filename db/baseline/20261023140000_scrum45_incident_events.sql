-- SCRUM-41 / 43 / 45: Location-sharing session end + incident timeline events
-- 1. incidents.location_sharing_ended_at — the backend marks the live
--    location session ended when mark_incident_safe closes the incident.
--    Legacy resolved rows are backfilled with resolved_at.
-- 2. public.incident_events — append-only audit timeline. Written only inside
--    SECURITY DEFINER functions (no client INSERT/UPDATE/DELETE).
--    Resident reads own; active circle members read while the incident is
--    active or resolved (via _can_view_incident_events, no RLS recursion).
-- 3. mark_incident_safe — one confirm records safe + closes + ends location
--    sharing + logs safe_recorded, incident_closed, location_sharing_ended,
--    closure_notified exactly once. Idempotent retries add nothing.
-- 4. renotify_emergency_alert — also logs a renotified event.
-- 5. attach_incident_location — not_open unless status = active and the
--    location session has not ended, so delayed pings cannot reactivate.
-- 6. get_incident_details — adds location_sharing_ended_at for members.
-- alert_sent / location_sharing_started are written by submit_emergency_alert
-- (next migration). In-app only: no FCM, no Twilio, no Edge Functions.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- public.incidents.location_sharing_ended_at
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column location_sharing_ended_at timestamptz null;

-- Legacy resolved rows: live sharing ended when they were resolved.
alter table public.incidents disable trigger incidents_set_updated_at;

update public.incidents
   set location_sharing_ended_at = resolved_at
 where status = 'resolved'
   and location_sharing_ended_at is null;

alter table public.incidents enable trigger incidents_set_updated_at;

alter table public.incidents
  add constraint incidents_location_sharing_ended_shape
    check (
      location_sharing_ended_at is null
      or status = 'resolved'
    );

comment on column public.incidents.location_sharing_ended_at is
  'SCRUM-41 / 45: When the backend ended the live location-sharing session. Set by mark_incident_safe on close (legacy resolved rows backfilled with resolved_at). Null while active. Only allowed on resolved rows. Once set, attach_incident_location is not_open.';

comment on constraint incidents_location_sharing_ended_shape on public.incidents is
  'SCRUM-41 / 45: location_sharing_ended_at only on resolved incidents.';

-- ---------------------------------------------------------------------------
-- public.incident_events — audit timeline
-- ---------------------------------------------------------------------------

create table public.incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null default now(),
  actor_id uuid null references public.profiles (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  constraint incident_events_type_allowed
    check (event_type in (
      'alert_sent',
      'renotified',
      'location_sharing_started',
      'location_sharing_ended',
      'safe_recorded',
      'incident_closed',
      'closure_notified'
    )),
  constraint incident_events_detail_object
    check (jsonb_typeof(detail) = 'object')
);

comment on table public.incident_events is
  'SCRUM-41 / 43 / 45: Append-only incident timeline for audit. Written only by SECURITY DEFINER RPCs (submit_emergency_alert, renotify_emergency_alert, mark_incident_safe). No client INSERT/UPDATE/DELETE. Resident reads own; active circle members read active/resolved incidents.';
comment on column public.incident_events.incident_id is
  'FK → incidents. Cascades on incident delete (incidents are not deleted in V1).';
comment on column public.incident_events.event_type is
  'alert_sent | renotified | location_sharing_started | location_sharing_ended | safe_recorded | incident_closed | closure_notified.';
comment on column public.incident_events.occurred_at is
  'Server time of the event (now()).';
comment on column public.incident_events.actor_id is
  'Auth user who caused the event (the resident for every current writer). Null if that profile is later deleted.';
comment on column public.incident_events.detail is
  'Event detail object. alert_sent: {recipient_count, recipient_ids}. renotified: {recipient_count}. closure_notified: {recipient_count, recipient_ids} (current active members, excluding the resident). incident_closed: {resolved_reason}. Others: {}.';

create index incident_events_incident_occurred_idx
  on public.incident_events (incident_id, occurred_at);

-- Lifecycle events happen at most once per incident (renotified may repeat).
create unique index incident_events_once_per_incident_uidx
  on public.incident_events (incident_id, event_type)
  where event_type in (
    'alert_sent',
    'location_sharing_started',
    'location_sharing_ended',
    'safe_recorded',
    'incident_closed',
    'closure_notified'
  );

comment on index public.incident_events_once_per_incident_uidx is
  'SCRUM-43 / 45: alert_sent, location_sharing_started/ended, safe_recorded, incident_closed, closure_notified at most once per incident.';

-- ---------------------------------------------------------------------------
-- Visibility helper (RLS). Definer so it reads incidents / members without
-- RLS layering. Uses auth.uid() itself — no uid argument to probe others.
-- ---------------------------------------------------------------------------

create or replace function public._can_view_incident_events(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.incidents i
     where i.id = p_incident_id
       and (
         i.resident_id = auth.uid()
         or (
           i.circle_id is not null
           and i.status in ('active', 'resolved')
           and public._is_active_circle_member(i.circle_id, auth.uid())
         )
       )
  );
$$;

comment on function public._can_view_incident_events(uuid) is
  'Internal (RLS): true when auth.uid() is the incident resident, or an active circle member and the incident is active or resolved. SECURITY DEFINER so policies do not recurse.';

revoke all on function public._can_view_incident_events(uuid) from public;
revoke all on function public._can_view_incident_events(uuid) from anon;
revoke all on function public._can_view_incident_events(uuid) from authenticated;
-- RLS USING runs as the invoking role, so authenticated needs EXECUTE.
grant execute on function public._can_view_incident_events(uuid) to authenticated;

alter table public.incident_events enable row level security;

drop policy if exists "incident_events_select_visible" on public.incident_events;
create policy "incident_events_select_visible"
  on public.incident_events
  for select
  to authenticated
  using (public._can_view_incident_events(incident_events.incident_id));

comment on policy "incident_events_select_visible" on public.incident_events is
  'SCRUM-41 / 43 / 45: Resident reads events on own incidents; active circle members read events while the incident is active or resolved. Pending, declined, removed, and outsiders read nothing. No write policies.';

revoke all on table public.incident_events from public;
revoke all on table public.incident_events from anon;
revoke all on table public.incident_events from authenticated;
grant select on table public.incident_events to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'incident_events'
  ) then
    alter publication supabase_realtime add table public.incident_events;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Internal writers
-- ---------------------------------------------------------------------------

create or replace function public._incident_record_event(
  p_incident_id uuid,
  p_event_type text,
  p_actor_id uuid,
  p_detail jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.incident_events (incident_id, event_type, actor_id, detail)
  values (p_incident_id, p_event_type, p_actor_id, coalesce(p_detail, '{}'::jsonb))
  on conflict (incident_id, event_type)
    where event_type in (
      'alert_sent',
      'location_sharing_started',
      'location_sharing_ended',
      'safe_recorded',
      'incident_closed',
      'closure_notified'
    )
  do nothing;
end;
$$;

comment on function public._incident_record_event(uuid, text, uuid, jsonb) is
  'Internal: append one incident_events row. Once-only lifecycle types are no-ops on repeat. Clients must not call this.';

revoke all on function public._incident_record_event(uuid, text, uuid, jsonb) from public;
revoke all on function public._incident_record_event(uuid, text, uuid, jsonb) from anon;
revoke all on function public._incident_record_event(uuid, text, uuid, jsonb) from authenticated;

create or replace function public._incident_active_recipient_ids(rec public.incidents)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    array_agg(m.user_id order by m.user_id),
    '{}'::uuid[]
  )
    from public.safety_circle_members m
   where rec.circle_id is not null
     and m.circle_id = rec.circle_id
     and m.status = 'active'
     and m.user_id is not null
     and m.user_id is distinct from rec.resident_id;
$$;

comment on function public._incident_active_recipient_ids(public.incidents) is
  'Internal: current active circle member user_ids for the incident circle, excluding the resident. Empty array when no circle. Clients must not call this.';

revoke all on function public._incident_active_recipient_ids(public.incidents) from public;
revoke all on function public._incident_active_recipient_ids(public.incidents) from anon;
revoke all on function public._incident_active_recipient_ids(public.incidents) from authenticated;

-- ---------------------------------------------------------------------------
-- Shared activation JSON — add location_sharing_ended_at
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
    'renotified_at', rec.renotified_at,
    'resolved_at', rec.resolved_at,
    'resolved_reason', rec.resolved_reason,
    'auto_closed', rec.auto_closed,
    'activity_confirmed_at', rec.activity_confirmed_at,
    'location_sharing_ended_at', rec.location_sharing_ended_at
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: shared resident incident shape (submit / open read / attach / notes / renotify / mark safe). Includes location_sharing_ended_at (null while active). auto_closed / activity_confirmed_at / cancelled_at are legacy keys kept for history. Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

-- ---------------------------------------------------------------------------
-- mark_incident_safe — one confirm: safe + close + end sharing + events
-- ---------------------------------------------------------------------------

create or replace function public.mark_incident_safe(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
  v_recipients uuid[];
begin
  uid := public._require_auth_uid('mark_incident_safe');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'mark_incident_safe:not_found';
  end if;

  -- Already safe: return as-is. No new events, resolved_at unchanged.
  if rec.status = 'resolved' and rec.resolved_reason = 'safe' then
    return public._incident_send_json(rec);
  end if;

  -- legacy activating / cancelled / legacy ended.
  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'mark_incident_safe:not_open';
  end if;

  update public.incidents
     set status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'safe',
         auto_closed = false,
         location_sharing_ended_at = now()
   where id = rec.id
  returning * into rec;

  v_recipients := public._incident_active_recipient_ids(rec);

  perform public._incident_record_event(rec.id, 'safe_recorded', uid, '{}'::jsonb);
  perform public._incident_record_event(
    rec.id,
    'incident_closed',
    uid,
    jsonb_build_object('resolved_reason', 'safe')
  );
  perform public._incident_record_event(rec.id, 'location_sharing_ended', uid, '{}'::jsonb);
  perform public._incident_record_event(
    rec.id,
    'closure_notified',
    uid,
    jsonb_build_object(
      'recipient_count', coalesce(array_length(v_recipients, 1), 0),
      'recipient_ids', to_jsonb(v_recipients)
    )
  );

  return public._incident_send_json(rec);
end;
$$;

comment on function public.mark_incident_safe(uuid) is
  'SCRUM-45 (consolidated with retired 46): resident confirms safe on their active incident. One call sets resolved / safe, resolved_at, location_sharing_ended_at, and logs safe_recorded, incident_closed, location_sharing_ended, closure_notified (recipient_count = current active members excluding resident) exactly once. Idempotent if already safe (no new events, timestamps unchanged). Not active raises not_open. Returns the shared JSON plus delivered_count / acknowledged_count. Closure notice is in-app (members see status resolved); no FCM/SMS. History kept.';

revoke all on function public.mark_incident_safe(uuid) from public;
revoke all on function public.mark_incident_safe(uuid) from anon;
grant execute on function public.mark_incident_safe(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- renotify_emergency_alert — same SCRUM-72 behavior + renotified event
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
  v_count integer;
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

  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'renotify_emergency_alert:not_open';
  end if;

  update public.incidents
     set renotified_at = now()
   where id = rec.id
  returning * into rec;

  update public.incident_deliveries
     set delivered_at = now()
   where incident_id = rec.id;

  get diagnostics v_count = row_count;

  perform public._incident_record_event(
    rec.id,
    'renotified',
    uid,
    jsonb_build_object('recipient_count', v_count)
  );

  return public._incident_send_json(rec);
end;
$$;

comment on function public.renotify_emergency_alert(uuid) is
  'SCRUM-72: re-notify the caller''s active incident in-app. Sets renotified_at, refreshes existing incident_deliveries.delivered_at (no new rows, acks kept), logs a renotified event {recipient_count}. Not active raises not_open. Never creates an incident. Not FCM/SMS.';

revoke all on function public.renotify_emergency_alert(uuid) from public;
revoke all on function public.renotify_emergency_alert(uuid) from anon;
grant execute on function public.renotify_emergency_alert(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- attach_incident_location — active + session not ended only
-- ---------------------------------------------------------------------------

create or replace function public.attach_incident_location(
  p_incident_id uuid,
  p_location_source text,
  p_location_lat double precision default null,
  p_location_lng double precision default null,
  p_location_accuracy_m double precision default null,
  p_location_captured_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('attach_incident_location');

  if p_location_source is null
     or p_location_source not in ('current', 'last_known', 'unavailable')
  then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:invalid_source';
  end if;

  if p_location_source = 'unavailable' then
    if p_location_lat is not null
       or p_location_lng is not null
       or p_location_accuracy_m is not null
       or p_location_captured_at is not null
    then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;
  else
    if p_location_lat is null
       or p_location_lng is null
       or p_location_captured_at is null
       or p_location_lat < -90
       or p_location_lat > 90
       or p_location_lng < -180
       or p_location_lng > 180
    then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;

    if p_location_source = 'current' and p_location_accuracy_m is null then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;

    if p_location_accuracy_m is not null and p_location_accuracy_m < 0 then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;
  end if;

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:not_found';
  end if;

  -- Only a live (active) incident whose sharing session has not ended.
  -- Late pings after mark safe never write and never reopen.
  if rec.status is distinct from 'active'
     or rec.location_sharing_ended_at is not null
  then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:not_open';
  end if;

  -- SCRUM-41: out-of-order — keep the newer fix; return current row.
  if rec.location_captured_at is not null
     and p_location_captured_at is not null
     and p_location_captured_at < rec.location_captured_at
  then
    return public._incident_activation_json(rec);
  end if;

  update public.incidents
     set location_source = p_location_source,
         location_lat = p_location_lat,
         location_lng = p_location_lng,
         location_accuracy_m = p_location_accuracy_m,
         location_captured_at = p_location_captured_at
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 41 / 45: attach or live-update location on the caller''s active incident. Owner JWT only. not_open unless status = active and location_sharing_ended_at is null (late pings after mark safe never write or reopen). Skips overwrite when p_location_captured_at is older than the stored fix. Does not notify or change status/type/notes/resolve columns.';

revoke all on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) from public;
revoke all on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) from anon;
grant execute on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- get_incident_details — add location_sharing_ended_at
-- ---------------------------------------------------------------------------

create or replace function public.get_incident_details(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
  resident_name text;
begin
  uid := public._require_auth_uid('get_incident_details');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id;

  if not found
     or rec.status not in ('active', 'resolved')
     or rec.resident_id = uid
     or rec.circle_id is null
     or not public._is_active_circle_member(rec.circle_id, uid)
  then
    raise exception using
      errcode = 'P0001',
      message = 'get_incident_details:not_found';
  end if;

  select p.full_name
    into resident_name
    from public.profiles p
   where p.id = rec.resident_id;

  return jsonb_build_object(
    'id', rec.id,
    'resident_name', coalesce(resident_name, ''),
    'emergency_type', rec.emergency_type,
    'activated_at', rec.activated_at,
    'status', rec.status,
    'sent_at', rec.sent_at,
    'renotified_at', rec.renotified_at,
    'resolved_at', rec.resolved_at,
    'resolved_reason', rec.resolved_reason,
    'auto_closed', rec.auto_closed,
    'location_lat', rec.location_lat,
    'location_lng', rec.location_lng,
    'location_accuracy_m', rec.location_accuracy_m,
    'location_captured_at', rec.location_captured_at,
    'location_source', rec.location_source,
    'location_sharing_ended_at', rec.location_sharing_ended_at,
    'incident_notes', rec.incident_notes,
    'incident_notes_updated_at', rec.incident_notes_updated_at,
    'share_payload', coalesce(rec.share_payload, '{}'::jsonb)
  );
end;
$$;

comment on function public.get_incident_details(uuid) is
  'SCRUM-48 / 45 / 41: JSON details for one active or resolved incident. Caller must be an active circle member and not the resident. Else not_found. Includes location_sharing_ended_at (null while live). emergency_type is medical | domestic_violence | fire | burglary | other (legacy unspecified). share_payload is the stored snapshot only.';

revoke all on function public.get_incident_details(uuid) from public;
revoke all on function public.get_incident_details(uuid) from anon;
grant execute on function public.get_incident_details(uuid) to authenticated;
