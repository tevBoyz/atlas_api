-- SCRUM-48: View Incident Details
-- Responder read of an active incident: name via definer RPC (profiles stay
-- own-row), location / notes / status / share_payload from the incident row.
-- Adds public.incidents to supabase_realtime so members who already pass
-- incidents_select_active_member receive postgres changes. Does not publish
-- profiles. Does not change RLS. Does not revert _is_active_circle_member.
-- No map, no FCM, no Twilio, no Edge Function. No mark-safe / end.
-- Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- Realtime: incidents only. profiles stays out of the publication.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'incidents'
  ) then
    alter publication supabase_realtime add table public.incidents;
  end if;
end
$$;

comment on table public.incidents is
  'SCRUM-36 / 38 / 40 / 42 / 43 / 39 / 72 / 48: Emergency loop. One open incident per resident (activating or active). 48 publishes this table on supabase_realtime for active-member SELECT. Profiles are not published. Not FCM/SMS. Not a map.';

-- ---------------------------------------------------------------------------
-- list_responder_incidents() — incoming active alerts for this member
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
          'renotified_at', i.renotified_at
        ) as payload,
        coalesce(i.sent_at, i.activated_at) as sort_at,
        i.id as sort_id
      from public.incidents i
      left join public.profiles p
        on p.id = i.resident_id
      where i.status = 'active'
        and i.resident_id <> uid
        and public._is_active_circle_member(i.circle_id, uid)
    ) as incoming;

  return result;
end;
$$;

comment on function public.list_responder_incidents() is
  'SCRUM-48: JSON array of active incidents where the caller is an active circle member and is not the resident. resident_name is profiles.full_name via this definer. Empty array if none. Omits activating, cancelled, and resolved. Does not open profiles to members.';

revoke all on function public.list_responder_incidents() from public;
revoke all on function public.list_responder_incidents() from anon;
grant execute on function public.list_responder_incidents() to authenticated;

-- ---------------------------------------------------------------------------
-- get_incident_details(p_incident_id) — one incoming active incident
-- Resident opening their own row is not this screen (not_found).
-- Pending / outsiders / non-active also not_found (do not leak existence).
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
     or rec.status is distinct from 'active'
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
  'SCRUM-48: JSON details for one active incident. Caller must be an active circle member and not the resident. Else not_found. resident_name is profiles.full_name. share_payload is the stored snapshot only (or {}). Does not merge live profile columns. Does not add date_of_birth. Map UI is mobile.';

revoke all on function public.get_incident_details(uuid) from public;
revoke all on function public.get_incident_details(uuid) from anon;
grant execute on function public.get_incident_details(uuid) to authenticated;
