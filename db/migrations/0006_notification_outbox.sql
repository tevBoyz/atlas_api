-- API-100-45: transactional outbox (spec §11.6 "DB write before notify", §11.7
-- `notification_outbox`). Domain code inserts a row in the SAME transaction as the write it reports,
-- so a rolled-back write leaves no row. The relay (src/jobs/outbox-relay.service.ts) publishes
-- committed, unpublished rows to BullMQ (job id = row id) and then sets `published_at`:
-- at-least-once, so consumers are idempotent by the outbox id.
--
-- `deliver_at` (not in the spec's column list; decision D23) delays the job until that time
-- (foundation for escalation, SCRUM-76); null = at once. `attempts` counts publish attempts.
-- `aggregate_id` names the row the event is about (the incident); no foreign key, like audit_log:
-- the outbox must never block or follow a delete.
--
-- Additive only (AGENTS.md rule 4): one new table and its indexes. Re-runnable on a fresh database
-- after the baseline. Locked down for the Supabase API roles like 0001-0005.

create table if not exists public.notification_outbox (
  id uuid not null default gen_random_uuid(),
  topic text not null,
  aggregate_id uuid null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  deliver_at timestamptz null,
  published_at timestamptz null,
  attempts integer not null default 0,
  constraint notification_outbox_pkey primary key (id),
  constraint notification_outbox_topic_check check (topic ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  constraint notification_outbox_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint notification_outbox_attempts_check check (attempts >= 0)
);

comment on table public.notification_outbox is
  'API-100-45: transactional outbox. A row is inserted in the transaction of the write it reports; the relay publishes it to BullMQ (job id = row id) and sets published_at. At-least-once: consumers are idempotent by outbox id. payload holds ids, the emergency type, the resident display name and times only: never medical or share data, tokens or coordinates.';

-- The relay's scan: unpublished rows, oldest first.
create index if not exists notification_outbox_unpublished_idx
  on public.notification_outbox (created_at, id)
  where published_at is null;

-- What was raised about one incident.
create index if not exists notification_outbox_aggregate_idx
  on public.notification_outbox (aggregate_id, created_at)
  where aggregate_id is not null;

alter table public.notification_outbox enable row level security;

revoke all on table public.notification_outbox from public;
revoke all on table public.notification_outbox from anon;
revoke all on table public.notification_outbox from authenticated;
