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
const { fromHeader } = await import(pathToFileURL(path.join(root, "supabase/functions/_shared/api/email.ts")).href);

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
    if (v === "not.is.null") return cell != null;
    // `is.true` / `is.false` are NOT `eq.`: in Postgres a NULL matches neither, so a row
    // whose flag was never set is excluded by both. /pipelines/track narrows on
    // `is_duplicate=is.false`, and treating NULL as false here would quietly widen it.
    if (v === "is.true" || v === "is.false") {
      const want = v === "is.true";
      if (typeof cell === "boolean") return cell === want;
      if (typeof cell === "string") return cell.trim().toLowerCase() === String(want);
      return false;
    }
    if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(cell));
    // gte/lte alongside gt/lt because the period routes window half-open — `gte.from` and
    // `lt.to` — so consecutive periods tile exactly. A fake that only knew `gt.` would
    // silently drop every row sitting on a window's first day.
    if (v.startsWith("gte.")) return cell != null && String(cell) >= v.slice(4);
    if (v.startsWith("lte.")) return cell != null && String(cell) <= v.slice(4);
    if (v.startsWith("lt.")) return cell != null && String(cell) < v.slice(3);
    if (v.startsWith("gt.")) return cell != null && String(cell) > v.slice(3);
    throw new Error(`fake: unsupported filter ${k}=${v}`);
  }
  const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "or"]);
  // Column defaults the API relies on reading back, as the migrations declare them. Without
  // these an inserted row looks different here than in Postgres, and a filter on the default
  // value (status=eq.pending) matches nothing.
  const DEFAULTS = {
    password_reset_requests: { status: "pending" },        // migration 016
    user_password_tokens: { attempts: 0 },                 // migration 100
  };
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
      // offset AND limit, both really applied. A fake that accepted `offset` and ignored
      // it would be worse than one that throws: every page of a paging loop would return
      // the whole set, the first page would look short enough to stop, and a broken
      // getAll would pass. `limit` is also capped at 1000 the way PostgREST caps it, so a
      // route that asks for more here gets what it would really get.
      const offset = Number(u.searchParams.get("offset")) || 0;
      if (offset) out = out.slice(offset);
      const limit = u.searchParams.get("limit");
      out = out.slice(0, Math.min(limit ? Number(limit) : 1000, 1000));
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
      // Two deliberately different strings, as the live deployment has them: a long name
      // for the From header, a tight one for the subject line.
      { key: "email_product_name", value: "CHAI RFP Intelligence System" },
      { key: "email_product_short_name", value: "CHAI RFPIS" },
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
  // The From header is named, not a bare address (core/mailer.py::_from_header), and the
  // subject uses the SHORT name — a different app_settings key, so the two can diverge.
  assert.equal(sent[0].from, "CHAI RFP Intelligence System <no-reply@x.org>");
  assert.equal(sent[0].subject, "Change your CHAI RFPIS password");

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

/** The six-digit code from the reset email, as the recipient reads it. */
const codeFrom = (html) => html.match(/>\s*(\d{6})\s*</)?.[1];

test("reset code: bound to one address, normalised, and burned by too many guesses", async () => {
  const { call, db, sent } = setup();
  await call("POST", "/password/reset-request", { email: "admin@x.org" });
  const code = codeFrom(sent[0].html);
  assert.ok(code, "the email carries a six-digit code");
  const tok = () => db.tables.user_password_tokens.find((t) => t.user_id === "u-admin");
  // Only the hash is stored — the code exists in the email and nowhere else.
  assert.equal(createHash("sha256").update(code).digest("hex"), tok().code_hash);

  // The right code against the WRONG account is simply wrong, not a way in.
  assert.equal((await call("POST", "/tokens/peek", { email: "col@x.org", code })).body.valid, false);
  // People space codes in threes; that is not a wrong code.
  const spaced = await call("POST", "/tokens/peek", { email: "admin@x.org", code: `${code.slice(0, 3)} ${code.slice(3)}` });
  assert.equal(spaced.body.valid, true);
  assert.equal(spaced.body.purpose, "reset");
  assert.equal(spaced.body.email, "admin@x.org");
  assert.equal(tok().used_at, undefined, "a check does not consume the credential");

  // Every check against THIS account is counted, the successful ones included.
  assert.equal(tok().attempts, 1);

  // Guessing burns it: once the limit is passed the credential is destroyed, not merely
  // refused, so an attacker who exhausts it loses the thing they were guessing at.
  for (let i = 0; i < 5; i++) await call("POST", "/tokens/peek", { email: "admin@x.org", code: "000001" });
  assert.ok(tok().used_at, "the token is burned once the attempt limit is passed");
  assert.equal((await call("POST", "/tokens/peek", { email: "admin@x.org", code })).body.valid, false,
    "the real code no longer works either");
});

test("reset code: a stranger cannot burn down someone else's credential by guessing", async () => {
  // Resolving the account from the email FIRST means a guess aimed at another address
  // never reaches this row's attempt counter. Without that, anyone who knew an address
  // could spend its five attempts and lock the holder out of their own reset — a denial
  // of service that needs no access to the mailbox at all.
  const { call, db, sent } = setup();
  await call("POST", "/password/reset-request", { email: "admin@x.org" });
  const code = codeFrom(sent[0].html);
  const tok = () => db.tables.user_password_tokens.find((t) => t.user_id === "u-admin");
  for (let i = 0; i < 20; i++) {
    await call("POST", "/tokens/peek", { email: "col@x.org", code: String(i).padStart(6, "0") });
  }
  assert.equal(tok().attempts, 0, "attempts aimed elsewhere never touched this account");
  assert.equal(tok().used_at, undefined, "and the credential is still live");
  assert.equal((await call("POST", "/tokens/peek", { email: "admin@x.org", code })).body.valid, true);
});

test("reset code: a mistyped confirmation must not cost an attempt", async () => {
  const { call, db, sent } = setup();
  await call("POST", "/password/reset-request", { email: "admin@x.org" });
  const code = codeFrom(sent[0].html);
  const attempts = () => db.tables.user_password_tokens.find((t) => t.user_id === "u-admin").attempts;
  const before = attempts();
  const r = await call("POST", "/tokens/redeem",
    { email: "admin@x.org", code, password: "new pass 1", confirm: "different 1" });
  assert.equal(r.status, 400);
  assert.equal(attempts(), before, "the password is checked before the credential is");

  // And the real thing still works afterwards.
  const ok = await call("POST", "/tokens/redeem",
    { email: "admin@x.org", code, password: "new pass 1", confirm: "new pass 1" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.email, "admin@x.org");
  assert.ok(db.tables.user_password_tokens.find((t) => t.user_id === "u-admin").used_at,
    "redeeming consumes it");
});

test("reset code: a deactivated or blacklisted account cannot be reopened by one", async () => {
  const { call, db } = setup();
  // Give both a live token with a known code, as though one had been issued earlier.
  for (const uid of ["u-off", "u-bl"]) {
    db.tables.user_password_tokens.push({
      id: `t-${uid}`, user_id: uid, purpose: "reset", attempts: 0,
      token_hash: "x", code_hash: createHash("sha256").update("123456").digest("hex"),
      expires_at: new Date(Date.now() + 3600_000).toISOString(), used_at: null,
    });
  }
  for (const email of ["off@x.org", "bl@x.org"]) {
    assert.equal((await call("POST", "/tokens/peek", { email, code: "123456" })).body.valid, false, email);
  }
});

test("From header: the cases email.utils.formataddr handles, and the two guards", () => {
  const addr = "no-reply@x.org";
  // The plain case, which is what goes out today.
  assert.equal(fromHeader(addr, "CHAI RFP Intelligence System"),
    "CHAI RFP Intelligence System <no-reply@x.org>");
  // A special in the name must be quoted, or the comma splits one address into two.
  assert.equal(fromHeader(addr, "Acme, Inc."), '"Acme, Inc." <no-reply@x.org>');
  assert.equal(fromHeader(addr, 'He said "hi"'), '"He said \\"hi\\"" <no-reply@x.org>');
  // A non-ASCII name must be RFC 2047 encoded, or the header is invalid.
  assert.equal(fromHeader(addr, "Zoë Ltd"), "=?utf-8?b?Wm/DqyBMdGQ=?= <no-reply@x.org>");
  // mailer._from_header's guards: naming an address twice produces an invalid header, and
  // a value that is not an address is passed through as configured rather than rewritten.
  assert.equal(fromHeader("Already Named <a@b.org>", "Ignored"), "Already Named <a@b.org>");
  assert.equal(fromHeader("not-an-address", "Some Name"), "not-an-address");
  // No name resolved: the bare address, not an empty display name.
  assert.equal(fromHeader(addr, ""), addr);
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

test("recording a decision stamps it and queues what the scan needs", async () => {
  const { call, signIn, db, dispatched } = setup();
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("POST", "/pipelines/decision",
    { uid: "R1", decision: "Decline", note: "Out of scope for us" }, col.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.row.decision, "Decline");
  assert.equal(r.body.row.decision_note, "Out of scope for us");
  assert.equal(r.body.row.decision_overridden_by, "col@x.org");
  // The flag the rest of the app reads as "a human has reviewed this". Date, not datetime.
  assert.match(r.body.row.decision_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(r.body.warnings, []);

  const jobs = db.tables.web_jobs.filter((j) => j.kind === "record_decision");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "dispatched");
  assert.deepEqual(jobs[0].params,
    { tenant_id: T1, uid: "R1", decision: "Decline", by: "col@x.org" });
  // Its own group, so a decision does not wait behind a whole-tenant re-score.
  assert.deepEqual(dispatched.map((d) => d.group), [`decision-${T1}`]);
});

test("a decision the app does not offer is refused, and named", async () => {
  const { call, signIn, db } = setup();
  const col = await signIn("col@x.org", "col pass 1");
  for (const decision of ["Maybe", "proceed", "", "Proceed as sub"]) {
    const r = await call("POST", "/pipelines/decision", { uid: "R1", decision }, col.token);
    assert.equal(r.status, 400, `${JSON.stringify(decision)} should be refused`);
    assert.deepEqual(r.body.allowed, ["Proceed", "Park", "Decline"]);
  }
  // Nothing was written and nothing was queued on the way to being refused.
  assert.equal(db.tables.web_jobs.length, 0);
  const unknown = await call("POST", "/pipelines/decision",
    { uid: "nope", decision: "Park" }, col.token);
  assert.equal(unknown.status, 404);
});

test("a decision on another tenant's row is a 404, not a 403", async () => {
  // Same rule the editor's save follows: a row that is missing and a row this tenant
  // cannot see answer alike, so the route cannot be used to discover that a uid exists.
  const { call, signIn, db } = setup();
  const adm = await signIn("admin@x.org", "correct horse 1");   // signs in to T2
  const r = await call("POST", "/pipelines/decision",
    { uid: "R1", decision: "Park" }, adm.token);                // R1 is T1's
  assert.equal(r.status, 404);
  assert.equal(db.tables.web_jobs.length, 0);
});

test("changing a verdict without a word does not keep the old rationale", async () => {
  const { call, signIn } = setup();
  const col = await signIn("col@x.org", "col pass 1");
  await call("POST", "/pipelines/decision",
    { uid: "R2", decision: "Proceed", note: "Strong fit" }, col.token);

  // Omitted: the reviewer is not touching the note.
  const kept = await call("POST", "/pipelines/decision",
    { uid: "R2", decision: "Park" }, col.token);
  assert.equal(kept.body.row.decision_note, "Strong fit");

  // Explicitly empty: they are clearing it, and a rationale for an abandoned verdict
  // must not be left standing under the new one.
  const cleared = await call("POST", "/pipelines/decision",
    { uid: "R2", decision: "Decline", note: "" }, col.token);
  assert.equal(cleared.body.row.decision_note, null);
});

test("Reviewed holds what a person decided, keyed on when they decided it", async () => {
  const { call, signIn } = setup();
  const col = await signIn("col@x.org", "col pass 1");
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);

  // Nothing is reviewed until somebody decides, even though both rows exist and are scored.
  const before = await call("GET", `/pipelines/reviewed?from=${today}&to=${tomorrow}`, null, col.token);
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.rows, []);

  await call("POST", "/pipelines/decision", { uid: "R1", decision: "Park" }, col.token);
  const after = await call("GET", `/pipelines/reviewed?from=${today}&to=${tomorrow}`, null, col.token);
  assert.deepEqual(after.body.rows.map((r) => r.uid), ["R1"]);
  assert.equal(after.body.rows[0].decision, "Park");
  assert.equal(after.body.rows[0].decision_date, today);

  // A window that ends before today excludes it: the stage files a call by the date the
  // decision was taken, which is the question "what did we decide this period" asks.
  const earlier = await call("GET", `/pipelines/reviewed?from=2020-01-01&to=2020-02-01`, null, col.token);
  assert.deepEqual(earlier.body.rows, []);
});

test("a migrated decision with no decision_date is still a decision", async () => {
  // The bug this route shipped with. 61 of the 83 decided rows on the live table have no
  // `decision_date` — the Excel migration carried the verdict and the rationale but never
  // a date — so requiring it showed 22 of 83 and looked broken. They are unmistakably
  // human: 32 disagree with the engine and 59 carry a written rationale.
  const { db, call, signIn } = setup();
  db.tables.rfp_submissions.push({
    uid: "OLD-1", tenant_id: T1, opportunity_title: "Migrated call", source: "migration",
    decision: "Proceed", decision_note: "Strong country fit — agreed in the May meeting",
    auto_recommendation: "Park", submitted_at: "2026-05-04T09:00:00+00:00",
    decision_date: null, decision_overridden_at: null,
  });
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("GET", "/pipelines/reviewed?from=2026-05-01&to=2026-06-01", null, col.token);
  assert.deepEqual(r.body.rows.map((x) => x.uid), ["OLD-1"]);
  // Filed under submitted_at, because that is the only date it has.
  assert.equal(r.body.rows[0].decided_on, "2026-05-04");
  assert.equal(r.body.undated, 0);
});

test("the date a decision counts under is the best one it has", async () => {
  const { db, call, signIn } = setup();
  // decision_date wins over both; decision_overridden_at wins over submitted_at.
  db.tables.rfp_submissions.push(
    { uid: "D-ALL", tenant_id: T1, decision: "Park", decision_date: "2026-03-02",
      decision_overridden_at: "2026-07-07T00:00:00+00:00", submitted_at: "2026-09-09T00:00:00+00:00" },
    { uid: "D-OVR", tenant_id: T1, decision: "Park", decision_date: null,
      decision_overridden_at: "2026-07-07T00:00:00+00:00", submitted_at: "2026-09-09T00:00:00+00:00" },
    { uid: "D-NONE", tenant_id: T1, decision: "Park", decision_date: null,
      decision_overridden_at: null, submitted_at: null },
  );
  const col = await signIn("col@x.org", "col pass 1");

  const year = await call("GET", "/pipelines/reviewed?from=2026-01-01&to=2027-01-01", null, col.token);
  const on = Object.fromEntries(year.body.rows.map((r) => [r.uid, r.decided_on]));
  assert.equal(on["D-ALL"], "2026-03-02", "decision_date wins");
  assert.equal(on["D-OVR"], "2026-07-07", "then the override stamp");

  // A row with no date at all is COUNTED, not dropped — dropping decisions is the bug.
  assert.equal(year.body.undated, 1);
  assert.ok(!year.body.rows.some((r) => r.uid === "D-NONE"));
  assert.equal(year.body.total, 3);
});

test("a tenant with more than 1000 decisions is counted in full", async () => {
  // PostgREST caps a response at 1000 rows and says nothing about the rest, so every read
  // whose result is counted has to page. Measured 2026-10-29: scan_decisions holds 5250
  // and extracted_solicitations 1546, both past the cap already; rfp_submissions is at 266
  // and will get there. The symptom is not a short list — it is a total that is wrong and
  // looks fine.
  const { db, call, signIn } = setup();
  for (let i = 0; i < 1500; i++) {
    db.tables.rfp_submissions.push({
      uid: `BULK-${String(i).padStart(5, "0")}`, tenant_id: T1,
      decision: i % 3 === 0 ? "Proceed" : i % 3 === 1 ? "Park" : "Decline",
      decision_date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}`,
    });
  }
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("GET", "/pipelines/reviewed?from=2026-06-01&to=2026-07-01", null, col.token);
  assert.equal(r.body.total, 1500, "every decision, not the first page of them");
  assert.equal(r.body.rows.length, 1500);
  // Distinct uids, so a paging loop that re-read page one would be caught too.
  assert.equal(new Set(r.body.rows.map((x) => x.uid)).size, 1500);
});

test("an empty window says where the decisions actually are", async () => {
  // Otherwise a stage whose data stops in September looks broken in late October, which is
  // exactly how this route's first version presented itself.
  const { db, call, signIn } = setup();
  db.tables.rfp_submissions.push({
    uid: "SEP-1", tenant_id: T1, decision: "Decline", decision_date: "2026-09-18",
  });
  const col = await signIn("col@x.org", "col pass 1");

  const empty = await call("GET", "/pipelines/reviewed?from=2026-10-26&to=2026-11-02", null, col.token);
  assert.deepEqual(empty.body.rows, []);
  assert.equal(empty.body.latest, "2026-09-18", "the page can offer to jump there");
  assert.equal(empty.body.total, 1);
});

test("the Reviewed window is half-open, so periods tile", async () => {
  // `to` is exclusive: a decision taken on the 1st belongs to the month starting the 1st
  // and not to the one ending there. Without this a decision on a boundary date is counted
  // in two periods, and the stage's numbers stop adding up to the year's.
  const { call, signIn } = setup();
  const col = await signIn("col@x.org", "col pass 1");
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  await call("POST", "/pipelines/decision", { uid: "R1", decision: "Proceed" }, col.token);

  const endingToday = await call("GET", `/pipelines/reviewed?from=2020-01-01&to=${today}`, null, col.token);
  assert.deepEqual(endingToday.body.rows, [], "`to` is exclusive");
  const startingToday = await call("GET", `/pipelines/reviewed?from=${today}&to=${tomorrow}`, null, col.token);
  assert.deepEqual(startingToday.body.rows.map((r) => r.uid), ["R1"], "`from` is inclusive");

  for (const bad of [`from=${today}&to=${today}`, "from=nope&to=2026-01-01", `from=${tomorrow}&to=${today}`]) {
    assert.equal((await call("GET", `/pipelines/reviewed?${bad}`, null, col.token)).status, 400);
  }
});

test("Bidding carries the columns its progress bar is made of", async () => {
  // TRACK_FIELDS is a projection, so a column the stage needs is absent rather than null
  // if nobody adds it — and an absent `stage` would draw every bid as "not started".
  const { db, call, signIn } = setup();
  const year = new Date().getUTCFullYear();
  db.tables.rfp_submissions.push({
    uid: "BID-1", tenant_id: T1, opportunity_title: "Open call", decision: "Proceed",
    is_duplicate: false, progress_status: "In Progress", donor_decision: "Not submitted",
    submitted_at: `${year}-03-01T00:00:00+00:00`, call_submission_deadline: "2099-01-01",
    stage: "Proposal development", applicant_role: "Prime", assigned_to: "Ama",
    next_action: "Draft the budget", action_deadline: "2099-01-05", proposal_lead: "Ada",
  });
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("GET", "/pipelines/track", null, col.token);
  const row = r.body.rows.find((x) => x.uid === "BID-1");
  assert.ok(row, "an active Proceed bid is in Track");
  for (const k of ["stage", "applicant_role", "assigned_to", "next_action", "action_deadline"]) {
    assert.ok(k in row, `${k} must be projected, not missing`);
  }
  assert.equal(row.stage, "Proposal development");
});

test("a bid leaves Bidding the moment it stops being live work", async () => {
  // The six rules are core/pipeline.py::is_active_proceed and belong to the route. Each
  // of these is a different way a bid stops being in flight, and each used to need a
  // person to notice; getting one wrong leaves finished work on the board forever.
  const year = new Date().getUTCFullYear();
  const base = {
    tenant_id: T1, decision: "Proceed", is_duplicate: false, progress_status: "In Progress",
    donor_decision: "Not submitted", submitted_at: `${year}-03-01T00:00:00+00:00`,
    call_submission_deadline: "2099-01-01",
  };
  const cases = [
    ["OUT-PARKED", { decision: "Park" }],
    ["OUT-DUP", { is_duplicate: true }],
    ["OUT-DONE", { progress_status: "Completed" }],
    ["OUT-STOPPED", { progress_status: "Discontinued" }],
    ["OUT-SUBMITTED", { donor_decision: "Under Review" }],
    ["OUT-LATE", { call_submission_deadline: "2020-01-01" }],
  ];
  const { db, call, signIn } = setup();
  db.tables.rfp_submissions.push({ uid: "IN-1", ...base });
  for (const [uid, over] of cases) db.tables.rfp_submissions.push({ uid, ...base, ...over });
  const col = await signIn("col@x.org", "col pass 1");

  const got = (await call("GET", "/pipelines/track", null, col.token)).body.rows.map((r) => r.uid);
  assert.deepEqual(got, ["IN-1"],
    `only the live bid belongs; got ${got.join(", ") || "nothing"}`);
});

test("a Proceed past its deadline is reported, not silently dropped", async () => {
  // Rule 6 removes 15 of the 16 Proceeds on the live table, so a stage that applied it
  // without a word would show one bid and look like a year of work had vanished. These
  // fail ONLY the deadline test — criteria_derive's needs_submission_check population.
  const { db, call, signIn } = setup();
  const year = new Date().getUTCFullYear();
  const base = {
    tenant_id: T1, decision: "Proceed", is_duplicate: false, progress_status: "Not Started",
    donor_decision: "Not submitted", submitted_at: `${year}-03-01T00:00:00+00:00`,
  };
  db.tables.rfp_submissions.push(
    { uid: "LIVE", ...base, call_submission_deadline: "2099-01-01" },
    { uid: "LATE", ...base, call_submission_deadline: "2020-01-01" },
    // Already answered or finished: these fail other rules too, so they are NOT a
    // question anybody needs to be asked.
    { uid: "LATE-ANSWERED", ...base, call_submission_deadline: "2020-01-01",
      donor_decision: "Approved" },
    { uid: "LATE-DONE", ...base, call_submission_deadline: "2020-01-01",
      progress_status: "Completed" },
    { uid: "LATE-DATED", ...base, call_submission_deadline: "2020-01-01",
      date_completed: "2020-01-05" },
  );
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("GET", "/pipelines/track", null, col.token);
  assert.deepEqual(r.body.rows.map((x) => x.uid), ["LIVE"]);
  assert.deepEqual(r.body.awaitingSubmission.map((x) => x.uid), ["LATE"],
    "only the one nobody has answered for");

  // Saying it went in takes it out of the question entirely.
  await call("PATCH", "/pipelines/rfp/LATE",
    { fields: { progress_status: "Completed" } }, col.token);
  const after = await call("GET", "/pipelines/track", null, col.token);
  assert.deepEqual(after.body.awaitingSubmission, []);
  assert.deepEqual(after.body.rows.map((x) => x.uid), ["LIVE"], "and not back into flight");
});

test("moving a bid's step is a plain save, and costs no re-score", async () => {
  // `stage` is on the workflow-only list, so the editor's save does not queue a job for
  // it. That is the whole reason the stepper can be clicked freely: it is a cheap write,
  // not a scoring event.
  const { db, call, signIn } = setup();
  const year = new Date().getUTCFullYear();
  db.tables.rfp_submissions.push({
    uid: "BID-2", tenant_id: T1, decision: "Proceed", is_duplicate: false,
    progress_status: "In Progress", donor_decision: "Not submitted",
    submitted_at: `${year}-03-01T00:00:00+00:00`, call_submission_deadline: "2099-01-01",
    stage: "Go/no-go decision & bid planning",
  });
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("PATCH", "/pipelines/rfp/BID-2",
    { fields: { stage: "Review, compliance check & approvals" } }, col.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.row.stage, "Review, compliance check & approvals");
  assert.equal(r.body.rescore, null, "a step change cannot move the score");
  assert.equal(db.tables.web_jobs.length, 0);

  // Including one of the two steps tracking_rfp.py's fallback list leaves out.
  const back = await call("PATCH", "/pipelines/rfp/BID-2",
    { fields: { stage: "Budgeting development" } }, col.token);
  assert.equal(back.body.row.stage, "Budgeting development",
    "a bid can go backwards; the record should say so");
});

test("saving an RFP queues the re-score that owns its score", async () => {
  // The wiring, not the rule: pipeline-writes.test.mjs decides WHICH saves re-score, and
  // this proves a save actually reaches the runner — through the same enqueue POST /jobs
  // uses, scoped to the right tenant.
  const { call, signIn, db, dispatched } = setup();
  // A collaborator, deliberately: anyone who can edit an RFP can cause a re-score of what
  // they edited, which is the same reach the edit itself has.
  const col = await signIn("col@x.org", "col pass 1");

  const r = await call("PATCH", "/pipelines/rfp/R1",
    { fields: { brief_description: "Now also covers drug resistance" } }, col.token);
  assert.equal(r.status, 200);
  assert.ok(r.body.rescore?.job_id, "the save tells the caller its score is being recomputed");
  assert.deepEqual(r.body.warnings, []);

  const jobs = db.tables.web_jobs.filter((j) => j.kind === "rescore");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "dispatched");
  assert.equal(jobs[0].params.uid, "R1", "one row, not the whole tenant");
  // Passed explicitly: the runner refuses a re-score it cannot scope, and scoring one
  // tenant's rows against another's profile is wrong in a way nothing downstream can see.
  assert.equal(jobs[0].params.tenant_id, T1);
  assert.deepEqual(dispatched.map((d) => d.group), [`rescore-${T1}`],
    "one group per tenant, so a save queued mid-run waits rather than racing it");

  // And a save that only records what the team is doing costs no run at all.
  const w = await call("PATCH", "/pipelines/rfp/R1",
    { fields: { assigned_to: "Ada", next_action: "Draft budget" } }, col.token);
  assert.equal(w.status, 200);
  assert.equal(w.body.rescore, null);
  assert.equal(db.tables.web_jobs.filter((j) => j.kind === "rescore").length, 1);
});
