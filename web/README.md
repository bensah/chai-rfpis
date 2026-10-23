# RFPIS web — React proof of concept

A React + Vite rebuild of the **Donors** page that runs beside the Streamlit app, on the
same Supabase database and the same user accounts. It is read-only: adding, editing,
suggesting and deleting donors still happen in Streamlit.

```
browser ──► Cloudflare Pages (static React build, free)
   │
   └──► Supabase Edge Function `rfpis-api` (free) ──► Supabase Postgres (unchanged)
```

The browser **never** talks to Supabase directly. The app's `SUPABASE_KEY` is the
service-role key, and several tables (including `users`) still have the permissive
`for all using (true)` policy from migration 023, so any key handed to a browser would
expose password hashes and allow writes. The Edge Function holds every secret and exposes
only these routes:

| Route | What it does |
|---|---|
| `POST /login` | Same checks as the Streamlit login: `users` row, `is_active`, not blacklisted, bcrypt. Picks the tenant the same way as `auth/tenant_context.py`. |
| `GET /me` | Re-checks the account and tenant membership on every app load. |
| `GET /donors` | `donor_intel`, ordered by name (gzipped, ~100 KB). |
| `GET /donors/:key/contacts` | `donor_contacts` for that donor. Row-level security limits it to the caller's tenant. |

All of them run on one handler, `supabase/functions/_shared/rfpis_api.ts`. Each database
call carries a fresh 5-minute tenant JWT, the same claims the Streamlit session client
mints. The browser's own session token is signed with a key *derived* from the JWT secret,
so it is not a valid Supabase token.

## Run it locally

From the repo root, with the Streamlit `.env` in place (it needs `SUPABASE_URL`,
`SUPABASE_KEY`, `SUPABASE_JWT_SECRET`):

```bash
cd web
npm install
npm run dev
```

Then open http://localhost:5180 and sign in with your RFPIS account. In development the Vite server
answers `/api/*` with the same handler module the Edge Function runs.

## Deploy (free tiers)

1. **API — Supabase Edge Function** (needs the [Supabase CLI](https://supabase.com/docs/guides/cli)):
   ```bash
   supabase login
   supabase link --project-ref <project-ref>
   supabase secrets set RFPIS_JWT_SECRET=<Settings → JWT Keys → legacy JWT secret>
   supabase secrets set RFPIS_WEB_ORIGINS=https://<your-site>.pages.dev
   supabase functions deploy rfpis-api --no-verify-jwt
   ```
   `--no-verify-jwt` is required: the function checks its own session tokens.
2. **Frontend — Cloudflare Pages**: connect the GitHub repo, then set
   - root directory: `web`
   - build command: `npm run build`
   - output directory: `dist`
   - environment variable: `VITE_API_BASE=https://<project-ref>.supabase.co/functions/v1/rfpis-api`

   `public/_redirects` sends every path to `index.html`.

## Keeping it in step with Streamlit

- `src/donors/model.ts` ports the Donors page's rules: labels, de-shouting, category
  normalisation, completeness and filters. When `app_pages/donors.py` changes, change it too.
- `src/generated/vocab.json` holds the program-area taxonomy and geography lists. Regenerate it
  with `python scripts/export_web_vocab.py` whenever `core/program_area_classifier.py` or
  `core/geographies.py` changes.
- `scripts/compare-with-python.mjs` checks parity. It runs the React model over saved donor
  rows and diffs it against the Python helpers. At the last check, completeness, categories,
  titles, every label and flag, and all program-area and geography filters matched on all
  190 donors.

## Not in this proof of concept

- Add / edit / suggest / delete donors (the buttons are shown, locked).
- ReportLab PDF export. "Print / save as PDF" uses the browser's print dialog instead.
- Sign-up, password reset, the must-change-password flow, the tenant switcher and
  login-history logging. Use the Streamlit app for these.
