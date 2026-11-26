-- Stage 1 (D76, approved by Dawit 2026-11-26): retire the old Supabase SQL backend. NON-ADDITIVE
-- (approved in docs/claude_handoff/Gaps_Adressed.md section 1.1); rollback: db/rollback/0025_down.sql.
--
-- The app runs only on this API (since 0012 / D42 it has no direct database access) and the API
-- calls none of the Supabase-era SQL functions. This migration removes them and what only they
-- and the old app's direct table access used:
--
-- 1. The 18 RLS policies on `public` tables (all `to authenticated`, written for the old app's
--    direct PostgREST access, which 0012 already revoked). RLS itself STAYS ENABLED on every
--    table: with no policy it denies `anon` / `authenticated` everything (defence in depth on a
--    Supabase-hosted database, whose default privileges grant new tables to those roles). The API
--    connects as the table owner, which RLS does not apply to, so nothing the API does changes.
--    `storage.objects` policy `avatars_select_public` (public avatar read) is not touched.
-- 2. The 69 Supabase-era `public` functions of db/baseline (the SQL RPCs and their `_` helpers).
--    KEPT (table plumbing, listed 2026-11-26 from every trigger and every function a view,
--    default, check, policy, index or kept function uses):
--      trigger functions  _app_config_set_updated_at, audit_log_refuse_change,
--                         enforce_safety_circle_member_capacity, api_ensure_user_row_trigger,
--                         notification_deliveries_fill_final_at, set_incidents_updated_at,
--                         set_profiles_updated_at, set_safety_circle_members_activated_at,
--                         set_safety_circle_members_updated_at, set_safety_circles_updated_at
--      used by them       _circle_invite_holds_slot, _circle_invite_capacity_json,
--                         _circle_member_limit (capacity trigger), api_ensure_user_row
--    `hook_reject_locked_password_session` (the old Supabase Auth hook) is among the dropped:
--    the hook must be switched off in the Supabase project's Auth settings before this runs there.
-- 3. The 0004 `app_config` row `client_incidents_backend` (the Phase 1 rollback switch).
--
-- Plain DROP (no CASCADE): an unexpected dependent stops the migration instead of disappearing.
-- Re-runnable (`if exists`). Ends with a self-check; on failure nothing changes.

set local search_path = pg_catalog;

-- ---------------------------------------------------------------------------
-- 1. RLS policies of the old app's direct access
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

-- ---------------------------------------------------------------------------
-- 2. The Supabase-era SQL functions
-- ---------------------------------------------------------------------------

drop function if exists public._auth_user_phone(uuid);
drop function if exists public._avatars_public_url(text);
drop function if exists public._can_view_incident_events(uuid);
drop function if exists public._circle_accept_used_after(uuid,uuid);
drop function if exists public._circle_has_active_membership(uuid,uuid,uuid);
drop function if exists public._circle_invite_lookup_status(public.safety_circle_members);
drop function if exists public._circle_invite_payload(public.safety_circle_members,boolean);
drop function if exists public._circle_invite_preview_payload(public.safety_circle_members,text,boolean,boolean);
drop function if exists public._circle_invite_recipient_ok(public.safety_circle_members,uuid,text);
drop function if exists public._circle_owner_display_name(uuid);
drop function if exists public._incident_activation_json(public.incidents);
drop function if exists public._incident_active_recipient_ids(public.incidents);
drop function if exists public._incident_apply_renotify(uuid,uuid);
drop function if exists public._incident_delivery_counts_json(uuid,text);
drop function if exists public._incident_record_event(uuid,text,uuid,jsonb);
drop function if exists public._incident_send_json(public.incidents);
drop function if exists public._incident_share_payload(public.profiles);
drop function if exists public._is_active_circle_member(uuid,uuid);
drop function if exists public._is_active_circle_member_since(uuid,uuid,timestamp with time zone);
drop function if exists public._login_lockout_client_ip();
drop function if exists public._login_lockout_key_for_user(uuid);
drop function if exists public._login_lockout_load(text,boolean);
drop function if exists public._login_lockout_payload(public.login_lockouts);
drop function if exists public._login_lockout_phone_key(text);
drop function if exists public._login_lockout_rate_limit(text,integer);
drop function if exists public._login_lockout_resolve_key(text,text);
drop function if exists public._login_lockout_status_json(boolean,timestamp with time zone,integer);
drop function if exists public._member_avatar_url(uuid);
drop function if exists public._member_profile_name(uuid);
drop function if exists public._normalize_e164(text);
drop function if exists public._normalize_login_email(text);
drop function if exists public._owner_circle_for_invite(text);
drop function if exists public._refresh_circle_invite(uuid,text,text,text);
drop function if exists public._reject_unless_pending(text,text);
drop function if exists public._require_auth_uid(text);
drop function if exists public._require_circle_invite_slot(uuid,text);
drop function if exists public.accept_circle_invite(text);
drop function if exists public.acknowledge_incident(uuid);
drop function if exists public.attach_incident_location(uuid,text,double precision,double precision,double precision,timestamp with time zone);
drop function if exists public.cancel_circle_invite(uuid);
drop function if exists public.circle_invite_capacity();
drop function if exists public.clear_login_failures(text);
drop function if exists public.complete_profile_setup();
drop function if exists public.create_circle_invite_link(text);
drop function if exists public.decline_circle_invite(text);
drop function if exists public.get_incident_details(uuid);
drop function if exists public.get_live_location_config();
drop function if exists public.get_my_open_incident();
drop function if exists public.hook_reject_locked_password_session(jsonb);
drop function if exists public.incident_delivery_counts(uuid);
drop function if exists public.invite_circle_member_by_phone(text,text,text);
drop function if exists public.invite_circle_members_by_phone(jsonb);
drop function if exists public.leave_safety_circle(uuid);
drop function if exists public.list_circle_members(uuid);
drop function if exists public.list_my_circle_invites();
drop function if exists public.list_my_joined_circles();
drop function if exists public.list_my_recent_incidents(integer);
drop function if exists public.list_responder_incidents();
drop function if exists public.login_lockout_status(text,text);
drop function if exists public.lookup_circle_invite(text);
drop function if exists public.mark_incident_safe(uuid);
drop function if exists public.new_circle_invite_token();
drop function if exists public.preview_circle_invite(text);
drop function if exists public.record_login_failure(text,text);
drop function if exists public.remove_circle_member(uuid);
drop function if exists public.renotify_emergency_alert(uuid);
drop function if exists public.resend_circle_invite(uuid);
drop function if exists public.set_incident_notes(uuid,text);
drop function if exists public.submit_emergency_alert(text);

-- ---------------------------------------------------------------------------
-- 3. The Phase 1 backend switch
-- ---------------------------------------------------------------------------

delete from public.app_config where key = 'client_incidents_backend';

-- ---------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------

do $check$
declare
  v_left text;
  v_missing text;
begin
  select string_agg(format('%I on %I', policyname, tablename), ', ' order by tablename, policyname)
    into v_left
    from pg_policies
   where schemaname = 'public';
  if v_left is not null then
    raise exception '0025: RLS policies left on public tables: %', v_left;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname)
    into v_left
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in (
       '_auth_user_phone', '_avatars_public_url', '_can_view_incident_events',
       '_circle_accept_used_after', '_circle_has_active_membership',
       '_circle_invite_lookup_status', '_circle_invite_payload',
       '_circle_invite_preview_payload', '_circle_invite_recipient_ok',
       '_circle_owner_display_name', '_incident_activation_json',
       '_incident_active_recipient_ids', '_incident_apply_renotify',
       '_incident_delivery_counts_json', '_incident_record_event', '_incident_send_json',
       '_incident_share_payload', '_is_active_circle_member', '_is_active_circle_member_since',
       '_login_lockout_client_ip', '_login_lockout_key_for_user', '_login_lockout_load',
       '_login_lockout_payload', '_login_lockout_phone_key', '_login_lockout_rate_limit',
       '_login_lockout_resolve_key', '_login_lockout_status_json', '_member_avatar_url',
       '_member_profile_name', '_normalize_e164', '_normalize_login_email',
       '_owner_circle_for_invite', '_refresh_circle_invite', '_reject_unless_pending',
       '_require_auth_uid', '_require_circle_invite_slot', 'accept_circle_invite',
       'acknowledge_incident', 'attach_incident_location', 'cancel_circle_invite',
       'circle_invite_capacity', 'clear_login_failures', 'complete_profile_setup',
       'create_circle_invite_link', 'decline_circle_invite', 'get_incident_details',
       'get_live_location_config', 'get_my_open_incident',
       'hook_reject_locked_password_session', 'incident_delivery_counts',
       'invite_circle_member_by_phone', 'invite_circle_members_by_phone', 'leave_safety_circle',
       'list_circle_members', 'list_my_circle_invites', 'list_my_joined_circles',
       'list_my_recent_incidents', 'list_responder_incidents', 'login_lockout_status',
       'lookup_circle_invite', 'mark_incident_safe', 'new_circle_invite_token',
       'preview_circle_invite', 'record_login_failure', 'remove_circle_member',
       'renotify_emergency_alert', 'resend_circle_invite', 'set_incident_notes',
       'submit_emergency_alert'
     );
  if v_left is not null then
    raise exception '0025: Supabase-era functions left: %', v_left;
  end if;

  select string_agg(k, ', ' order by k)
    into v_missing
    from unnest(array[
           '_app_config_set_updated_at', 'audit_log_refuse_change',
           'enforce_safety_circle_member_capacity', 'api_ensure_user_row_trigger',
           'notification_deliveries_fill_final_at', 'set_incidents_updated_at',
           'set_profiles_updated_at', 'set_safety_circle_members_activated_at',
           'set_safety_circle_members_updated_at', 'set_safety_circles_updated_at',
           '_circle_invite_holds_slot', '_circle_invite_capacity_json', '_circle_member_limit',
           'api_ensure_user_row']) k
   where not exists (select 1 from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname = k);
  if v_missing is not null then
    raise exception '0025: kept table-plumbing functions missing: %', v_missing;
  end if;

  if exists (select 1 from public.app_config where key = 'client_incidents_backend') then
    raise exception '0025: app_config client_incidents_backend still present';
  end if;
end
$check$;
