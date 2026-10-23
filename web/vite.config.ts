import { fileURLToPath } from "node:url";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import bcrypt from "bcryptjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const apiModule = path.join(repoRoot, "supabase", "functions", "_shared", "rfpis_api.ts");

/**
 * Local stand-in for the Supabase Edge Function: serves /api/* from the SAME handler module
 * the function runs in production, using the Streamlit app's own `.env` (SUPABASE_URL,
 * SUPABASE_KEY, SUPABASE_JWT_SECRET) from the repo root. Nothing secret reaches the browser
 * bundle — only VITE_-prefixed variables from web/.env* are exposed to client code.
 */
function devApi(mode: string): Plugin {
  const envDir = process.env.RFPIS_ENV_DIR ?? repoRoot;
  return {
    name: "rfpis-dev-api",
    configureServer(server: ViteDevServer) {
      const e = loadEnv(mode, envDir, "");
      server.middlewares.use("/api", async (req, res) => {
        if (!e.SUPABASE_URL || !e.SUPABASE_KEY || !e.SUPABASE_JWT_SECRET) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `SUPABASE_URL, SUPABASE_KEY and SUPABASE_JWT_SECRET ` +
            `must be set in ${path.join(envDir, ".env")} (the Streamlit app's .env).` }));
          return;
        }
        const { createApi } = (await server.ssrLoadModule(apiModule)) as
          typeof import("../supabase/functions/_shared/rfpis_api");
        const api = createApi(
          { supabaseUrl: e.SUPABASE_URL, supabaseKey: e.SUPABASE_KEY, jwtSecret: e.SUPABASE_JWT_SECRET },
          { bcryptCompare: (plain, hash) => bcrypt.compare(plain, hash) },
        );
        const response = await api.handle(await toRequest(req));
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(", "));
  }
  // Connect strips the "/api" mount prefix from req.url; put it back for the router.
  const url = `http://${req.headers.host ?? "localhost"}/api${req.url ?? "/"}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), devApi(mode)],
  server: { port: 5180, strictPort: true },
  preview: { port: 5181, strictPort: true },
}));
