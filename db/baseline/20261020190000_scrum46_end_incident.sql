-- SCRUM-46: End Incident
-- Resident closes an active incident (resolved / ended, auto_closed false).
-- 24h inactivity: the phone asks on Home open; these RPCs decide due and close.
-- No pg_cron, no Edge Function, no FCM, no Twilio.
-- Columns were added in SCRUM-45. This migration does not add columns.
-- attach_incident_location already rejects resolved. No new location writer.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- Inactivity clock: latest of the five activity timestamps.
-- Due when that time is strictly older than 24 hours.
-- ---------------------------------------------------------------------------

create or replace function public._incident_activity_at(rec public.incidents)
returns timestamptz
language sql
stable
set search_path = public
as $$
  select max(ts)
    from unnest(array[
      rec.sent_at,
      rec.activity_confirmed_at,
      rec.renotified_at,
      rec.incident_notes_updated_at,
      rec.location_captured_at
    ]) as ts;
$$;

comment on function public._incident_activity_at(public.incidents) is
  'Internal: Latest of sent_at, activity_confirmed_at, renotified_at, incident_notes_updated_at, location_captured_at. Null when all are null. Clients must not call this.';

revoke all on function public._incident_activity_at(public.incidents) from public;
revoke all on function public._incident_activity_at(public.incidents) from anon;
revoke all on function public._incident_activity_at(public.incidents) from authenticated;

create or replace function public._incident_inactivity_is_due(rec public.incidents)
returns boolean
language sql
volatile
set search_path = public
as $$
  select coalesce(
    public._incident_activity_at(rec) < (now() - interval '24 hours'),
    false
  );
$$;

comment on function public._incident_inactivity_is_due(public.incidents) is
  'Internal: True when the activity clock is strictly older than 24 hours. Null clock is not due. Clients must not call this.';

revoke all on function public._incident_inactivity_is_due(public.incidents) from public;
revoke all on function public._incident_inactivity_is_due(public.incidents) from anon;
revoke all on function public._incident_inactivity_is_due(public.incidents) from authenticated;

-- ---------------------------------------------------------------------------
-- end_incident(p_incident_id) — manual close, reason ended, auto_closed false
-- ---------------------------------------------------------------------------

create or replace function public.end_incident(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('end_incident');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'end_incident:not_found';
  end if;

  -- Already ended (manual or auto). Do not move resolved_at or auto_closed.
  if rec.status = 'resolved' and rec.resolved_reason = 'ended' then
    return public._incident_activation_json(rec);
  end if;

  -- activating, cancelled, or already safe.
  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'end_incident:not_open';
  end if;

  update public.incidents
     set status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'ended',
         auto_closed = false
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.end_incident(uuid) is
  'SCRUM-46: Resident ends their active incident. resolved / ended, auto_closed false. Idempotent if already ended (resolved_at and auto_closed unchanged). activating, cancelled, and safe raise not_open. Does not delete. Location attach already rejects resolved. Not FCM/SMS.';

revoke all on function public.end_incident(uuid) from public;
revoke all on function public.end_incident(uuid) from anon;
grant execute on function public.end_incident(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- incident_inactivity_due() — caller's active incident, 24h clock
-- ---------------------------------------------------------------------------

create or replace function public.incident_inactivity_due()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
  v_since timestamptz;
begin
  uid := public._require_auth_uid('incident_inactivity_due');

  select *
    into rec
    from public.incidents i
   where i.resident_id = uid
     and i.status = 'active'
   order by i.activated_at desc
   limit 1;

  if not found then
    return jsonb_build_object('due', false);
  end if;

  v_since := public._incident_activity_at(rec);

  if public._incident_inactivity_is_due(rec) then
    return jsonb_build_object(
      'due', true,
      'incident_id', rec.id,
      'inactive_since', v_since
    );
  end if;

  return jsonb_build_object(
    'due', false,
    'incident_id', rec.id
  );
end;
$$;

comment on function public.incident_inactivity_due() is
  'SCRUM-46: Whether the caller''s active incident has been quiet for more than 24 hours. No active row returns {due:false}. Does not write. Not pg_cron. The phone asks; this decides.';

revoke all on function public.incident_inactivity_due() from public;
revoke all on function public.incident_inactivity_due() from anon;
grant execute on function public.incident_inactivity_due() to authenticated;

-- ---------------------------------------------------------------------------
-- confirm_incident_still_active(p_incident_id) — reset the 24h window
-- ---------------------------------------------------------------------------

create or replace function public.confirm_incident_still_active(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('confirm_incident_still_active');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'confirm_incident_still_active:not_found';
  end if;

  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'confirm_incident_still_active:not_open';
  end if;

  update public.incidents
     set activity_confirmed_at = now()
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.confirm_incident_still_active(uuid) is
  'SCRUM-46: Resident says the active incident is still active. Sets only activity_confirmed_at, which resets the 24h clock. Not active raises not_open. Does not resolve.';

revoke all on function public.confirm_incident_still_active(uuid) from public;
revoke all on function public.confirm_incident_still_active(uuid) from anon;
grant execute on function public.confirm_incident_still_active(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- auto_close_inactive_incident(p_incident_id) — dismiss without Still active
-- ---------------------------------------------------------------------------

create or replace function public.auto_close_inactive_incident(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('auto_close_inactive_incident');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'auto_close_inactive_incident:not_found';
  end if;

  -- Already ended (manual or auto). Do not move resolved_at or auto_closed.
  if rec.status = 'resolved' and rec.resolved_reason = 'ended' then
    return public._incident_activation_json(rec);
  end if;

  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'auto_close_inactive_incident:not_open';
  end if;

  if not public._incident_inactivity_is_due(rec) then
    raise exception using
      errcode = 'P0001',
      message = 'auto_close_inactive_incident:not_due';
  end if;

  update public.incidents
     set status = 'resolved',
         resolved_at = now(),
         resolved_reason = 'ended',
         auto_closed = true
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.auto_close_inactive_incident(uuid) is
  'SCRUM-46: Close the caller''s active incident when the 24h clock is due. resolved / ended, auto_closed true. Idempotent if already ended. Not due raises not_due. Not active raises not_open. Not pg_cron. Not FCM/SMS.';

revoke all on function public.auto_close_inactive_incident(uuid) from public;
revoke all on function public.auto_close_inactive_incident(uuid) from anon;
grant execute on function public.auto_close_inactive_incident(uuid) to authenticated;

comment on table public.incidents is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39 / 72 / 48 / 45 / 46: Emergency loop. One open incident per resident (activating or active). 45 marks safe. 46 ends or auto-closes after 24h quiet. The row stays. Members can SELECT active and resolved. Not FCM/SMS. Not pg_cron.';

comment on column public.incidents.status is
  'activating (36) | active (43) | cancelled (42) | resolved (45 safe / 46 ended). 46 writes resolved via end_incident() or auto_close_inactive_incident().';
