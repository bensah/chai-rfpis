// End-to-end tests of the API's flows against an in-memory fake of PostgREST, so the write
// paths (password changes, token redemption, login logging, tenant switching) are exercised
// without touching the real database.
//
//   node --test scripts/api-flows.test.mjs        (from web/)
//
// The fake understands what the API sends: eq / is.null / in / lt / gt filters, select with
// a tenants(...) embed, order, limit, upsert on_conflict, Prefer count/representation. Every
// request is logged with the bearer it carried, so routing (tenant JWT vs service role) is
// asserted too.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const { createApi } = await import(pathToFileURL(path.join(root, "supabase/functions/_shared/rfpis_api.ts")).href);

const SERVICE_KEY = "service-key";
const SECRET = "test-jwt-secret-of-reasonable-length-0123456789";

// ── Fake PostgREST ───────────────────────────────────────────────────────────
function fakeDb(tables) {
  const log = [];
  const sent = [];   // emails the API handed to Resend
  function match(row, k, v) {
    const cell = row[k];
    if (v.startsWith("eq.")) return String(cell) === decodeURIComponent(v.slice(3)) || (cell === true && v === "eq.true");
    if (v === "is.null") return cell == null;
    if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(cell));
    if (v.startsWith("lt.")) return cell != null && String(cell) < v.slice(3);
    if (v.startsWith("gt.")) return cell != null && String(cell) > v.slice(3);
    throw new Error(`fake: unsupported filter ${k}=${v}`);
  }
  const RESERVED = new Set(["select", "order", "limit", "on_conflict", "or"]);
  // Column defaults the API relies on reading back, as the migrations declare them. Without
  // these an inserted row looks different here than in Postgres, and a filter on the default
  // value (status=eq.pending) matches nothing.
  const DEFAULTS = { password_reset_requests: { status: "pending" } };   // migration 016
  function filtered(rows, params) {
    return rows.filter((r) => [...params].every(([k, v]) => RESERVED.has(k) || match(r, k, v)));
  }
  function project(row, select) {
    const out = { ...row };
    const m = (select || "").match(/tenants\(([^)]*)\)/);
    if (m) {
      const t = (tables.tenants || []).find((x) => x.id === row.tenant_id);
      out.tenants = t ? Object.fromEntries(m[1].split(",").map((c) => [c, t[c]])) : null;
    }
    return out;
  }
  async function fetch(url, init = {}) {
    const u = new URL(url);
    // Outgoing mail (api/email.ts) goes to Resend, not PostgREST: capture it so a test can
    // assert what was sent, and to whom, without a network call.
    if (u.host === "api.resend.com") {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "fake-mail-id" }), { status: 200 });
    }
    if (!u.pathname.startsWith("/rest/v1/")) throw new Error(`fake: unexpected fetch ${url}`);
    const table = u.pathname.slice("/rest/v1/".length);
    const method = init.method || "GET";
    const headers = new Headers(init.headers);
    const bearer = (headers.get("authorization") || "").replace(/^Bearer /, "");
    let claims = null;
    if (bearer !== SERVICE_KEY) claims = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString());
    log.push({ method, table, params: Object.fromEntries(u.searchParams), service: bearer === SERVICE_KEY, claims });
    const rows = (tables[table] ??= []);
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (data, extra = {}) => new Response(JSON.stringify(data), { status: 200, headers: extra });
    if (method === "GET") {
      let out = filtered(rows, u.searchParams);
      const order = u.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(",")[0].split(".");
        out = [...out].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === "desc" ? -1 : 1));
      }
      const total = out.length;
      const limit = u.searchParams.get("limit");
      if (limit) out = out.slice(0, Number(limit));
      return reply(out.map((r) => project(r, u.searchParams.get("select"))), { "content-range": `0-${out.length}/${total}` });
    }
    if (method === "POST") {
      const items = Array.isArray(body) ? body : [body];
      const conflict = u.searchParams.get("on_conflict");
      const out = [];
      for (const it of items) {
        const existing = conflict && rows.find((r) => conflict.split(",").every((c) => r[c] === it[c]));
        if (existing) {
          Object.assign(existing, it);
          out.push(existing);
        } else {
          const r = { id: randomUUID(), ...(DEFAULTS[table] ?? {}), ...it };
          rows.push(r);
          out.push(r);
        }
      }
      return reply(out);
    }
    if (method === "PATCH") {
      const hit = filtered(rows, u.searchParams);
      hit.forEach((r) => Object.assign(r, body));
      return reply(hit);
    }
    if (method === "DELETE") {
      const hit = filtered(rows, u.searchParams);
      tables[table] = rows.filter((r) => !hit.includes(r));
      return reply(hit);
    }
    throw new Error(`fake: method ${method}`);
  }
  return { fetch, log, tables, sent };
}

// ── Fixture ──────────────────────────────────────────────────────────────────
const T1 = "11111111-1111-1111-1111-111111111111"; // client tenant A
const T2 = "22222222-2222-2222-2222-222222222222"; // client tenant B
const TP = "33333333-3333-3333-3333-333333333333"; // platform / developer tenant
const hash = (pw) => bcrypt.hashSync(pw, 4);

function fixture() {
  return {
    tenants: [
      { id: T1, name: "Alpha Org", slug: "alpha", status: "active", is_platform: false, is_developer: false, org_identity: {} },
      { id: T2, name: "Beta Org — Health", slug: "beta", status: "active", is_platform: false, is_developer: false,
        org_identity: { org_logo_b64: "AAAA", org_logo_mime: "image/png" } },
      { id: TP, name: "RFPIS", slug: "rfpis", status: "active", is_platform: true, is_developer: true, org_identity: {} },
    ],
    users: [
      { id: "u-admin", email: "admin@x.org", name: "Ada", role: "admin", is_active: true, is_blacklisted: false,
        must_change_password: false, password_hash: hash("correct horse 1"), last_tenant_id: T2 },
      { id: "u-super", email: "super@x.org", name: "Sam", role: "super_user", is_active: true, is_blacklisted: false,
        must_change_password: false, password_hash: hash("super pass 1") },
      { id: "u-new", email: "new@x.org", name: "Nia", role: "collaborator", is_active: true, is_blacklisted: false,
        must_change_password: true, password_hash: hash("temp pass 1") },
      { id: "u-off", email: "off@x.org", role: "collaborator", is_active: false, is_blacklisted: false, password_hash: hash("off pass 1") },
      { id: "u-bl", email: "bl@x.org", role: "collaborator", is_active: true, is_blacklisted: true, password_hash: hash("bl pass 1") },
      { id: "u-col", email: "col@x.org", role: "collaborator", is_active: true, is_blacklisted: false,
        must_change_password: false, password_hash: hash("col pass 1") },
    ],
    tenant_memberships: [
      { user_id: "u-admin", tenant_id: T1, role: "admin", status: "active" },
      { user_id: "u-admin", tenant_id: T2, role: "reviewer", status: "active" },
      { user_id: "u-super", tenant_id: TP, role: "super_user", status: "active" },
      { user_id: "u-super", tenant_id: T1, role: "collaborator", status: "active" },
      { user_id: "u-new", tenant_id: T1, role: "collaborator", status: "active" },
      { user_id: "u-col", tenant_id: T1, role: "collaborator", status: "active" },
    ],
    user_password_tokens: [],
    password_reset_requests: [],
    login_logs: [],
    app_settings: [
      { key: "app_public_url", value: "https://classic.example" },
      // mailer._from_name: what the named From header is built from.
      { key: "email_product_name", value: "CHAI RFPIS" },
    ],
    tenant_settings: [{ tenant_id: T1, key: "schedule_json",
      value: JSON.stringify([{ date: "2099-01-05", note_taker: "Ada", presenter: "", chair: "Sam" }, { date: "2001-01-01" }]) }],
    scan_logs: [
      { id: 1, scan_date: "2026-10-20T06:00:00+00:00", triggered_by: "cron", rfps_new: 3, rfps_found: 40, rfps_added: 2, tenant_id: null },
      { id: 2, scan_date: "2026-10-21T06:00:00+00:00", triggered_by: "manual", rfps_new: 1, rfps_found: 5, tenant_id: T2 },
    ],
    rfp_submissions: [
      { uid: "R1", opportunity_title: "Malaria call", source: "manual", search_date: "2026-10-22", submitted_by: "Ada", tenant_id: T1 },
      { uid: "R2", opportunity_title: "Auto call", source: "auto", search_date: "2026-10-23", tenant_id: T1 },
    ],
    web_jobs: [],
  };
}

function setup() {
  const db = fakeDb(fixture());
  globalThis.fetch = db.fetch;
  const dispatched = [];
  const api = createApi(
    {
      supabaseUrl: "https://fake.supabase.co", supabaseKey: SERVICE_KEY, jwtSecret: SECRET,
      resendApiKey: "re_fake", resendFrom: "no-reply@x.org", appPublicUrl: "https://app.example.org",
    },
    {
      bcryptCompare: (p, h) => bcrypt.compare(p, h),
      bcryptHash: (p) => bcrypt.hash(p, 4),
      dispatchJob: async (id, group) => void dispatched.push({ id, group }),
    },
  );
  async function call(method, route, body, token, headers = {}) {
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (body) h["content-type"] = "application/json";
    const r = await api.handle(new Request(`http://localhost/api${route}`, {
      method, headers: h, body: body ? JSON.stringify(body) : undefined,
    }));
    return { status: r.status, body: await r.json() };
  }
  const signIn = async (email, password) => (await call("POST", "/login", { email, password })).body;
  return { db, call, signIn, dispatched, sent: db.sent };
}

// ── Sign in ──────────────────────────────────────────────────────────────────
test("login: wrong password, unknown email and inactive account get the same answer", async () => {
  const { call } = setup();
  for (const [email, pw] of [["admin@x.org", "nope"], ["ghost@x.org", "x"], ["off@x.org", "off pass 1"]]) {
    const r = await call("POST", "/login", { email, password: pw });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "Username or password is incorrect.");
  }
});

test("login: blacklisted account is told it is blocked", async () => {
  const { call } = setup();
  const r = await call("POST", "/login", { email: "bl@x.org", password: "bl pass 1" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /blocked/);
});

test("login: success records the login and lands on the remembered tenant", async () => {
  const { call, db } = setup();
  const r = await call("POST", "/login", { email: "admin@x.org", password: "correct horse 1" },
    null, { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "TestUA" });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, "admin");               // the ACCOUNT role…
  assert.equal(r.body.user.tenant.id, T2);               // …last_tenant_id wins with 2 memberships
  assert.equal(r.body.user.tenantRole, "reviewer");      // …and the membership role is separate
  assert.equal(r.body.user.homeIsDeveloper, false);
  const log = db.tables.login_logs.at(-1);
  assert.deepEqual([log.user_id, log.ip, log.user_agent], ["u-admin", "203.0.113.9", "TestUA"]);
  assert.ok(db.tables.users.find((u) => u.id === "u-admin").last_login_at);
});

test("login: a super_user lands on the platform tenant", async () => {
  const { signIn } = setup();
  const s = await signIn("super@x.org", "super pass 1");
  assert.equal(s.user.tenant.id, TP);
  assert.equal(s.user.homeIsDeveloper, true);
});

// ── Must change password ─────────────────────────────────────────────────────
test("forced change: restricted token reads nothing, then the change opens the app", async () => {
  const { call, signIn, db } = setup();
  const s = await signIn("new@x.org", "temp pass 1");
  assert.equal(s.mustChangePassword, true);
  assert.equal((await call("GET", "/me", null, s.token)).status, 401);
  assert.equal((await call("GET", "/donors", null, s.token)).status, 401);

  let r = await call("POST", "/password/forced-change", { current: "same pass 1", password: "same pass 1", confirm: "x" }, s.token);
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.problems, ["Current password is incorrect.", "The two passwords do not match.",
    "New password must be different from the temporary one."]);
  r = await call("POST", "/password/forced-change", { current: "temp pass 1", password: "short", confirm: "short" }, s.token);
  assert.equal(r.status, 400);
  assert.ok(r.body.problems.some((p) => p.startsWith("Too short")));

  r = await call("POST", "/password/forced-change", { current: "temp pass 1", password: "brand new 22", confirm: "brand new 22" }, s.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.mustChangePassword, undefined);
  assert.equal(r.body.user.tenant.id, T1);
  const u = db.tables.users.find((x) => x.id === "u-new");
  assert.equal(u.must_change_password, false);
  assert.ok(await bcrypt.compare("brand new 22", u.password_hash));
  assert.equal((await call("GET", "/me", null, r.body.token)).status, 200);
  // An app token cannot use the forced-change route.
  assert.equal((await call("POST", "/password/forced-change", { current: "x" }, r.body.token)).status, 401);
});

// ── Setup / reset links ──────────────────────────────────────────────────────
function issueToken(db, userId, purpose, { expired = false } = {}) {
  const raw = randomUUID();
  db.tables.user_password_tokens.push({
    id: randomUUID(), user_id: userId, purpose, used_at: null,
    token_hash: createHash("sha256").update(raw).digest("hex"),
    expires_at: new Date(Date.now() + (expired ? -1 : 1) * 3600_000).toISOString(),
  });
  return raw;
}

test("tokens: peek, redeem once, and every other link retired", async () => {
  const { call, db } = setup();
  const other = issueToken(db, "u-col", "reset");
  const raw = issueToken(db, "u-col", "invite");
  let r = await call("POST", "/tokens/peek", { token: raw });
  assert.deepEqual([r.body.valid, r.body.purpose, r.body.email], [true, "invite", "col@x.org"]);

  r = await call("POST", "/tokens/redeem", { token: raw, password: "fresh pass 9", confirm: "different 9" });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.problems, ["The two passwords do not match."]);

  r = await call("POST", "/tokens/redeem", { token: raw, password: "fresh pass 9", confirm: "fresh pass 9" });
  assert.equal(r.status, 200);
  const u = db.tables.users.find((x) => x.id === "u-col");
  assert.ok(await bcrypt.compare("fresh pass 9", u.password_hash));
  assert.equal(u.must_change_password, false);
  for (const t of [raw, other]) {
    assert.equal((await call("POST", "/tokens/peek", { token: t })).body.valid, false);
  }
  r = await call("POST", "/tokens/redeem", { token: raw, password: "fresh pass 9", confirm: "fresh pass 9" });
  assert.equal(r.status, 400);
  assert.equal(r.body.invalid, true);
});

test("tokens: unknown and expired links get one answer", async () => {
  const { call, db } = setup();
  const expired = issueToken(db, "u-col", "reset", { expired: true });
  for (const t of ["nonsense", expired, ""]) {
    const r = await call("POST", "/tokens/peek", { token: t });
    assert.equal(r.body.valid, false);
    assert.match(r.body.error, /can only be used once/);
  }
});

test("reset request: validated, recorded, same answer for any address", async () => {
  const { call, db } = setup();
  assert.equal((await call("POST", "/password/reset-request", { email: "no-at-sign" })).status, 400);
  const a = await call("POST", "/password/reset-request", { email: " ghost@x.org " });
  const b = await call("POST", "/password/reset-request", { email: "admin@x.org" });
  assert.equal(a.status, 200);
  assert.equal(a.body.message, b.body.message);
  assert.deepEqual(db.tables.password_reset_requests.map((x) => x.email), ["ghost@x.org", "admin@x.org"]);
});

test("reset request: the link is sent at once, and only to an account that may use it", async () => {
  const { call, db, sent } = setup();
  // An account that exists and is usable: one mail, carrying a live token, and the request
  // row closed so Manage Users shows no queue the app has already answered itself.
  await call("POST", "/password/reset-request", { email: "admin@x.org" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["admin@x.org"]);
  const tokens = db.tables.user_password_tokens.filter((t) => t.user_id === "u-admin");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].purpose, "reset");
  assert.equal(tokens[0].created_by, "self-service");
  assert.equal(tokens[0].used_at, undefined);
  assert.ok(Date.parse(tokens[0].expires_at) > Date.now(), "the token is still live");
  assert.equal(db.tables.password_reset_requests[0].status, "handled");
  assert.equal(db.tables.password_reset_requests[0].handled_by, "self-service");
  // The token is in the email and nowhere else: only its hash is stored.
  const link = sent[0].html.match(/https:\/\/classic\.example\/password-reset\?token=([A-Za-z0-9_-]+)/);
  assert.ok(link, "the email links to the configured app_public_url, carrying the token");
  assert.equal(createHash("sha256").update(link[1]).digest("hex"), tokens[0].token_hash);
  // The From header is named, not a bare address (core/mailer.py::_from_header).
  assert.equal(sent[0].from, "CHAI RFPIS <no-reply@x.org>");
  assert.match(sent[0].subject, /^Change your CHAI RFPIS password$/);

  // Nobody else gets one: an unknown address, a deactivated account and a blacklisted one
  // must all look identical from outside, and none may re-open an account by asking.
  for (const email of ["ghost@x.org", "off@x.org", "bl@x.org"]) {
    const before = sent.length;
    const r = await call("POST", "/password/reset-request", { email });
    assert.equal(r.status, 200);
    assert.equal(sent.length, before, `${email} must not be emailed a reset link`);
  }
  assert.equal(db.tables.user_password_tokens.length, 1, "no token minted for those three");
  // Still recorded, so the audit trail of who asked survives.
  assert.deepEqual(db.tables.password_reset_requests.map((x) => x.email),
    ["admin@x.org", "ghost@x.org", "off@x.org", "bl@x.org"]);
});

test("reset request: with no mail configured it answers the same and mints nothing", async () => {
  // The Edge Function without RESEND_API_KEY. The person must not be able to tell, and a
  // token nobody can receive must not be left live on the account.
  const db = fakeDb(fixture());
  globalThis.fetch = db.fetch;
  const api = createApi(
    { supabaseUrl: "https://fake.supabase.co", supabaseKey: SERVICE_KEY, jwtSecret: SECRET },
    { bcryptCompare: (p, h) => bcrypt.compare(p, h), bcryptHash: (p) => bcrypt.hash(p, 4) },
  );
  const r = await api.handle(new Request("http://localhost/api/password/reset-request", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@x.org" }),
  }));
  const bodyJson = await r.json();
  assert.equal(r.status, 200);
  assert.match(bodyJson.message, /on its way/);
  assert.equal(db.sent.length, 0);
  assert.equal(db.tables.user_password_tokens.length, 0, "no token nobody can receive");
  assert.equal(db.tables.password_reset_requests[0].status, "pending", "left for an admin to action");
});

// ── Session checks ───────────────────────────────────────────────────────────
test("session: deactivation and a revoked membership end it on the next request", async () => {
  const { call, signIn, db } = setup();
  const s = await signIn("col@x.org", "col pass 1");
  assert.equal((await call("GET", "/me", null, s.token)).status, 200);
  db.tables.tenant_memberships.find((m) => m.user_id === "u-col").status = "removed";
  assert.equal((await call("GET", "/me", null, s.token)).status, 401);
  db.tables.tenant_memberships.find((m) => m.user_id === "u-col").status = "active";
  db.tables.users.find((u) => u.id === "u-col").is_active = false;
  assert.equal((await call("GET", "/me", null, s.token)).status, 401);
  assert.equal((await call("GET", "/me", null, "garbage.token.here")).status, 401);
});

test("tenant switch: members only, remembered, refused for a super_user", async () => {
  const { call, signIn, db } = setup();
  const s = await signIn("admin@x.org", "correct horse 1");
  assert.equal((await call("POST", "/session/tenant", { tenantId: TP }, s.token)).status, 403);
  const r = await call("POST", "/session/tenant", { tenantId: T1 }, s.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.tenant.id, T1);
  assert.equal(r.body.user.tenantRole, "admin");
  assert.equal(r.body.expiresAt, s.expiresAt);              // a switch does not extend the session
  assert.equal(db.tables.users.find((u) => u.id === "u-admin").last_tenant_id, T1);
  const sup = await signIn("super@x.org", "super pass 1");
  assert.equal((await call("POST", "/session/tenant", { tenantId: T1 }, sup.token)).status, 403);
});

test("view-as: super_user only; reads of the viewed tenant use the service role, scoped", async () => {
  const { call, signIn, db } = setup();
  const adm = await signIn("admin@x.org", "correct horse 1");
  assert.equal((await call("POST", "/session/view", { key: "alpha" }, adm.token)).status, 403);
  const sup = await signIn("super@x.org", "super pass 1");
  assert.equal((await call("POST", "/session/view", { key: "nope" }, sup.token)).status, 404);
  const v = await call("POST", "/session/view", { key: "beta" }, sup.token);
  assert.equal(v.body.user.view.id, T2);
  assert.equal(v.body.user.homeIsDeveloper, true);          // home tenant unchanged

  db.log.length = 0;
  const sh = await call("GET", "/shell", null, v.body.token);
  assert.equal(sh.body.org.name, "Beta Org — Health");
  const rfp = db.log.find((l) => l.table === "rfp_submissions");
  assert.equal(rfp.service, true);
  assert.equal(rfp.params.tenant_id, `eq.${T2}`);
  // Only the viewed tenant's own scan run and the system-wide one.
  assert.deepEqual(sh.body.feed.filter((f) => f.nav === "report").map((f) => f.title).sort(),
    ["Auto-scan completed", "Manual scan completed"]);

  const back = await call("POST", "/session/view", { key: null }, v.body.token);
  assert.equal(back.body.user.view, null);
});

// ── Routing and the shell ────────────────────────────────────────────────────
test("routing: tenant tables on the tenant JWT, scoped; locked tables on the service role", async () => {
  const { call, signIn, db } = setup();
  const s = await signIn("col@x.org", "col pass 1");
  db.log.length = 0;
  const sh = await call("GET", "/shell", null, s.token);
  const rfp = db.log.find((l) => l.table === "rfp_submissions");
  assert.equal(rfp.service, false);
  assert.equal(rfp.claims.tenant_id, T1);
  assert.equal(rfp.claims.role, "authenticated");
  assert.equal(rfp.params.tenant_id, `eq.${T1}`);
  const scans = db.log.find((l) => l.table === "scan_logs");
  assert.equal(scans.service, false);                       // read-only shared table: read as the user
  for (const t of ["users", "app_settings", "tenant_settings"]) {
    assert.ok(db.log.filter((l) => l.table === t).every((l) => l.service), `${t} must use the service role`);
  }
  // Feed: the auto-sourced row is folded into the scan line; the other tenant's run is hidden.
  assert.deepEqual(sh.body.feed.map((f) => f.title), ["New opportunity", "Auto-scan completed"]);
  assert.equal(sh.body.feed[0].detail, "Malaria call — Ada");
  assert.equal(sh.body.feed[1].detail, "2 new · 3 eligible · 40 found");
  assert.equal(sh.body.unread, 2);
  assert.equal(sh.body.nextMeeting.date, "2099-01-05");
  assert.equal(sh.body.classicUrl, "https://classic.example");

  const read = await call("POST", "/notifications/read", {}, s.token);
  assert.equal(read.status, 200);
  assert.equal((await call("GET", "/shell", null, s.token)).body.unread, 0);
});

// ── Jobs ─────────────────────────────────────────────────────────────────────
test("jobs: gated like the control that starts them; visible to the right people only", async () => {
  const { call, signIn, dispatched } = setup();
  const adm = await signIn("admin@x.org", "correct horse 1");
  assert.equal((await call("POST", "/jobs", { kind: "ping" }, adm.token)).status, 403);
  assert.equal((await call("POST", "/jobs", { kind: "rm-rf" }, adm.token)).status, 400);
  const sup = await signIn("super@x.org", "super pass 1");
  const r = await call("POST", "/jobs", { kind: "ping" }, sup.token);
  assert.equal(r.status, 202);
  assert.equal(r.body.job.status, "dispatched");
  assert.deepEqual(dispatched.map((d) => d.id), [r.body.job.id]);
  assert.equal((await call("GET", `/jobs/${r.body.job.id}`, null, sup.token)).status, 200);
  const col = await signIn("col@x.org", "col pass 1");
  assert.equal((await call("GET", `/jobs/${r.body.job.id}`, null, col.token)).status, 404);
});
