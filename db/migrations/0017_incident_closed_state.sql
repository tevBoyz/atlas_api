-- SCRUM-63 (Incident Resolution Status), decisions D61 (states and transitions) and D62 (the close
-- sweeper, its settings and events): an incident moves only Active -> Resolved (Safe) -> Closed, or
-- Active -> Closed (closed automatically after a period without activity).
--
-- Backward compatible (AGENTS.md rule 4): the set of allowed statuses only grows (every existing value
-- stays valid), `closed_at` is a new nullable column, the widened checks accept every row they
-- accepted before, the new index and the two `app_config` rows are additive. Nothing else changes:
-- - `resolved` stays the Resolved (Safe) state written by mark safe (`resolved_reason = 'safe'`).
-- - `closed` is written only by the API's close sweeper (worker process): Resolved -> Closed after
--   `incident_close_after_minutes` (reason kept, `auto_closed` kept), and Active -> Closed after
--   `incident_auto_close_after_hours` without activity (`resolved_reason = 'ended'`,
--   `auto_closed = true`, `resolved_at = closed_at`, location sharing ended). The existing columns
--   `resolved_reason` ('ended') and `auto_closed` (retired SCRUM-46) are reused, not repurposed.
-- - The old SQL functions are not changed (parity divergence, like D41/D44): they never write
--   `closed`; their reads list `active`/`resolved` only, and `mark_incident_safe` on a closed row
--   raises `not_open` (status is not `active`), as the API does.
-- Re-runnable on a fresh database after the baseline.

alter table public.incidents
  add column if not exists closed_at timestamptz;

comment on column public.incidents.closed_at is
  'SCRUM-63 (D61): when the incident became closed (final, read-only). Set exactly when status is '
  'closed (check incidents_closed_shape). Written only by the API close sweeper.';

alter table public.incidents
  drop constraint if exists incidents_status_allowed,
  add constraint incidents_status_allowed
    check (status in ('activating', 'active', 'cancelled', 'resolved', 'closed'));

-- Resolved and closed both carry resolved_at and resolved_reason (closed keeps what it had when it
-- was resolved; an automatic close sets them); every other status keeps them null and auto_closed
-- false, as before.
alter table public.incidents
  drop constraint if exists incidents_resolved_shape_check,
  add constraint incidents_resolved_shape_check
    check (
      (
        status in ('resolved', 'closed')
        and resolved_at is not null
        and resolved_reason is not null
      )
      or (
        status not in ('resolved', 'closed')
        and resolved_at is null
        and resolved_reason is null
        and auto_closed = false
      )
    );

alter table public.incidents
  drop constraint if exists incidents_closed_shape,
  add constraint incidents_closed_shape
    check (
      (status = 'closed') = (closed_at is not null)
      and (status <> 'closed' or resolved_reason in ('safe', 'ended'))
    );

alter table public.incidents
  drop constraint if exists incidents_location_sharing_ended_shape,
  add constraint incidents_location_sharing_ended_shape
    check (location_sharing_ended_at is null or status in ('resolved', 'closed'));

comment on column public.incidents.status is
  'activating (legacy 36) | active | cancelled (legacy 42) | resolved (Resolved / Safe: mark safe) | '
  'closed (SCRUM-63, D61: final; after the wrap-up period, or automatically after inactivity).';

-- The sweeper's Resolved -> Closed scan (`status = 'resolved' and resolved_at <= ...`). The
-- Active -> Closed scan uses incidents_one_open_per_resident_uidx (status in activating, active).
create index if not exists incidents_resolved_at_resolved_idx
  on public.incidents (resolved_at)
  where status = 'resolved';

-- D62: the two close settings, read by the sweeper on every run (no restart needed). Whole numbers
-- (JSON numbers, like live_location_interval_seconds); missing or <= 0 falls back to 30 / 24.
-- `on conflict do nothing`: a re-run never resets a value ops already changed.
insert into public.app_config (key, value)
values ('incident_close_after_minutes', '30'::jsonb),
       ('incident_auto_close_after_hours', '24'::jsonb)
on conflict (key) do nothing;
