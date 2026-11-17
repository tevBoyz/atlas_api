-- SCRUM-36 / 45 resident read checks. Run as one script against the hosted
-- database. All writes stay inside this DO block. The block ends by raising
-- scrum36_resident_incident_reads_ok so PostgreSQL rolls the test rows back.
-- A different error is a failed assert.
--
-- Covers: get_my_open_incident (null → open incident with counts → null
-- after mark safe; another user's incident never returned) and
-- list_my_recent_incidents (own active/resolved only, newest first, legacy
-- cancelled excluded, limit default / clamp, exact keys).

do $scrum36$
declare
  resident uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  tag text := replace(gen_random_uuid()::text, '-', '');
  open_inc jsonb;
  inc jsonb;
  list jsonb;
  ids uuid[] := '{}';
  other_id uuid;
  i integer;
  n integer;
begin
  if has_function_privilege('anon', 'public.get_my_open_incident()', 'execute')
     or has_function_privilege('anon', 'public.list_my_recent_incidents(integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.get_my_open_incident()', 'execute')
     or not has_function_privilege('authenticated', 'public.list_my_recent_incidents(integer)', 'execute')
  then
    raise exception 'read RPC grants wrong';
  end if;

  insert into auth.users (id, email, email_confirmed_at)
  values
    (resident, 's36r' || tag || '@atlas.test', now()),
    (other, 's36o' || tag || '@atlas.test', now());

  insert into public.profiles (id, full_name, date_of_birth, profile_setup_completed_at)
  values
    (resident, 'Resident Reads', date '1990-01-01', now()),
    (other, 'Other Reads', date '1991-01-01', now());

  -- Legacy cancelled row: never listed.
  insert into public.incidents (resident_id, status, emergency_type, activated_at, cancelled_at)
  values (resident, 'cancelled', 'unspecified', now() + interval '1 hour', now());

  -- No JWT.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.get_my_open_incident();
    raise exception 'anonymous open read did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'get_my_open_incident:not_authenticated%' then
        raise exception 'anonymous open read got %', sqlerrm;
      end if;
  end;
  begin
    perform public.list_my_recent_incidents();
    raise exception 'anonymous recent read did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'list_my_recent_incidents:not_authenticated%' then
        raise exception 'anonymous recent read got %', sqlerrm;
      end if;
  end;

  -- Other user has an open incident.
  perform set_config('request.jwt.claim.sub', other::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', other, 'role', 'authenticated')::text, true);
  other_id := (public.submit_emergency_alert('fire')->>'id')::uuid;

  -- Resident.
  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);

  open_inc := public.get_my_open_incident();
  if open_inc is distinct from 'null'::jsonb then
    raise exception 'open read before submit should be null: %', open_inc;
  end if;

  list := public.list_my_recent_incidents();
  if list is distinct from '[]'::jsonb then
    raise exception 'recent list should be empty (cancelled excluded): %', list;
  end if;

  -- Seven closed incidents, then one open.
  for i in 1..7 loop
    inc := public.submit_emergency_alert(
      (array['medical', 'domestic_violence', 'fire', 'burglary', 'other'])[1 + (i % 5)]
    );
    ids := ids || (inc->>'id')::uuid;
    perform public.mark_incident_safe((inc->>'id')::uuid);
    -- Distinct, increasing activated_at for deterministic order.
    update public.incidents
       set activated_at = now() - interval '1 day' + make_interval(mins => i)
     where id = (inc->>'id')::uuid;
  end loop;

  inc := public.submit_emergency_alert('medical');
  ids := ids || (inc->>'id')::uuid;

  open_inc := public.get_my_open_incident();
  if open_inc->>'id' is distinct from inc->>'id'
     or open_inc->>'status' is distinct from 'active'
     or open_inc->>'emergency_type' is distinct from 'medical'
     or not (open_inc ? 'delivered_count' and open_inc ? 'acknowledged_count')
     or open_inc ? 'submit_outcome'
     or open_inc->'location_sharing_ended_at' is distinct from 'null'::jsonb
     or open_inc->>'id' = other_id::text
  then
    raise exception 'open read failed: %', open_inc;
  end if;

  -- Default limit 5, newest first (open one is newest).
  list := public.list_my_recent_incidents();
  if jsonb_array_length(list) <> 5
     or list->0->>'id' is distinct from inc->>'id'
     or list->0->>'status' is distinct from 'active'
     or list->1->>'id' is distinct from ids[7]::text
     or list->1->>'status' is distinct from 'resolved'
     or list->1->>'resolved_reason' is distinct from 'safe'
     or list->1->>'resolved_at' is null
     or list->4->>'id' is distinct from ids[4]::text
  then
    raise exception 'default recent list wrong: %', list;
  end if;

  if (
    select array_agg(k order by k) from jsonb_object_keys(list->1) k
  ) is distinct from array[
    'activated_at', 'emergency_type', 'id', 'resolved_at',
    'resolved_reason', 'sent_at', 'status'
  ] then
    raise exception 'recent list keys wrong: %', list->1;
  end if;

  if exists (
    select 1 from jsonb_array_elements(public.list_my_recent_incidents(20)) e
     where e->>'id' = other_id::text or e->>'status' = 'cancelled'
  ) then
    raise exception 'recent list leaked another user or cancelled';
  end if;

  if jsonb_array_length(public.list_my_recent_incidents(20)) <> 8 then
    raise exception 'limit 20 should return all 8';
  end if;
  if jsonb_array_length(public.list_my_recent_incidents(500)) <> 8 then
    raise exception 'limit 500 should clamp to 20 and return 8';
  end if;
  if jsonb_array_length(public.list_my_recent_incidents(0)) <> 1
     or jsonb_array_length(public.list_my_recent_incidents(-3)) <> 1 then
    raise exception 'limit <= 0 should clamp to 1';
  end if;
  if jsonb_array_length(public.list_my_recent_incidents(null)) <> 5 then
    raise exception 'null limit should default to 5';
  end if;

  -- After mark safe, no open incident; completed one tops Recent Activity.
  perform public.mark_incident_safe((inc->>'id')::uuid);
  open_inc := public.get_my_open_incident();
  if open_inc is distinct from 'null'::jsonb then
    raise exception 'open read after mark safe should be null: %', open_inc;
  end if;

  list := public.list_my_recent_incidents(1);
  if list->0->>'id' is distinct from inc->>'id'
     or list->0->>'status' is distinct from 'resolved' then
    raise exception 'completed incident not first in recent: %', list;
  end if;

  select count(*) into n from public.incidents where resident_id = resident;
  if n <> 9 then
    raise exception 'unexpected incident count %', n;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'scrum36_resident_incident_reads_ok';
end
$scrum36$;
