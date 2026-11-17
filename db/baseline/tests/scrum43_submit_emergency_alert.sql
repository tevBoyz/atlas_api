-- SCRUM-36 / 38 / 43 / 72 atomic submit checks. Run as one script against
-- the hosted database. All writes stay inside this DO block. The block ends
-- by raising scrum43_submit_emergency_alert_ok so PostgreSQL rolls the test
-- rows back. A different error is a failed assert.
--
-- Covers: retired RPCs are gone, type rename (no crime_safety / accident
-- rows, constraint rejects them), invalid type, profile gates, create +
-- deliveries + events, idempotent double submit (exactly one incident, no
-- duplicate deliveries / alert_sent), active re-notify keeps the type.
-- True concurrent double-tap is guaranteed by the profiles row lock and
-- incidents_one_open_per_resident_uidx; both are asserted to exist.

do $scrum43$
declare
  resident uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  pending_user uuid := gen_random_uuid();
  noprofile uuid := gen_random_uuid();
  incomplete uuid := gen_random_uuid();
  cid uuid := gen_random_uuid();
  tag text := replace(gen_random_uuid()::text, '-', '');
  first jsonb;
  second jsonb;
  third jsonb;
  open_count integer;
  n integer;
  ev jsonb;
  saved_sent timestamptz;
  saved_renotified timestamptz;
  bad text;
begin
  -- Retired RPCs no longer exist.
  if to_regprocedure('public.start_emergency_activation()') is not null
     or to_regprocedure('public.set_emergency_type(uuid,text)') is not null
     or to_regprocedure('public.send_emergency_alert(uuid)') is not null
     or to_regprocedure('public.cancel_emergency_activation(uuid)') is not null
     or to_regprocedure('public.end_incident(uuid)') is not null
     or to_regprocedure('public.incident_inactivity_due()') is not null
     or to_regprocedure('public.confirm_incident_still_active(uuid)') is not null
     or to_regprocedure('public.auto_close_inactive_incident(uuid)') is not null
     or to_regprocedure('public._incident_activity_at(public.incidents)') is not null
     or to_regprocedure('public._incident_inactivity_is_due(public.incidents)') is not null
  then
    raise exception 'a retired RPC still exists';
  end if;

  if has_function_privilege('anon', 'public.submit_emergency_alert(text)', 'execute')
     or not has_function_privilege('authenticated', 'public.submit_emergency_alert(text)', 'execute')
  then
    raise exception 'submit_emergency_alert grants wrong';
  end if;

  if has_table_privilege('authenticated', 'public.incidents', 'insert')
     or has_table_privilege('authenticated', 'public.incidents', 'update')
     or has_table_privilege('authenticated', 'public.incidents', 'delete')
     or not has_table_privilege('authenticated', 'public.incidents', 'select')
  then
    raise exception 'incidents client grants are not select-only';
  end if;

  if to_regclass('public.incidents_one_open_per_resident_uidx') is null then
    raise exception 'one-open unique index missing';
  end if;

  -- Type rename.
  select count(*) into n
    from public.incidents
   where emergency_type in ('crime_safety', 'accident');
  if n <> 0 then
    raise exception 'legacy type rows remain: %', n;
  end if;

  select count(*) into n
    from public.incidents
   where status = 'activating';
  if n <> 0 then
    raise exception 'activating rows remain: %', n;
  end if;

  -- Fixtures.
  insert into auth.users (id, email, email_confirmed_at)
  values
    (resident, 's43r' || tag || '@atlas.test', now()),
    (member, 's43m' || tag || '@atlas.test', now()),
    (pending_user, 's43p' || tag || '@atlas.test', now()),
    (noprofile, 's43n' || tag || '@atlas.test', now()),
    (incomplete, 's43i' || tag || '@atlas.test', now());

  insert into public.profiles (
    id, full_name, date_of_birth, profile_setup_completed_at,
    blood_type, share_blood_type, allergies, share_allergies
  )
  values
    (resident, 'Resident Submit', date '1990-01-01', now(),
     'O+', true, 'Peanuts', false),
    (member, 'Member Submit', date '1991-01-01', now(), null, false, null, false),
    (pending_user, 'Pending Submit', date '1992-01-01', now(), null, false, null, false),
    (incomplete, 'Incomplete Submit', date '1993-01-01', null, null, false, null, false);

  insert into public.safety_circles (id, owner_id, name)
  values (cid, resident, 'My Safety Circle');

  insert into public.safety_circle_members (circle_id, role, status, display_name, user_id)
  values (cid, 'owner', 'active', 'Resident Submit', resident);

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at
  )
  values (cid, 'member', 'active', 'Member Submit', member, now());

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Pending Submit',
    public.new_circle_invite_token(), now() + interval '7 days'
  );

  -- Constraint rejects renamed legacy values.
  foreach bad in array array['crime_safety', 'accident', 'police'] loop
    begin
      insert into public.incidents (resident_id, status, emergency_type, cancelled_at)
      values (resident, 'cancelled', bad, now());
      raise exception 'constraint accepted %', bad;
    exception
      when check_violation then null;
    end;
  end loop;

  -- No JWT.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.submit_emergency_alert('medical');
    raise exception 'anonymous submit did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'submit_emergency_alert:not_authenticated%' then
        raise exception 'anonymous submit got %', sqlerrm;
      end if;
  end;

  -- No profile / incomplete setup.
  perform set_config('request.jwt.claim.sub', noprofile::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', noprofile, 'role', 'authenticated')::text, true);
  begin
    perform public.submit_emergency_alert('medical');
    raise exception 'no-profile submit did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'submit_emergency_alert:profile_not_found%' then
        raise exception 'no-profile submit got %', sqlerrm;
      end if;
  end;

  perform set_config('request.jwt.claim.sub', incomplete::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', incomplete, 'role', 'authenticated')::text, true);
  begin
    perform public.submit_emergency_alert('fire');
    raise exception 'incomplete submit did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'submit_emergency_alert:profile_setup_incomplete%' then
        raise exception 'incomplete submit got %', sqlerrm;
      end if;
  end;

  -- Resident.
  perform set_config('request.jwt.claim.sub', resident::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', resident, 'role', 'authenticated')::text, true);

  -- Invalid types never create a row.
  foreach bad in array array['unspecified', 'crime_safety', 'accident', 'Medical', '', 'police'] loop
    begin
      perform public.submit_emergency_alert(bad);
      raise exception 'type % accepted', bad;
    exception
      when sqlstate 'P0001' then
        if sqlerrm not like 'submit_emergency_alert:invalid_type%' then
          raise exception 'type % got %', bad, sqlerrm;
        end if;
    end;
  end loop;

  begin
    perform public.submit_emergency_alert(null);
    raise exception 'null type accepted';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like 'submit_emergency_alert:invalid_type%' then
        raise exception 'null type got %', sqlerrm;
      end if;
  end;

  select count(*) into n from public.incidents where resident_id = resident;
  if n <> 0 then
    raise exception 'invalid submit created a row';
  end if;

  -- Create.
  first := public.submit_emergency_alert('domestic_violence');
  if first->>'status' is distinct from 'active'
     or first->>'emergency_type' is distinct from 'domestic_violence'
     or first->>'submit_outcome' is distinct from 'created'
     or first->>'resident_id' is distinct from resident::text
     or first->>'circle_id' is distinct from cid::text
     or first->>'sent_at' is null
     or first->>'activated_at' is null
     or (first->>'delivered_count')::int is distinct from 1
     or (first->>'acknowledged_count')::int is distinct from 0
     or first->'renotified_at' is distinct from 'null'::jsonb
     or first->'location_sharing_ended_at' is distinct from 'null'::jsonb
     or first->'resolved_at' is distinct from 'null'::jsonb
     or first->'share_payload' is distinct from '{"blood_type": "O+"}'::jsonb
     or not (first ? 'location_lat' and first ? 'incident_notes' and first ? 'cancelled_at')
  then
    raise exception 'create payload failed: %', first;
  end if;
  saved_sent := (first->>'sent_at')::timestamptz;

  select count(*) into n
    from public.incident_deliveries d
   where d.incident_id = (first->>'id')::uuid;
  if n <> 1 or not exists (
    select 1 from public.incident_deliveries d
     where d.incident_id = (first->>'id')::uuid and d.member_user_id = member
  ) then
    raise exception 'deliveries wrong (pending / resident / missing): %', n;
  end if;

  select e.detail into ev
    from public.incident_events e
   where e.incident_id = (first->>'id')::uuid and e.event_type = 'alert_sent';
  if ev is null
     or (ev->>'recipient_count')::int is distinct from 1
     or ev->'recipient_ids' is distinct from jsonb_build_array(member::text)
  then
    raise exception 'alert_sent detail wrong: %', ev;
  end if;

  if not exists (
    select 1 from public.incident_events e
     where e.incident_id = (first->>'id')::uuid
       and e.event_type = 'location_sharing_started'
       and e.actor_id = resident
  ) then
    raise exception 'location_sharing_started missing';
  end if;

  -- Double submit (retry / double tap, different type): same incident,
  -- re-notified, type unchanged, no new deliveries or alert_sent.
  second := public.submit_emergency_alert('fire');
  if second->>'id' is distinct from first->>'id'
     or second->>'submit_outcome' is distinct from 'renotified'
     or second->>'emergency_type' is distinct from 'domestic_violence'
     or second->>'status' is distinct from 'active'
     or (second->>'sent_at')::timestamptz is distinct from saved_sent
     or second->'renotified_at' = 'null'::jsonb
     or (second->>'delivered_count')::int is distinct from 1
  then
    raise exception 'second submit failed: %', second;
  end if;
  saved_renotified := (second->>'renotified_at')::timestamptz;

  third := public.submit_emergency_alert('medical');
  if third->>'id' is distinct from first->>'id'
     or third->>'emergency_type' is distinct from 'domestic_violence' then
    raise exception 'third submit failed: %', third;
  end if;

  select count(*) into open_count
    from public.incidents i
   where i.resident_id = resident;
  if open_count <> 1 then
    raise exception 'double submit created % incidents', open_count;
  end if;

  select count(*) into n
    from public.incident_deliveries d
   where d.incident_id = (first->>'id')::uuid;
  if n <> 1 then
    raise exception 'double submit duplicated deliveries: %', n;
  end if;

  select count(*) into n
    from public.incident_events e
   where e.incident_id = (first->>'id')::uuid
     and e.event_type in ('alert_sent', 'location_sharing_started');
  if n <> 2 then
    raise exception 'double submit duplicated lifecycle events: %', n;
  end if;

  select count(*) into n
    from public.incident_events e
   where e.incident_id = (first->>'id')::uuid
     and e.event_type = 'renotified'
     and (e.detail->>'recipient_count')::int = 1;
  if n <> 2 then
    raise exception 'renotified events wrong: %', n;
  end if;

  -- Explicit SCRUM-72 RPC still works on the same incident.
  second := public.renotify_emergency_alert((first->>'id')::uuid);
  if second->>'id' is distinct from first->>'id'
     or (second->>'renotified_at')::timestamptz < saved_renotified then
    raise exception 'renotify_emergency_alert failed: %', second;
  end if;

  -- Member ack still works and counts reflect it.
  perform set_config('request.jwt.claim.sub', member::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', member, 'role', 'authenticated')::text, true);
  ev := public.acknowledge_incident((first->>'id')::uuid);
  if (ev->>'acknowledged_count')::int is distinct from 1 then
    raise exception 'ack failed: %', ev;
  end if;

  -- Member cannot submit on behalf of the resident; their own submit is
  -- their own incident (no circle → zero deliveries is success).
  third := public.submit_emergency_alert('other');
  if third->>'resident_id' is distinct from member::text
     or third->>'id' = first->>'id'
     or third->'circle_id' is distinct from 'null'::jsonb
     or (third->>'delivered_count')::int is distinct from 0 then
    raise exception 'member own submit failed: %', third;
  end if;

  select e.detail into ev
    from public.incident_events e
   where e.incident_id = (third->>'id')::uuid and e.event_type = 'alert_sent';
  if (ev->>'recipient_count')::int is distinct from 0
     or ev->'recipient_ids' is distinct from '[]'::jsonb then
    raise exception 'zero-recipient alert_sent wrong: %', ev;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'scrum43_submit_emergency_alert_ok';
end
$scrum43$;
