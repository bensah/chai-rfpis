# RFPIS web — the React app

The React + Vite rebuild of the RFPIS frontend. It runs beside the Streamlit app, on the
same Supabase database and the same user accounts, and takes over page by page. The plan and
its progress are in [`docs/FRONTEND_MIGRATION.md`](../docs/FRONTEND_MIGRATION.md).

Built so far: the app shell (rail, top bar, notifications, user menu, breadcrumbs, view-as
banner), sign-in and every account flow, **Home**, **Opportunity** and the **live opportunity
feed**, the Donors page (read-only), and Settings → Accounts → Active tenant. Every other
page shows a link to the same page in the classic app.

## The scoring engine

Screening, the opportunity feed and the decision aid rest on about 6,500 lines of Python
that every RFPIS surface has to agree about. Re-implementing that in TypeScript would drift,
so the browser runs the repo's own `core/` modules under Pyodide, in a Web Worker
(`src/scoring/`). The code that scores here is the code that scores in Streamlit.

Only the data layer differs: `web/python/*_stub.py` replaces `db/supabase_client.py` and
`auth/tenant_context.py` with stand-ins that serve a snapshot the API has already fetched,
with this caller's permissions and tenant scope applied. No scoring module changes.

Booting costs a few seconds and the first score a few more, once per tab, so nothing waits
on it: a page renders from stored values and asks for the live numbers afterwards. The
engine starts as soon as a signed-in page mounts.

Two things to know:

- `scripts/build-py-bundle.mjs` packs `core/` and `config/` into `public/py/bundle.json`
  before dev and build. It is generated, not committed.
- `core/fx.py` converts non-USD amounts with a live rate it fetches over the network, which
  the browser cannot do. The API fetches the rates and the snapshot carries them; without
  that, scoring silently falls back to a stale static table. See `api/fx.ts`.

```
browser ──► Cloudflare Pages (static React build, free)
   │
   └──► Supabase Edge Function `rfpis-api` (free) ──► Supabase Postgres
                                   │
                                   └──► GitHub Actions `web-job.yml` (heavy work, free)
```

The browser **never** talks to Supabase directly. The app's `SUPABASE_KEY` is the
service-role key; the Edge Function holds it and enforces the same permissions as the Python
app before it reads or writes anything.

## The API

One handler, `supabase/functions/_shared/rfpis_api.ts`, over modules in `_shared/api/`:

| Module | Port of |
|---|---|
| `db.ts` | `db/supabase_client.py::get_client()` — tenant tables on a 5-minute tenant JWT (RLS applies) and filtered to the tenant; the tables migration 098 closed on the service role; a super_user's view-as on the service role, scoped to the viewed tenant |
| `tenants.ts` | `auth/tenant_context.py` — active memberships, default tenant, developer tenants, view-as lookup |
| `permissions.ts` | `core/permissions.py`, `core/suggestions.can_suggest`, `core/password_policy` |
| `session.ts` | browser sessions (8 hours, as the Streamlit cookie). Every request re-reads the account and re-checks the membership |
| `routes_auth.ts` | `auth/authenticator.py`, `core/password_tokens.py` |
| `routes_shell.ts` | `core/app_header.py` header data, `core/notifications.py` |
| `routes_jobs.ts` | background jobs on GitHub Actions |

| Route | What it does |
|---|---|
| `POST /login` | Streamlit's checks (active, not blacklisted, bcrypt), then records `login_logs` and `last_login_at`. A must-change-password account gets a restricted token that can only call `/password/forced-change` |
| `POST /password/forced-change` | `_gate_must_change_password` |
| `POST /tokens/peek`, `POST /tokens/redeem` | invite (7 days) and reset (2 hours) links: the token is burned before the password is written; nobody is signed in by a link |
| `POST /password/reset-request` | queues a request for an admin; same answer for any address |
| `GET /me` | the account, its memberships, and whether its home tenant is a developer tenant |
| `POST /session/tenant` | Settings → Accounts → Active tenant (members of more than one tenant; not super_users) |
| `POST /session/view` | a super_user's `?tenant=<slug>` view-as; `null` returns home |
| `GET /shell`, `POST /notifications/read` | org identity, notification feed and unread count, next call, the classic app's URL |
| `POST /jobs`, `GET /jobs/:id` | start a background job (gated like its Streamlit button) and poll it |
| `GET /donors`, `GET /donors/:key/contacts` | the donor catalogue; the caller's tenant's contacts |

The browser's session token is signed with a key *derived* from the JWT secret, so it is
never a valid Supabase token.

## Background jobs

Work that cannot fit an Edge Function (about 2 s of CPU per request) runs on GitHub Actions.
`POST /jobs` writes a `web_jobs` row (migration 099) and dispatches
`.github/workflows/web-job.yml` with the row's id; `scripts/run_web_job.py` does the work and
writes status, progress and the result back to the row. The repository is public, so the
Actions log is public: only the job id goes into it.

Locally, the Vite dev server runs the same runner script on your machine instead, so jobs
can be reviewed before the workflow is on GitHub.

## Run it locally

From the repo root, with the Streamlit `.env` in place (it needs `SUPABASE_URL`,
`SUPABASE_KEY`, `SUPABASE_JWT_SECRET`):

```bash
cd web
npm install
npm run dev
```

Then open http://localhost:5180 and sign in with your RFPIS account. In development the Vite
server answers `/api/*` with the same handler module the Edge Function runs.

## Checks

```bash
npm run typecheck
npm test          # every auth/session/job flow, against an in-memory fake of PostgREST
npm run parity    # TypeScript vs the Python originals, on the live data (read-only)
```

`npm run parity` runs:
- `check-permissions.mjs`: every permission function against `core/permissions.py`, over every
  role × developer-tenant × override combination;
- `check-routing.mjs`: the table routing sets against `db/supabase_client.py` and migration
  098, and every user's landing tenant against `auth/tenant_context.py`;
- `check-shell.mjs`: the notification feed against `core/notifications.recent_feed`, for every
  tenant;
- `check-scoring.mjs`: Home's counters against `app_pages/home.py`, and the rail and
  Opportunity page computed twice — through the browser's stand-ins over the API's snapshot,
  and through the real Supabase client — then diffed. This is what catches a snapshot that
  forgets a column: it found the rail losing `pursued_areas`, 28% of what Featured ranks by.

`scripts/compare-with-python.mjs` checks the Donors page's model the same way.

## Deploy (free tiers)

1. **API — Supabase Edge Function** (from `D:\Apps\chai-rfpis`, with the Supabase CLI):
   ```bash
   npx supabase@latest secrets set RFPIS_JWT_SECRET=<Settings → JWT Keys → legacy JWT secret>
   npx supabase@latest secrets set RFPIS_WEB_ORIGINS=https://rfpis.pages.dev
   npx supabase@latest secrets set RFPIS_GH_DISPATCH_TOKEN=<fine-grained token: this repo, Actions read & write>
   npx supabase@latest functions deploy rfpis-api --no-verify-jwt --use-api
   ```
   `--no-verify-jwt` is required: the function checks its own session tokens.
2. **Frontend — Cloudflare Pages**, connected to the GitHub repo:
   - root directory: `web`
   - build command: `npm run build`
   - output directory: `dist`
   - environment variable: `VITE_API_BASE=https://<project-ref>.supabase.co/functions/v1/rfpis-api`

   `public/_redirects` sends every path to `index.html`.

## Keeping it in step with Streamlit

- `src/donors/model.ts` ports the Donors page's rules. When `app_pages/donors.py` changes,
  change it too.
- `src/generated/vocab.json` holds the program-area taxonomy and geography lists. Regenerate
  it with `python scripts/export_web_vocab.py` whenever `core/program_area_classifier.py` or
  `core/geographies.py` changes.
- A new shared table needs adding to the sets in `supabase/functions/_shared/api/db.ts` as
  well as `db/supabase_client.py`; `check-routing.mjs` fails until both agree.
