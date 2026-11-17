-- Membership access window (device test run 2026-11-17, fix #9; api_doc rule 54)
-- A circle member may read an incident only if the incident started at or
-- after the moment that person became an active member of that circle, and
-- only while they are still an active member. Before this migration a member
-- who joined today could list and open the owner's incidents from before they
-- joined (location, share_payload, notes, events).
--
-- 1. safety_circle_members.activated_at — when the row last became active.
--    Kept by a BEFORE trigger: set to now() on the transition to active
--    (accept, owner row on circle creation), immutable while active for
--    client roles, null whenever the row is not active.
--    Backfill: members use invite_consumed_at (accept_circle_invite stamps it
--    with now() in the same UPDATE that sets status = active), else
--    updated_at, else created_at. Owner rows use the circle's created_at.
-- 2. _is_active_circle_member_since(circle, uid, incident_activated_at) —
--    SECURITY DEFINER helper (same pattern as _is_active_circle_member, so the
--    RLS recursion fix stays intact; no raw exists on members in a policy).
-- 3. Window applied to every non-resident read path:
--    incidents_select_active_member (RLS, so Realtime on incidents too),
--    list_responder_incidents, get_incident_details,
--    _can_view_incident_events (incident_events RLS + Realtime),
--    incident_delivery_counts, acknowledge_incident,
--    incident_deliveries_select_own / _update_own.
--    _incident_active_recipient_ids (closure_notified recipients) only lists
--    members inside the window.
-- Rule: incident.activated_at >= member.activated_at AND member is active.
-- The resident's own reads are unchanged. Remove / leave delete the member
-- row, so access ends at once (and delivery rows cascade).
-- In-app only: no FCM, no Twilio, no Edge Functions. Hosted Supabase.

-- ---------------------------------------------------------------------------
-- safety_circle_members.activated_at
-- ---------------------------------------------------------------------------

alter table public.safety_circle_members
  add column if not exists activated_at timestamptz null;

comment on column public.safety_circle_members.activated_at is
  'Rule 54 / fix #9: When this membership last became active (accept, or owner row on circle creation). Null unless status = active. Set by trigger safety_circle_members_set_activated_at; clients cannot change it. A member reads only incidents with incidents.activated_at >= this value.';

-- Backfill existing active rows. Keep updated_at untouched.
alter table public.safety_circle_members disable trigger safety_circle_members_set_updated_at;

update public.safety_circle_members m
   set activated_at = sc.created_at
  from public.safety_circles sc
 where sc.id = m.circle_id
   and m.role = 'owner'
   and m.status = 'active'
   and m.activated_at is null;

update public.safety_circle_members m
   set activated_at = coalesce(m.invite_consumed_at, m.updated_at, m.created_at)
 where m.role = 'member'
   and m.status = 'active'
   and m.activated_at is null;

update public.safety_circle_members m
   set activated_at = null
 where m.status <> 'active'
   and m.activated_at is not null;

alter table public.safety_circle_members enable trigger safety_circle_members_set_updated_at;

alter table public.safety_circle_members
  drop constraint if exists safety_circle_members_activated_shape;

alter table public.safety_circle_members
  add constraint safety_circle_members_activated_shape
    check (
      (status = 'active' and activated_at is not null)
      or (status <> 'active' and activated_at is null)
    );

comment on constraint safety_circle_members_activated_shape on public.safety_circle_members is
  'Rule 54: activated_at is set exactly when status = active.';

-- ---------------------------------------------------------------------------
-- Trigger: keep activated_at correct on every write path
-- ---------------------------------------------------------------------------

create or replace function public.set_safety_circle_members_activated_at()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  -- Client roles (direct table writes) can never choose the value.
  -- SECURITY DEFINER RPCs run as the owner and do not pass a value either,
  -- so they get now(). Only maintenance as postgres/service_role may set it.
  client_write boolean := current_user in ('authenticated', 'anon');
begin
  if new.status is distinct from 'active' then
    new.activated_at := null;
    return new;
  end if;

  if tg_op = 'INSERT' or old.status is distinct from 'active' then
    -- Becoming active now.
    if client_write or new.activated_at is null then
      new.activated_at := now();
    end if;
  else
    -- Stays active: the activation time does not move.
    if client_write or new.activated_at is null then
      new.activated_at := coalesce(old.activated_at, now());
    end if;
  end if;

  return new;
end;
$$;

comment on function public.set_safety_circle_members_activated_at() is
  'Rule 54: BEFORE INSERT/UPDATE on safety_circle_members. now() on the transition to active, unchanged while active (client roles cannot edit it), null when not active. Internal.';

revoke all on function public.set_safety_circle_members_activated_at() from public;
revoke all on function public.set_safety_circle_members_activated_at() from anon;
revoke all on function public.set_safety_circle_members_activated_at() from authenticated;

drop trigger if exists safety_circle_members_set_activated_at
  on public.safety_circle_members;

create trigger safety_circle_members_set_activated_at
  before insert or update on public.safety_circle_members
  for each row
  execute function public.set_safety_circle_members_activated_at();

-- ---------------------------------------------------------------------------
-- Window helper (definer: reads members without RLS, no recursion)
-- ---------------------------------------------------------------------------

create or replace function public._is_active_circle_member_since(
  p_circle_id uuid,
  p_uid uuid,
  p_incident_activated_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_circle_id is not null
     and p_uid is not null
     and p_incident_activated_at is not null
     and exists (
       select 1
         from public.safety_circle_members m
        where m.circle_id = p_circle_id
          and m.user_id = p_uid
          and m.status = 'active'
          and m.activated_at is not null
          and m.activated_at <= p_incident_activated_at
     );
$$;

comment on function public._is_active_circle_member_since(uuid, uuid, timestamptz) is
  'Internal (RLS + RPCs): true when uid is an active member of circle_id whose activated_at <= the incident''s activated_at (rule 54 membership window). SECURITY DEFINER so policies do not recurse.';

revoke all on function public._is_active_circle_member_since(uuid, uuid, timestamptz) from public;
revoke all on function public._is_active_circle_member_since(uuid, uuid, timestamptz) from anon;
revoke all on function public._is_active_circle_member_since(uuid, uuid, timestamptz) from authenticated;
-- RLS USING runs as the invoking role, so authenticated needs EXECUTE.
grant execute on function public._is_active_circle_member_since(uuid, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- incidents: member SELECT inside the window (Realtime follows RLS)
-- ---------------------------------------------------------------------------

drop policy if exists "incidents_select_active_member" on public.incidents;
create policy "incidents_select_active_member"
  on public.incidents
  for select
  to authenticated
  using (
    circle_id is not null
    and status in ('active', 'resolved')
    and public._is_active_circle_member_since(
      incidents.circle_id,
      auth.uid(),
      incidents.activated_at
    )
  );

comment on policy "incidents_select_active_member" on public.incidents is
  'SCRUM-45 / 48 + rule 54: Active circle members SELECT active or resolved incidents that started at or after their membership activated_at. Earlier incidents, activating, cancelled, pending, declined, removed, left, and outsiders: nothing. Uses _is_active_circle_member_since (definer, no RLS loop). Realtime on incidents follows this policy.';

-- ---------------------------------------------------------------------------
-- incident_events visibility helper
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
           and public._is_active_circle_member_since(
             i.circle_id,
             auth.uid(),
             i.activated_at
           )
         )
       )
  );
$$;

comment on function public._can_view_incident_events(uuid) is
  'Internal (RLS): true when auth.uid() is the incident resident, or an active circle member whose membership activated at or before the incident started, and the incident is active or resolved (rule 54). Used by incident_events and incident_deliveries member policies. SECURITY DEFINER so policies do not recurse.';

-- Grants unchanged (EXECUTE to authenticated); restated.
revoke all on function public._can_view_incident_events(uuid) from public;
revoke all on function public._can_view_incident_events(uuid) from anon;
grant execute on function public._can_view_incident_events(uuid) to authenticated;

comment on policy "incident_events_select_visible" on public.incident_events is
  'SCRUM-41 / 43 / 45 + rule 54: Resident reads events on own incidents; active circle members read events of active/resolved incidents that started at or after they joined. Pending, declined, removed, left, and outsiders read nothing. No write policies.';

-- ---------------------------------------------------------------------------
-- incident_deliveries: member's own row only inside the window
-- ---------------------------------------------------------------------------

drop policy if exists "incident_deliveries_select_own" on public.incident_deliveries;
create policy "incident_deliveries_select_own"
  on public.incident_deliveries
  for select
  to authenticated
  using (
    member_user_id = auth.uid()
    and public._can_view_incident_events(incident_id)
  );

drop policy if exists "incident_deliveries_update_own" on public.incident_deliveries;
create policy "incident_deliveries_update_own"
  on public.incident_deliveries
  for update
  to authenticated
  using (
    member_user_id = auth.uid()
    and public._can_view_incident_events(incident_id)
  )
  with check (
    member_user_id = auth.uid()
    and public._can_view_incident_events(incident_id)
  );

comment on policy "incident_deliveries_select_own" on public.incident_deliveries is
  'SCRUM-43 + rule 54: Member can SELECT their own delivery row while they can view the incident (active member, incident started at or after they joined). Ack is via acknowledge_incident().';
comment on policy "incident_deliveries_update_own" on public.incident_deliveries is
  'SCRUM-43 + rule 54: Member can UPDATE their own row only while they can view the incident. Inserts are RPC-only.';

-- ---------------------------------------------------------------------------
-- Closure recipients: only members inside the window
-- ---------------------------------------------------------------------------

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
     and m.user_id is distinct from rec.resident_id
     and m.activated_at is not null
     and m.activated_at <= rec.activated_at;
$$;

comment on function public._incident_active_recipient_ids(public.incidents) is
  'Internal: active circle member user_ids for the incident circle whose membership activated at or before the incident started (rule 54), excluding the resident. Empty array when no circle. Clients must not call this.';

revoke all on function public._incident_active_recipient_ids(public.incidents) from public;
revoke all on function public._incident_active_recipient_ids(public.incidents) from anon;
revoke all on function public._incident_active_recipient_ids(public.incidents) from authenticated;

-- ---------------------------------------------------------------------------
-- list_responder_incidents
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
        and public._is_active_circle_member_since(i.circle_id, uid, i.activated_at)
    ) as incoming;

  return result;
end;
$$;

comment on function public.list_responder_incidents() is
  'SCRUM-48 / 45 + rule 54: JSON array of active and resolved incidents where the caller is an active circle member whose membership activated at or before the incident started, and is not the resident. Newest resolved_at, else sent_at, else activated_at. Omits activating, cancelled, the caller''s own rows, and incidents from before they joined. Does not open profiles to members.';

revoke all on function public.list_responder_incidents() from public;
revoke all on function public.list_responder_incidents() from anon;
grant execute on function public.list_responder_incidents() to authenticated;

-- ---------------------------------------------------------------------------
-- get_incident_details (latest shape: 20261023140000 + window)
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
     or not public._is_active_circle_member_since(rec.circle_id, uid, rec.activated_at)
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
  'SCRUM-48 / 45 / 41 + rule 54: JSON details for one active or resolved incident. Caller must be an active circle member whose membership activated at or before the incident started, and not the resident. Else not_found (same code for pre-join incidents, so existence is not revealed). share_payload is the stored snapshot only.';

revoke all on function public.get_incident_details(uuid) from public;
revoke all on function public.get_incident_details(uuid) from anon;
grant execute on function public.get_incident_details(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- incident_delivery_counts
-- ---------------------------------------------------------------------------

create or replace function public.incident_delivery_counts(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('incident_delivery_counts');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'incident_delivery_counts:not_found';
  end if;

  if rec.resident_id is not distinct from uid then
    return public._incident_delivery_counts_json(rec.id, rec.status);
  end if;

  -- Members: active incident, inside the membership window.
  if rec.circle_id is not null
     and rec.status = 'active'
     and public._is_active_circle_member_since(rec.circle_id, uid, rec.activated_at)
  then
    return public._incident_delivery_counts_json(rec.id, rec.status);
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'incident_delivery_counts:not_found';
end;
$$;

comment on function public.incident_delivery_counts(uuid) is
  'SCRUM-43 + rule 54: Live in-app delivery/ack counts. Resident of the incident, or an active circle member (joined at or before the incident started) while the incident is active. not_found if no access. Not FCM/SMS.';

revoke all on function public.incident_delivery_counts(uuid) from public;
revoke all on function public.incident_delivery_counts(uuid) from anon;
grant execute on function public.incident_delivery_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- acknowledge_incident
-- ---------------------------------------------------------------------------

create or replace function public.acknowledge_incident(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
  d public.incident_deliveries%rowtype;
begin
  uid := public._require_auth_uid('acknowledge_incident');

  select *
    into d
    from public.incident_deliveries del
   where del.incident_id = p_incident_id
     and del.member_user_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'acknowledge_incident:not_found';
  end if;

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id;

  -- Outside the membership window (or no longer a member): same as no row.
  if not found
     or not public._is_active_circle_member_since(rec.circle_id, uid, rec.activated_at)
  then
    raise exception using
      errcode = 'P0001',
      message = 'acknowledge_incident:not_found';
  end if;

  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'acknowledge_incident:not_open';
  end if;

  if d.delivered_at is not null and d.acknowledged_at is null then
    update public.incident_deliveries
       set acknowledged_at = now()
     where id = d.id;
  end if;

  return public._incident_delivery_counts_json(rec.id, rec.status);
end;
$$;

comment on function public.acknowledge_incident(uuid) is
  'SCRUM-43 + rule 54: Set acknowledged_at on the caller''s in-app delivery row when the incident is active. not_found without a delivery row or outside the membership window (not an active member, or joined after the incident started). Idempotent if already acked. Not FCM/SMS.';

revoke all on function public.acknowledge_incident(uuid) from public;
revoke all on function public.acknowledge_incident(uuid) from anon;
grant execute on function public.acknowledge_incident(uuid) to authenticated;
