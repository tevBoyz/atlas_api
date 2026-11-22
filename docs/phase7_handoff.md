# Phase 7 hand-off (Epic 100 API-100-60 to 62)

Notes for the coordinator and Dawit about Phase 7 (7.6 database changes, 7.7a the SendGrid adapter;
the single-switch runbook is `docs/runbook.md`, the parity sign-off `docs/parity_signoff.md`). Earlier Phase 7 stages (7.1 to 7.5)
are described in `docs/phase6_handoff.md` section 0 and in the decisions D37 to D41 (epic §18).

## 7.6 Retire the Supabase app paths (API-100-62, D42)

### What changed

Migration `db/migrations/0012_retire_supabase_app_paths.sql` (the only non-additive migration of
Epic 100). The mobile app uses no Supabase path since 7.3d-2; the API connects as the database
owner and is not affected.

| Path | Before (local = staging schema, 2026-11-22) | After 0012 |
|---|---|---|
| Table grants (PostgREST) | `anon`: ALL on `profiles`, `safety_circles`, `safety_circle_members`; `authenticated`: ALL on those three, SELECT + MAINTAIN on `app_config`, SELECT + UPDATE on `incident_deliveries`, SELECT on `incidents`, `incident_events` (54 grants) | none for `anon` / `authenticated` / PUBLIC |
| Function EXECUTE (RPC) | 8 functions for `anon`, 40 for `authenticated`, 5 trigger functions for PUBLIC (53 grants) | none for `anon` / `authenticated` / PUBLIC; the functions still exist (dropped in a later release, AC1) |
| Supabase Realtime | `supabase_realtime` has `public.incidents`, `public.incident_events` | neither (the publication stays) |
| Storage `avatars` | `avatars_select_public` (public read) + `avatars_insert_own`, `avatars_update_own`, `avatars_delete_own` (authenticated writes to own folder) | `avatars_select_public` only; the API's Storage service key is the only writer |

Not touched: RLS policies, functions, the `auth` schema, `service_role` grants, schema USAGE, default
privileges. The Supabase Auth settings (sign-ups off, custom access token hook off, providers off)
are changed in the Supabase project config, not by this migration (staging step 3 of the plan).

0012 first records everything it removes in `public.api_retired_supabase_access` (owner only, RLS on),
then revokes / removes / drops, then self-checks: if any privilege of those roles is left (for
example one granted by another role), it raises and the whole migration is rolled back.

### Apply on staging (needs Dawit's OK at that time)

From `api/`, with the staging connection string in `DATABASE_URL` (never written to a file in the
repo; `api/.env` already holds it):

```sh
npm run db:migrate -- --allow-remote
```

Expected output: `applied 0012_retire_supabase_app_paths`, `Applied 1 migration(s).` If Supabase
refuses `drop policy` on `storage.objects` (the `postgres` role must be allowed to manage those
policies, as it was when the baseline created them), the migration fails as a whole and changes
nothing: report it and stop.

### Read-only checks (before and after)

```sql
-- 1. Privileges of anon / authenticated / PUBLIC on public tables and functions (after: 0 rows).
select 'table' as kind, c.oid::regclass::text as object,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'public' and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
union all
select 'function', p.oid::regprocedure::text,
       case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, a.privilege_type
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where n.nspname = 'public'
   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass
                    and d.objid = p.oid and d.deptype = 'e')
   and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'));
-- Before: 107 rows (54 table, 53 function) on a database built from the baseline + 0001-0011.

-- 2. Realtime members (after: 0 rows; before: incidents, incident_events).
select tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'public';

-- 3. Storage policies (after: only avatars_select_public).
select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects';

-- 4. What 0012 recorded (after: 54 table_grant, 53 function_grant, 2 publication_member, 3 storage_policy).
select kind, count(*) from public.api_retired_supabase_access group by kind order by kind;
```

A Supabase-style call with the anon key (`/rest/v1/profiles`, `/rest/v1/rpc/...`) is now refused
(permission denied); the API keeps working (it is the owner).

### Rollback

`db/rollback/0012_down.sql` restores exactly what 0012 recorded (grants with their grant option,
publication members with any column list / row filter, the three Storage policies statement for
statement), drops the record table and removes 0012 from `api_schema_migrations`. One transaction;
a second run stops at its first check and changes nothing. Tested by
`test/int/rollback-0012.int-spec.ts` (snapshot before 0012 = snapshot after the rollback).

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/rollback/0012_down.sql
```

Then re-run the read-only checks: 107 privilege rows, both publication members, four Storage policies,
and `api_retired_supabase_access` gone.

### Tests

- Every suite except the two below runs on a template that, after the migrations, re-grants exactly
  the recorded table / column / function privileges (`test/support/test-harness-grants.ts`, "test
  harness only"), so the parity suites and integration files that call the old SQL functions as
  `authenticated` are unchanged (parity 267/267).
- `test/int/production-state.int-spec.ts` runs on the template frozen before that re-grant: no
  Supabase privileges, no Realtime members, no avatars write policy, Supabase-style calls refused
  (42501), and the API end to end (sign-up, profile, circle, invite + join, SOS, responder list,
  mark safe).
- `test/int/rollback-0012.int-spec.ts` runs on the template frozen before 0012.

## 7.7a SendGrid email adapter, off by default (D43)

### What changed

A real `EmailSender` for SendGrid (`SendGridEmailSender` in
`src/modules/notifications/channels/real-senders.ts`), chosen in `channel-senders.ts`. With the
default settings **nothing changes**: the email adapter stays the in-process fake. There is no
SendGrid account and no domain yet, so it is switched on nowhere (not on staging either).

Every email goes through the selected adapter: the three auth links of `AuthMessenger` (verification
after sign-up, magic link, password reset) and the notification emails of the delivery worker (incident notices use push only today, D26, so in practice only the
auth emails would go through SendGrid). `CHANNEL_EMAIL_ENABLED` still decides whether anything is
sent at all.

| Env name | Value | Notes |
| --- | --- | --- |
| `CHANNEL_EMAIL_ADAPTER` | `fake` (default) or `sendgrid` | `sendgrid` is refused at startup without the two keys below |
| `SENDGRID_API_KEY` | SECRET | a restricted key with the "Mail Send" permission only; host secret store only |
| `EMAIL_FROM_ADDRESS` | e.g. `no-reply@<your domain>` | must be on a domain authenticated in SendGrid (or a verified single sender) |
| `EMAIL_FROM_NAME` | optional, e.g. `Atlas` | at most 100 characters, no line breaks, `<`, `>` or quotes |
| `SENDGRID_API_BASE_URL` | leave empty | default `https://api.sendgrid.com`; only tests point it at a local fake server; production refuses a non-https URL |
| `CHANNEL_EMAIL_ENABLED` | `true` to send | production now accepts `true` only with `CHANNEL_EMAIL_ADAPTER=sendgrid` and its keys |
| `AUTH_TEST_MAILBOX_ENABLED` | `false` | still refused in production; it only ever shows what the FAKE adapter "sent", so with `sendgrid` it is empty |

What a send does: `POST https://api.sendgrid.com/v3/mail/send` with `Authorization: Bearer <key>`,
one recipient, the from address / name, the subject and one plain-text part. Click and open tracking
are switched off for every message (the links carry a single-use token and must not be rewritten).
202 → `sent` with SendGrid's `X-Message-Id` as `provider_message_id`; a 400 about the recipient →
`invalid_recipient`, other 4xx → `invalid_request` (both final, not retried); 401 / 403 → `auth_failed`,
429 → `rate_limited`, 5xx → `provider_unavailable`, network failure → `transport_error`, no answer in
`NOTIFICATIONS_SEND_TIMEOUT_MS` → `timeout` (retried by the worker for notification emails; for auth
emails the request has already answered, and the failure is logged as `auth email not sent` with the
kind and the code only). The key, addresses and email texts are never logged.

### Switching it on later (Dawit)

1. **SendGrid account.** Create it (any plan that allows API sending; check today's free-tier limits).
2. **Sender authentication** (SendGrid: Settings → Sender Authentication). Two options:
   - **Single Sender Verification**: SendGrid emails one address; you click to confirm it. Quick, good
     for a first test, but mail sent "from" an address on a domain you do not authenticate (for
     example a Gmail address) is often rejected or put in spam (DMARC). Not for production.
   - **Domain Authentication (recommended, needed for production)**: enter your domain (SendGrid can
     use a subdomain such as `em1234.<domain>` for the return path). SendGrid shows DNS records,
     normally three CNAMEs (return path and two DKIM keys `s1._domainkey`, `s2._domainkey`); add them
     at your DNS provider and press Verify (DNS can take minutes to hours). Also add a DMARC TXT record
     at `_dmarc.<domain>` (start with `v=DMARC1; p=none; rua=mailto:<your address>`) and, optionally,
     Link Branding. The from address is then any address on that domain, e.g. `no-reply@<domain>`.
3. **API key.** Settings → API Keys → Create → **Restricted Access**, "Mail Send" only. Copy it once
   into the host's secret store (or `api/.env` on the laptop) as `SENDGRID_API_KEY`. Never paste it
   in a chat, a ticket or the repo.
4. **Settings** (API host, then restart the API and the worker): `CHANNEL_EMAIL_ADAPTER=sendgrid`,
   `SENDGRID_API_KEY`, `EMAIL_FROM_ADDRESS=no-reply@<domain>`, `EMAIL_FROM_NAME=Atlas`,
   `CHANNEL_EMAIL_ENABLED=true`, `AUTH_TEST_MAILBOX_ENABLED=false`; leave `SENDGRID_API_BASE_URL` empty.
5. **Check.** The startup log line `notification channels` shows `mail=sendgrid`. Sign up with your
   own address: the "Confirm your Atlas account" email arrives (SendGrid Activity Feed shows it as
   delivered). A failure shows in the API log as `auth email not sent` with an `error_code`
   (`auth_failed` = wrong key; `invalid_request` = usually the from address is not authenticated).
6. **Back to the fake** at any time: `CHANNEL_EMAIL_ADAPTER=fake` (or `CHANNEL_EMAIL_ENABLED=false`) and
   restart. Nothing is stored about the adapter.

**Staging note:** the staging smoke guide and the phone tests read links from the test mailbox or the
API log. With `sendgrid` the mailbox is empty, so keep staging on the fake for those runs, or read the
links from the real inbox.

### The links (gap 14, not built yet)

The emails still carry `AUTH_LINK_BASE=io.supabase.atlasmobile://login-callback/?type=...&token=...`
(the prototype scheme; it only opens the app, which then calls the API). **Many mail apps (for example
Gmail) do not make a custom-scheme link clickable in a plain-text email**, so real email is only
convenient once gap 14 is built: https App Links on Dawit's domain (decided 2026-11-22), e.g.
`AUTH_LINK_BASE=https://<domain>/auth/callback` and `INVITE_URL_BASE=https://<domain>/invite/`, with
`/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` hosted on the domain, an
Android intent filter with `autoVerify`, iOS Associated Domains, the app's link parser for https, a
store redirect when the app is not installed, and the old scheme accepted for a while. That work
needs the same domain as SendGrid and a mobile change; it is a later stage (see the runbook's going
live checklist, `docs/runbook.md`).

### Tests

- Unit (`channels.spec.ts`): the request (URL, Bearer header, JSON body, tracking off), every answer
  class, timeouts and network errors, nothing secret in a result; which adapter `ChannelSenders`
  builds. Config (`channel-config.spec.ts`): `sendgrid` needs the key and the sender, field formats,
  the production rules (fake + enabled refused, sendgrid + keys allowed, non-https refused, test
  mailbox refused).
- Integration (`test/int/email-sendgrid.int-spec.ts`): a local fake SendGrid HTTP server and the real
  fetch transport: 202 → sent + message id; 400 → permanent; 401, 429, 500 → retried codes; a slow
  answer → `timeout`; a closed port → `transport_error`; sign-up, magic link and reset emails reach
  the fake SendGrid (and a sign-up link from it verifies the account); a SendGrid 500 never fails the
  sign-up; a notification email retried 429 → 500 → 202 ends `sent` with the message id; a 400 ends
  `failed` after one attempt; no key or address in any log. No test reaches the real SendGrid.
