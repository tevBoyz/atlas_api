-- Rollback of db/migrations/0025_drop_legacy_sql.sql (Stage 1, D76).
--
-- Recreates exactly what 0025 dropped, generated 2026-11-26 from a database built from db/baseline
-- + 0001-0024 (no migration after the baseline changed any of these functions):
--   - the 69 Supabase-era `public` functions (definition, EXECUTE privileges as they were after
--     0012: owner + service_role, plus supabase_auth_admin on the Auth hook; comments);
--   - the 18 RLS policies on `public` tables (they call `auth.uid()`, present on every Supabase
--     database and in the local shim);
--   - the 0004 `app_config` row `client_incidents_backend` with its 0004 seed value "supabase"
--     (an existing row is kept).
-- Then it removes 0025 from `public.api_schema_migrations`, so `npm run db:migrate` applies it again.
-- RLS flags are not touched by 0025, so nothing to restore there.
--
-- Run as the database owner (the role `npm run db:migrate` uses), in one transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/0025_down.sql
-- Safe to run twice (create or replace, drop policy if exists, on conflict do nothing).
-- If 0012 must be rolled back too, run this first, then db/rollback/0012_down.sql.

begin;

-- The definitions and comments contain UTF-8 text (en dash, arrows).
set client_encoding = 'UTF8';
set local search_path = pg_catalog;
-- Function bodies reference each other; validate at call time, as the baseline did.
set local check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. Functions
-- ---------------------------------------------------------------------------

-- public._auth_user_phone(uuid)
CREATE OR REPLACE FUNCTION public._auth_user_phone(uid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select public._normalize_e164(u.phone)
    from auth.users u
   where u.id = uid;
$function$
;
revoke all on function public._auth_user_phone(uuid) from public, anon, authenticated, service_role;
grant execute on function public._auth_user_phone(uuid) to service_role;
comment on function public._auth_user_phone(uuid) is 'SCRUM-28: Auth phone for uid, normalized to +E.164 when possible. Internal.';

-- public._avatars_public_url(text)
CREATE OR REPLACE FUNCTION public._avatars_public_url(object_path text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  raw text := nullif(trim(coalesce(object_path, '')), '');
  host text;
begin
  if raw is null then
    return null;
  end if;

  if raw ~* '^https?://' then
    return raw;
  end if;

  begin
    host := nullif(
      trim(
        split_part(
          coalesce(
            current_setting('request.headers', true)::json->>'x-forwarded-host',
            current_setting('request.headers', true)::json->>'host',
            ''
          ),
          ',',
          1
        )
      ),
      ''
    );
  exception
    when others then
      host := null;
  end;

  if host is not null then
    host := split_part(host, ':', 1);
    return 'https://' || host || '/storage/v1/object/public/avatars/' || raw;
  end if;

  -- Host missing (direct SQL). Same public path Flutter prefixes with SUPABASE_URL
  -- or resolves via storage.from('avatars').getPublicUrl(object_path).
  return '/storage/v1/object/public/avatars/' || raw;
end;
$function$
;
revoke all on function public._avatars_public_url(text) from public, anon, authenticated, service_role;
grant execute on function public._avatars_public_url(text) to service_role;
comment on function public._avatars_public_url(text) is 'SCRUM-29: Public avatars URL from object path. Internal. Does not read other profile columns.';

-- public._can_view_incident_events(uuid)
CREATE OR REPLACE FUNCTION public._can_view_incident_events(p_incident_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._can_view_incident_events(uuid) from public, anon, authenticated, service_role;
grant execute on function public._can_view_incident_events(uuid) to service_role;
comment on function public._can_view_incident_events(uuid) is 'Internal (RLS): true when auth.uid() is the incident resident, or an active circle member whose membership activated at or before the incident started, and the incident is active or resolved (rule 54). Used by incident_events and incident_deliveries member policies. SECURITY DEFINER so policies do not recurse.';

-- public._circle_accept_used_after(uuid,uuid)
CREATE OR REPLACE FUNCTION public._circle_accept_used_after(p_circle_id uuid, p_member_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select (
    count(*) filter (
      where public._circle_invite_holds_slot(scm)
        and scm.id is distinct from p_member_id
    )
    + 1
  )::integer
  from public.safety_circle_members scm
  where scm.circle_id = p_circle_id;
$function$
;
revoke all on function public._circle_accept_used_after(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public._circle_accept_used_after(uuid,uuid) to service_role;
comment on function public._circle_accept_used_after(uuid,uuid) is 'SCRUM-28 / fix #14: Trusted slots after activating p_member_id = other active members + other valid pending invites + 1. Owner, declined and expired rows excluded. Internal.';

-- public._circle_has_active_membership(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public._circle_has_active_membership(cid uuid, uid uuid, exclude_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.safety_circle_members x
     where x.circle_id = cid
       and x.user_id = uid
       and x.status = 'active'
       and x.id is distinct from exclude_id
  );
$function$
;
revoke all on function public._circle_has_active_membership(uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public._circle_has_active_membership(uuid,uuid,uuid) to service_role;
comment on function public._circle_has_active_membership(uuid,uuid,uuid) is 'SCRUM-28: True if uid is already an active member (including owner) of the circle. Internal.';

-- public._circle_invite_lookup_status(public.safety_circle_members)
CREATE OR REPLACE FUNCTION public._circle_invite_lookup_status(m public.safety_circle_members)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  if m.invite_canceled_at is not null or m.status = 'declined' then
    return 'canceled';
  elsif m.invite_consumed_at is not null or m.status = 'active' then
    return 'consumed';
  elsif m.invite_expires_at is not null and m.invite_expires_at <= now() then
    return 'expired';
  elsif m.invite_expires_at is null
        and m.invited_at + interval '7 days' <= now() then
    return 'expired';
  elsif m.status = 'pending' then
    return 'pending';
  else
    return 'not_found';
  end if;
end;
$function$
;
revoke all on function public._circle_invite_lookup_status(public.safety_circle_members) from public, anon, authenticated, service_role;
grant execute on function public._circle_invite_lookup_status(public.safety_circle_members) to service_role;
comment on function public._circle_invite_lookup_status(public.safety_circle_members) is 'SCRUM-28: Same precedence as lookup_circle_invite. Internal.';

-- public._circle_invite_payload(public.safety_circle_members,boolean)
CREATE OR REPLACE FUNCTION public._circle_invite_payload(m public.safety_circle_members, resent boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'status', m.status,
    'display_name', m.display_name,
    'relationship', m.relationship,
    'phone', m.phone,
    'invite_token', m.invite_token,
    'invite_url', 'io.supabase.atlasmobile://invite/' || m.invite_token,
    'invited_at', m.invited_at,
    'invite_expires_at', m.invite_expires_at,
    'resent', resent
  );
$function$
;
revoke all on function public._circle_invite_payload(public.safety_circle_members,boolean) from public, anon, authenticated, service_role;
grant execute on function public._circle_invite_payload(public.safety_circle_members,boolean) to service_role;
comment on function public._circle_invite_payload(public.safety_circle_members,boolean) is 'SCRUM-27: JSON payload for invite / resend RPCs. Internal.';

-- public._circle_invite_preview_payload(public.safety_circle_members,text,boolean,boolean)
CREATE OR REPLACE FUNCTION public._circle_invite_preview_payload(m public.safety_circle_members, st text, recipient_ok boolean, claimed boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  if m.id is null then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false
    );
  end if;

  if not recipient_ok then
    return jsonb_build_object(
      'status', st,
      'invite_expires_at', m.invite_expires_at,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false
    );
  end if;

  return jsonb_build_object(
    'status', st,
    'invite_expires_at', m.invite_expires_at,
    'member_id', m.id,
    'circle_id', m.circle_id,
    'owner_name', public._circle_owner_display_name(m.circle_id),
    'invited_at', m.invited_at,
    'claimed', claimed,
    'recipient_ok', true
  );
end;
$function$
;
revoke all on function public._circle_invite_preview_payload(public.safety_circle_members,text,boolean,boolean) from public, anon, authenticated, service_role;
grant execute on function public._circle_invite_preview_payload(public.safety_circle_members,text,boolean,boolean) to service_role;
comment on function public._circle_invite_preview_payload(public.safety_circle_members,text,boolean,boolean) is 'SCRUM-28: Authenticated preview JSON. No emergency_*, medical, other members, or profiles. Internal.';

-- public._circle_invite_recipient_ok(public.safety_circle_members,uuid,text)
CREATE OR REPLACE FUNCTION public._circle_invite_recipient_ok(m public.safety_circle_members, uid uuid, auth_phone text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
begin
  if m.user_id is not null and m.user_id <> uid then
    return false;
  end if;

  if m.phone is not null then
    return public._normalize_e164(auth_phone) is not null
       and public._normalize_e164(m.phone)
         = public._normalize_e164(auth_phone);
  end if;

  -- Link-only: possession of the current token is enough.
  return true;
end;
$function$
;
revoke all on function public._circle_invite_recipient_ok(public.safety_circle_members,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public._circle_invite_recipient_ok(public.safety_circle_members,uuid,text) to service_role;
comment on function public._circle_invite_recipient_ok(public.safety_circle_members,uuid,text) is 'SCRUM-28: Phone invites must match Auth after _normalize_e164. Link-only (phone null) allows the token holder. Internal.';

-- public._circle_owner_display_name(uuid)
CREATE OR REPLACE FUNCTION public._circle_owner_display_name(cid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select om.display_name
    from public.safety_circle_members om
   where om.circle_id = cid
     and om.role = 'owner'
   limit 1;
$function$
;
revoke all on function public._circle_owner_display_name(uuid) from public, anon, authenticated, service_role;
grant execute on function public._circle_owner_display_name(uuid) to service_role;
comment on function public._circle_owner_display_name(uuid) is 'SCRUM-28: Owner member display_name (not profiles). Internal.';

-- public._incident_activation_json(public.incidents)
CREATE OR REPLACE FUNCTION public._incident_activation_json(rec public.incidents)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_activation_json(public.incidents) from public, anon, authenticated, service_role;
grant execute on function public._incident_activation_json(public.incidents) to service_role;
comment on function public._incident_activation_json(public.incidents) is 'Internal: shared resident incident shape (submit / open read / attach / notes / renotify / mark safe). Includes location_sharing_ended_at (null while active). auto_closed / activity_confirmed_at / cancelled_at are legacy keys kept for history. Clients must not call this.';

-- public._incident_active_recipient_ids(public.incidents)
CREATE OR REPLACE FUNCTION public._incident_active_recipient_ids(rec public.incidents)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_active_recipient_ids(public.incidents) from public, anon, authenticated, service_role;
grant execute on function public._incident_active_recipient_ids(public.incidents) to service_role;
comment on function public._incident_active_recipient_ids(public.incidents) is 'Internal: active circle member user_ids for the incident circle whose membership activated at or before the incident started (rule 54), excluding the resident. Empty array when no circle. Clients must not call this.';

-- public._incident_apply_renotify(uuid,uuid)
CREATE OR REPLACE FUNCTION public._incident_apply_renotify(p_incident_id uuid, p_actor_id uuid)
 RETURNS public.incidents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_apply_renotify(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public._incident_apply_renotify(uuid,uuid) to service_role;
comment on function public._incident_apply_renotify(uuid,uuid) is 'Internal: SCRUM-72 re-notify. Sets renotified_at, refreshes delivered_at on existing deliveries, logs renotified {recipient_count}. Clients must not call this.';

-- public._incident_delivery_counts_json(uuid,text)
CREATE OR REPLACE FUNCTION public._incident_delivery_counts_json(p_incident_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_delivery_counts_json(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public._incident_delivery_counts_json(uuid,text) to service_role;
comment on function public._incident_delivery_counts_json(uuid,text) is 'Internal: {incident_id, delivered_count, acknowledged_count, status}. Clients must not call this.';

-- public._incident_record_event(uuid,text,uuid,jsonb)
CREATE OR REPLACE FUNCTION public._incident_record_event(p_incident_id uuid, p_event_type text, p_actor_id uuid, p_detail jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_record_event(uuid,text,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public._incident_record_event(uuid,text,uuid,jsonb) to service_role;
comment on function public._incident_record_event(uuid,text,uuid,jsonb) is 'Internal: append one incident_events row. Once-only lifecycle types are no-ops on repeat. Clients must not call this.';

-- public._incident_send_json(public.incidents)
CREATE OR REPLACE FUNCTION public._incident_send_json(rec public.incidents)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_send_json(public.incidents) from public, anon, authenticated, service_role;
grant execute on function public._incident_send_json(public.incidents) to service_role;
comment on function public._incident_send_json(public.incidents) is 'Internal: Shared incident shape (including resolve keys) plus delivered_count and acknowledged_count. Send and renotify do not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Clients must not call this.';

-- public._incident_share_payload(public.profiles)
CREATE OR REPLACE FUNCTION public._incident_share_payload(p public.profiles)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._incident_share_payload(public.profiles) from public, anon, authenticated, service_role;
grant execute on function public._incident_share_payload(public.profiles) to service_role;
comment on function public._incident_share_payload(public.profiles) is 'Internal: SCRUM-43 share snapshot. Nine emergency-profile fields gated by SCRUM-24 / 22 flags. Off, null, or blank keys are omitted. No personal-info full_name/DOB. Does not include incidents.incident_notes (SCRUM-39). Clients must not call this.';

-- public._is_active_circle_member(uuid,uuid)
CREATE OR REPLACE FUNCTION public._is_active_circle_member(circle_id uuid, uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from public.safety_circle_members m
    where m.circle_id = _is_active_circle_member.circle_id
      and m.user_id = _is_active_circle_member.uid
      and m.status = 'active'
  );
$function$
;
revoke all on function public._is_active_circle_member(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public._is_active_circle_member(uuid,uuid) to service_role;
comment on function public._is_active_circle_member(uuid,uuid) is 'Internal: true when uid has an active safety_circle_members row on circle_id. SECURITY DEFINER so RLS cannot recurse. Used by safety_circles_select_active_member and incidents_select_active_member.';

-- public._is_active_circle_member_since(uuid,uuid,timestamp with time zone)
CREATE OR REPLACE FUNCTION public._is_active_circle_member_since(p_circle_id uuid, p_uid uuid, p_incident_activated_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public._is_active_circle_member_since(uuid,uuid,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public._is_active_circle_member_since(uuid,uuid,timestamp with time zone) to service_role;
comment on function public._is_active_circle_member_since(uuid,uuid,timestamp with time zone) is 'Internal (RLS + RPCs): true when uid is an active member of circle_id whose activated_at <= the incident''s activated_at (rule 54 membership window). SECURITY DEFINER so policies do not recurse.';

-- public._login_lockout_client_ip()
CREATE OR REPLACE FUNCTION public._login_lockout_client_ip()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  headers jsonb;
  forwarded text;
  real_ip text;
begin
  begin
    headers := current_setting('request.headers', true)::jsonb;
  exception
    when others then
      headers := null;
  end;

  if headers is null then
    return 'unknown';
  end if;

  forwarded := nullif(trim(split_part(coalesce(headers->>'x-forwarded-for', ''), ',', 1)), '');
  if forwarded is not null then
    return forwarded;
  end if;

  real_ip := nullif(trim(coalesce(headers->>'x-real-ip', '')), '');
  if real_ip is not null then
    return real_ip;
  end if;

  return 'unknown';
end;
$function$
;
revoke all on function public._login_lockout_client_ip() from public, anon, authenticated, service_role;
grant execute on function public._login_lockout_client_ip() to service_role;
comment on function public._login_lockout_client_ip() is 'SCRUM-16: Caller IP from request headers. Internal.';

-- public._login_lockout_key_for_user(uuid)
CREATE OR REPLACE FUNCTION public._login_lockout_key_for_user(uid uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  user_email text;
  user_phone text;
  phone_norm text;
begin
  if uid is null then
    return null;
  end if;

  select nullif(lower(trim(coalesce(u.email, ''))), ''),
         u.phone
    into user_email, user_phone
    from auth.users u
   where u.id = uid;

  if user_email is not null
     and char_length(user_email) <= 254
     and user_email ~ '^[^@\s]+@[^@\s]+$' then
    return user_email;
  end if;

  phone_norm := public._normalize_e164(user_phone);
  if phone_norm is not null and phone_norm ~ '^\+[1-9][0-9]{7,14}$' then
    return phone_norm;
  end if;

  return null;
end;
$function$
;
revoke all on function public._login_lockout_key_for_user(uuid) from public, anon, authenticated, service_role;

comment on function public._login_lockout_key_for_user(uuid) is 'SCRUM-16: Email lock key, else E.164, else null. Internal. Not an RPC. Do not grant to API roles — the key can be an email.';

-- public._login_lockout_load(text,boolean)
CREATE OR REPLACE FUNCTION public._login_lockout_load(email_norm text, reset_expired boolean)
 RETURNS public.login_lockouts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  rec public.login_lockouts;
begin
  select *
    into rec
    from public.login_lockouts l
   where l.email = email_norm
   for update;

  if not found then
    return null;
  end if;

  if not reset_expired then
    return rec;
  end if;

  if rec.locked_until is not null and rec.locked_until <= now() then
    rec.failed_attempts := 0;
    rec.locked_until := null;
    rec.last_failed_at := null;
    rec.updated_at := now();
    update public.login_lockouts l
       set failed_attempts = rec.failed_attempts,
           locked_until = rec.locked_until,
           last_failed_at = rec.last_failed_at,
           updated_at = rec.updated_at
     where l.email = email_norm;
  elsif rec.locked_until is null
     and rec.last_failed_at is not null
     and rec.last_failed_at <= now() - interval '15 minutes' then
    rec.failed_attempts := 0;
    rec.last_failed_at := null;
    rec.updated_at := now();
    update public.login_lockouts l
       set failed_attempts = rec.failed_attempts,
           last_failed_at = rec.last_failed_at,
           updated_at = rec.updated_at
     where l.email = email_norm;
  end if;

  return rec;
end;
$function$
;
revoke all on function public._login_lockout_load(text,boolean) from public, anon, authenticated, service_role;
grant execute on function public._login_lockout_load(text,boolean) to service_role;
comment on function public._login_lockout_load(text,boolean) is 'SCRUM-16: Load row; optionally expire lock / 15-minute window. Internal.';

-- public._login_lockout_payload(public.login_lockouts)
CREATE OR REPLACE FUNCTION public._login_lockout_payload(rec public.login_lockouts)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  is_locked boolean;
begin
  if rec is null then
    return public._login_lockout_status_json(false, null, 0);
  end if;
  is_locked := rec.locked_until is not null and rec.locked_until > now();
  return public._login_lockout_status_json(
    is_locked,
    case when is_locked then rec.locked_until else null end,
    coalesce(rec.failed_attempts, 0)
  );
end;
$function$
;
revoke all on function public._login_lockout_payload(public.login_lockouts) from public, anon, authenticated, service_role;
grant execute on function public._login_lockout_payload(public.login_lockouts) to service_role;
comment on function public._login_lockout_payload(public.login_lockouts) is 'SCRUM-16: Row → status JSON. Internal.';

-- public._login_lockout_phone_key(text)
CREATE OR REPLACE FUNCTION public._login_lockout_phone_key(raw text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  n text;
begin
  if raw is null or btrim(raw) = '' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:phone_required';
  end if;

  n := public._normalize_e164(raw);
  if n is null or n !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:invalid_phone';
  end if;

  return n;
end;
$function$
;
revoke all on function public._login_lockout_phone_key(text) from public, anon, authenticated, service_role;

comment on function public._login_lockout_phone_key(text) is 'SCRUM-16: Strict E.164 for lockout. Digits-only 8-15 get a leading +. Internal. Not an RPC.';

-- public._login_lockout_rate_limit(text,integer)
CREATE OR REPLACE FUNCTION public._login_lockout_rate_limit(rpc_name text, max_calls integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bucket text;
  v_count integer;
begin
  if rpc_name is null or max_calls is null or max_calls < 1 then
    return;
  end if;

  v_bucket := rpc_name || ':' || public._login_lockout_client_ip();

  insert into public.login_lockout_rpc_throttle as t (
    bucket,
    window_started_at,
    call_count
  )
  values (v_bucket, now(), 1)
  on conflict (bucket) do update
    set window_started_at = case
          when t.window_started_at <= now() - interval '5 minutes'
            then now()
          else t.window_started_at
        end,
        call_count = case
          when t.window_started_at <= now() - interval '5 minutes'
            then 1
          else t.call_count + 1
        end
  returning t.call_count
    into v_count;

  if v_count > max_calls then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:rate_limited';
  end if;
end;
$function$
;
revoke all on function public._login_lockout_rate_limit(text,integer) from public, anon, authenticated, service_role;
grant execute on function public._login_lockout_rate_limit(text,integer) to service_role;
comment on function public._login_lockout_rate_limit(text,integer) is 'SCRUM-16: Per-IP 5-minute window. Internal.';

-- public._login_lockout_resolve_key(text,text)
CREATE OR REPLACE FUNCTION public._login_lockout_resolve_key(p_email text, p_phone text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  phone_norm text;
  uid uuid;
  resolved text;
begin
  if p_email is not null and p_phone is not null then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:identifier_exclusive';
  end if;

  if p_email is null and p_phone is null then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:identifier_required';
  end if;

  if p_email is not null then
    return public._normalize_login_email(p_email);
  end if;

  phone_norm := public._login_lockout_phone_key(p_phone);

  select u.id
    into uid
    from auth.users u
   where public._normalize_e164(u.phone) = phone_norm
   order by case
     when nullif(lower(trim(coalesce(u.email, ''))), '') is not null
      and char_length(lower(trim(u.email))) <= 254
      and lower(trim(u.email)) ~ '^[^@\s]+@[^@\s]+$'
     then 0
     else 1
   end,
   u.created_at nulls last
   limit 1;

  if not found then
    return phone_norm;
  end if;

  resolved := public._login_lockout_key_for_user(uid);
  return coalesce(resolved, phone_norm);
end;
$function$
;
revoke all on function public._login_lockout_resolve_key(text,text) from public, anon, authenticated, service_role;

comment on function public._login_lockout_resolve_key(text,text) is 'SCRUM-16: Exactly one of p_email or p_phone. Phone of a user with an email returns that email key. Internal. Not an RPC.';

-- public._login_lockout_status_json(boolean,timestamp with time zone,integer)
CREATE OR REPLACE FUNCTION public._login_lockout_status_json(p_locked boolean, p_locked_until timestamp with time zone, p_failed_attempts integer)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'locked', coalesce(p_locked, false),
    'locked_until', p_locked_until,
    'failed_attempts', coalesce(p_failed_attempts, 0)
  );
$function$
;
revoke all on function public._login_lockout_status_json(boolean,timestamp with time zone,integer) from public, anon, authenticated, service_role;
grant execute on function public._login_lockout_status_json(boolean,timestamp with time zone,integer) to service_role;
comment on function public._login_lockout_status_json(boolean,timestamp with time zone,integer) is 'SCRUM-16: Status payload. Internal.';

-- public._member_avatar_url(uuid)
CREATE OR REPLACE FUNCTION public._member_avatar_url(uid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public._avatars_public_url(p.avatar_path)
    from public.profiles p
   where p.id = uid;
$function$
;
revoke all on function public._member_avatar_url(uuid) from public, anon, authenticated, service_role;
grant execute on function public._member_avatar_url(uuid) to service_role;
comment on function public._member_avatar_url(uuid) is 'SCRUM-29: avatar_path only for uid. Null if no profile or no photo. Internal. Does not expose emergency_*, medical, or share flags.';

-- public._member_profile_name(uuid)
CREATE OR REPLACE FUNCTION public._member_profile_name(uid uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select nullif(trim(p.full_name), '')
    from public.profiles p
   where p.id = uid;
$function$
;
revoke all on function public._member_profile_name(uuid) from public, anon, authenticated, service_role;
grant execute on function public._member_profile_name(uuid) to service_role;
comment on function public._member_profile_name(uuid) is 'Fix #18: full_name only for uid, trimmed; null if no profile or empty. Internal. Does not expose emergency_*, medical, contact, or share flags.';

-- public._normalize_e164(text)
CREATE OR REPLACE FUNCTION public._normalize_e164(raw text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public'
AS $function$
  select case
    when raw is null then null
    when btrim(raw) = '' then null
    when btrim(raw) ~ '^\+[1-9][0-9]{7,14}$' then btrim(raw)
    when btrim(raw) ~ '^[1-9][0-9]{7,14}$' then '+' || btrim(raw)
    else btrim(raw)
  end;
$function$
;
revoke all on function public._normalize_e164(text) from public, anon, authenticated, service_role;
grant execute on function public._normalize_e164(text) to service_role;
comment on function public._normalize_e164(text) is 'SCRUM-28: Trim. Keep +E.164. Prefix + on digits-only 8–15 starting 1-9. Else trimmed or null. Internal.';

-- public._normalize_login_email(text)
CREATE OR REPLACE FUNCTION public._normalize_login_email(raw text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
declare
  n text;
begin
  n := lower(trim(coalesce(raw, '')));
  if n = '' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:email_required';
  end if;
  if char_length(n) > 254 or n !~ '^[^@\s]+@[^@\s]+$' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:invalid_email';
  end if;
  return n;
end;
$function$
;
revoke all on function public._normalize_login_email(text) from public, anon, authenticated, service_role;
grant execute on function public._normalize_login_email(text) to service_role;
comment on function public._normalize_login_email(text) is 'SCRUM-16: lower(trim(email)). Reject blank / oversized / no-at. Internal.';

-- public._owner_circle_for_invite(text)
CREATE OR REPLACE FUNCTION public._owner_circle_for_invite(err_prefix text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  sharing boolean;
  cid uuid;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_authenticated';
  end if;

  select p.location_sharing_enabled
    into sharing
    from public.profiles p
   where p.id = uid;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':profile_not_found';
  end if;

  if not sharing then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':location_sharing_disabled';
  end if;

  select sc.id
    into cid
    from public.safety_circles sc
   where sc.owner_id = uid
   for update;

  if cid is null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':circle_not_found';
  end if;

  return cid;
end;
$function$
;
revoke all on function public._owner_circle_for_invite(text) from public, anon, authenticated, service_role;
grant execute on function public._owner_circle_for_invite(text) to service_role;
comment on function public._owner_circle_for_invite(text) is 'SCRUM-27: Auth + location_sharing_enabled + owner circle lock. Internal.';

-- public._refresh_circle_invite(uuid,text,text,text)
CREATE OR REPLACE FUNCTION public._refresh_circle_invite(p_member_id uuid, err_prefix text, p_display_name text DEFAULT NULL::text, p_relationship text DEFAULT NULL::text)
 RETURNS public.safety_circle_members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m public.safety_circle_members%rowtype;
  new_name text;
  new_rel text;
begin
  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = p_member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':member_not_found';
  end if;

  if m.role <> 'member' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_invitable';
  end if;

  if m.status = 'active' or m.invite_consumed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':already_active';
  end if;

  new_name := coalesce(nullif(trim(p_display_name), ''), m.display_name);
  if char_length(new_name) = 0 then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':invalid_display_name';
  end if;

  if p_relationship is null then
    new_rel := m.relationship;
  else
    new_rel := nullif(trim(p_relationship), '');
  end if;

  if new_rel is not null
     and new_rel not in (
       'spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'
     ) then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':invalid_relationship';
  end if;

  update public.safety_circle_members
     set display_name = new_name,
         relationship = new_rel,
         status = 'pending',
         user_id = null,
         invited_at = now(),
         invite_token = public.new_circle_invite_token(),
         invite_expires_at = now() + interval '7 days',
         invite_consumed_at = null,
         invite_canceled_at = null,
         updated_at = now()
   where public.safety_circle_members.id = p_member_id
   returning * into m;

  return m;
end;
$function$
;
revoke all on function public._refresh_circle_invite(uuid,text,text,text) from public, anon, authenticated, service_role;
grant execute on function public._refresh_circle_invite(uuid,text,text,text) to service_role;
comment on function public._refresh_circle_invite(uuid,text,text,text) is 'SCRUM-27: Rotate token, refresh invited_at + 7-day expiry, set pending. Never regresses active. Internal. Columns qualified vs args.';

-- public._reject_unless_pending(text,text)
CREATE OR REPLACE FUNCTION public._reject_unless_pending(err_prefix text, st text)
 RETURNS void
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
begin
  if st = 'pending' then
    return;
  elsif st = 'expired' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':expired';
  elsif st = 'consumed' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':consumed';
  elsif st = 'canceled' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':canceled';
  else
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_found';
  end if;
end;
$function$
;
revoke all on function public._reject_unless_pending(text,text) from public, anon, authenticated, service_role;
grant execute on function public._reject_unless_pending(text,text) to service_role;
comment on function public._reject_unless_pending(text,text) is 'SCRUM-28: Raise lookup-status errors. Internal.';

-- public._require_auth_uid(text)
CREATE OR REPLACE FUNCTION public._require_auth_uid(err_prefix text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_authenticated';
  end if;
  return uid;
end;
$function$
;
revoke all on function public._require_auth_uid(text) from public, anon, authenticated, service_role;
grant execute on function public._require_auth_uid(text) to service_role;
comment on function public._require_auth_uid(text) is 'SCRUM-28: Require auth.uid(). Internal.';

-- public._require_circle_invite_slot(uuid,text)
CREATE OR REPLACE FUNCTION public._require_circle_invite_slot(p_circle_id uuid, err_prefix text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform 1
    from public.safety_circles sc
   where sc.id = p_circle_id
   for update;

  if coalesce(
       (public._circle_invite_capacity_json(p_circle_id)->>'available')::integer,
       0
     ) <= 0 then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':circle_full';
  end if;
end;
$function$
;
revoke all on function public._require_circle_invite_slot(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public._require_circle_invite_slot(uuid,text) to service_role;
comment on function public._require_circle_invite_slot(uuid,text) is 'SCRUM-27: Lock the circle row, then refuse with {prefix}:circle_full when available is 0. Call before an insert or before a non-pending row becomes pending. Internal.';

-- public.accept_circle_invite(text)
CREATE OR REPLACE FUNCTION public.accept_circle_invite(token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'accept_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  cid uuid;
  m public.safety_circle_members%rowtype;
  st text;
  circle_owner uuid;
  used_after integer;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  -- Circle lock first, same order as the SCRUM-27 invite RPCs, so two accepts
  -- cannot both pass the capacity check.
  select scm.circle_id
    into cid
    from public.safety_circle_members scm
   where scm.invite_token = raw;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  perform 1
    from public.safety_circles sc
   where sc.id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members scm
   where scm.invite_token = raw
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  -- Same token, already active for this caller: success, no second row.
  if m.status = 'active' and m.user_id = uid then
    return jsonb_build_object(
      'circle_id', m.circle_id,
      'member_id', m.id,
      'status', 'active',
      'owner_name', public._circle_owner_display_name(m.circle_id)
    );
  end if;

  st := public._circle_invite_lookup_status(m);
  perform public._reject_unless_pending(prefix, st);

  if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_recipient';
  end if;

  select sc.owner_id
    into circle_owner
    from public.safety_circles sc
   where sc.id = m.circle_id;

  if circle_owner = uid then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':own_circle';
  end if;

  if public._circle_has_active_membership(m.circle_id, uid, m.id) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':already_member';
  end if;

  used_after := public._circle_accept_used_after(m.circle_id, m.id);
  if used_after > public._circle_member_limit() then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':circle_full';
  end if;

  begin
    update public.safety_circle_members
       set user_id = uid,
           status = 'active',
           -- Member names fix #18: the accepter's own profile name, so the owner
           -- and other members recognise them. Stored name if no profile name.
           display_name = coalesce(
             public._member_profile_name(uid),
             m.display_name
           ),
           invite_consumed_at = now(),
           invite_canceled_at = null,
           updated_at = now()
     where public.safety_circle_members.id = m.id
     returning * into m;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':duplicate_membership';
  end;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'status', m.status,
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$function$
;
revoke all on function public.accept_circle_invite(text) from public, anon, authenticated, service_role;
grant execute on function public.accept_circle_invite(text) to service_role;
comment on function public.accept_circle_invite(text) is 'SCRUM-28 / fix #18: Pending + recipient. Expired token still raises accept_circle_invite:expired. On accept stores the accepter''s profile full name as display_name (via _member_profile_name; stored name kept if none). Does not write profiles and does not require location sharing. Owner gets own_circle. Over-capacity (active + valid pending) gets circle_full and no write. No SMS/push/email.';

-- public.acknowledge_incident(uuid)
CREATE OR REPLACE FUNCTION public.acknowledge_incident(p_incident_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.acknowledge_incident(uuid) from public, anon, authenticated, service_role;
grant execute on function public.acknowledge_incident(uuid) to service_role;
comment on function public.acknowledge_incident(uuid) is 'SCRUM-43 + rule 54: Set acknowledged_at on the caller''s in-app delivery row when the incident is active. not_found without a delivery row or outside the membership window (not an active member, or joined after the incident started). Idempotent if already acked. Not FCM/SMS.';

-- public.attach_incident_location(uuid,text,double precision,double precision,double precision,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.attach_incident_location(p_incident_id uuid, p_location_source text, p_location_lat double precision DEFAULT NULL::double precision, p_location_lng double precision DEFAULT NULL::double precision, p_location_accuracy_m double precision DEFAULT NULL::double precision, p_location_captured_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.attach_incident_location(uuid,text,double precision,double precision,double precision,timestamp with time zone) from public, anon, authenticated, service_role;
grant execute on function public.attach_incident_location(uuid,text,double precision,double precision,double precision,timestamp with time zone) to service_role;
comment on function public.attach_incident_location(uuid,text,double precision,double precision,double precision,timestamp with time zone) is 'SCRUM-40 / 41 / 45: attach or live-update location on the caller''s active incident. Owner JWT only. not_open unless status = active and location_sharing_ended_at is null (late pings after mark safe never write or reopen). Skips overwrite when p_location_captured_at is older than the stored fix. Does not notify or change status/type/notes/resolve columns.';

-- public.cancel_circle_invite(uuid)
CREATE OR REPLACE FUNCTION public.cancel_circle_invite(member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'cancel_circle_invite';
  uid uuid;
  m public.safety_circle_members%rowtype;
  caller_is_owner boolean := false;
  lookup_status text;
begin
  uid := public._require_auth_uid(prefix);

  if cancel_circle_invite.member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = cancel_circle_invite.member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = m.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  if not caller_is_owner then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  if m.role = 'owner' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':cannot_cancel_owner';
  end if;

  lookup_status := public._circle_invite_lookup_status(m);

  -- Fix #14: an expired invite can be cleared too (it already holds no slot).
  if lookup_status not in ('pending', 'expired') then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_pending';
  end if;

  update public.safety_circle_members
     set status = 'declined',
         invite_canceled_at = now()
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'status', 'canceled',
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$function$
;
revoke all on function public.cancel_circle_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.cancel_circle_invite(uuid) to service_role;
comment on function public.cancel_circle_invite(uuid) is 'SCRUM-29 / fix #14: Owner-only. Pending or expired invite. Sets declined and invite_canceled_at so the token looks up as canceled and any slot is released. Active / declined: not_pending. Does not delete the row, write profiles, or send SMS/email/push.';

-- public.circle_invite_capacity()
CREATE OR REPLACE FUNCTION public.circle_invite_capacity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'circle_invite_capacity:not_authenticated';
  end if;

  select sc.id
    into cid
    from public.safety_circles sc
   where sc.owner_id = uid;

  if cid is null then
    raise exception using
      errcode = 'P0001',
      message = 'circle_invite_capacity:not_owner';
  end if;

  return public._circle_invite_capacity_json(cid);
end;
$function$
;
revoke all on function public.circle_invite_capacity() from public, anon, authenticated, service_role;
grant execute on function public.circle_invite_capacity() to service_role;
comment on function public.circle_invite_capacity() is 'SCRUM-27 / fix #14: Owner-only capacity. Returns limit, active_count, pending_count, used, available. Active + valid pending only; an expired pending invite does not use a slot. Non-owners get not_owner. Does not send SMS.';

-- public.clear_login_failures(text)
CREATE OR REPLACE FUNCTION public.clear_login_failures(email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  email_norm text;
  phone_norm text;
  auth_phone text;
  uid uuid := auth.uid();
  jwt_email text;
  auth_email text;
begin
  perform public._login_lockout_rate_limit('clear_login_failures', 30);

  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:not_authenticated';
  end if;

  jwt_email := nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');

  select nullif(lower(trim(coalesce(u.email, ''))), ''),
         u.phone
    into auth_email, auth_phone
    from auth.users u
   where u.id = uid;

  if auth_email is not null or jwt_email is not null then
    email_norm := public._normalize_login_email(clear_login_failures.email);

    if jwt_email is distinct from email_norm
       and auth_email is distinct from email_norm then
      raise exception using
        errcode = 'P0001',
        message = 'login_lockout:email_mismatch';
    end if;

    delete from public.login_lockouts l
     where l.email = email_norm;
  end if;

  phone_norm := public._normalize_e164(auth_phone);
  if phone_norm is not null and phone_norm ~ '^\+[1-9][0-9]{7,14}$' then
    delete from public.login_lockouts l
     where l.email = phone_norm;
  end if;

  return public._login_lockout_status_json(false, null, 0);
end;
$function$
;
revoke all on function public.clear_login_failures(text) from public, anon, authenticated, service_role;
grant execute on function public.clear_login_failures(text) to service_role;
comment on function public.clear_login_failures(text) is 'SCRUM-16: Authenticated. Deletes the caller email row when the argument matches, and the caller E.164 row when one exists.';

-- public.complete_profile_setup()
CREATE OR REPLACE FUNCTION public.complete_profile_setup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  p public.profiles%rowtype;
  v_circle_id uuid;
  v_member_id uuid;
  v_member_status text;
  v_completed_at timestamptz;
  v_contact_email text;
  v_invite_tok text;
  v_invite_exp timestamptz;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:not_authenticated';
  end if;

  select *
    into p
    from public.profiles
   where public.profiles.id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:profile_not_found';
  end if;

  if p.personal_info_completed_at is null
     or char_length(trim(p.full_name)) = 0
     or p.date_of_birth is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:personal_info_incomplete';
  end if;

  if p.emergency_info_completed_at is null
     or p.emergency_contact_full_name is null
     or char_length(trim(p.emergency_contact_full_name)) = 0
     or p.emergency_contact_relationship is null
     or p.emergency_contact_phone is null
     or p.emergency_contact_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:emergency_info_incomplete';
  end if;

  if p.preferences_completed_at is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:preferences_incomplete';
  end if;

  update public.profiles
     set profile_setup_completed_at = coalesce(
           public.profiles.profile_setup_completed_at,
           now()
         )
   where public.profiles.id = uid
   returning public.profiles.profile_setup_completed_at into v_completed_at;

  if not p.location_sharing_enabled then
    return jsonb_build_object(
      'profile_setup_completed_at', v_completed_at,
      'location_sharing_enabled', false,
      'circle_id', null,
      'member_id', null,
      'member_status', null
    );
  end if;

  select sc.id
    into v_circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  if v_circle_id is null then
    insert into public.safety_circles as sc (owner_id, name)
    values (uid, 'My Safety Circle')
    returning sc.id into v_circle_id;
  end if;

  insert into public.safety_circle_members as scm (
    circle_id,
    role,
    status,
    display_name,
    relationship,
    phone,
    email,
    user_id,
    invited_at
  )
  values (
    v_circle_id,
    'owner',
    'active',
    trim(p.full_name),
    null,
    null,
    null,
    uid,
    now()
  )
  on conflict (circle_id, user_id) where user_id is not null
  do update set
    display_name = excluded.display_name,
    role = 'owner',
    status = 'active',
    updated_at = now();

  -- An expired or declined contact row no longer holds a slot. Refreshing it
  -- at 5/5 is refused by the capacity trigger; Complete must still succeed,
  -- so keep the row as it is and report its stored status.
  begin
    v_contact_email := nullif(trim(coalesce(p.emergency_contact_email, '')), '');
    v_invite_tok := public.new_circle_invite_token();
    v_invite_exp := now() + interval '7 days';

    insert into public.safety_circle_members as scm (
      circle_id,
      role,
      status,
      display_name,
      relationship,
      phone,
      email,
      user_id,
      invited_at,
      invite_token,
      invite_expires_at
    )
    values (
      v_circle_id,
      'member',
      'pending',
      trim(p.emergency_contact_full_name),
      p.emergency_contact_relationship,
      p.emergency_contact_phone,
      v_contact_email,
      null,
      now(),
      v_invite_tok,
      v_invite_exp
    )
    on conflict (circle_id, phone) where phone is not null
    do update set
      display_name = excluded.display_name,
      relationship = excluded.relationship,
      email = excluded.email,
      status = case
        when scm.status = 'active' then 'active'
        else 'pending'
      end,
      invited_at = case
        when scm.status = 'active'
          then scm.invited_at
        else now()
      end,
      -- A declined / canceled row gets a fresh token. Only a still-pending,
      -- uncanceled row keeps its token (the link the owner already shared).
      invite_token = case
        when scm.status = 'active'
          then scm.invite_token
        when scm.status = 'pending'
             and scm.invite_canceled_at is null
             and scm.invite_token is not null
          then scm.invite_token
        else excluded.invite_token
      end,
      -- Expired-invites fix #14: a re-run after decline / cancel must give a
      -- usable invite, not a token that looks up as canceled.
      invite_canceled_at = case
        when scm.status = 'active'
          then scm.invite_canceled_at
        else null
      end,
      invite_consumed_at = case
        when scm.status = 'active'
          then scm.invite_consumed_at
        else null
      end,
      user_id = case
        when scm.status = 'active'
          then scm.user_id
        when scm.status = 'pending'
             and scm.invite_canceled_at is null
          then scm.user_id
        else null
      end,
      invite_expires_at = case
        when scm.status = 'active'
          then scm.invite_expires_at
        else excluded.invite_expires_at
      end,
      updated_at = now()
    returning scm.id, scm.status into v_member_id, v_member_status;
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'circle_full' then
        raise;
      end if;
      select scm.id, scm.status
        into v_member_id, v_member_status
        from public.safety_circle_members scm
       where scm.circle_id = v_circle_id
         and scm.phone = p.emergency_contact_phone;
  end;

  return jsonb_build_object(
    'profile_setup_completed_at', v_completed_at,
    'location_sharing_enabled', true,
    'circle_id', v_circle_id,
    'member_id', v_member_id,
    'member_status', v_member_status
  );
end;
$function$
;
revoke all on function public.complete_profile_setup() from public, anon, authenticated, service_role;
grant execute on function public.complete_profile_setup() to service_role;
comment on function public.complete_profile_setup() is 'SCRUM-80 / 27 / fix #14: Atomic Complete. Sets profile_setup_completed_at. If location_sharing_enabled, ensures My Safety Circle + owner active member + emergency contact pending invite. A re-run on a declined/canceled contact row clears invite_canceled_at / invite_consumed_at / user_id and issues a new token + 7-day expiry; a still-pending row keeps its token and gets a new expiry. If that refresh would pass 5/5 the contact row is left as is (member_status is its stored status). Does not send SMS/email. Return JSON keys unchanged.';

-- public.create_circle_invite_link(text)
CREATE OR REPLACE FUNCTION public.create_circle_invite_link(display_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'create_circle_invite_link';
  cid uuid;
  raw_name text;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  raw_name := nullif(trim(coalesce(display_name, '')), '');
  if raw_name is null then
    raw_name := 'Invited member';
  end if;

  perform public._require_circle_invite_slot(cid, prefix);

  begin
    insert into public.safety_circle_members as scm (
      circle_id,
      role,
      status,
      display_name,
      relationship,
      phone,
      email,
      user_id,
      invited_at,
      invite_token,
      invite_expires_at
    )
    values (
      cid,
      'member',
      'pending',
      raw_name,
      null,
      null,
      null,
      null,
      now(),
      public.new_circle_invite_token(),
      now() + interval '7 days'
    )
    returning * into created;
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'circle_full' then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':circle_full';
      end if;
      raise;
  end;

  return public._circle_invite_payload(created, false);
end;
$function$
;
revoke all on function public.create_circle_invite_link(text) from public, anon, authenticated, service_role;
grant execute on function public.create_circle_invite_link(text) to service_role;
comment on function public.create_circle_invite_link(text) is 'SCRUM-27: Owner-only. Inserts one pending link invite (phone null) and reserves one slot. circle_full when available is 0, with no row left behind. 7-day single-use token. Does not activate membership. Does not send SMS.';

-- public.decline_circle_invite(text)
CREATE OR REPLACE FUNCTION public.decline_circle_invite(token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'decline_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
  st text;
  claimed_uid uuid;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members scm
   where scm.invite_token = raw
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  st := public._circle_invite_lookup_status(m);
  perform public._reject_unless_pending(prefix, st);

  if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_recipient';
  end if;

  claimed_uid := uid;
  begin
    update public.safety_circle_members
       set user_id = claimed_uid,
           status = 'declined',
           invite_canceled_at = now(),
           invite_consumed_at = null,
           updated_at = now()
     where public.safety_circle_members.id = m.id
     returning * into m;
  exception
    when unique_violation then
      update public.safety_circle_members
         set status = 'declined',
             invite_canceled_at = now(),
             invite_consumed_at = null,
             updated_at = now()
       where public.safety_circle_members.id = m.id
       returning * into m;
  end;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'status', m.status,
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$function$
;
revoke all on function public.decline_circle_invite(text) from public, anon, authenticated, service_role;
grant execute on function public.decline_circle_invite(text) to service_role;
comment on function public.decline_circle_invite(text) is 'SCRUM-28: Pending only. Sets declined + invite_canceled_at so the trusted-member slot is released. Does not require location sharing. Does not grant membership. No SMS/push/email.';

-- public.get_incident_details(uuid)
CREATE OR REPLACE FUNCTION public.get_incident_details(p_incident_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.get_incident_details(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_incident_details(uuid) to service_role;
comment on function public.get_incident_details(uuid) is 'SCRUM-48 / 45 / 41 + rule 54: JSON details for one active or resolved incident. Caller must be an active circle member whose membership activated at or before the incident started, and not the resident. Else not_found (same code for pre-join incidents, so existence is not revealed). share_payload is the stored snapshot only.';

-- public.get_live_location_config()
CREATE OR REPLACE FUNCTION public.get_live_location_config()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid;
  v_interval integer;
  v_stale integer;
begin
  uid := public._require_auth_uid('get_live_location_config');

  select case
           when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
           else null
         end
    into v_interval
    from public.app_config c
   where c.key = 'live_location_interval_seconds';

  select case
           when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
           else null
         end
    into v_stale
    from public.app_config c
   where c.key = 'live_location_stale_threshold_seconds';

  if v_interval is null or v_interval <= 0 then
    v_interval := 12;
  end if;

  if v_stale is null or v_stale <= 0 then
    v_stale := 45;
  end if;

  return jsonb_build_object(
    'interval_seconds', v_interval,
    'stale_threshold_seconds', v_stale
  );
end;
$function$
;
revoke all on function public.get_live_location_config() from public, anon, authenticated, service_role;
grant execute on function public.get_live_location_config() to service_role;
comment on function public.get_live_location_config() is 'SCRUM-41: Return live location interval_seconds (default 12) and stale_threshold_seconds (default 45) from app_config. JWT required. Does not write.';

-- public.get_my_open_incident()
CREATE OR REPLACE FUNCTION public.get_my_open_incident()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('get_my_open_incident');

  select *
    into rec
    from public.incidents i
   where i.resident_id = uid
     and i.status = 'active'
   order by i.activated_at desc
   limit 1;

  if not found then
    return 'null'::jsonb;
  end if;

  return public._incident_send_json(rec);
end;
$function$
;
revoke all on function public.get_my_open_incident() from public, anon, authenticated, service_role;
grant execute on function public.get_my_open_incident() to service_role;
comment on function public.get_my_open_incident() is 'SCRUM-36 / 45: the caller''s active incident as the shared JSON plus delivered_count and acknowledged_count, or JSON null when none. Read-only. Used to restore Alert Sent on app launch.';

-- public.hook_reject_locked_password_session(jsonb)
CREATE OR REPLACE FUNCTION public.hook_reject_locked_password_session(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  claims jsonb;
  method text;
  uid uuid;
  lock_key text;
  until_ts timestamptz;
begin
  claims := event->'claims';
  method := lower(trim(both '"' from coalesce(event->>'authentication_method', '')));

  if claims is null then
    return event;
  end if;

  -- Email+password and phone+password both use method "password".
  -- OTP, oauth, magic link, recovery, and token_refresh are not blocked.
  if method is distinct from 'password' then
    return jsonb_build_object('claims', claims);
  end if;

  begin
    uid := nullif(trim(coalesce(event->>'user_id', '')), '')::uuid;
  exception
    when others then
      uid := null;
  end;

  if uid is null then
    return jsonb_build_object('claims', claims);
  end if;

  lock_key := public._login_lockout_key_for_user(uid);
  if lock_key is null then
    return jsonb_build_object('claims', claims);
  end if;

  select l.locked_until
    into until_ts
    from public.login_lockouts l
   where l.email = lock_key
     and l.locked_until is not null
     and l.locked_until > now();

  if until_ts is not null then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'login_lockout:locked'
      )
    );
  end if;

  return jsonb_build_object('claims', claims);
end;
$function$
;
revoke all on function public.hook_reject_locked_password_session(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.hook_reject_locked_password_session(jsonb) to service_role;
grant execute on function public.hook_reject_locked_password_session(jsonb) to supabase_auth_admin;
comment on function public.hook_reject_locked_password_session(jsonb) is 'SCRUM-16: Custom access token hook. Reject email or phone password grant when that user lock key is locked.';

-- public.incident_delivery_counts(uuid)
CREATE OR REPLACE FUNCTION public.incident_delivery_counts(p_incident_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.incident_delivery_counts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.incident_delivery_counts(uuid) to service_role;
comment on function public.incident_delivery_counts(uuid) is 'SCRUM-43 + rule 54: Live in-app delivery/ack counts. Resident of the incident, or an active circle member (joined at or before the incident started) while the incident is active. not_found if no access. Not FCM/SMS.';

-- public.invite_circle_member_by_phone(text,text,text)
CREATE OR REPLACE FUNCTION public.invite_circle_member_by_phone(display_name text, phone text, relationship text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'invite_circle_member_by_phone';
  cid uuid;
  raw_phone text;
  raw_name text;
  raw_rel text;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  raw_name := trim(coalesce(display_name, ''));
  if char_length(raw_name) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_display_name';
  end if;

  raw_phone := trim(coalesce(phone, ''));
  if raw_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_phone';
  end if;

  raw_rel := nullif(trim(coalesce(relationship, '')), '');
  if raw_rel is not null
     and raw_rel not in (
       'spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'
     ) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_relationship';
  end if;

  select *
    into existing
    from public.safety_circle_members
   where public.safety_circle_members.circle_id = cid
     and public.safety_circle_members.phone = raw_phone
   for update;

  if found then
    if existing.status = 'active' or existing.invite_consumed_at is not null then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':already_active';
    end if;

    -- A valid pending invite already holds a slot. An expired or declined row
    -- does not, so refreshing it needs a free slot. Never a second row.
    if not public._circle_invite_holds_slot(existing) then
      perform public._require_circle_invite_slot(cid, prefix);
    end if;

    created := public._refresh_circle_invite(
      existing.id,
      prefix,
      raw_name,
      coalesce(raw_rel, existing.relationship)
    );
    return public._circle_invite_payload(created, true);
  end if;

  perform public._require_circle_invite_slot(cid, prefix);

  begin
    insert into public.safety_circle_members as scm (
      circle_id,
      role,
      status,
      display_name,
      relationship,
      phone,
      email,
      user_id,
      invited_at,
      invite_token,
      invite_expires_at
    )
    values (
      cid,
      'member',
      'pending',
      raw_name,
      raw_rel,
      raw_phone,
      null,
      null,
      now(),
      public.new_circle_invite_token(),
      now() + interval '7 days'
    )
    returning * into created;
  exception
    when unique_violation then
      select *
        into existing
        from public.safety_circle_members
       where public.safety_circle_members.circle_id = cid
         and public.safety_circle_members.phone = raw_phone
       for update;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':duplicate_membership';
      end if;

      if existing.status = 'active' or existing.invite_consumed_at is not null then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':already_active';
      end if;

      if not public._circle_invite_holds_slot(existing) then
        perform public._require_circle_invite_slot(cid, prefix);
      end if;

      created := public._refresh_circle_invite(
        existing.id,
        prefix,
        raw_name,
        coalesce(raw_rel, existing.relationship)
      );
      return public._circle_invite_payload(created, true);
    when sqlstate 'P0001' then
      if sqlerrm = 'circle_full' then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':circle_full';
      end if;
      raise;
  end;

  return public._circle_invite_payload(created, false);
end;
$function$
;
revoke all on function public.invite_circle_member_by_phone(text,text,text) from public, anon, authenticated, service_role;
grant execute on function public.invite_circle_member_by_phone(text,text,text) to service_role;
comment on function public.invite_circle_member_by_phone(text,text,text) is 'SCRUM-27 / fix #14: Owner-only. E.164 phone invite, or refresh the existing row for that phone. Refreshing a valid pending row takes no new slot; a declined or expired row needs one (circle_full when available is 0). Does not insert a second row. 7-day single-use token. Does not send SMS.';

-- public.invite_circle_members_by_phone(jsonb)
CREATE OR REPLACE FUNCTION public.invite_circle_members_by_phone(p_invites jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'invite_circle_members_by_phone';
  cid uuid;
  item jsonb;
  raw_phone text;
  raw_name text;
  shown_phone text;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
  created_rows jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  not_created jsonb := '[]'::jsonb;
  available integer;
begin
  cid := public._owner_circle_for_invite(prefix);

  if p_invites is null or jsonb_typeof(p_invites) <> 'array' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_invites';
  end if;

  available := coalesce(
    (public._circle_invite_capacity_json(cid)->>'available')::integer,
    0
  );

  for item in
    select elem
      from jsonb_array_elements(p_invites) as t(elem)
  loop
    if item is null or jsonb_typeof(item) <> 'object' then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', null,
          'display_name', null,
          'reason', 'invalid_invite'
        )
      );
      continue;
    end if;

    raw_name := trim(coalesce(item->>'display_name', ''));
    raw_phone := public._normalize_e164(item->>'phone');
    shown_phone := coalesce(raw_phone, nullif(btrim(coalesce(item->>'phone', '')), ''));

    if raw_phone is null or raw_phone !~ '^\+[1-9][0-9]{7,14}$' then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', shown_phone,
          'display_name', nullif(raw_name, ''),
          'reason', 'invalid_phone'
        )
      );
      continue;
    end if;

    if char_length(raw_name) = 0 then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', null,
          'reason', 'invalid_display_name'
        )
      );
      continue;
    end if;

    select *
      into existing
      from public.safety_circle_members
     where public.safety_circle_members.circle_id = cid
       and public.safety_circle_members.phone = raw_phone
     for update;

    if found and (
      existing.status = 'active' or existing.invite_consumed_at is not null
    ) then
      skipped := skipped || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', raw_name,
          'reason', 'already_active',
          'member_id', existing.id
        )
      );
      continue;
    end if;

    -- Valid pending only. An expired pending row is refreshed below and
    -- needs a free slot, like a declined row.
    if found and public._circle_invite_holds_slot(existing) then
      skipped := skipped || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', raw_name,
          'reason', 'already_pending',
          'member_id', existing.id
        )
      );
      continue;
    end if;

    if available <= 0 then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', raw_name,
          'reason', 'circle_full'
        )
      );
      continue;
    end if;

    if found then
      begin
        created := public._refresh_circle_invite(
          existing.id,
          prefix,
          raw_name
        );
        created_rows := created_rows || jsonb_build_array(
          public._circle_invite_payload(created, true)
        );
        available := available - 1;
      exception
        when sqlstate 'P0001' then
          if sqlerrm = 'circle_full' then
            not_created := not_created || jsonb_build_array(
              jsonb_build_object(
                'phone', raw_phone,
                'display_name', raw_name,
                'reason', 'circle_full'
              )
            );
          elsif sqlerrm = prefix || ':already_active' then
            skipped := skipped || jsonb_build_array(
              jsonb_build_object(
                'phone', raw_phone,
                'display_name', raw_name,
                'reason', 'already_active',
                'member_id', existing.id
              )
            );
          else
            raise;
          end if;
      end;
      continue;
    end if;

    begin
      insert into public.safety_circle_members as scm (
        circle_id,
        role,
        status,
        display_name,
        relationship,
        phone,
        email,
        user_id,
        invited_at,
        invite_token,
        invite_expires_at
      )
      values (
        cid,
        'member',
        'pending',
        raw_name,
        null,
        raw_phone,
        null,
        null,
        now(),
        public.new_circle_invite_token(),
        now() + interval '7 days'
      )
      returning * into created;

      created_rows := created_rows || jsonb_build_array(
        public._circle_invite_payload(created, false)
      );
      available := available - 1;
    exception
      when unique_violation then
        select *
          into existing
          from public.safety_circle_members
         where public.safety_circle_members.circle_id = cid
           and public.safety_circle_members.phone = raw_phone
         for update;

        if not found then
          not_created := not_created || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'duplicate_membership'
            )
          );
        elsif existing.status = 'active'
           or existing.invite_consumed_at is not null then
          skipped := skipped || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'already_active',
              'member_id', existing.id
            )
          );
        elsif existing.status = 'pending' then
          skipped := skipped || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'already_pending',
              'member_id', existing.id
            )
          );
        else
          not_created := not_created || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'duplicate_membership'
            )
          );
        end if;
      when sqlstate 'P0001' then
        if sqlerrm = 'circle_full' then
          not_created := not_created || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'circle_full'
            )
          );
        else
          raise;
        end if;
    end;
  end loop;

  return jsonb_build_object(
    'created', created_rows,
    'skipped', skipped,
    'not_created', not_created,
    'available_after', coalesce(
      (public._circle_invite_capacity_json(cid)->>'available')::integer,
      0
    )
  );
end;
$function$
;
revoke all on function public.invite_circle_members_by_phone(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.invite_circle_members_by_phone(jsonb) to service_role;
comment on function public.invite_circle_members_by_phone(jsonb) is 'SCRUM-27 / fix #14: Owner-only batch of {phone, display_name}. Normalizes E.164. Skips active and valid pending (already_pending) without a second row. An expired pending phone is refreshed (resent true) when a slot is free, else circle_full. One transaction. Does not send SMS.';

-- public.leave_safety_circle(uuid)
CREATE OR REPLACE FUNCTION public.leave_safety_circle(circle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'leave_safety_circle';
  uid uuid;
  circle_exists boolean := false;
  caller_is_owner boolean := false;
  m public.safety_circle_members%rowtype;
begin
  uid := public._require_auth_uid(prefix);

  if leave_safety_circle.circle_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = leave_safety_circle.circle_id
  )
    into circle_exists;

  if not circle_exists then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = leave_safety_circle.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  if caller_is_owner then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':is_owner';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.circle_id = leave_safety_circle.circle_id
     and public.safety_circle_members.user_id = uid
     and public.safety_circle_members.status = 'active'
     and public.safety_circle_members.role = 'member'
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  delete from public.safety_circle_members
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'left', true
  );
end;
$function$
;
revoke all on function public.leave_safety_circle(uuid) from public, anon, authenticated, service_role;
grant execute on function public.leave_safety_circle(uuid) to service_role;
comment on function public.leave_safety_circle(uuid) is 'SCRUM-29: Active non-owner deletes their membership row so they drop from the list and from list_my_joined_circles. Owner cannot leave. Does not delete the circle. No SMS/push. safety_circle_members.circle_id qualified vs arg.';

-- public.list_circle_members(uuid)
CREATE OR REPLACE FUNCTION public.list_circle_members(circle_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'list_circle_members';
  uid uuid;
  circle_exists boolean := false;
  caller_is_owner boolean := false;
  caller_is_active boolean := false;
begin
  uid := public._require_auth_uid(prefix);

  if list_circle_members.circle_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = list_circle_members.circle_id
  )
    into circle_exists;

  if not circle_exists then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = list_circle_members.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  select exists (
    select 1
      from public.safety_circle_members mem
     where mem.circle_id = list_circle_members.circle_id
       and mem.user_id = uid
       and mem.status = 'active'
  )
    into caller_is_active;

  if not caller_is_owner and not caller_is_active then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  return (
    select coalesce(
      jsonb_agg(payload order by sort_owner desc, sort_status, display_sort, invited_sort),
      '[]'::jsonb
    )
    from (
      select
        case
          when caller_is_owner then
            jsonb_build_object(
              'member_id', r.id,
              'role', r.role,
              'status', r.shown_status,
              'display_name', r.shown_name,
              'is_owner', r.role = 'owner',
              'invited_at', r.invited_at,
              'user_id', r.user_id,
              'avatar_url', case
                when r.user_id is not null
                then public._member_avatar_url(r.user_id)
                else null
              end,
              'phone', r.phone,
              'email', r.email,
              'relationship', r.relationship,
              'invite_expires_at', r.invite_expires_at,
              'invite_consumed_at', r.invite_consumed_at,
              'invite_canceled_at', r.invite_canceled_at
            )
          else
            jsonb_build_object(
              'member_id', r.id,
              'role', r.role,
              'status', r.shown_status,
              'display_name', r.shown_name,
              'is_owner', r.role = 'owner',
              'invited_at', r.invited_at,
              'user_id', r.user_id,
              'avatar_url', case
                when r.user_id is not null
                then public._member_avatar_url(r.user_id)
                else null
              end
            )
        end as payload,
        (r.role = 'owner') as sort_owner,
        case r.shown_status
          when 'active' then 0
          when 'pending' then 1
          when 'expired' then 2
          when 'declined' then 3
          else 4
        end as sort_status,
        lower(r.shown_name) as display_sort,
        r.invited_at as invited_sort
      from (
        select
          scm.id,
          scm.role,
          scm.user_id,
          scm.invited_at,
          scm.phone,
          scm.email,
          scm.relationship,
          scm.invite_expires_at,
          scm.invite_consumed_at,
          scm.invite_canceled_at,
          -- Fix #18: active members are shown by their own profile name.
          -- Pending rows keep the invite name ("Invited member" for links).
          case
            when scm.status = 'active' and scm.user_id is not null
              then coalesce(
                public._member_profile_name(scm.user_id),
                scm.display_name
              )
            else scm.display_name
          end as shown_name,
          -- Fix #14: lookup-style value in JSON only; stored status stays.
          case
            when scm.status = 'pending'
                 and public._circle_invite_lookup_status(scm) = 'expired'
              then 'expired'
            else scm.status
          end as shown_status
        from public.safety_circle_members scm
        where scm.circle_id = list_circle_members.circle_id
          and (
            caller_is_owner
            or scm.status = 'active'
          )
      ) r
    ) listed
  );
end;
$function$
;
revoke all on function public.list_circle_members(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_circle_members(uuid) to service_role;
comment on function public.list_circle_members(uuid) is 'SCRUM-29 / SCRUM-28 / fixes #18 #14: Owner lists every row; a pending row past invite_expires_at is returned with status expired (stored status stays pending). An active non-owner lists active rows only. Active rows with a user show that user''s profile full name (stored name if empty) and avatar_url. Non-owners do not receive phone, email, relationship, invite token, or emergency fields.';

-- public.list_my_circle_invites()
CREATE OR REPLACE FUNCTION public.list_my_circle_invites()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'list_my_circle_invites';
  uid uuid;
  auth_phone text;
  m public.safety_circle_members%rowtype;
  st text;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  for m in
    select scm.*
      from public.safety_circle_members scm
     where scm.role = 'member'
       and scm.status = 'pending'
       and (
         scm.user_id = uid
         or (
           scm.user_id is null
           and scm.phone is not null
           and auth_phone is not null
           and public._normalize_e164(scm.phone)
             = public._normalize_e164(auth_phone)
         )
       )
     for update
  loop
    st := public._circle_invite_lookup_status(m);
    if st <> 'pending' then
      continue;
    end if;
    if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
      continue;
    end if;
    if public._circle_has_active_membership(m.circle_id, uid, m.id) then
      continue;
    end if;
    if m.user_id is null then
      begin
        update public.safety_circle_members
           set user_id = uid,
               updated_at = now()
         where id = m.id;
      exception
        when unique_violation then
          null;
      end;
    end if;
  end loop;

  return (
    select coalesce(
      jsonb_agg(payload order by (payload->>'invited_at') desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
               'member_id', scm.id,
               'circle_id', scm.circle_id,
               'status', public._circle_invite_lookup_status(scm),
               'owner_name', public._circle_owner_display_name(scm.circle_id),
               'invited_at', scm.invited_at,
               'invite_expires_at', scm.invite_expires_at,
               'invite_token', case
                 when public._circle_invite_lookup_status(scm) = 'pending'
                 then scm.invite_token
                 else null
               end
             ) as payload
        from public.safety_circle_members scm
       where scm.role = 'member'
         and (
           scm.user_id = uid
           or (
             scm.user_id is null
             and scm.phone is not null
             and auth_phone is not null
             and public._normalize_e164(scm.phone)
               = public._normalize_e164(auth_phone)
           )
         )
         and public._circle_invite_lookup_status(scm) in (
           'pending', 'expired', 'canceled'
         )
    ) listed
  );
end;
$function$
;
revoke all on function public.list_my_circle_invites() from public, anon, authenticated, service_role;
grant execute on function public.list_my_circle_invites() to service_role;
comment on function public.list_my_circle_invites() is 'SCRUM-28: Pending/expired/declined invites this user may see (normalized phone match or claimed user_id). Claims pending phone rows. No other members, emergency_*, or medical. Token only while pending.';

-- public.list_my_joined_circles()
CREATE OR REPLACE FUNCTION public.list_my_joined_circles()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'list_my_joined_circles';
  uid uuid;
begin
  uid := public._require_auth_uid(prefix);

  return (
    select coalesce(
      jsonb_agg(payload order by (payload->>'joined_at') desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
               'circle_id', c.id,
               'name', c.name,
               'role', scm.role,
               'member_id', scm.id,
               'status', scm.status,
               'owner_name', public._circle_owner_display_name(c.id),
               'joined_at', scm.updated_at,
               'active_member_count', (
                 select count(*)::integer
                   from public.safety_circle_members active_members
                  where active_members.circle_id = c.id
                    and active_members.role = 'member'
                    and active_members.status = 'active'
               )
             ) as payload
        from public.safety_circle_members scm
        join public.safety_circles c on c.id = scm.circle_id
       where scm.user_id = uid
         and scm.status = 'active'
    ) listed
  );
end;
$function$
;
revoke all on function public.list_my_joined_circles() from public, anon, authenticated, service_role;
grant execute on function public.list_my_joined_circles() to service_role;
comment on function public.list_my_joined_circles() is 'SCRUM-28 / SCRUM-29: Circles where the caller is an active member (owned and joined). active_member_count is role member and status active on that circle (owner, pending, and declined excluded). No phone, email, emergency, or medical fields.';

-- public.list_my_recent_incidents(integer)
CREATE OR REPLACE FUNCTION public.list_my_recent_incidents(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid;
  v_limit integer;
  result jsonb;
begin
  uid := public._require_auth_uid('list_my_recent_incidents');

  v_limit := least(greatest(coalesce(p_limit, 5), 1), 20);

  select coalesce(
    jsonb_agg(r.payload order by r.activated_at desc, r.id desc),
    '[]'::jsonb
  )
    into result
    from (
      select
        i.id,
        i.activated_at,
        jsonb_build_object(
          'id', i.id,
          'emergency_type', i.emergency_type,
          'status', i.status,
          'activated_at', i.activated_at,
          'sent_at', i.sent_at,
          'resolved_at', i.resolved_at,
          'resolved_reason', i.resolved_reason
        ) as payload
      from public.incidents i
      where i.resident_id = uid
        and i.status in ('active', 'resolved')
      order by i.activated_at desc, i.id desc
      limit v_limit
    ) as r;

  return result;
end;
$function$
;
revoke all on function public.list_my_recent_incidents(integer) from public, anon, authenticated, service_role;
grant execute on function public.list_my_recent_incidents(integer) to service_role;
comment on function public.list_my_recent_incidents(integer) is 'SCRUM-36 / 45: JSON array of the caller''s own active and resolved incidents, newest activated_at first. p_limit default 5, clamped 1–20 (null → 5). Keys: id, emergency_type, status, activated_at, sent_at, resolved_at, resolved_reason. Read-only. Legacy cancelled/activating rows are excluded.';

-- public.list_responder_incidents()
CREATE OR REPLACE FUNCTION public.list_responder_incidents()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.list_responder_incidents() from public, anon, authenticated, service_role;
grant execute on function public.list_responder_incidents() to service_role;
comment on function public.list_responder_incidents() is 'SCRUM-48 / 45 + rule 54: JSON array of active and resolved incidents where the caller is an active circle member whose membership activated at or before the incident started, and is not the resident. Newest resolved_at, else sent_at, else activated_at. Omits activating, cancelled, the caller''s own rows, and incidents from before they joined. Does not open profiles to members.';

-- public.login_lockout_status(text,text)
CREATE OR REPLACE FUNCTION public.login_lockout_status(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lock_key text;
  rec public.login_lockouts;
begin
  perform public._login_lockout_rate_limit('login_lockout_status', 60);
  lock_key := public._login_lockout_resolve_key(p_email, p_phone);
  rec := public._login_lockout_load(lock_key, true);
  return public._login_lockout_payload(rec);
end;
$function$
;
revoke all on function public.login_lockout_status(text,text) from public, anon, authenticated, service_role;
grant execute on function public.login_lockout_status(text,text) to service_role;
comment on function public.login_lockout_status(text,text) is 'SCRUM-16: { locked, locked_until, failed_attempts }. Exactly one of p_email or p_phone. Anon + authenticated.';

-- public.lookup_circle_invite(text)
CREATE OR REPLACE FUNCTION public.lookup_circle_invite(token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
begin
  if char_length(raw) = 0 then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null
    );
  end if;

  select *
    into m
    from public.safety_circle_members
   where invite_token = raw;

  if not found then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null
    );
  end if;

  return jsonb_build_object(
    'status', public._circle_invite_lookup_status(m),
    'invite_expires_at', m.invite_expires_at
  );
end;
$function$
;
revoke all on function public.lookup_circle_invite(text) from public, anon, authenticated, service_role;
grant execute on function public.lookup_circle_invite(text) to service_role;
comment on function public.lookup_circle_invite(text) is 'SCRUM-27: Token preview. Returns status pending|expired|consumed|canceled|not_found and invite_expires_at. No profile, phone, or other member fields. Does not activate membership.';

-- public.mark_incident_safe(uuid)
CREATE OR REPLACE FUNCTION public.mark_incident_safe(p_incident_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.mark_incident_safe(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_incident_safe(uuid) to service_role;
comment on function public.mark_incident_safe(uuid) is 'SCRUM-45 (consolidated with retired 46): resident confirms safe on their active incident. One call sets resolved / safe, resolved_at, location_sharing_ended_at, and logs safe_recorded, incident_closed, location_sharing_ended, closure_notified (recipient_count = current active members excluding resident) exactly once. Idempotent if already safe (no new events, timestamps unchanged). Not active raises not_open. Returns the shared JSON plus delivered_count / acknowledged_count. Closure notice is in-app (members see status resolved); no FCM/SMS. History kept.';

-- public.new_circle_invite_token()
CREATE OR REPLACE FUNCTION public.new_circle_invite_token()
 RETURNS text
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  select replace((gen_random_uuid()::text || gen_random_uuid()::text), '-', '');
$function$
;
revoke all on function public.new_circle_invite_token() from public, anon, authenticated, service_role;
grant execute on function public.new_circle_invite_token() to service_role;
comment on function public.new_circle_invite_token() is 'SCRUM-27: 64-char hex invite token. Internal; not granted to API roles.';

-- public.preview_circle_invite(text)
CREATE OR REPLACE FUNCTION public.preview_circle_invite(token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'preview_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
  st text;
  recipient_ok boolean := false;
  claimed boolean := false;
  display_status text;
  show_owner boolean := false;
  include_row boolean := false;
  circle_owner uuid;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false,
      'owner_avatar_url', null
    );
  end if;

  select *
    into m
    from public.safety_circle_members scm
   where scm.invite_token = raw
   for update;

  if not found then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null,
      'member_id', null,
      'circle_id', null,
      'owner_name', null,
      'invited_at', null,
      'claimed', false,
      'recipient_ok', false,
      'owner_avatar_url', null
    );
  end if;

  st := public._circle_invite_lookup_status(m);
  recipient_ok := public._circle_invite_recipient_ok(m, uid, auth_phone);

  select sc.owner_id
    into circle_owner
    from public.safety_circles sc
   where sc.id = m.circle_id;

  if circle_owner = uid then
    -- Owner preview never claims and never activates.
    display_status := 'own_circle';
    show_owner := true;
    include_row := true;
    claimed := m.user_id = uid;
  elsif m.status = 'active' and m.user_id = uid then
    display_status := 'already_member';
    show_owner := true;
    include_row := true;
    claimed := true;
  elsif st = 'consumed' then
    display_status := 'consumed';
    show_owner := false;
    include_row := false;
    claimed := false;
    recipient_ok := false;
  elsif st = 'canceled' then
    display_status := 'canceled';
    show_owner := false;
    include_row := recipient_ok;
    claimed := recipient_ok and m.user_id = uid;
  elsif st = 'expired' then
    display_status := 'expired';
    show_owner := recipient_ok;
    include_row := recipient_ok;
    claimed := recipient_ok and m.user_id = uid;
  elsif public._circle_has_active_membership(m.circle_id, uid, m.id) then
    display_status := 'already_member';
    show_owner := true;
    include_row := true;
    claimed := false;
  elsif st = 'pending' and recipient_ok then
    if public._circle_accept_used_after(m.circle_id, m.id)
         > public._circle_member_limit() then
      display_status := 'circle_full';
      show_owner := true;
      include_row := true;
      if m.user_id = uid then
        claimed := true;
      elsif m.user_id is null
            and not exists (
              select 1
                from public.safety_circle_members x
               where x.circle_id = m.circle_id
                 and x.user_id = uid
                 and x.id <> m.id
            ) then
        begin
          update public.safety_circle_members
             set user_id = uid,
                 updated_at = now()
           where public.safety_circle_members.id = m.id
           returning * into m;
          claimed := true;
        exception
          when unique_violation then
            claimed := false;
        end;
      else
        claimed := false;
      end if;
    else
      display_status := 'pending';
      show_owner := true;
      include_row := true;
      if m.user_id is null then
        begin
          update public.safety_circle_members
             set user_id = uid,
                 updated_at = now()
           where public.safety_circle_members.id = m.id
           returning * into m;
          claimed := true;
        exception
          when unique_violation then
            raise exception using
              errcode = 'P0001',
              message = prefix || ':duplicate_membership';
        end;
      else
        claimed := true;
      end if;
    end if;
  else
    display_status := st;
    show_owner := false;
    include_row := false;
    claimed := false;
  end if;

  return jsonb_build_object(
    'status', display_status,
    'invite_expires_at', m.invite_expires_at,
    'member_id', case when include_row then m.id else null end,
    'circle_id', case when include_row then m.circle_id else null end,
    'owner_name', case
      when show_owner then public._circle_owner_display_name(m.circle_id)
      else null
    end,
    'invited_at', case when include_row then m.invited_at else null end,
    'claimed', claimed,
    'recipient_ok', recipient_ok,
    'owner_avatar_url', case
      when show_owner then public._member_avatar_url(circle_owner)
      else null
    end
  );
end;
$function$
;
revoke all on function public.preview_circle_invite(text) from public, anon, authenticated, service_role;
grant execute on function public.preview_circle_invite(text) to service_role;
comment on function public.preview_circle_invite(text) is 'SCRUM-28: Authenticated preview. Claims a still-pending intended recipient (user_id set, status stays pending) except own_circle, already_member, and circle_full when the claim would duplicate. Returns already_member, circle_full, and own_circle instead of raising already_member. owner_avatar_url only when owner_name is returned. No emergency or medical profile fields. No SMS.';

-- public.record_login_failure(text,text)
CREATE OR REPLACE FUNCTION public.record_login_failure(p_email text DEFAULT NULL::text, p_phone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lock_key text;
  rec public.login_lockouts;
  payload jsonb;
begin
  perform public._login_lockout_rate_limit('record_login_failure', 15);
  lock_key := public._login_lockout_resolve_key(p_email, p_phone);
  rec := public._login_lockout_load(lock_key, true);

  if rec is not null
     and rec.locked_until is not null
     and rec.locked_until > now() then
    payload := public._login_lockout_payload(rec);
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:locked',
      detail = payload::text;
  end if;

  if rec is null then
    insert into public.login_lockouts as l (
      email,
      failed_attempts,
      locked_until,
      last_failed_at,
      updated_at
    )
    values (lock_key, 1, null, now(), now())
    returning * into rec;
  else
    rec.failed_attempts := coalesce(rec.failed_attempts, 0) + 1;
    rec.last_failed_at := now();
    rec.updated_at := now();
    if rec.failed_attempts >= 5 then
      rec.locked_until := now() + interval '15 minutes';
    end if;
    update public.login_lockouts l
       set failed_attempts = rec.failed_attempts,
           locked_until = rec.locked_until,
           last_failed_at = rec.last_failed_at,
           updated_at = rec.updated_at
     where l.email = lock_key
    returning * into rec;
  end if;

  -- Return JSON (including locked: true). Raising here would roll back the
  -- 5th-failure write in the same PostgREST transaction.
  return public._login_lockout_payload(rec);
end;
$function$
;
revoke all on function public.record_login_failure(text,text) from public, anon, authenticated, service_role;
grant execute on function public.record_login_failure(text,text) to service_role;
comment on function public.record_login_failure(text,text) is 'SCRUM-16: Increment after invalid_credentials only. Exactly one of p_email or p_phone. Locks at 5. Anon + authenticated.';

-- public.remove_circle_member(uuid)
CREATE OR REPLACE FUNCTION public.remove_circle_member(member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'remove_circle_member';
  uid uuid;
  m public.safety_circle_members%rowtype;
  caller_is_owner boolean := false;
begin
  uid := public._require_auth_uid(prefix);

  if member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = m.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  if not caller_is_owner then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  if m.role = 'owner' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':cannot_remove_owner';
  end if;

  delete from public.safety_circle_members
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'removed', true
  );
end;
$function$
;
revoke all on function public.remove_circle_member(uuid) from public, anon, authenticated, service_role;
grant execute on function public.remove_circle_member(uuid) to service_role;
comment on function public.remove_circle_member(uuid) is 'SCRUM-29: Owner-only. Deletes a non-owner member row (pending/active/declined). Cannot remove the owner or the circle. Does not write profiles.emergency_*. No SMS/push. id column qualified vs member_id arg.';

-- public.renotify_emergency_alert(uuid)
CREATE OR REPLACE FUNCTION public.renotify_emergency_alert(p_incident_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.renotify_emergency_alert(uuid) from public, anon, authenticated, service_role;
grant execute on function public.renotify_emergency_alert(uuid) to service_role;
comment on function public.renotify_emergency_alert(uuid) is 'SCRUM-72: re-notify the caller''s active incident in-app. Sets renotified_at, refreshes existing incident_deliveries.delivered_at (no new rows, acks kept), logs a renotified event {recipient_count}. Not active raises not_open. Never creates an incident. submit_emergency_alert on an active incident does the same. Not FCM/SMS.';

-- public.resend_circle_invite(uuid)
CREATE OR REPLACE FUNCTION public.resend_circle_invite(member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  prefix constant text := 'resend_circle_invite';
  cid uuid;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  if member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  select *
    into existing
    from public.safety_circle_members
   where public.safety_circle_members.id = member_id
     and public.safety_circle_members.circle_id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  -- Declined or expired rows do not hold a slot, so the resend takes one.
  if existing.role = 'member'
     and existing.status is distinct from 'active'
     and existing.invite_consumed_at is null
     and not public._circle_invite_holds_slot(existing) then
    perform public._require_circle_invite_slot(cid, prefix);
  end if;

  begin
    created := public._refresh_circle_invite(existing.id, prefix);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'circle_full' then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':circle_full';
      end if;
      raise;
  end;

  return public._circle_invite_payload(created, true);
end;
$function$
;
revoke all on function public.resend_circle_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.resend_circle_invite(uuid) to service_role;
comment on function public.resend_circle_invite(uuid) is 'SCRUM-27 / fix #14: Owner-only. Same row: new token, invited_at now, invite_expires_at now + 7 days. Valid pending refresh takes no new slot. Declined or expired pending takes a slot and raises resend_circle_invite:circle_full when available is 0. Active/consumed still already_active. Does not send SMS.';

-- public.set_incident_notes(uuid,text)
CREATE OR REPLACE FUNCTION public.set_incident_notes(p_incident_id uuid, p_incident_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.set_incident_notes(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.set_incident_notes(uuid,text) to service_role;
comment on function public.set_incident_notes(uuid,text) is 'SCRUM-39 / 72 / 45: Set or clear the live incident note on the caller''s activating or active incident. Does not set resolved_at, resolved_reason, auto_closed, or activity_confirmed_at. Does not mark safe or send.';

-- public.submit_emergency_alert(text)
CREATE OR REPLACE FUNCTION public.submit_emergency_alert(p_emergency_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
revoke all on function public.submit_emergency_alert(text) from public, anon, authenticated, service_role;
grant execute on function public.submit_emergency_alert(text) to service_role;
comment on function public.submit_emergency_alert(text) is 'SCRUM-36 / 38 / 43 / 72: one call creates and sends the resident''s emergency alert. Type required (medical | domestic_violence | fire | burglary | other; unspecified/unknown → invalid_type). Serialized per resident; exactly one open incident. Already active → re-notify that incident (type unchanged, submit_outcome renotified). Legacy activating → promoted. Else inserts active incident with sent_at + share_payload, in-app deliveries for active members, and alert_sent / location_sharing_started events. Returns shared JSON + delivered_count + acknowledged_count + submit_outcome. No grace. Not FCM/SMS.';

-- ---------------------------------------------------------------------------
-- 2. RLS policies (RLS is still enabled on these tables)
-- ---------------------------------------------------------------------------

drop policy if exists app_config_select_authenticated on public.app_config;
drop policy if exists incident_deliveries_select_own on public.incident_deliveries;
drop policy if exists incident_deliveries_select_resident on public.incident_deliveries;
drop policy if exists incident_deliveries_update_own on public.incident_deliveries;
drop policy if exists incident_events_select_visible on public.incident_events;
drop policy if exists incidents_select_active_member on public.incidents;
drop policy if exists incidents_select_own on public.incidents;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists safety_circle_members_insert_owner on public.safety_circle_members;
drop policy if exists safety_circle_members_select_owner on public.safety_circle_members;
drop policy if exists safety_circle_members_select_self on public.safety_circle_members;
drop policy if exists safety_circle_members_update_owner on public.safety_circle_members;
drop policy if exists safety_circles_insert_own on public.safety_circles;
drop policy if exists safety_circles_select_active_member on public.safety_circles;
drop policy if exists safety_circles_select_own on public.safety_circles;
drop policy if exists safety_circles_update_own on public.safety_circles;

create policy app_config_select_authenticated on public.app_config as permissive for select to authenticated
  using (true);
create policy incident_deliveries_select_own on public.incident_deliveries as permissive for select to authenticated
  using (((member_user_id = auth.uid()) AND public._can_view_incident_events(incident_id)));
create policy incident_deliveries_select_resident on public.incident_deliveries as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM public.incidents i
  WHERE ((i.id = incident_deliveries.incident_id) AND (i.resident_id = auth.uid())))));
create policy incident_deliveries_update_own on public.incident_deliveries as permissive for update to authenticated
  using (((member_user_id = auth.uid()) AND public._can_view_incident_events(incident_id)))
  with check (((member_user_id = auth.uid()) AND public._can_view_incident_events(incident_id)));
create policy incident_events_select_visible on public.incident_events as permissive for select to authenticated
  using (public._can_view_incident_events(incident_id));
create policy incidents_select_active_member on public.incidents as permissive for select to authenticated
  using (((circle_id IS NOT NULL) AND (status = ANY (ARRAY['active'::text, 'resolved'::text])) AND public._is_active_circle_member_since(circle_id, auth.uid(), activated_at)));
create policy incidents_select_own on public.incidents as permissive for select to authenticated
  using ((auth.uid() = resident_id));
create policy profiles_insert_own on public.profiles as permissive for insert to authenticated
  with check ((auth.uid() = id));
create policy profiles_select_own on public.profiles as permissive for select to authenticated
  using ((auth.uid() = id));
create policy profiles_update_own on public.profiles as permissive for update to authenticated
  using ((auth.uid() = id))
  with check ((auth.uid() = id));
create policy safety_circle_members_insert_owner on public.safety_circle_members as permissive for insert to authenticated
  with check ((EXISTS ( SELECT 1
   FROM public.safety_circles c
  WHERE ((c.id = safety_circle_members.circle_id) AND (c.owner_id = auth.uid())))));
create policy safety_circle_members_select_owner on public.safety_circle_members as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM public.safety_circles c
  WHERE ((c.id = safety_circle_members.circle_id) AND (c.owner_id = auth.uid())))));
create policy safety_circle_members_select_self on public.safety_circle_members as permissive for select to authenticated
  using ((user_id = auth.uid()));
create policy safety_circle_members_update_owner on public.safety_circle_members as permissive for update to authenticated
  using ((EXISTS ( SELECT 1
   FROM public.safety_circles c
  WHERE ((c.id = safety_circle_members.circle_id) AND (c.owner_id = auth.uid())))))
  with check ((EXISTS ( SELECT 1
   FROM public.safety_circles c
  WHERE ((c.id = safety_circle_members.circle_id) AND (c.owner_id = auth.uid())))));
create policy safety_circles_insert_own on public.safety_circles as permissive for insert to authenticated
  with check ((auth.uid() = owner_id));
create policy safety_circles_select_active_member on public.safety_circles as permissive for select to authenticated
  using (public._is_active_circle_member(id, auth.uid()));
create policy safety_circles_select_own on public.safety_circles as permissive for select to authenticated
  using ((auth.uid() = owner_id));
create policy safety_circles_update_own on public.safety_circles as permissive for update to authenticated
  using ((auth.uid() = owner_id))
  with check ((auth.uid() = owner_id));

-- ---------------------------------------------------------------------------
-- 3. The Phase 1 backend switch row, and the migration record
-- ---------------------------------------------------------------------------

insert into public.app_config (key, value)
values ('client_incidents_backend', '"supabase"'::jsonb)
on conflict (key) do nothing;

delete from public.api_schema_migrations where id = '0025_drop_legacy_sql';

commit;
