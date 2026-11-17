-- SCRUM-45: Mark Safe
-- Adds the resolve columns both 45 and 46 use. 45 writes resolved_reason
-- 'safe' only. Does not write 'ended', does not auto-close, and does not
-- stamp activity_confirmed_at (46).
-- Widens incidents_select_active_member to active + resolved so a stand-down
-- stays visible. activating and cancelled stay hidden. Keeps
-- _is_active_circle_member. Does not revert to an exists-on-members subquery.
-- Shared activation JSON gains the new keys (null / false until set).
-- Start, type, attach, cancel, notes, send, and renotify do not set them.
-- Responder list and details include resolved. In-app only.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio, no pg_cron.

-- ---------------------------------------------------------------------------
-- Resolve columns (45 adds them; 46 writes ended / auto-close / still-active)
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column resolved_at timestamptz null,
  add column resolved_reason text null,
  add column auto_closed boolean not null default false,
  add column activity_confirmed_at timestamptz null;

alter table public.incidents
  add constraint incidents_resolved_reason_check
    check (
      resolved_reason is null
      or resolved_reason in ('safe', 'ended')
    );

alter table public.incidents
  add constraint incidents_resolved_shape_check
    check (
      (
        status = 'resolved'
        and resolved_at is not null
        and resolved_reason is not null
      )
      or (
        status <> 'resolved'
        and resolved_at is null
        and resolved_reason is null
        and auto_closed = false
      )
    );

comment on column public.incidents.resolved_at is
  'SCRUM-45 / 46 resolve time. Null until mark safe or end. Required when status is resolved. Idempotent retry does not move it.';

comment on column public.incidents.resolved_reason is
  'SCRUM-45 writes safe. SCRUM-46 writes ended. Null until resolved. Required when status is resolved.';

comment on column public.incidents.auto_closed is
  'SCRUM-46: true only when auto_close_inactive_incident closes the row. Mark safe and manual end keep false. Must be false unless status is resolved.';

comment on column public.incidents.activity_confirmed_at is
  'SCRUM-46 still-active stamp. Null until confirm_incident_still_active. Resets the 24h inactivity clock. 45 does not set it.';

comment on constraint incidents_resolved_reason_check on public.incidents is
  'SCRUM-45 / 46: resolved_reason is null, safe, or ended.';

comment on constraint incidents_resolved_shape_check on public.incidents is
  'SCRUM-45 / 46: resolved requires resolved_at and resolved_reason. Any other status keeps both null and auto_closed false.';

comment on column public.incidents.status is
  'activating (36) | active (43) | cancelled (42) | resolved (45 safe / 46 ended). 45 writes resolved only via mark_incident_safe().';

comment on table public.incidents is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39 / 72 / 48 / 45: Emergency loop. One open incident per resident (activating or active). 45 marks the resident safe (resolved / safe) and keeps the row. Members can SELECT active and resolved. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- Member SELECT: active and resolved. activating / cancelled stay hidden.
-- ---------------------------------------------------------------------------

drop policy if exists "incidents_select_active_member" on public.incidents;
create policy "incidents_select_active_member"
  on public.incidents
  for select
  to authenticated
  using (
    circle_id is not null
    and public._is_active_circle_member(incidents.circle_id, auth.uid())
    and status in ('active', 'resolved')
  );

comment on policy "incidents_select_active_member" on public.incidents is
  'SCRUM-45 / 46: Active circle members can SELECT status active or resolved. activating and cancelled stay invisible. Uses _is_active_circle_member (no RLS loop). Pending/declined cannot.';

-- ---------------------------------------------------------------------------
-- Shared activation JSON — new keys, null / false until a resolve writer sets
-- them. Existing writers are not replaced; their UPDATEs do not name these
-- columns, and start's INSERT omits them.
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
    'activity_confirmed_at', rec.activity_confirmed_at
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: Shared start / type / attach / cancel / notes / mark-safe / end return shape. Includes resolved_at, resolved_reason, auto_closed, and activity_confirmed_at. Those are null or false until 45/46 set them. Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

comment on function public._incident_send_json(public.incidents) is
  'Internal: Shared incident shape (including resolve keys) plus delivered_count and acknowledged_count. Send and renotify do not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Clients must not call this.';

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39 / 72 / 45: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes resolve keys (null / auto_closed false until 45/46). Insert and idempotent retry do not set them. Does not mark safe, end, notify, or require a circle.';

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 / 40 / 42 / 43 / 39 / 72 / 45: Set emergency_type on the caller''s activating or active incident. Does not change status, location, notes, sent_at, share_payload, renotified_at, resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Does not mark safe.';

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 42 / 43 / 39 / 72 / 45: Attach location on the caller''s activating or active incident. Rejects cancelled and resolved as not_open. Does not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Not live tracking.';

comment on function public.cancel_emergency_activation(uuid) is
  'SCRUM-42 / 43 / 39 / 72 / 45: Cancel the caller''s activating incident during grace. Does not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Does not mark safe. Does not notify or delete.';

comment on function public.set_incident_notes(uuid, text) is
  'SCRUM-39 / 72 / 45: Set or clear the live incident note on the caller''s activating or active incident. Does not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Does not mark safe or send.';

comment on function public.send_emergency_alert(uuid) is
  'SCRUM-43 / 39 / 72 / 45: Promote activating to active and insert in-app deliveries. Does not set renotified_at, resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Does not write resolved. Not FCM/SMS.';

comment on function public.renotify_emergency_alert(uuid) is
  'SCRUM-72 / 45: Re-notify the caller''s active incident in-app. Sets only renotified_at and refreshes delivered_at. Does not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. resolved is not_open. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- mark_incident_safe(p_incident_id) — resident stand-down, reason safe
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

  -- Already safe: same resolved_at. Do not rewrite.
  if rec.status = 'resolved' and rec.resolved_reason = 'safe' then
    return public._incident_activation_json(rec);
  end if;

  -- activating, cancelled, or resolved as ended.
  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'mark_incident_safe:not_open';
  end if;

  update public.incidents
     set status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'safe',
         auto_closed = false
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.mark_incident_safe(uuid) is
  'SCRUM-45: Resident marks their active incident resolved with reason safe. Idempotent if already safe (resolved_at unchanged). activating, cancelled, and ended raise not_open. Does not change type, location, notes, sent_at, share_payload, or renotified_at. Does not delete. Not FCM/SMS. End is end_incident().';

revoke all on function public.mark_incident_safe(uuid) from public;
revoke all on function public.mark_incident_safe(uuid) from anon;
grant execute on function public.mark_incident_safe(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Responder reads: active and resolved. Own row, activating, cancelled stay out.
-- ---------------------------------------------------------------------------

create or replace function public.list_responder_incidents()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  result jsonb;
begin
  uid := public._require_auth_uid('list_responder_incidents');

  select coalesce(
    jsonb_agg(
      incoming.payload
      order by incoming.sort_at desc, incoming.sort_id
    ),
    '[]'::jsonb
  )
    into result
    from (
      select
        jsonb_build_object(
          'id', i.id,
          'resident_name', coalesce(p.full_name, ''),
          'emergency_type', i.emergency_type,
          'activated_at', i.activated_at,
          'status', i.status,
          'sent_at', i.sent_at,
          'renotified_at', i.renotified_at,
          'resolved_at', i.resolved_at,
          'resolved_reason', i.resolved_reason,
          'auto_closed', i.auto_closed
        ) as payload,
        coalesce(i.resolved_at, i.sent_at, i.activated_at) as sort_at,
        i.id as sort_id
      from public.incidents i
      left join public.profiles p
        on p.id = i.resident_id
      where i.status in ('active', 'resolved')
        and i.resident_id <> uid
        and public._is_active_circle_member(i.circle_id, uid)
    ) as incoming;

  return result;
end;
$$;

comment on function public.list_responder_incidents() is
  'SCRUM-48 / 45: JSON array of active and resolved incidents where the caller is an active circle member and is not the resident. Newest resolved_at, else sent_at, else activated_at. Includes resolved_at, resolved_reason, auto_closed. Omits activating, cancelled, and the caller''s own row. Does not open profiles to members.';

revoke all on function public.list_responder_incidents() from public;
revoke all on function public.list_responder_incidents() from anon;
grant execute on function public.list_responder_incidents() to authenticated;

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
    'incident_notes', rec.incident_notes,
    'incident_notes_updated_at', rec.incident_notes_updated_at,
    'share_payload', coalesce(rec.share_payload, '{}'::jsonb)
  );
end;
$$;

comment on function public.get_incident_details(uuid) is
  'SCRUM-48 / 45: JSON details for one active or resolved incident. Caller must be an active circle member and not the resident. activating, cancelled, own row, pending, and outsider are not_found. Returns resolved_at, resolved_reason, and auto_closed. share_payload is the stored snapshot only.';

revoke all on function public.get_incident_details(uuid) from public;
revoke all on function public.get_incident_details(uuid) from anon;
grant execute on function public.get_incident_details(uuid) to authenticated;
