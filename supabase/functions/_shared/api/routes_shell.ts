/**
 * Everything the app shell draws on every page (core/app_header.py): the tenant's identity
 * badge, the notification bell (core/notifications.py) and the next-call line
 * (core/schedule.next_meeting). One request, so the header costs one round trip.
 */
import { q, type Db } from "./db.ts";
import { json } from "./http.ts";
import type { Json } from "./jwt.ts";
import type { Ctx } from "./session.ts";

const SEEN_KEY = "notifications_seen";     // app_settings: {email: iso} of each "mark read"

const ORG_DEFAULT_NAME = "Your Organization";

/**
 * How far back the feed reads, EXPORTED because the parity harness needs the same numbers.
 *
 * `core/notifications.recent_feed` takes these as `limit_scans` / `limit_rfps`, and the two
 * sides must read the same window or the comparison turns into an argument about which rows
 * each one happened to see. They are named here, and check-shell.mjs passes them to the
 * Python half, so widening one window cannot silently leave the check comparing two
 * different slices of the table.
 */
export const SCAN_FEED_LIMIT = 12;
export const RFP_FEED_LIMIT = 40;

/** pandas.to_datetime(v, utc=True): a naive timestamp is UTC, a bare date is UTC midnight. */
export function parseTs(v: unknown): number | null {
  if (v == null || v === "") return null;
  let s = String(v).trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00Z";
  else if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** notifications.scan_icon_and_detail */
export function scanIconAndDetail(row: Json): [string, string] {
  if (row.errors) return ["⚠️", "completed with errors"];
  const eligible = Number(row.rfps_new || 0);
  const found = Number(row.rfps_found || 0);
  const added = row.rfps_added;
  if (added == null) return ["🔎", `${eligible} eligible · ${found} found`];
  return ["🔎", `${Math.trunc(Number(added))} new · ${eligible} eligible · ${found} found`];
}

/** date.fromisoformat on the first 10 characters: a real calendar date or nothing. */
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const SCAN_KIND: Record<string, string> = {
  cron: "Auto-scan", manual: "Manual scan", startup: "Startup scan", test: "Test scan",
};

export type FeedItem = {
  ts: number; icon: string; title: string; detail: string; nav: string; uid: string | null;
  /** What the Alerts screen shows when an item is opened. The bell stays a one-line
   *  summary; these are the facts somebody needs before deciding to act, and they come
   *  from the row we already read rather than a second fetch per alert. */
  kind: "scan" | "opportunity" | "verdict";
  facts?: { label: string; value: string }[];
};

/**
 * The placeholder `views/account_sections.py` falls back to when ADMIN_CONTACT_EMAIL is
 * unset. Kept identical so a deployment that has not configured it shows the same
 * obviously-unconfigured address in both apps, rather than one app inventing a plausible
 * one nobody reads.
 */
const ADMIN_CONTACT_FALLBACK = "admin@example.org";

export function createShellRoutes(db: Db, adminContactEmail?: string) {
  /** notifications.recent_feed for the session's effective tenant. */
  async function recentFeed(ctx: Ctx): Promise<FeedItem[]> {
    const sb = db.as(ctx.scope);
    const eff = db.scopeTid(ctx.scope);
    const [rawScans, rfps] = await Promise.all([
      // NEITHER READ IS CAUGHT HERE, deliberately. A feed built from one of its two
      // sources is the worst of the three outcomes: it looks complete, it is short by
      // whatever the broken half held, and nothing on the page can tell. `shell` catches
      // the whole part instead and reports the bell as unavailable.
      sb.get("scan_logs", `select=*&order=scan_date.desc&limit=${SCAN_FEED_LIMIT * 4}`),
      sb.get("rfp_submissions",
        "select=uid,opportunity_title,source,search_date,submitted_by," +
        "auto_recommendation,alignment_score,funding_agency,call_submission_deadline" +
        // 40, not 15: auto rows are now kept when the engine rated them Proceed or
        // Park, and a Friday scan can bury a week of manual entries in the first 15.
        `&order=search_date.desc&limit=${RFP_FEED_LIMIT}`),
    ]);
    const items: FeedItem[] = [];
    // System-wide runs (no tenant_id) show to everyone; a tenant's own screening run only to
    // that tenant. In multi-tenant mode a super_user is scoped like everyone else.
    const scans: Json[] = [];
    for (const s of rawScans) {
      const stid = s.tenant_id;
      if (!stid || String(stid) === eff) scans.push(s);
      if (scans.length >= SCAN_FEED_LIMIT) break;
    }
    for (const s of scans) {
      const [icon, detail] = scanIconAndDetail(s);
      const ts = parseTs(s.scan_date);
      if (ts == null) continue;
      items.push({ ts, icon, title: `${SCAN_KIND[String(s.triggered_by)] ?? "Scan"} completed`,
        detail, nav: "report", uid: null, kind: "scan",
        facts: [
          { label: "Run", value: SCAN_KIND[String(s.triggered_by)] ?? "Scan" },
          { label: "Found", value: String(s.rfps_found ?? "—") },
          { label: "Eligible", value: String(s.rfps_new ?? "—") },
          ...(s.rfps_added == null
            ? [] : [{ label: "Added", value: String(s.rfps_added) }]),
          ...(s.errors ? [{ label: "Errors", value: String(s.errors) }] : []),
        ],
      });
    }
    for (const r of rfps) {
      const auto = String(r.source ?? "").toLowerCase() === "auto";
      const ts = parseTs(r.search_date);
      if (ts == null) continue;
      const title = String(r.opportunity_title || "Untitled opportunity").trim();
      const who = String(r.submitted_by ?? "").trim();
      const uid = String(r.uid ?? "").trim() || null;
      const nav = uid ? "opportunity" : "pipelines";
      // THE VERDICT ITEMS ARE WHY auto ROWS ARE NO LONGER SKIPPED WHOLESALE.
      //
      // Every auto row used to be dropped here, and the reason was sound: a Friday scan
      // adds dozens at once and the scan_logs line above already says so, in one item
      // rather than forty. But it also meant the alert the owner most wanted - a new call
      // the system rates Proceed or Park - was the one thing the feed could not carry.
      //
      // So the flood is still suppressed and the verdicts are not: an auto row appears
      // only when the engine rated it Proceed or Park, which is a handful of a Friday,
      // and it says which rating so a reader can tell "look at this" from "we logged it".
      const verdict = String(r.auto_recommendation ?? "").trim().toLowerCase();
      const isProceed = verdict.startsWith("proceed");
      const isPark = verdict === "park";
      if (auto && !(isProceed || isPark)) continue;
      const score = r.alignment_score == null
        ? "—" : String(Math.round(Number(r.alignment_score)));
      if (auto) {
        items.push({
          ts, icon: isProceed ? "✅" : "🟡",
          title: isProceed ? "New Proceed call" : "New Park call",
          detail: [...title].slice(0, 64).join(""),
          nav, uid, kind: "verdict",
          facts: [
            { label: "Funder", value: String(r.funding_agency || "—") },
            { label: "System rating", value: isProceed ? "Proceed" : "Park" },
            { label: "Score", value: score },
            { label: "Deadline", value: String(r.call_submission_deadline || "—") },
          ],
        });
        continue;
      }
      items.push({
        ts, icon: "📥", title: "New opportunity",
        detail: [...title].slice(0, 64).join("") + (who ? ` — ${who}` : ""),
        nav, uid, kind: "opportunity",
        facts: [
          { label: "Funder", value: String(r.funding_agency || "—") },
          { label: "Added by", value: who || "—" },
          { label: "Deadline", value: String(r.call_submission_deadline || "—") },
        ],
      });
    }
    items.sort((a, b) => b.ts - a.ts);
    return items;
  }

  async function seenMap(): Promise<Record<string, string>> {
    const rows = await db.service.get("app_settings", `select=value&key=eq.${SEEN_KEY}&limit=1`);
    try {
      const m = JSON.parse(String(rows[0]?.value ?? "{}"));
      return m && typeof m === "object" ? m as Record<string, string> : {};
    } catch {
      return {};
    }
  }

  /** core/schedule.next_meeting, from the HOME tenant's schedule_json (tenant_settings). */
  async function nextMeeting(ctx: Ctx): Promise<Json | null> {
    const tid = ctx.session.tenant?.id;
    if (!tid) return null;
    const rows = await db.service.get("tenant_settings",
      `select=value&tenant_id=eq.${q(tid)}&key=eq.schedule_json&limit=1`);
    let items: Json[] = [];
    try {
      // A schedule that will not parse is a corrupt VALUE, which is genuinely "no next
      // meeting" — unlike a read that failed, which is now left to `shell` to report.
      items = JSON.parse(String(rows[0]?.value ?? "[]")) as Json[];
    } catch {
      return null;
    }
    const today = new Date().toISOString().slice(0, 10);
    // _clean: valid dates, first entry per date, ascending.
    const seen = new Set<string>();
    const clean = (Array.isArray(items) ? items : [])
      .map((it): Json => ({ ...it, date: String(it?.date ?? "").slice(0, 10) }))
      .filter((it) => isRealDate(String(it.date)) && !seen.has(String(it.date)) && !!seen.add(String(it.date)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const m = clean.find((it) => String(it.date) >= today);
    if (!m) return null;
    return { date: m.date, note_taker: m.note_taker ?? "", presenter: m.presenter ?? "", chair: m.chair ?? "" };
  }

  /** settings.get_org / get_org_logo for the tenant being shown. */
  async function orgIdentity(ctx: Ctx) {
    const tid = ctx.scope.viewTenantId || ctx.session.tenant?.id;
    if (!tid) return { name: ORG_DEFAULT_NAME, logo: null };
    const rows = await db.service.get("tenants", `select=name,org_identity&id=eq.${q(tid)}&limit=1`);
    const ident = (rows[0]?.org_identity && typeof rows[0].org_identity === "object" ?
      rows[0].org_identity : {}) as Json;
    const name = String(rows[0]?.name || ident.org_name || ORG_DEFAULT_NAME);
    const b64 = String(ident.org_logo_b64 ?? "");
    return { name, logo: b64 ? { b64, mime: String(ident.org_logo_mime || "image/png") } : null };
  }

  /**
   * Everything the chrome needs, in one request — plus whatever could not be read.
   *
   * THIS ROUTE MUST NOT FAIL THE WAY routes_phase1 NOW DOES, and the difference is what it
   * costs. The rail is one panel on one page, so a 502 there loses a panel and says so.
   * The shell is drawn on EVERY page: a 502 here is the whole app refusing to render
   * because the next-meeting line could not be fetched. So each part may fail on its own.
   *
   * What it must not do is what it used to: swallow the failure and serve the fallback as
   * the answer. A bell with no items reads "you have no notifications". A schedule that
   * could not be loaded reads "no meeting booked". A tenants row that could not be loaded
   * puts the placeholder "Your Organization" in the header of somebody's own app. Each is
   * a statement about the user's data, made at the one moment nobody had asked.
   *
   * `unavailable` names the parts that failed, so a page can say so where it would
   * otherwise draw an empty state. The reads INSIDE each part are no longer caught
   * separately: a feed missing only its scan rows is a harder lie to catch than a feed
   * that admits it could not be built at all.
   */
  async function shell(ctx: Ctx): Promise<Response> {
    const unavailable: string[] = [];
    const part = <T>(name: string, fallback: T, p: Promise<T>): Promise<T> =>
      p.catch((e) => {
        console.error(`shell: ${name} could not be read`, e);
        unavailable.push(name);
        return fallback;
      });

    const [feed, seen, meeting, org, urlRows] = await Promise.all([
      part<FeedItem[]>("feed", [], recentFeed(ctx)),
      part<Record<string, string> | null>("seen", null, seenMap()),
      part<Json | null>("meeting", null, nextMeeting(ctx)),
      part<{ name: string; logo: { b64: string; mime: string } | null }>(
        "org", { name: ORG_DEFAULT_NAME, logo: null }, orgIdentity(ctx)),
      part<Json[]>("classicUrl", [],
        db.service.get("app_settings", "select=value&key=eq.app_public_url&limit=1")),
    ]);
    const email = String(ctx.user.email ?? "");
    const seenTs = seen ? parseTs(seen[email]) : null;
    // NO BADGE ON A FAILED READ. A null `seen` legitimately means "has never marked
    // anything read", which counts every item as unread — so a seen map that could not be
    // read would put a full-count badge on the bell and present it as news. Unknown is 0,
    // and `unavailable` says why.
    const unread = !email || unavailable.includes("feed") || unavailable.includes("seen")
      ? 0
      : (seenTs == null ? feed.length : feed.filter((it) => it.ts > seenTs).length);
    return json({
      org, nextMeeting: meeting, feed, seen: seenTs, unread,
      classicUrl: String(urlRows[0]?.value ?? "").trim() || null,
      adminContactEmail: (adminContactEmail ?? "").trim() || ADMIN_CONTACT_FALLBACK,
      // WHETHER IT IS A REAL ADDRESS, said rather than left to be inferred. The
      // placeholder is deliberately obvious to a developer reading a config file and
      // completely opaque to a user reading a Help page — who would email it, and hear
      // nothing. A page that knows the difference can write "your administrator"
      // instead of printing a dead address, and the Deployment panel can say it needs
      // setting. Both apps keep the SAME fallback value; only the wording differs.
      adminContactConfigured: !!(adminContactEmail ?? "").trim(),
      unavailable,
    });
  }

  /** notifications.mark_all_read */
  async function markRead(ctx: Ctx): Promise<Response> {
    const email = String(ctx.user.email ?? "");
    const now = new Date().toISOString();
    const m = await seenMap();
    m[email] = now;
    await db.service.upsert("app_settings", { key: SEEN_KEY, value: JSON.stringify(m), updated_by: email }, "key");
    return json({ ok: true, seen: Date.parse(now) });
  }

  return { shell, markRead };
}
