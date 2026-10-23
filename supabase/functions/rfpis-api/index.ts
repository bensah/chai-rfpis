// Supabase Edge Function entry for the RFPIS web API (Deno). All logic lives in
// ../_shared/rfpis_api.ts, which the Vite dev server also runs locally.
//
// Deploy (free tier):
//   supabase secrets set RFPIS_JWT_SECRET=<Dashboard → Settings → JWT Keys → legacy secret>
//   supabase secrets set RFPIS_WEB_ORIGINS=https://<your-project>.pages.dev
//   supabase functions deploy rfpis-api --no-verify-jwt
//
// --no-verify-jwt: the browser sends its own RFPIS session token, which is deliberately NOT
// a Supabase JWT (see the header of _shared/rfpis_api.ts); the handler verifies it itself.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform. Custom secrets
// may not start with SUPABASE_, hence RFPIS_JWT_SECRET.
import bcrypt from "npm:bcryptjs@3.0.3";
import { createApi } from "../_shared/rfpis_api.ts";

const origins = (Deno.env.get("RFPIS_WEB_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const api = createApi(
  {
    supabaseUrl: Deno.env.get("SUPABASE_URL")!,
    supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    jwtSecret: Deno.env.get("RFPIS_JWT_SECRET")!,
    allowedOrigins: origins,
  },
  { bcryptCompare: (plain, hash) => bcrypt.compare(plain, hash) },
);

Deno.serve((req) => api.handle(req));
