// Supabase Edge Function entry for the RFPIS web API (Deno). All logic lives in
// ../_shared/rfpis_api.ts, which the Vite dev server also runs locally.
//
// Deploy (free tier):
//   supabase secrets set RFPIS_JWT_SECRET=<Dashboard → Settings → JWT Keys → legacy secret>
//   supabase secrets set RFPIS_WEB_ORIGINS=https://<your-project>.pages.dev
//   supabase secrets set RFPIS_GH_DISPATCH_TOKEN=<fine-grained PAT: this repo, Actions: write>
//   supabase secrets set RESEND_API_KEY=<same key the Streamlit app uses>
//   supabase secrets set RESEND_FROM_EMAIL=<the verified sender, e.g. no-reply@example.org>
//   supabase functions deploy rfpis-api --no-verify-jwt
//
// Without RESEND_API_KEY and RESEND_FROM_EMAIL the API sends no mail, and the self-service
// password reset silently goes back to being a dead end. See _shared/api/email.ts.
//
// --no-verify-jwt: the browser sends its own RFPIS session token, which is deliberately NOT
// a Supabase JWT (see the header of _shared/rfpis_api.ts); the handler verifies it itself.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform. Custom secrets
// may not start with SUPABASE_, hence RFPIS_JWT_SECRET.
import bcrypt from "npm:bcryptjs@3.0.3";
import { createApi } from "../_shared/rfpis_api.ts";
import { githubDispatch } from "../_shared/api/routes_jobs.ts";

const origins = (Deno.env.get("RFPIS_WEB_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ghToken = Deno.env.get("RFPIS_GH_DISPATCH_TOKEN") ?? "";
// Renamed 2026-10-26 from rfp-intelligence-system. Git clones survive that on GitHub's
// redirect, which is why the old name went unnoticed for a while, but this default feeds
// the REST API for workflow_dispatch and a redirect is not something to rely on there.
const ghRepo = Deno.env.get("RFPIS_GH_REPO") ?? "bensah/chai-rfpis";

const api = createApi(
  {
    supabaseUrl: Deno.env.get("SUPABASE_URL")!,
    supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    jwtSecret: Deno.env.get("RFPIS_JWT_SECRET")!,
    allowedOrigins: origins,
    resendApiKey: Deno.env.get("RESEND_API_KEY") ?? "",
    resendFrom: Deno.env.get("RESEND_FROM_EMAIL") ?? "",
    appPublicUrl: Deno.env.get("APP_PUBLIC_URL") ?? "",
  },
  {
    bcryptCompare: (plain, hash) => bcrypt.compare(plain, hash),
    // Cost 12 = Python's bcrypt.gensalt() default, so both apps' hashes cost the same.
    bcryptHash: (plain) => bcrypt.hash(plain, 12),
    dispatchJob: ghToken ? githubDispatch(ghToken, ghRepo) : null,
  },
);

Deno.serve((req) => api.handle(req));
