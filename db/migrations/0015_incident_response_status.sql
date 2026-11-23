-- SCRUM-49 / 50 / 51 / 55 (decision D56): a notified member's response to an alert.
--
-- Additive and backward compatible (AGENTS.md rule 4): two new nullable columns on
-- `incident_deliveries`, no default, so every existing row stays exactly as it was (null = the member
-- has not said whether they are responding). The old SQL functions never read or write them.
-- - `response_status`: null, `responding` ("I'm Responding") or `unable` ("Unable to Respond"); a
--   member may switch between the two while the alert is active (written only by the API,
--   `POST /v1/incidents/{id}/response`).
-- - `response_at`: when the current `response_status` was set (server time, `now()`); set exactly
--   when `response_status` is set (check `incident_deliveries_response_shape`).
-- Re-runnable on a fresh database after the baseline.

alter table public.incident_deliveries
  add column if not exists response_status text,
  add column if not exists response_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'incident_deliveries_response_status_allowed'
       and conrelid = 'public.incident_deliveries'::regclass
  ) then
    alter table public.incident_deliveries
      add constraint incident_deliveries_response_status_allowed
      check (response_status is null or response_status in ('responding', 'unable'));
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'incident_deliveries_response_shape'
       and conrelid = 'public.incident_deliveries'::regclass
  ) then
    alter table public.incident_deliveries
      add constraint incident_deliveries_response_shape
      check ((response_status is null) = (response_at is null));
  end if;
end
$$;

comment on column public.incident_deliveries.response_status is
  'SCRUM-50/51 (D56): null, responding or unable. Set by the API only, while the incident is active; '
  'the member may switch between responding and unable.';
comment on column public.incident_deliveries.response_at is
  'SCRUM-50/51 (D56): when the current response_status was set (server time). Null exactly when '
  'response_status is null.';
