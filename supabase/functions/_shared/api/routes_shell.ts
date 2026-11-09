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

export function createShellRoutes(db: Db) {
  /** notifications.recent_feed for the session's effective tenant. */
  async function recentFeed(ctx: Ctx): Promise<FeedItem[]> {
    const sb = db.as(ctx.scope);
    const eff = db.scopeTid(ctx.scope);
    const [rawScans, rfps] = await Promise.all([
      sb.get("scan_logs", `select=*&order=scan_date.desc&limit=${12 * 4}`).catch(() => [] as Json[]),
      sb.get("rfp_submissions",
        "select=uid,opportunity_title,source,search_date,submitted_by," +
        "auto_recommendation,alignment_score,funding_agency,call_submission_deadline" +
        // 40, not 15: auto rows are now kept when the engine rated them Proceed or
        // Park, and a Friday scan can bury a week of manual entries in the first 15.
        "&order=search_date.desc&limit=40").catch(() => [] as Json[]),
    ]);
    const items: FeedItem[] = [];
    // System-wide runs (no tenant_id) show to everyone; a tenant's own screening run only to
    // that tenant. In multi-tenant mode a super_user is scoped like everyone else.
    const scans: Json[] = [];
    for (const s of rawScans) {
      const stid = s.tenant_id;
      if (!stid || String(stid) === eff) scans.push(s);
      if (scans.length >= 12) break;
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
      `select=value&tenant_id=eq.${q(tid)}&key=eq.schedule_json&limit=1`).catch(() => [] as Json[]);
    let items: Json[] = [];
    try {
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
    const rows = await db.service.get("tenants", `select=name,org_identity&id=eq.${q(tid)}&limit=1`)
      .catch(() => [] as Json[]);
    const ident = (rows[0]?.org_identity && typeof rows[0].org_identity === "object" ?
      rows[0].org_identity : {}) as Json;
    const name = String(rows[0]?.name || ident.org_name || ORG_DEFAULT_NAME);
    const b64 = String(ident.org_logo_b64 ?? "");
    return { name, logo: b64 ? { b64, mime: String(ident.org_logo_mime || "image/png") } : null };
  }

  async function shell(ctx: Ctx): Promise<Response> {
    const [feed, seen, meeting, org, urlRows] = await Promise.all([
      recentFeed(ctx).catch(() => [] as FeedItem[]),
      seenMap().catch(() => ({} as Record<string, string>)),
      nextMeeting(ctx),
      orgIdentity(ctx),
      db.service.get("app_settings", "select=value&key=eq.app_public_url&limit=1").catch(() => [] as Json[]),
    ]);
    const email = String(ctx.user.email ?? "");
    const seenTs = parseTs(seen[email]);
    const unread = email ? (seenTs == null ? feed.length : feed.filter((it) => it.ts > seenTs).length) : 0;
    return json({
      org, nextMeeting: meeting, feed, seen: seenTs, unread,
      classicUrl: String(urlRows[0]?.value ?? "").trim() || null,
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
