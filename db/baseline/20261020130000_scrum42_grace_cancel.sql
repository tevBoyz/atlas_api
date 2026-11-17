-- SCRUM-42: Accidental Activation Grace Period (cancel)
-- Adds incidents.cancelled_at. Tightens member SELECT to status = 'active'
-- so activating / cancelled rows are not visible to circle members.
-- Replaces the shared activation JSON so start / set_emergency_type /
-- attach_incident_location include cancelled_at (null until cancel).
-- Adds cancel_emergency_activation(). Does not notify, write active, delete,
-- or send when the 5s timer ends (that is mobile; send is SCRUM-43).
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- public.incidents.cancelled_at
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column cancelled_at timestamptz null;

comment on column public.incidents.cancelled_at is
  '42 grace cancel time; not a send.';

comment on column public.incidents.status is
  'activating (36) | active (43) | cancelled (42) | resolved (45/46). 42 writes cancelled only via cancel_emergency_activation(). Not a sent alert.';

-- ---------------------------------------------------------------------------
-- Member SELECT: only status = 'active' (AC: no visible incident record)
-- Keep _is_active_circle_member. Do not revert to exists-on-members.
-- ---------------------------------------------------------------------------

drop policy if exists "incidents_select_active_member" on public.incidents;
create policy "incidents_select_active_member"
  on public.incidents
  for select
  to authenticated
  using (
    circle_id is not null
    and public._is_active_circle_member(incidents.circle_id, auth.uid())
    and status = 'active'
  );

comment on policy "incidents_select_active_member" on public.incidents is
  'SCRUM-42 / 48: Active circle members can SELECT only status = active. activating and cancelled are invisible to members. Uses _is_active_circle_member (no RLS loop). Pending/declined cannot. Does not notify (43).';

comment on policy "incidents_select_own" on public.incidents is
  'SCRUM-36 / 42: Resident can SELECT own incidents, including activating and cancelled. App hides cancelled.';

-- ---------------------------------------------------------------------------
-- Shared activation JSON — add cancelled_at. start / type / attach use this.
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
    'cancelled_at', rec.cancelled_at
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: Shared start / set_emergency_type / attach_incident_location / cancel_emergency_activation return shape. Includes cancelled_at (null until cancel). Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

-- start still omits cancelled_at on insert (column stays null). Idempotent
-- start returns the existing open row and does not change status / type /
-- location / cancelled_at. Type and attach still reject cancelled as not_open.

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38 / 40 / 42: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes emergency_type, location keys, and cancelled_at (null until cancel). New inserts omit location, type, and cancelled_at (defaults). Does not notify, attach GPS, cancel, or require a circle.';

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 / 40 / 42: Set emergency_type on the caller''s activating or active incident. Does not change status, location, activated_at, circle_id, resident_id, or cancelled_at. Return includes cancelled_at. Does not send.';

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 42: Attach the activation location snapshot on the caller''s activating or active incident. Overwrite allowed. Does not change status, type, activated_at, circle_id, resident_id, or cancelled_at. Return includes cancelled_at. Does not send. Not live tracking.';

-- ---------------------------------------------------------------------------
-- cancel_emergency_activation(p_incident_id) — grace cancel only
-- ---------------------------------------------------------------------------

create or replace function public.cancel_emergency_activation(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('cancel_emergency_activation');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'cancel_emergency_activation:not_found';
  end if;

  if rec.status = 'cancelled' then
    return public._incident_activation_json(rec);
  end if;

  if rec.status is distinct from 'activating' then
    raise exception using
      errcode = 'P0001',
      message = 'cancel_emergency_activation:not_open';
  end if;

  update public.incidents
     set status = 'cancelled',
         cancelled_at = now()
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.cancel_emergency_activation(uuid) is
  'SCRUM-42: Cancel the caller''s activating incident during grace. Idempotent if already cancelled. Does not notify, write active, or delete. Timer-end send is SCRUM-43.';

revoke all on function public.cancel_emergency_activation(uuid) from public;
revoke all on function public.cancel_emergency_activation(uuid) from anon;
grant execute on function public.cancel_emergency_activation(uuid) to authenticated;
