-- SCRUM-40: Capture GPS Location
-- Adds incidents location columns + attach_incident_location().
-- Replaces start_emergency_activation() and set_emergency_type() so every
-- return includes the five location keys plus 38's emergency_type.
-- New start inserts omit location columns (null / no source).
-- Idempotent retry does not change location, type, activated_at, circle_id,
-- or status. Type RPC still updates type only.
-- Does not notify, cancel, promote to active, add notes, or live-track.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- public.incidents location columns
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column location_lat double precision null,
  add column location_lng double precision null,
  add column location_accuracy_m double precision null,
  add column location_captured_at timestamptz null,
  add column location_source text null;

alter table public.incidents
  add constraint incidents_location_source_allowed
    check (
      location_source is null
      or location_source in ('current', 'last_known', 'unavailable')
    );

alter table public.incidents
  add constraint incidents_location_shape
    check (
      (
        location_source is null
        and location_lat is null
        and location_lng is null
        and location_accuracy_m is null
        and location_captured_at is null
      )
      or (
        location_source = 'unavailable'
        and location_lat is null
        and location_lng is null
        and location_accuracy_m is null
        and location_captured_at is null
      )
      or (
        location_source in ('current', 'last_known')
        and location_lat is not null
        and location_lng is not null
        and location_captured_at is not null
        and location_lat >= -90
        and location_lat <= 90
        and location_lng >= -180
        and location_lng <= 180
        and (location_accuracy_m is null or location_accuracy_m >= 0)
        and (location_source = 'last_known' or location_accuracy_m is not null)
      )
    );

comment on column public.incidents.location_lat is
  'SCRUM-40: Activation fix latitude. Null until attach; always null when source is unavailable.';
comment on column public.incidents.location_lng is
  'SCRUM-40: Activation fix longitude. Null until attach; always null when source is unavailable.';
comment on column public.incidents.location_accuracy_m is
  'SCRUM-40: Accuracy radius in meters. Required for current; allowed null for last_known if the cache predates accuracy.';
comment on column public.incidents.location_captured_at is
  'SCRUM-40: When the fix was taken (client clock / OS). Not activated_at.';
comment on column public.incidents.location_source is
  'SCRUM-40: current | last_known | unavailable. Null until first attach. 40 stores the activation fix; missing location is unavailable so send (42+43) is never blocked.';

-- ---------------------------------------------------------------------------
-- Shared open-incident JSON (start / set type / attach). Internal.
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
    'location_source', rec.location_source
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: Shared start / set_emergency_type / attach_incident_location return shape. Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

-- ---------------------------------------------------------------------------
-- start_emergency_activation() — same 36/38 rules; return includes location
-- ---------------------------------------------------------------------------

create or replace function public.start_emergency_activation()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  p public.profiles%rowtype;
  rec public.incidents%rowtype;
  v_circle_id uuid;
begin
  uid := public._require_auth_uid('start_emergency_activation');

  select *
    into p
    from public.profiles
   where id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'start_emergency_activation:profile_not_found';
  end if;

  if p.profile_setup_completed_at is null then
    raise exception using
      errcode = 'P0001',
      message = 'start_emergency_activation:profile_setup_incomplete';
  end if;

  select *
    into rec
    from public.incidents i
   where i.resident_id = uid
     and i.status in ('activating', 'active');

  if found then
    return public._incident_activation_json(rec);
  end if;

  select sc.id
    into v_circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  insert into public.incidents as i (
    resident_id,
    circle_id,
    status,
    activated_at
  )
  values (
    uid,
    v_circle_id,
    'activating',
    now()
  )
  on conflict (resident_id) where (status in ('activating', 'active'))
  do nothing
  returning * into rec;

  if rec.id is null then
    select *
      into rec
      from public.incidents i
     where i.resident_id = uid
       and i.status in ('activating', 'active');
  end if;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38 / 40: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes emergency_type and location keys (null until attach). New inserts omit location and type (defaults). Does not notify, attach GPS, or require a circle.';

revoke all on function public.start_emergency_activation() from public;
revoke all on function public.start_emergency_activation() from anon;
grant execute on function public.start_emergency_activation() to authenticated;

-- ---------------------------------------------------------------------------
-- set_emergency_type — type only; return includes location keys
-- ---------------------------------------------------------------------------

create or replace function public.set_emergency_type(
  p_incident_id uuid,
  p_emergency_type text
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
  uid := public._require_auth_uid('set_emergency_type');

  if p_emergency_type is null
     or p_emergency_type not in (
       'medical',
       'fire',
       'crime_safety',
       'accident',
       'other',
       'unspecified'
     )
  then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:invalid_type';
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
      message = 'set_emergency_type:not_found';
  end if;

  if rec.status not in ('activating', 'active') then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:not_open';
  end if;

  update public.incidents
     set emergency_type = p_emergency_type
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 / 40: Set emergency_type on the caller''s activating or active incident. Does not change status, location, activated_at, circle_id, or resident_id. Return includes location keys. Does not send.';

revoke all on function public.set_emergency_type(uuid, text) from public;
revoke all on function public.set_emergency_type(uuid, text) from anon;
grant execute on function public.set_emergency_type(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- attach_incident_location — activation snapshot only. Overwrite allowed.
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

  if rec.status not in ('activating', 'active') then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:not_open';
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
  'SCRUM-40: Attach the activation location snapshot on the caller''s activating or active incident. Overwrite allowed. Does not change status, type, activated_at, circle_id, or resident_id. Does not send. Not live tracking.';

revoke all on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) from public;
revoke all on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) from anon;
grant execute on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) to authenticated;
