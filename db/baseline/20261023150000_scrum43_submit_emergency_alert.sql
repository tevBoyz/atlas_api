-- SCRUM-36 / 38 / 43 (+72): Atomic emergency submit
-- SOS tap only opens "What's happening?" in the app. No incident exists until
-- the resident taps a type; that tap calls submit_emergency_alert(type) once.
-- No grace period, no countdown, no confirm (SCRUM-42 is Cancelled).
--
-- submit_emergency_alert(p_emergency_type):
--   * JWT resident; profile must exist and setup be complete.
--   * Type must be medical | domestic_violence | fire | burglary | other.
--   * Serialized per resident (profiles row lock + one-open unique index).
--   * Already active → SCRUM-72 re-notify of that same incident (type kept).
--   * Legacy activating row → promoted to active with the given type.
--   * Else → insert a new active incident (type, activated_at, sent_at,
--     circle_id, share_payload snapshot) and in-app incident_deliveries for
--     active members. Logs alert_sent {recipient_count, recipient_ids} and
--     location_sharing_started once.
--   * renotify_emergency_alert now shares _incident_apply_renotify.
--   * Returns the shared JSON + delivered_count + acknowledged_count +
--     submit_outcome (created | promoted | renotified).
--
-- Drops the old multi-step path: start_emergency_activation,
-- set_emergency_type, send_emergency_alert, cancel_emergency_activation.
-- Leftover activating rows become cancelled (cancelled_at = now()).
-- Status values activating / cancelled stay in the check for history.
-- Incidents become RPC-write-only: client INSERT/UPDATE grants and the
-- insert/update policies are removed (no direct reopen / rewrite).
-- In-app delivery only. No FCM, no Twilio, no Edge Functions.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- Retire leftover grace rows (no writer can promote them after this file
-- except submit's legacy branch, which runs only if a row slipped in).
-- ---------------------------------------------------------------------------

update public.incidents
   set status = 'cancelled',
       cancelled_at = coalesce(cancelled_at, now())
 where status = 'activating';

-- ---------------------------------------------------------------------------
-- Drop the retired multi-step RPCs
-- ---------------------------------------------------------------------------

drop function if exists public.start_emergency_activation();
drop function if exists public.set_emergency_type(uuid, text);
drop function if exists public.send_emergency_alert(uuid);
drop function if exists public.cancel_emergency_activation(uuid);

-- ---------------------------------------------------------------------------
-- incidents: RPC-only writes
-- ---------------------------------------------------------------------------

drop policy if exists "incidents_insert_own" on public.incidents;
drop policy if exists "incidents_update_own" on public.incidents;

revoke insert, update, delete, truncate, references, trigger
  on table public.incidents from authenticated;
revoke all on table public.incidents from anon;
revoke all on table public.incidents from public;
grant select on table public.incidents to authenticated;

comment on policy "incidents_select_own" on public.incidents is
  'Resident can SELECT own incidents (active, resolved, legacy cancelled). Writes are RPC-only.';

comment on column public.incidents.status is
  'active (submit_emergency_alert) | resolved (mark_incident_safe; legacy ended). activating / cancelled are legacy (retired SCRUM-36 grace / SCRUM-42) and are no longer written except cancelled by the cleanup migration.';

comment on column public.incidents.cancelled_at is
  'Legacy (retired SCRUM-42 grace). Set on historical cancelled rows and on activating rows retired by the SCRUM-36/43 submit migration.';

comment on column public.incidents.sent_at is
  'SCRUM-43: in-app send time. Set by submit_emergency_alert in the same transaction that creates/promotes the incident and inserts deliveries. Unchanged on re-notify.';

comment on table public.incidents is
  'Emergency loop. One open incident per resident (incidents_one_open_per_resident_uidx). Created active by submit_emergency_alert (type required), closed by mark_incident_safe. Writes are RPC-only. Timeline in incident_events. Rows are never deleted. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- Internal: SCRUM-72 re-notify of an active incident (shared by submit and
-- renotify_emergency_alert). Caller must hold the incident row lock.
-- ---------------------------------------------------------------------------

create or replace function public._incident_apply_renotify(
  p_incident_id uuid,
  p_actor_id uuid
)
returns public.incidents
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.incidents%rowtype;
  v_count integer;
begin
  update public.incidents
     set renotified_at = now()
   where id = p_incident_id
     and status = 'active'
  returning * into rec;

  if rec.id is null then
    raise exception using
      errcode = 'P0001',
      message = '_incident_apply_renotify:not_open';
  end if;

  -- Same members. No new delivery rows. Ack history stays.
  update public.incident_deliveries
     set delivered_at = now()
   where incident_id = rec.id;

  get diagnostics v_count = row_count;

  perform public._incident_record_event(
    rec.id,
    'renotified',
    p_actor_id,
    jsonb_build_object('recipient_count', v_count)
  );

  return rec;
end;
$$;

comment on function public._incident_apply_renotify(uuid, uuid) is
  'Internal: SCRUM-72 re-notify. Sets renotified_at, refreshes delivered_at on existing deliveries, logs renotified {recipient_count}. Clients must not call this.';

revoke all on function public._incident_apply_renotify(uuid, uuid) from public;
revoke all on function public._incident_apply_renotify(uuid, uuid) from anon;
revoke all on function public._incident_apply_renotify(uuid, uuid) from authenticated;

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

  if rec.status is distinct from 'active' then
    raise exception using
      errcode = 'P0001',
      message = 'renotify_emergency_alert:not_open';
  end if;

  rec := public._incident_apply_renotify(rec.id, uid);

  return public._incident_send_json(rec);
end;
$$;

comment on function public.renotify_emergency_alert(uuid) is
  'SCRUM-72: re-notify the caller''s active incident in-app. Sets renotified_at, refreshes existing incident_deliveries.delivered_at (no new rows, acks kept), logs a renotified event {recipient_count}. Not active raises not_open. Never creates an incident. submit_emergency_alert on an active incident does the same. Not FCM/SMS.';

revoke all on function public.renotify_emergency_alert(uuid) from public;
revoke all on function public.renotify_emergency_alert(uuid) from anon;
grant execute on function public.renotify_emergency_alert(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_emergency_alert(p_emergency_type)
-- ---------------------------------------------------------------------------

create or replace function public.submit_emergency_alert(p_emergency_type text)
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
  v_payload jsonb;
  v_recipients uuid[];
  v_outcome text;
begin
  uid := public._require_auth_uid('submit_emergency_alert');

  if p_emergency_type is null
     or p_emergency_type not in (
       'medical',
       'domestic_violence',
       'fire',
       'burglary',
       'other'
     )
  then
    raise exception using
      errcode = 'P0001',
      message = 'submit_emergency_alert:invalid_type';
  end if;

  -- Serializes concurrent submits for this resident.
  select *
    into p
    from public.profiles
   where id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'submit_emergency_alert:profile_not_found';
  end if;

  if p.profile_setup_completed_at is null then
    raise exception using
      errcode = 'P0001',
      message = 'submit_emergency_alert:profile_setup_incomplete';
  end if;

  select *
    into rec
    from public.incidents i
   where i.resident_id = uid
     and i.status in ('activating', 'active')
   for update;

  -- SCRUM-72: already active → re-notify the same incident. Type unchanged.
  if found and rec.status = 'active' then
    rec := public._incident_apply_renotify(rec.id, uid);

    return public._incident_send_json(rec)
      || jsonb_build_object('submit_outcome', 'renotified');
  end if;

  v_payload := public._incident_share_payload(p);

  if found then
    -- Legacy activating row (pre-cleanup client): promote with this type.
    update public.incidents
       set status = 'active',
           emergency_type = p_emergency_type,
           sent_at = now(),
           share_payload = v_payload,
           cancelled_at = null
     where id = rec.id
    returning * into rec;

    v_outcome := 'promoted';
  else
    select sc.id
      into v_circle_id
      from public.safety_circles sc
     where sc.owner_id = uid;

    insert into public.incidents as i (
      resident_id,
      circle_id,
      status,
      emergency_type,
      activated_at,
      sent_at,
      share_payload
    )
    values (
      uid,
      v_circle_id,
      'active',
      p_emergency_type,
      now(),
      now(),
      v_payload
    )
    on conflict (resident_id) where (status in ('activating', 'active'))
    do nothing
    returning * into rec;

    if rec.id is null then
      -- Lost a race the profile lock should have prevented: never insert a
      -- second incident. Return the open one unchanged.
      select *
        into rec
        from public.incidents i
       where i.resident_id = uid
         and i.status = 'active'
       for update;

      rec := public._incident_apply_renotify(rec.id, uid);

      return public._incident_send_json(rec)
        || jsonb_build_object('submit_outcome', 'renotified');
    end if;

    v_outcome := 'created';
  end if;

  -- In-app deliveries for active members (never the resident, never pending).
  if rec.circle_id is not null then
    insert into public.incident_deliveries (
      incident_id,
      member_id,
      member_user_id
    )
    select rec.id,
           m.id,
           m.user_id
      from public.safety_circle_members m
     where m.circle_id = rec.circle_id
       and m.status = 'active'
       and m.user_id is not null
       and m.user_id is distinct from rec.resident_id
    on conflict (incident_id, member_user_id) do nothing;
  end if;

  select coalesce(array_agg(d.member_user_id order by d.member_user_id), '{}'::uuid[])
    into v_recipients
    from public.incident_deliveries d
   where d.incident_id = rec.id;

  perform public._incident_record_event(
    rec.id,
    'alert_sent',
    uid,
    jsonb_build_object(
      'recipient_count', coalesce(array_length(v_recipients, 1), 0),
      'recipient_ids', to_jsonb(v_recipients),
      'emergency_type', rec.emergency_type
    )
  );

  perform public._incident_record_event(
    rec.id,
    'location_sharing_started',
    uid,
    '{}'::jsonb
  );

  return public._incident_send_json(rec)
    || jsonb_build_object('submit_outcome', v_outcome);
end;
$$;

comment on function public.submit_emergency_alert(text) is
  'SCRUM-36 / 38 / 43 / 72: one call creates and sends the resident''s emergency alert. Type required (medical | domestic_violence | fire | burglary | other; unspecified/unknown → invalid_type). Serialized per resident; exactly one open incident. Already active → re-notify that incident (type unchanged, submit_outcome renotified). Legacy activating → promoted. Else inserts active incident with sent_at + share_payload, in-app deliveries for active members, and alert_sent / location_sharing_started events. Returns shared JSON + delivered_count + acknowledged_count + submit_outcome. No grace. Not FCM/SMS.';

revoke all on function public.submit_emergency_alert(text) from public;
revoke all on function public.submit_emergency_alert(text) from anon;
grant execute on function public.submit_emergency_alert(text) to authenticated;
