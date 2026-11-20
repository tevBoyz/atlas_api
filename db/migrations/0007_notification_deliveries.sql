-- API-100-47: one row per recipient x channel x device of an outbox row (spec §11.7
-- `notification_deliveries`), with its outcome: `queued` -> `sent` -> `delivered` (only with a
-- provider receipt) or `failed` (with `error_code`); `skipped` (with `error_code`) when the channel
-- is disabled, the user has no device or no address, or is no longer an eligible recipient.
-- Foundation for SCRUM-65/66/67/71; no read endpoint in Epic 100.
--
-- The unique index makes the outbox consumer idempotent: a second run for the same outbox row
-- inserts nothing new. `preferences` (not in the spec's column list; decision D25) records the
-- recipient's `alert_*_enabled` flags at fan-out time: recorded, not enforced for SOS (D4).
-- `device_id` cascades: a device row is only ever deleted with its user (auth.users), and then that
-- user's push rows go too. `recipient_user_id` and `incident_id` carry no foreign key, like
-- audit_log: delivery records must never block a delete.
--
-- Additive only (AGENTS.md rule 4): one new table and its indexes. Re-runnable on a fresh database
-- after the baseline. Locked down for the Supabase API roles like 0001-0006.

create table if not exists public.notification_deliveries (
  id uuid not null default gen_random_uuid(),
  outbox_id uuid not null,
  incident_id uuid null,
  recipient_user_id uuid not null,
  channel text not null,
  device_id uuid null,
  provider_message_id text null,
  status text not null default 'queued',
  error_code text null,
  attempts integer not null default 0,
  preferences jsonb not null default '{}'::jsonb,
  queued_at timestamptz not null default now(),
  sent_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint notification_deliveries_pkey primary key (id),
  constraint notification_deliveries_outbox_id_fkey foreign key (outbox_id)
    references public.notification_outbox (id),
  constraint notification_deliveries_device_id_fkey foreign key (device_id)
    references public.user_devices (id) on delete cascade,
  constraint notification_deliveries_channel_check check (channel in ('push', 'sms', 'email')),
  constraint notification_deliveries_status_check
    check (status in ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  constraint notification_deliveries_device_channel_check
    check (device_id is null or channel = 'push'),
  constraint notification_deliveries_error_code_check
    check ((status in ('failed', 'skipped')) = (error_code is not null) or status = 'queued'),
  constraint notification_deliveries_attempts_check check (attempts >= 0),
  constraint notification_deliveries_preferences_check
    check (jsonb_typeof(preferences) = 'object')
);

comment on table public.notification_deliveries is
  'API-100-47: one row per recipient x channel x device of a notification_outbox row, with its outcome (queued, sent, delivered, failed, skipped). Written only by the API worker. Never holds a push token, phone number, email address or message text.';

-- Idempotent fan-out: one row per outbox row, recipient, channel and device (or none).
create unique index if not exists notification_deliveries_target_key
  on public.notification_deliveries (
    outbox_id, recipient_user_id, channel,
    coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- Spec §11.7: a user's deliveries over time (SCRUM-65/67).
create index if not exists notification_deliveries_recipient_idx
  on public.notification_deliveries (recipient_user_id, queued_at);

-- The deliveries of one incident (SCRUM-65 delivery confirmation).
create index if not exists notification_deliveries_incident_idx
  on public.notification_deliveries (incident_id, queued_at)
  where incident_id is not null;

alter table public.notification_deliveries enable row level security;

revoke all on table public.notification_deliveries from public;
revoke all on table public.notification_deliveries from anon;
revoke all on table public.notification_deliveries from authenticated;
