-- SCRUM-36 / 45: Resident incident reads
-- get_my_open_incident() — the caller's active incident (shared JSON +
--   delivered_count + acknowledged_count) or JSON null. Lets the app restore
--   the Alert Sent state after a restart.
-- list_my_recent_incidents(p_limit) — the caller's own active / resolved
--   incidents, newest first, for Home "Recent Activity". Legacy cancelled /
--   activating rows are never listed.
-- Read-only. JWT resident only. No member or outsider access.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- get_my_open_incident()
-- ---------------------------------------------------------------------------

create or replace function public.get_my_open_incident()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
$$;

comment on function public.get_my_open_incident() is
  'SCRUM-36 / 45: the caller''s active incident as the shared JSON plus delivered_count and acknowledged_count, or JSON null when none. Read-only. Used to restore Alert Sent on app launch.';

revoke all on function public.get_my_open_incident() from public;
revoke all on function public.get_my_open_incident() from anon;
grant execute on function public.get_my_open_incident() to authenticated;

-- ---------------------------------------------------------------------------
-- list_my_recent_incidents(p_limit)
-- ---------------------------------------------------------------------------

create or replace function public.list_my_recent_incidents(p_limit integer default 5)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
$$;

comment on function public.list_my_recent_incidents(integer) is
  'SCRUM-36 / 45: JSON array of the caller''s own active and resolved incidents, newest activated_at first. p_limit default 5, clamped 1–20 (null → 5). Keys: id, emergency_type, status, activated_at, sent_at, resolved_at, resolved_reason. Read-only. Legacy cancelled/activating rows are excluded.';

revoke all on function public.list_my_recent_incidents(integer) from public;
revoke all on function public.list_my_recent_incidents(integer) from anon;
grant execute on function public.list_my_recent_incidents(integer) to authenticated;
