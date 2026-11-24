-- SCRUM-35 (Send a Test Safety Circle Alert), decisions D66-D68: the circle owner sends a test alert
-- to the ACTIVE members of their circle to check that they receive Atlas notifications.
--
-- A test alert is stored SEPARATELY from real emergencies: it never creates or touches an incident,
-- an incident event, an incident delivery (responder) row, live location, the emergency numbers or
-- the SOS rate limits.
--
-- Additive and backward compatible (AGENTS.md rule 4):
-- - `circle_test_alerts`: one row per test sent (owner, circle, time, how many members it went to);
--   written only by the API (`POST /v1/me/circle/test-alerts`). Deleting the circle or the owner's
--   profile deletes its tests.
-- - `circle_test_alert_receipts`: one row per recipient of a test (the active members at send time),
--   with `seen_at` (null until the member opened the test in Atlas, D68). Deleting the test or the
--   member's user deletes the row.
-- - `notification_deliveries.test_alert_id` (nullable, foreign key, cascades with its test): the
--   push delivery rows of a test point at it. Check `notification_deliveries_single_subject`: a
--   delivery belongs to an incident OR a test alert, never both (every existing row has
--   `test_alert_id` null, so the check holds for them; rows with neither stay allowed).
-- - two `app_config` rows, the send rate limit of D66 (server settings, read on every send):
--   `circle_test_alert_min_interval_minutes` = 5 and `circle_test_alert_daily_max` = 10
--   (`on conflict do nothing`: a re-run never resets a value ops already changed).
-- Re-runnable on a fresh database after the baseline. The two new tables are locked down for the
-- Supabase API roles like 0001-0008 and 0014.

create table if not exists public.circle_test_alerts (
  id uuid not null default gen_random_uuid(),
  circle_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  recipient_count integer not null,
  constraint circle_test_alerts_pkey primary key (id),
  constraint circle_test_alerts_circle_id_fkey foreign key (circle_id)
    references public.safety_circles (id) on delete cascade,
  constraint circle_test_alerts_owner_id_fkey foreign key (owner_id)
    references public.profiles (id) on delete cascade,
  -- D66: a test with no eligible recipient is refused before anything is stored.
  constraint circle_test_alerts_recipient_count_check check (recipient_count > 0)
);

comment on table public.circle_test_alerts is
  'SCRUM-35 (D66-D68): one test alert sent by a circle owner to the active members of their circle. '
  'Never an incident: no incident, incident event, responder row, live location or emergency number '
  'is involved. Written only by the API.';

-- D66 rate limit (the owner's tests over the last 24 hours) and the owner's latest test (D68).
create index if not exists circle_test_alerts_owner_created_idx
  on public.circle_test_alerts (owner_id, created_at desc, id);

create index if not exists circle_test_alerts_circle_created_idx
  on public.circle_test_alerts (circle_id, created_at desc, id);

create table if not exists public.circle_test_alert_receipts (
  test_alert_id uuid not null,
  member_user_id uuid not null,
  seen_at timestamptz null,
  constraint circle_test_alert_receipts_pkey primary key (test_alert_id, member_user_id),
  constraint circle_test_alert_receipts_test_alert_id_fkey foreign key (test_alert_id)
    references public.circle_test_alerts (id) on delete cascade,
  constraint circle_test_alert_receipts_member_user_id_fkey foreign key (member_user_id)
    references public.users (id) on delete cascade
);

comment on table public.circle_test_alert_receipts is
  'SCRUM-35 (D66, D68): the recipients of a test alert (the circle''s active members when it was '
  'sent) and when each opened it in Atlas (seen_at, null until then). Written only by the API.';

-- A member's own tests (GET /v1/test-alerts/{id}).
create index if not exists circle_test_alert_receipts_member_idx
  on public.circle_test_alert_receipts (member_user_id);

alter table public.notification_deliveries
  add column if not exists test_alert_id uuid null;

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_test_alert_id_fkey,
  add constraint notification_deliveries_test_alert_id_fkey foreign key (test_alert_id)
    references public.circle_test_alerts (id) on delete cascade;

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_single_subject,
  add constraint notification_deliveries_single_subject
    check (incident_id is null or test_alert_id is null);

comment on column public.notification_deliveries.test_alert_id is
  'SCRUM-35 (D67, D68): the test alert this delivery belongs to (null for incident notices). Never '
  'set together with incident_id (check notification_deliveries_single_subject).';

-- The deliveries of one test alert (the owner's status read, D68).
create index if not exists notification_deliveries_test_alert_idx
  on public.notification_deliveries (test_alert_id, recipient_user_id)
  where test_alert_id is not null;

alter table public.circle_test_alerts enable row level security;
alter table public.circle_test_alert_receipts enable row level security;

revoke all on table public.circle_test_alerts from public;
revoke all on table public.circle_test_alerts from anon;
revoke all on table public.circle_test_alerts from authenticated;
revoke all on table public.circle_test_alert_receipts from public;
revoke all on table public.circle_test_alert_receipts from anon;
revoke all on table public.circle_test_alert_receipts from authenticated;

-- D66: the send rate limit, read on every send (no restart needed). Whole numbers (JSON numbers);
-- missing or <= 0 falls back to 5 minutes / 10 per 24 hours.
insert into public.app_config (key, value)
values ('circle_test_alert_min_interval_minutes', '5'::jsonb),
       ('circle_test_alert_daily_max', '10'::jsonb)
on conflict (key) do nothing;
