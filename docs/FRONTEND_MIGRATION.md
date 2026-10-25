# Moving the RFPIS frontend from Streamlit to React

Status: phase order approved by the owner (2026-10-24). **Phase 0 built, in review.**

## Progress

| Phase | State | Parity evidence |
|---|---|---|
| 0 Foundation | Built; on local `main` for review. Not deployed | `npm test`: 13 flow tests (login, forced change, links, reset requests, session re-checks, tenant switch, view-as, routing, jobs). `npm run parity`: permissions 47,064 cases, 0 differences; routing sets and the landing tenant of all 15 users, 0 differences; notification feed for all 6 tenants, 0 differences |
| 1 Home, Opportunity, rail | Not started | |
| 2 Pipelines | Not started | |
| 3 Grants, Actions, Submit | Not started | |
| 4 Donors (full), Search, Profile, Help, Organization | Donors read-only page live since PR #292 | Donors model: 190 donors, 0 differences |
| 5 Report | Not started | |
| 6 Settings | Accounts → Active tenant built (Phase 0) | |
| 7 Cut-over | — | |

Phase 0 still needs, outside the code:
- ~~Migration 099~~ applied 2026-10-25: `web_jobs` (no anon/authenticated access) and the
  private `web-job-files` bucket. A test job ran end to end through the local runner.
- **`RFPIS_GH_DISPATCH_TOKEN`**: a fine-grained GitHub token, limited to this repository with
  "Actions: read and write", set as an Edge Function secret. Without it the deployed API marks
  jobs "not configured"; locally the dev server runs jobs on the machine instead.
- After approval: push, deploy the function, and check the live API.

## Where we start

| Piece | Today |
|---|---|
| UI | Streamlit (`App.py`, `app_pages/`, `views/`, `core/app_header.py`), on Streamlit Community Cloud |
| React app | `web/`, React 19 + Vite + Tailwind + TypeScript. Read-only Donors page, live at https://rfpis.pages.dev (Cloudflare Pages, builds on every push to `main`) |
| API | One handler, `supabase/functions/_shared/rfpis_api.ts`, deployed as the Edge Function `rfpis-api`. Routes: `POST /login`, `GET /health`, `GET /me`, `GET /donors`, `GET /donors/:key/contacts`. Reads only |
| Heavy work | GitHub Actions: `scan.yml` (weekly scan: crawl, LLM, Playwright), `backup.yml` (weekly backup to OneDrive) |
| Database | Supabase Postgres. Migration 098 (applied 2026-10-23) closes the shared tables to `anon` and `authenticated` |

## Rules every phase follows

1. **Free tiers only.** Cloudflare Pages, Supabase Edge Functions, Supabase Storage (1 GB),
   GitHub Actions. The repository is public, so Actions minutes on standard runners are free.
   No paid hosting.
2. **The browser never talks to Supabase.** Every read and write goes through `rfpis-api`,
   which holds the service-role key. The browser's session token is signed with a key
   derived from the JWT secret, so it is never a valid PostgREST token. The legacy HS256 key
   stays in Supabase's verify set (the JWT Keys page lists it as "Previous"); revoking it
   breaks both apps.
3. **Same permissions as Python.** The API enforces `core/permissions.py`,
   `core/suggestions.py`, the tenant rules in `auth/tenant_context.py`, and the routing in
   `db/supabase_client.py`:
   - reads and writes on tenant tables go out with a short-lived tenant JWT, so RLS scopes them;
   - the service-only tables (`users`, `password_reset_requests`, `user_password_tokens`,
     `app_settings`, `tenant_settings`) and writes to the read-only shared tables
     (`donor_intel`, `donor_sources`, `source_registry`, `extracted_solicitations`,
     `scan_logs`, `scan_blacklist`) go to the service role, **after** the same permission
     check the Python page makes;
   - a super_user viewing another tenant reads through the service role, scoped to that
     tenant, as `_TenantScopedClient` does.
4. **Behaviour parity.** Same labels, same rules, same tenant scoping. Where a page has real
   logic, a comparison script runs the TypeScript (or browser) version and the Python
   version over the same live rows and diffs them (pattern: `web/scripts/compare-with-python.mjs`).
5. **Where work lands.** Each phase is built on a branch, then merged into local `main` in
   `D:\Apps\chai-rfpis` for review (`cd web; npm run dev`, http://localhost:5180). Nothing
   goes to GitHub until the owner has reviewed it and said so. The Edge Function is
   redeployed from `D:\Apps\chai-rfpis` after the change is approved and on `main`, then the
   live API is checked.
6. **Both apps run side by side** until the cut-over phase. They share the database and the
   accounts, so a user can move between them at any point.

## The three hard problems, and how each is solved

### 1. Live scoring (Pipelines, Opportunity, the opportunity rail, Records)

Screen, Review, Records and the rail re-score every row on every render:
`core/live_scoring.scores_for` → `core/assessment.assess_row` → `core/auto_scorer.auto_score`
→ `core/criteria_derive`, `core/matching`, `core/scorer`. That is about 6,500 lines of
Python over hundreds of rows. It will not fit an Edge Function's ~2 s of CPU, and porting
it to TypeScript by hand would take weeks and drift from the Python on every change.

**Plan: run the same Python in the browser with Pyodide (Python compiled to WebAssembly).**
- These modules are pure Python. Their only outside inputs are the tenant's policies, org
  profile, program-area settings, dropdowns and `donor_intel`, which they currently read
  through `core.settings` / `core.policies` / `core.donor_intel`.
- Every one of those lookups goes through `db.supabase_client.get_client()` (via
  `core/settings.py`, `core/donor_intel.py`, `core/user_program_areas.py`). In the browser,
  Pyodide gets a stand-in `db/supabase_client.py` whose client answers
  `.table(...).select(...).eq(...).execute()` from a snapshot the API serves (already
  RLS-scoped). No scoring module changes. The browser loads the `core/` files from the
  same commit, so the code that scores in React **is** the code that scores in Streamlit,
  and parity holds by construction.
- Cost: Pyodide plus pandas and PyYAML is about 12 MB, downloaded once and cached. Scoring
  runs in a Web Worker, so the page stays responsive.
- **Spike first** (start of Phase 1): load the scoring modules in Pyodide, score
  one week of rows, and diff against Python. If it fails (an import that can't load, or
  too slow on a modest laptop), fall back to **precomputed scores**: a GitHub Actions job
  writes `live_scores` after each scan, and after any save the API queues a re-score of
  that one row. Then the score after an edit takes about a minute to update, which is
  worse for Review.

The other logic (deadline status, buckets, KPIs, weighting) is small. It is ported to
TypeScript and covered by comparison scripts.

### 2. Heavy jobs → GitHub Actions

A new `web_jobs` table (migration 099) and one workflow, `.github/workflows/web-job.yml`
(`workflow_dispatch`, one input: the job id).

```
browser ── POST /jobs {kind, params} ──► rfpis-api
                                          │ 1. permission check (same gate as the Streamlit button)
                                          │ 2. insert web_jobs row (status=queued, tenant, user)
                                          │ 3. POST GitHub API workflow_dispatch(job_id)
browser ◄─ {job_id} ──────────────────────┘
browser ── GET /jobs/:id (poll every 5 s) ─► status, progress, message, result link
GitHub Actions: scripts/run_web_job.py <job_id>
   reads the row with the service key → runs the job → writes progress/result →
   files to a private Storage bucket → status=done|failed
```

- The GitHub token is a fine-grained PAT that can only dispatch workflows on this repo,
  stored as the Edge Function secret `RFPIS_GH_DISPATCH_TOKEN`.
- **The repo is public, so Actions logs are public.** Workflow inputs carry only the job
  id. The runner prints no tenant data, only counts and status. Results go to the database
  or to Storage, never to the log.
- Files (backup ZIPs, report PDFs, CSV exports too big to build in the API) go to a private
  Storage bucket. The API hands out a short-lived signed URL after a permission check.
- Concurrency: one running scan at a time (the same `rfp-scan` group as `scan.yml`); other
  job kinds are per tenant.
- A job takes about 1 to 2 minutes to start (runner boot plus `pip install`, cached), so the
  UI says "queued" and shows progress. It does not wait on a spinner.

| Streamlit action | Where it runs now | Where it runs after |
|---|---|---|
| Run Extraction (Settings → Manual Scan) | subprocess, 20–40 min | job `extract`: `run_scan.py --extract-only` |
| Eligibility Scan (Pipelines → Screen, Settings → Manual Scan) | in-process, LLM judge | job `screen`: screening for the caller's tenant |
| Excel Sync, workbook upload | subprocess over a local XLSX | upload to Storage, then job `excel_sync` |
| Excel auto-sync on Home load | subprocess on page load | dropped from page load; scheduled job instead |
| Backup ZIP, OneDrive upload | in-process | job `backup` (`backup.yml` logic) |
| Re-run dedup | in-process | job `dedup` |
| Report PDF (ReportLab or Chromium) | in-process | job `report_pdf`; the browser's "Print / save as PDF" stays as the instant option |
| Learning-data reason histogram | pages through every reject row | a Postgres function (SQL aggregate), called by the API |
| Web search (Search page) | 8 threads, Serper/Tavily/Exa | API (I/O-bound, fits the wall-clock limit). Page-signal fetches are capped and parallel |
| Super analytics per-tenant activity (2 queries per tenant) | in-process | a Postgres function |
| Report keyword cloud (WordCloud + matplotlib) | in-process | drawn in the browser |
| Report XLSX export (openpyxl) | in-process | built in the browser (SheetJS) |
| Weekly scan, weekly backup | GitHub Actions | unchanged |

### 3. Auth flows

All of them move into the API. Streamlit's cookie auth goes away with Streamlit.

| Flow | Streamlit | API / React |
|---|---|---|
| Sign in | `streamlit-authenticator`, bcrypt, refuses blacklisted and inactive accounts | `POST /login` already does this. **Adds:** writes `login_logs` (ip, user agent) and `users.last_login_at`, as `_record_login` does |
| Must change password | `_gate_must_change_password` blocks every page | `/login` returns a restricted token (`scope=change-password`). The only thing it can call is `POST /password/change` (current + new password, `core/password_policy` rules) |
| Activation (invite link, 7 days) and reset link (2 hours) | public pages `/activate-account`, `/password-reset`; `peek_token` / `consume_token` | public routes `GET /tokens/peek`, `POST /tokens/redeem`. The token is consumed **before** the hash is written, and the user is not signed in, matching Python. Email links point to the React pages after cut-over |
| Forgot password | public form queues `password_reset_requests` (no email, no enumeration) | `POST /password/reset-request`, same behaviour |
| Self sign-up | switched off (`_SIGNUP_ENABLED=False`) | stays off. Accounts are created by admins (Phase 5) |
| Tenant switcher | `set_active_tenant`, writes `users.last_tenant_id`, refuses non-members | `POST /session/tenant` re-checks membership, re-issues the session, writes `last_tenant_id` |
| super_user view-as | `?tenant=<slug>`, banner, "Return to my account" | `POST /session/view-as`. The session carries `view_tenant`; data calls for that tenant use the service role, scoped to it (the Python behaviour) |
| No tenant yet | `auth/tenant_onboarding` | onboarding page (Phase 5, with tenant management) |
| Session length | cookie, 8 hours | session token, 8 hours. `GET /me` re-checks the account on each load |
| Sign out | clears the cookie and session | drops the token |

**A parity bug to fix first.** Streamlit's permission checks read `users.role`; only the
tenant JWT's `user_role` claim uses the membership role. The API's session currently stores
the membership role as `role`. Phase 0 keeps both (`role` from `users`, `tenant_role` for
the JWT), and every permission check reads `role`.

## Phases

Order is by how much each page is used. Home, Pipelines and Opportunity are the daily
surfaces, so they come first. Settings is used by a few admins and comes last.
**This order is the owner's call.**

Every phase ends with: comparison scripts green, the owner reviewing on local `main`, then
(after approval) the push, the function deploy and a live check.

### Phase 0: Foundation (no new pages yet)

- **API structure.** Split `rfpis_api.ts` into modules: router, session, `db.ts`
  (`userGet/userWrite/serviceGet/serviceWrite` plus a port of the `_TenantScopedClient`
  routing tables, with a test that checks they match the Python sets and migration 098's
  arrays), `permissions.ts` (a port of `core/permissions.py`).
- **Writes**: `POST`/`PATCH`/`DELETE` support, JSON validation, a CSRF-safe design (bearer
  token only, no cookies).
- **Auth flows** from the table above: login logging, must-change-password, activation,
  reset links, reset requests, tenant switcher, view-as. Setting a password means a bcrypt
  hash at cost 12 inside the function. Measure it against the CPU limit first; comparing
  already works in `/login`.
- **App shell** matching `core/app_header.py`: the rail (Home, Pipelines, Grants, Actions,
  Report, Donors, plus Settings for admins), the top bar (search box, 🔔 notifications
  with unread count, 👤 menu: Help, Tenant, Profile, Settings, Sign out), breadcrumbs, org
  logo and name, view-as banner, footer version. Unbuilt pages show "open in the classic
  app" with a deep link to the Streamlit page.
- **Jobs**: migration 099 (`web_jobs` + Storage bucket), `web-job.yml`,
  `scripts/run_web_job.py`, `POST /jobs`, `GET /jobs/:id`. The first job kind is a no-op
  `ping`, to prove the loop end to end.
- **Parity**: `permissions.ts` vs `core/permissions.py` over every role × tenant-kind ×
  override combination. Auth-flow tests against a throwaway test user.

### Phase 1: Home, Opportunity, the opportunity rail

- Home: KPI tiles, quick-start cards (Settings card for admins), manual downloads.
- Opportunity (`/opportunity?uid=`): both parts, super_user provenance, Add to my pipeline
  / Not relevant (writes `rfp_submissions`, `rfp_seen`, `scan_decisions`).
- Rail: Featured, Top Matches, Top Funding, Also Interesting.
- Includes the **Pyodide spike** and the scoring seam, because the rail and Opportunity
  both score.
- Parity: KPI buckets, `opportunity_feed.classify`, `featured_score`, `deadline_status`,
  and the Opportunity decision aid vs `opportunity_scoring.analyse`, for every live uid.

### Phase 2: Pipelines (Screen, Review, Track, Summary) and the RFP editor

- Screen: week picker, filters, KPIs, the table with live scores; Eligibility Scan as the
  `screen` job.
- Review: criterion cards, the component editor, Bid Strength, Update Decision, feedback.
  Writes `criteria_component_overrides`, `decision_date`, `scan_decisions`, `rfp_seen`,
  and the org-profile write-through.
- Track: filters, next action from meeting notes, Apply.
- Summary: sections A–E and the charts.
- The shared RFP editor (seven tabs, about 60 columns, `score_submission`, the
  `applied_funding` upsert, admin-only Delete with tombstone).
- Parity traps carried over exactly, not "fixed": `score_submission` (70/45) on save vs
  the composite rule (90/70) for display, and `decision_date` as the "reviewed" flag.
- Parity: scores and decisions per row (Python vs Pyodide), the Track filter set, Summary
  aggregates, `records.*` helpers.

### Phase 3: Grants, Actions, Submit

- Grants: KPIs and win rate, the per-grant view, the editor, applications by funder.
- Actions: Meetings (notes, rota), Engagements, Pending, Schedule. Keeps the current split
  where the rota reads `meeting_schedule` but Schedule writes `app_settings.schedule_json`,
  and flags it to the owner rather than changing it silently.
- Submit: the five-section form, validation, `score_submission`, `generate_uid`,
  `review_week_label`.
- Parity: Grants buckets and balances, the pending-actions filters, uid and review-week labels.

### Phase 4: Donors (full), Search, Profile, Help, Organization

- **Donors, the rest of the page.**
  - Add donor: slug key from the name, with `_2`, `_3`… when the slug is taken.
  - Edit dialog, eight tabs: the flag matrix with its four-state requirements, the
    program-area matrix, typed multi-selects, funding tiers, past projects, contacts.
  - Save rules:
    - columns that no longer exist are dropped, with a warning;
    - answered requirements are stamped human-verified in `field_provenance`;
    - contacts are replaced (delete, then insert);
    - an unchecked box writes "no" only if the field was answered before.
  - Suggest mode (`suggestions.diff_of`, `create_suggestion`) and "Suggest donor".
  - Delete, one row or many.
  - Gates: `is_developer_super` to edit or delete, `suggestions.can_suggest` to suggest.
    Python checks the multi-row delete only in the UI; the API checks it on every call.
  - The ReportLab donor PDF stays replaced by the browser's print dialog, as in the proof
    of concept.
- **Search.** In-app results (pages, opportunities, donors) and web results
  (Serper/Tavily/Exa, called from the API with the keys server-side). 👍 / 😐 / 👎
  feedback and ➕ Track (the `provenance="search"` gate in `found_loader`). Navigation
  results are filtered by `is_admin`.
- **Profile.** My profile:
  - self-edit through the service role, filtered to the caller's own row;
  - case-insensitive email uniqueness;
  - program areas stored in `users.program`;
  - self-delete, blocked for the sole super_user.

  Also Change password (`core/password_policy`) and login history (the caller's last 12
  `login_logs` rows).
- **Help.** A static guide, with sections shown by role. The manual PDF/PPTX in
  `assets/help/` become static files on Pages.
- **Organization** (the Tenant page).
  - A read-only entity view with the profile-completeness bar and readiness gap
    (`core/profile_completeness.py`), and the opportunity rail.
  - "Edit tenant" opens the org setup editor (`views/org_setup.py`), which has four tabs:
    - Profile: identity, logo upload stored as base64, read-back check.
    - Bid Fitness: about 40 fields; the legal type and entity type limit each other.
    - Team Members.
    - Scan Preferences: countries, themes, criteria, search terms, currency, JSON;
      Reset criteria, Reset to defaults.
  - These writes use the service role in Python with no gate inside the view, so the API
    requires admin, and super_user to write to another tenant.
  - Ports `set_org`'s derived flags, `get_profile`'s deep-merge and key migration, and
    `_seed_geo_from_profile`.
- **Parity:** donor slug/dedup, `diff_of`, the four-state and checkbox mappings, profile
  completeness and RAG band, `set_org` derived flags, the policies round-trip (save in
  React, read in Python, compare).

### Phase 5: Report

The biggest single page (`views/report.py`, about 3,200 lines). It has its own phase.
- Controls: the period (this year, YTD, a month, last 90 days, last 12 months, all time),
  "view by", and the section and item picker (21 metric blocks in 5 sections).
- "Generate report" saves a snapshot to `report_snapshots_json` (newest 100 kept) and puts
  `?r=<id>` in the URL, so a report link reopens the same selection.
- Data: `scan_logs`, `rfp_submissions` (up to 50,000 rows), `meeting_logs`,
  `engagement_logs`, `applied_funding`, all read as the user.
- **Aggregation runs in the browser.** The API streams the rows (gzipped). The FX
  conversion, `_submitted_mask`, period and bucket bounds, programme-area frequency,
  headline summary and every section's numbers are ported to TypeScript. Charts are drawn
  client-side.
- The system-wide discovery panel (`analytics.system_discovery_stats`, which pages through
  up to 50,000 `scan_logs` rows) becomes a Postgres function.
- **Exports:**
  - XLSX: built in the browser (SheetJS), with the same sheets and columns as `openpyxl`.
  - PDF: the browser's print dialog right away (a print stylesheet). The job
    `report_pdf` (Chromium on Actions, the same `report_pdf.render_pdf`) is there for the
    pixel-matched version, and returns a Storage link.
  - The keyword cloud is drawn client-side.
- Parity: every section's numbers, React vs `views/report.py`'s helpers, for each period
  and grouping on live data, plus the XLSX sheet contents.

### Phase 6: Settings

- Accounts: Users (add with invite email, edit, access overrides, reset, delete,
  blacklist), Tenants (add/request, approval queue, bulk actions, view-as links),
  Blacklisted, Deployment (an API version of `env_diag`), Active tenant. The rules are
  `can_manage_user`, `assignable_roles` and `can_assign_override`; emails go through
  Resend from the API.
- Setup: year, org identity, eligibility policies, suspend my tenant.
- Records: Screened (the records table, live scores), Extracted, the four log tables,
  Verify, Backup & Reset (jobs), danger-zone deletes.
- Sources (developer tenants): catalogue, import, suggest, Verify Registry, Blocked.
- Manual Scan: Run Extraction, Eligibility Scan, Excel Sync (jobs), history.
- Learning data (SQL function), Suggestions inbox, Analytics.
- Tenant onboarding for a user with no tenant.
- Parity: the gate for every tab and action is checked against the Python gate for each
  role × developer/client tenant.

### Phase 7: Cut-over and switching Streamlit off

Streamlit can be switched off when all of these hold:
1. Every page and flow in the inventory has a React equivalent, and its comparison script passes.
2. The owner has used the React app for normal work for **two weeks** with Streamlit still
   running as a fallback, and has a list of nothing outstanding.
3. Email links point to React: the `app_public_url` setting, and `APP_PUBLIC_URL` in the
   Actions secrets, become `https://rfpis.pages.dev`; `/activate-account` and
   `/password-reset` resolve there.
4. Jobs that used the Streamlit process (anything still calling `core/scan_runner`
   in-process) run on Actions.
5. The owner signs off.

Then: put a "this app has moved" notice on the Streamlit app for two weeks, then turn off the
Streamlit Cloud app. The Python code stays: the scans, backups and jobs still run on it, and
the scoring engine runs in the browser through Pyodide. Remove the Streamlit-only modules
(`app_pages/`, `views/`, `core/app_header.py`, `auth/authenticator.py`) in a separate,
later clean-up.

## Parity evidence, per phase

- A comparison script per logic area under `web/scripts/parity/`. Each pulls live rows
  through the service key, runs the TypeScript (or Pyodide) version and the Python helper
  over them, and prints the mismatch count. It must be zero, or each difference is listed
  and explained.
- Permission tables: for each API route and each action button, the gate is tested against
  the Python function for every role and tenant kind.
- A per-phase checklist in this file. For every Streamlit section: built, parity script,
  owner-checked.

## Known items carried into this work

- `split-bundled-program-areas` (migrations 096/097) changes the program-area vocabulary.
  When it lands on `main`, rerun `python scripts/export_web_vocab.py` and the Donors parity
  check. New migrations from this work start at **099**.
- Supabase moved the project to ECC signing keys; the HS256 tenant JWTs work only because the
  legacy key is still in the verify set. The long-term fix (asymmetric keys, or a
  Postgres-side session) needs its own plan. It is not urgent.
- `scan_logs` reads are open to every authenticated user across tenants (see
  `docs/RLS_LOCKDOWN.md`). The API scopes them itself until a migration narrows the policy.
