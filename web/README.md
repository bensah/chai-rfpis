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

**Both halves deploy themselves on a push to `main`.** Nothing below needs running by hand
for an ordinary change.

| Half | Deployed by | On | From |
|---|---|---|---|
| Frontend | Cloudflare Pages, connected to the GitHub repo | every push to `main` | `web/`, `npm run build`, output `dist` |
| API — Edge Function `rfpis-api` | GitHub Actions, [`.github/workflows/deploy-api.yml`](../.github/workflows/deploy-api.yml) | a push to `main` that touches `supabase/functions/**` | `npx --yes supabase@latest functions deploy rfpis-api --no-verify-jwt --use-api --yes` |

The API half used to be the manual one, and that asymmetry is what broke the live site on
2026-11-09: the function was several commits behind the frontend, so the rail asked for a
route it did not have and Home asked for a `/home` contract it did not serve. Every tile
read "—" and the funnel read `NaN` — a page that looks like lost data rather than an old
API. The workflow exists to stop that recurring; its header explains the path list and why
it stays faster than the Pages build.

### One-time setup

Three secrets on the **Supabase project**, set once with the CLI from `D:\Apps\chai-rfpis`.
These are the function's own runtime secrets; CI never reads or rewrites them, and a deploy
leaves them alone.

```bash
npx supabase@latest secrets set RFPIS_JWT_SECRET=<Settings → JWT Keys → legacy JWT secret>
npx supabase@latest secrets set RFPIS_WEB_ORIGINS=https://rfpis.pages.dev
npx supabase@latest secrets set RFPIS_GH_DISPATCH_TOKEN=<fine-grained token: this repo, Actions read & write>
```

One secret on **GitHub**, which the deploy workflow authenticates with. Without it the
workflow fails on its first step with these instructions rather than half-deploying:

- **`SUPABASE_ACCESS_TOKEN`** — a Supabase personal access token from
  <https://supabase.com/dashboard/account/tokens>, added at GitHub → this repo → Settings →
  Secrets and variables → Actions → New **repository** secret. Scope the token to the RFPIS
  project alone (Resource access → Project), then drop the "Full access" preset and set
  every permission to None except **Application services → Edge Functions: Read-write** and
  **Project → Project Settings: Read**. Leaving *Edge Function Secrets* at None is what
  makes "CI does not touch the function's secrets" true of the token and not just of the
  workflow; leaving *API Key Secrets* and the whole *Database* category at None keeps the
  service-role key and the migration surface away from a public repo's CI.
  Give it the longest expiry offered: the dashboard defaults to 7 days, and an expired
  token stops API deploys while Cloudflare keeps shipping the frontend, which is the drift
  this workflow exists to prevent.

One setting on **Cloudflare Pages**, in its own dashboard:
`VITE_API_BASE=https://<project-ref>.supabase.co/functions/v1/rfpis-api`.
`public/_redirects` sends every path to `index.html`.

### Deploying the API by hand

Still possible, and still the way to put a function change on the project without a push to
`main` — testing a branch against the real project, or recovering when the workflow itself
cannot run.

**Not from `D:\Apps\chai-rfpis`.** The CLI uploads the files in the checkout you run it
from, not a git ref. That tree runs well ahead of `origin/main` and is reliably dirty with
several sessions' work, so a deploy from there publishes every unreviewed commit — and
anything uncommitted — straight to production. To recover the live site, deploy the ref the
live frontend was actually built from, in a throwaway checkout:

```bash
git worktree add --detach .claude/worktrees/deploy-origin-main origin/main
```

```bash
cd .claude/worktrees/deploy-origin-main && npx --yes supabase@latest functions deploy rfpis-api --remote=hbpsoslcrasvakbxwkns --no-verify-jwt --use-api --yes
```

```bash
cd D:/Apps/chai-rfpis && git worktree remove .claude/worktrees/deploy-origin-main --force
```

`--remote=<ref>` needs the equals sign, and the throwaway checkout needs the flag at all:
it is not linked to a project the way your main checkout is. To deploy a *branch* rather
than recover, run the same command in that branch's own worktree.

Both `--yes` are required whenever nothing is attached to a terminal — and that includes an
agent running this for you, not just CI. CLI 3.1.0 asks "Confirmation required: Deploy 1
Function", finds it cannot ask, and exits having changed nothing. The first CI run of
`deploy-api.yml` failed exactly there while Cloudflare shipped the frontend regardless.

`--no-verify-jwt` is required, in CI and here: the function checks its own session tokens,
which are deliberately not Supabase JWTs. With Supabase's gate in front, every request is
rejected before the handler sees it.

## Keeping it in step with Streamlit

- `src/donors/model.ts` ports the Donors page's rules. When `app_pages/donors.py` changes,
  change it too.
- `src/generated/vocab.json` holds the program-area taxonomy and geography lists. Regenerate
  it with `python scripts/export_web_vocab.py` whenever `core/program_area_classifier.py` or
  `core/geographies.py` changes.
- A new shared table needs adding to the sets in `supabase/functions/_shared/api/db.ts` as
  well as `db/supabase_client.py`; `check-routing.mjs` fails until both agree.
