-- SCRUM-43: Send Emergency Alert
-- Promotes an activating incident to active, snapshots shareable profile
-- fields, and inserts in-app delivery rows for active circle members.
-- "Delivered" means: status = active, a delivery row exists for that
-- member, and they can SELECT the incident. In-app only. No FCM, no
-- device-token table, no Twilio/SMS, no Edge Functions.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- public.incidents.sent_at + share_payload
-- ---------------------------------------------------------------------------

alter table public.incidents
  add column sent_at timestamptz null,
  add column share_payload jsonb null;

alter table public.incidents
  add constraint incidents_share_payload_object
    check (
      share_payload is null
      or jsonb_typeof(share_payload) = 'object'
    );

comment on column public.incidents.sent_at is
  'SCRUM-43: First in-app send time. Null until send_emergency_alert(). Not a cancel. Unchanged on idempotent retry.';
comment on column public.incidents.share_payload is
  'SCRUM-43: Snapshot of shareable emergency-profile fields at send. Only keys whose flags are true and values are non-null/non-empty. Null until send. Empty object if nothing was shareable. Does not include personal-info full_name/DOB or type/GPS.';
comment on column public.incidents.status is
  'activating (36) | active (43) | cancelled (42) | resolved (45/46). 43 writes active only via send_emergency_alert(). In-app send; not FCM/SMS.';
comment on table public.incidents is
  'SCRUM-36 / 38 / 40 / 42 / 43: Emergency loop. One open incident per resident (activating or active). 43 send is in-app delivery rows + status active. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- public.incident_deliveries — in-app visibility rows, not push receipts
-- ---------------------------------------------------------------------------

create table public.incident_deliveries (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.incidents (id) on delete cascade,
  member_id uuid not null references public.safety_circle_members (id) on delete cascade,
  member_user_id uuid not null,
  delivered_at timestamptz not null default now(),
  acknowledged_at timestamptz null,
  constraint incident_deliveries_incident_member_user_uidx
    unique (incident_id, member_user_id)
);

comment on table public.incident_deliveries is
  'SCRUM-43: In-app delivery of an active incident to an active circle member. A row means the member can SELECT the incident. Not an FCM/APNs/SMS receipt. Pending (user_id null) and declined members are never inserted.';
comment on column public.incident_deliveries.incident_id is
  'FK → incidents. Cascades on incident delete.';
comment on column public.incident_deliveries.member_id is
  'FK → safety_circle_members. The active member row at send. Cascades if that membership is removed.';
comment on column public.incident_deliveries.member_user_id is
  'Auth user of the active member (safety_circle_members.user_id). Never the resident. Never null.';
comment on column public.incident_deliveries.delivered_at is
  'In-app visible time. Set on insert (send). Not a push timestamp.';
comment on column public.incident_deliveries.acknowledged_at is
  'Set by acknowledge_incident() when the member acks. Null until then.';

create index incident_deliveries_incident_id_idx
  on public.incident_deliveries (incident_id);

create index incident_deliveries_member_user_id_idx
  on public.incident_deliveries (member_user_id);

alter table public.incident_deliveries enable row level security;

-- Resident: all delivery rows for their incident.
drop policy if exists "incident_deliveries_select_resident" on public.incident_deliveries;
create policy "incident_deliveries_select_resident"
  on public.incident_deliveries
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.incidents i
      where i.id = incident_id
        and i.resident_id = auth.uid()
    )
  );

-- Member: own row only (ack + own delivery).
drop policy if exists "incident_deliveries_select_own" on public.incident_deliveries;
create policy "incident_deliveries_select_own"
  on public.incident_deliveries
  for select
  to authenticated
  using (member_user_id = auth.uid());

drop policy if exists "incident_deliveries_update_own" on public.incident_deliveries;
create policy "incident_deliveries_update_own"
  on public.incident_deliveries
  for update
  to authenticated
  using (member_user_id = auth.uid())
  with check (member_user_id = auth.uid());

comment on policy "incident_deliveries_select_resident" on public.incident_deliveries is
  'SCRUM-43: Resident can SELECT every delivery row for their incident (live counts).';
comment on policy "incident_deliveries_select_own" on public.incident_deliveries is
  'SCRUM-43: Member can SELECT their own delivery row. Ack is via acknowledge_incident().';
comment on policy "incident_deliveries_update_own" on public.incident_deliveries is
  'SCRUM-43: Member can UPDATE their own row (ack). Inserts are RPC-only (no INSERT policy / grant).';

-- No INSERT policy: members and residents cannot insert except via SECURITY DEFINER RPC.
-- No DELETE policy / grant.

revoke all on table public.incident_deliveries from public;
revoke all on table public.incident_deliveries from anon;
revoke all on table public.incident_deliveries from authenticated;
grant select, update on table public.incident_deliveries to authenticated;

-- ---------------------------------------------------------------------------
-- Shared activation JSON — add sent_at + share_payload (null until send).
-- start / type / attach / cancel keep the same behavior and pick these up.
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
    'share_payload', rec.share_payload
  );
$$;

comment on function public._incident_activation_json(public.incidents) is
  'Internal: Shared start / set_emergency_type / attach_incident_location / cancel_emergency_activation return shape. Includes sent_at and share_payload (null until send). Clients must not call this.';

revoke all on function public._incident_activation_json(public.incidents) from public;
revoke all on function public._incident_activation_json(public.incidents) from anon;
revoke all on function public._incident_activation_json(public.incidents) from authenticated;

comment on function public.start_emergency_activation() is
  'SCRUM-36 / 38 / 40 / 42 / 43: Start (or return) the resident open incident as activating. Idempotent while activating/active. Return includes emergency_type, location keys, cancelled_at, sent_at, and share_payload (null until send). New inserts omit those (defaults/null). Does not notify, attach GPS, cancel, send, or require a circle.';

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 / 40 / 42 / 43: Set emergency_type on the caller''s activating or active incident. Does not change status, location, activated_at, circle_id, resident_id, cancelled_at, sent_at, or share_payload. Return includes sent_at and share_payload. Does not send.';

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 42 / 43: Attach the activation location snapshot on the caller''s activating or active incident. Overwrite allowed. Does not change status, type, activated_at, circle_id, resident_id, cancelled_at, sent_at, or share_payload. Return includes sent_at and share_payload. Does not send. Not live tracking.';

comment on function public.cancel_emergency_activation(uuid) is
  'SCRUM-42 / 43: Cancel the caller''s activating incident during grace. Idempotent if already cancelled. Does not notify, write active, or delete. Return includes sent_at and share_payload (null on cancel-before-send). Timer-end send is send_emergency_alert().';

comment on policy "incidents_select_active_member" on public.incidents is
  'SCRUM-42 / 43 / 48: Active circle members can SELECT only status = active. activating and cancelled are invisible to members. Uses _is_active_circle_member (no RLS loop). Pending/declined cannot. 43 send writes active and inserts in-app delivery rows. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- Snapshot helper: only flagged, non-null, non-empty emergency-profile keys.
-- ---------------------------------------------------------------------------

create or replace function public._incident_share_payload(p public.profiles)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(
    jsonb_strip_nulls(
      jsonb_build_object(
        'emergency_contact_full_name',
          case
            when p.share_emergency_contact_full_name then
              nullif(btrim(p.emergency_contact_full_name), '')
            else null
          end,
        'emergency_contact_relationship',
          case
            when p.share_emergency_contact_relationship then
              nullif(btrim(p.emergency_contact_relationship), '')
            else null
          end,
        'emergency_contact_phone',
          case
            when p.share_emergency_contact_phone then
              nullif(btrim(p.emergency_contact_phone), '')
            else null
          end,
        'emergency_contact_email',
          case
            when p.share_emergency_contact_email then
              nullif(btrim(p.emergency_contact_email), '')
            else null
          end,
        'blood_type',
          case
            when p.share_blood_type then
              nullif(btrim(p.blood_type), '')
            else null
          end,
        'allergies',
          case
            when p.share_allergies then
              nullif(btrim(p.allergies), '')
            else null
          end,
        'medical_conditions',
          case
            when p.share_medical_conditions then
              nullif(btrim(p.medical_conditions), '')
            else null
          end,
        'emergency_preferred_language',
          case
            when p.share_emergency_preferred_language then
              nullif(btrim(p.emergency_preferred_language), '')
            else null
          end,
        'emergency_notes',
          case
            when p.emergency_notes_shareable then
              nullif(btrim(p.emergency_notes), '')
            else null
          end
      )
    ),
    '{}'::jsonb
  );
$$;

comment on function public._incident_share_payload(public.profiles) is
  'Internal: SCRUM-43 share snapshot. Nine emergency-profile fields gated by SCRUM-24 / 22 flags. Off, null, or blank keys are omitted. No personal-info full_name/DOB. Clients must not call this.';

revoke all on function public._incident_share_payload(public.profiles) from public;
revoke all on function public._incident_share_payload(public.profiles) from anon;
revoke all on function public._incident_share_payload(public.profiles) from authenticated;

-- ---------------------------------------------------------------------------
-- Count helpers
-- ---------------------------------------------------------------------------

create or replace function public._incident_delivery_counts_json(
  p_incident_id uuid,
  p_status text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'incident_id', p_incident_id,
    'delivered_count', (
      select count(*)::int
      from public.incident_deliveries d
      where d.incident_id = p_incident_id
    ),
    'acknowledged_count', (
      select count(*)::int
      from public.incident_deliveries d
      where d.incident_id = p_incident_id
        and d.acknowledged_at is not null
    ),
    'status', p_status
  );
$$;

comment on function public._incident_delivery_counts_json(uuid, text) is
  'Internal: {incident_id, delivered_count, acknowledged_count, status}. Clients must not call this.';

revoke all on function public._incident_delivery_counts_json(uuid, text) from public;
revoke all on function public._incident_delivery_counts_json(uuid, text) from anon;
revoke all on function public._incident_delivery_counts_json(uuid, text) from authenticated;

create or replace function public._incident_send_json(rec public.incidents)
returns jsonb
language sql
stable
set search_path = public
as $$
  select public._incident_activation_json(rec)
    || jsonb_build_object(
      'delivered_count', (
        select count(*)::int
        from public.incident_deliveries d
        where d.incident_id = rec.id
      ),
      'acknowledged_count', (
        select count(*)::int
        from public.incident_deliveries d
        where d.incident_id = rec.id
          and d.acknowledged_at is not null
      )
    );
$$;

comment on function public._incident_send_json(public.incidents) is
  'Internal: Shared incident shape plus delivered_count and acknowledged_count. Clients must not call this.';

revoke all on function public._incident_send_json(public.incidents) from public;
revoke all on function public._incident_send_json(public.incidents) from anon;
revoke all on function public._incident_send_json(public.incidents) from authenticated;

-- ---------------------------------------------------------------------------
-- send_emergency_alert(p_incident_id) — in-app send, not FCM/SMS
-- ---------------------------------------------------------------------------

create or replace function public.send_emergency_alert(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
  p public.profiles%rowtype;
  v_payload jsonb;
begin
  uid := public._require_auth_uid('send_emergency_alert');

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'send_emergency_alert:not_found';
  end if;

  -- Already sent: return current shape + counts. Do not rewrite.
  if rec.status = 'active' then
    return public._incident_send_json(rec);
  end if;

  if rec.status is distinct from 'activating' then
    raise exception using
      errcode = 'P0001',
      message = 'send_emergency_alert:not_open';
  end if;

  select *
    into p
    from public.profiles
   where id = uid;

  if found then
    v_payload := public._incident_share_payload(p);
  else
    v_payload := '{}'::jsonb;
  end if;

  update public.incidents
     set status = 'active',
         sent_at = now(),
         share_payload = v_payload
   where id = rec.id
  returning * into rec;

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
       and m.user_id is distinct from rec.resident_id;
  end if;

  return public._incident_send_json(rec);
end;
$$;

comment on function public.send_emergency_alert(uuid) is
  'SCRUM-43: Promote the caller''s activating incident to active, snapshot share_payload, insert in-app delivery rows for active members with user_id. Idempotent if already active. Does not notify FCM/SMS. Does not write cancelled/resolved. Zero deliveries is success.';

revoke all on function public.send_emergency_alert(uuid) from public;
revoke all on function public.send_emergency_alert(uuid) from anon;
grant execute on function public.send_emergency_alert(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- incident_delivery_counts(p_incident_id)
-- Resident of the incident, or an active member who can SELECT it (status
-- active). Counts RPC is definer so a member can see the full tally; member
-- RLS on incident_deliveries only allows their own row.
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

  -- Active members may count only after send (they can SELECT the incident).
  if rec.circle_id is not null
     and rec.status = 'active'
     and public._is_active_circle_member(rec.circle_id, uid)
  then
    return public._incident_delivery_counts_json(rec.id, rec.status);
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'incident_delivery_counts:not_found';
end;
$$;

comment on function public.incident_delivery_counts(uuid) is
  'SCRUM-43: Live in-app delivery/ack counts. Resident of the incident, or an active circle member after send. not_found if no access. Not FCM/SMS.';

revoke all on function public.incident_delivery_counts(uuid) from public;
revoke all on function public.incident_delivery_counts(uuid) from anon;
grant execute on function public.incident_delivery_counts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- acknowledge_incident(p_incident_id) — member ack so counts can be real.
-- Flutter ack screen is a different assignment.
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

  if not found or rec.status is distinct from 'active' then
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
  'SCRUM-43: Set acknowledged_at on the caller''s in-app delivery row when the incident is active. Idempotent if already acked. Does not build a Flutter ack screen. Not FCM/SMS.';

revoke all on function public.acknowledge_incident(uuid) from public;
revoke all on function public.acknowledge_incident(uuid) from anon;
grant execute on function public.acknowledge_incident(uuid) to authenticated;
