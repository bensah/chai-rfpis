# Closing the shared tables (migration 098)

## The problem

`SUPABASE_KEY` is the service-role key, and migrations 023 and 066 gave every table a
`for all using (true) with check (true)` policy that applies to **every** Postgres role.
Migration 085 replaced that policy on the per-tenant tables. On the shared tables it is
still in place. So anyone with the anon (publishable) key, or any authenticated JWT, can
call PostgREST directly and:

- read every bcrypt `password_hash` in `users`
- list the email addresses in `password_reset_requests`
- rewrite `donor_intel`, `donor_sources`, the source catalogue and `app_settings`

Three tables were created later with no RLS at all: `scan_blacklist` (024),
`tenant_settings` (075) and `user_password_tokens` (093). Under Supabase's default grants
they are just as open.

The React proof of concept avoids this by reading through an Edge Function that holds the
service-role key. A future frontend that talks to the database from the browser would ship
the anon key and a user JWT, so these policies have to be tight before that can happen.

## Who reaches these tables today, and with which key

`get_client()` (db/supabase_client.py) decides the key:

| Context | What `get_client()` returns | Role PostgREST runs as |
|---|---|---|
| Before login, cron, scripts, single-tenant | `service_client()` | service_role (bypasses RLS) |
| Logged-in multi-tenant session | `_TenantScopedClient` over the session's tenant-JWT client | **authenticated** |
| super_user viewing another tenant | `_TenantScopedClient` over `service_client()` | service_role |

The `_TenantScopedClient` used to pass every shared table straight through to the JWT
client. So once a user was logged in, the shared-table queries ran as `authenticated`. The
most important case was `auth/authenticator.py::_load_credentials`, which reads every
user's `password_hash` on every rerun. Closing `users` to `authenticated` without moving
that query would have broken the app for anyone already logged in.

| Table | Readers / writers (app code) | Key before this change |
|---|---|---|
| `users` | `auth/authenticator.py` (credential cache, `_fetch_user`, `_record_login`, sign-up, forced password change) | get_client: service before login, **JWT after** |
| | `auth/authenticator.py` setup-token, `auth/tenant_context.py`, `core/password_tokens.py`, `core/suggestions.py`, `core/analytics.py`, most of `views/account_sections.py` | service_client |
| | `core/user_program_areas.py`, `views/account_sections.py::_fetch_self` (Profile, with the `sb` it is passed) | get_client → **JWT** |
| `password_reset_requests` | `auth/authenticator.py` (request form, pre-login); the reset queue in `views/account_sections.py` (Admin, through `sb = get_client()`) | get_client: service before login, **JWT** in Admin |
| `user_password_tokens` | `core/password_tokens.py` | service_client |
| `app_settings` | `core/settings.py` (get/set), `core/backup.py` (watermark) | get_client → **JWT** / service |
| `tenant_settings` | `core/settings.py` through `tenant_store()` | service_client |
| `donor_intel` | reads: `core/donor_intel.py`, `views/org_setup.py`, `views/tracking_rfp.py`, `app_pages/donors.py`; writes: `core/donor_enrich.py`; `core/suggestions.py` (service) | get_client → **JWT** |
| `donor_sources` | `app_pages/admin.py` (CRUD), `core/source_registry.py`, `core/site_search.py`; `core/suggestions.py` (service) | get_client → **JWT** |
| `source_registry` | `core/source_registry.py` (reads and writes) | get_client → **JWT** |
| `extracted_solicitations` | `core/extracted_store.py` (upsert, close); `app_pages/opportunity.py`, `views/opportunity_rail.py` (service) | get_client → **JWT** |
| `scan_logs` | `core/scan_pipeline.py` (insert), `app_pages/admin.py` (read, clear), `views/report.py`; `core/analytics.py` (service) | get_client → **JWT** |
| `scan_blacklist` | `core/blacklist.py` (read), `app_pages/admin.py` (replace), `views/rfp_records.py` (upsert) | get_client → **JWT** |
| `donor_source_seeds` | scripts only | service |
| `login_logs` | `auth/authenticator.py` (insert), `views/login_history.py` (read) | service_client |

`scripts/` run outside Streamlit, so `get_client()` is already the service client there.
Nothing calls `.rpc()`, no select embeds `users(...)` or the config tables, and no SQL view
or function reads these tables under the caller's role. `supabase/functions/rfpis-api` uses
`SUPABASE_SERVICE_ROLE_KEY`.

## The change

**Database (`db/migrations/098_rls_lockdown_shared_tables.sql`)**

| Tier | Tables | anon | authenticated | service_role |
|---|---|---|---|---|
| Service only | users, password_reset_requests, user_password_tokens, app_settings, tenant_settings | none | none | all |
| Read-only | donor_intel, donor_sources, donor_source_seeds, source_registry, extracted_solicitations, scan_logs, scan_blacklist | none | SELECT (all rows) | all |
| login_logs | login_logs | none | SELECT own rows (unchanged 084 policy) | all |

Each listed table has all of its policies dropped and the intended ones recreated, and its
grants are revoked and then given again, so re-running the file is safe. Migration 085's
tables, `tenants`, `tenant_memberships` and `resource_suggestions` are not touched.

**Code**

- `db/supabase_client.py`: `_SERVICE_ONLY_TABLES` and `_SERVICE_WRITE_TABLES` mirror the two
  tiers. `_TenantScopedClient.table()` sends a service-only table to `service_client()`. For
  a read-only table it returns `_ServiceWriteTable`, which keeps `select` on the session
  client and sends `insert`, `upsert`, `update` and `delete` to `service_client()`. None of
  these tables is tenant-scoped, so the routing changes which key answers, not which rows
  come back. Permission checks stay in the app (`core.permissions`), as they were under
  the open baseline.
- `auth/authenticator.py`: every `users` and `password_reset_requests` query now calls
  `service_client()` explicitly. These are identity operations, and most of them run before
  a tenant exists.
- `tests/test_rls_lockdown_routing.py`: checks the routing in a live session, and checks
  that the Python sets match the arrays in migration 098.

The code is correct with or without the migration, because the service role reaches these
tables either way. So the order is: deploy the code, then apply 098. To undo, run the
migration's ROLLBACK block. The code does not need reverting.

## Before applying 098

1. Deploy this code to every runtime first.
2. Confirm that `SUPABASE_KEY` is the service-role key everywhere:
   - the deployed app: Settings → Accounts → Deployment shows the key kind;
   - the GitHub Actions secret used by `scan.yml` and `backup.yml`. That workflow's header
     still allows an anon key, which would stop scan logging after 098;
   - local `.env`.
3. Run the two VERIFY queries at the bottom of the migration **before** applying it, and
   save their output. The live policies may differ from the repo. A comment in
   `views/account_sections.py` says an authenticated UPDATE on `users` is "silently
   blocked", which the 023 policy cannot do. The migration drops every policy on these
   tables, and its ROLLBACK block restores only the repo's baseline, so the snapshot is
   what lets you restore exactly.
4. `python scripts/migrate.py` applies **every** pending file, 098 included. Run it only
   after steps 1 to 3.
5. Run the VERIFY queries at the bottom of the migration. Then sign in as a regular user
   and as an admin, open Admin → Users and Settings, and edit one donor.

## Left for later

- `scan_logs` reads are still open to every authenticated user across tenants. Migration
  074 meant tenant rows to be visible only to that tenant (plus super_user). Scoping the
  SELECT policy would change what a super_user sees on their own-tenant JWT, so it needs
  its own change.
- The read-only tier allows every authenticated user to read every row. That is correct for
  the shared catalogue. A browser frontend may want narrower column sets (for example,
  hiding `donor_intel` provenance fields).
- Supabase's default privileges still grant new `public` tables to anon and authenticated.
  Each new table needs RLS and grants in its own migration, or the defaults need changing.
