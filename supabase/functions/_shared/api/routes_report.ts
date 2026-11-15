/**
 * Report (views/report.py) — the server half.
 *
 * Report reads up to 50,000 rows and turns them into 21 metric blocks, so the aggregation
 * stays here: the rows never leave the server, the payload is the numbers themselves, and
 * there is exactly one implementation of each rule to hold against the Python.
 *
 * This file starts with the period model alone — `GET /report/periods`. Everything else on
 * the page is a function of the selected period, so it is the piece that has to be right
 * first, and the one a parity check can pin without any data in play.
 */
import { q, type Db } from "./db.ts";
import { body, gzipped, json, str } from "./http.ts";
import { loadNameConfig } from "./report_names.ts";
import { buildSection1, loadSection1, RFP_COLUMNS } from "./report_section1.ts";
import { buildSection2, loadOrgIdentity, loadSection2 } from "./report_section2.ts";
import { exportFilename, type ExportParams } from "./report_export.ts";
import { buildSection3, currenciesUsed } from "./report_section3.ts";
import { buildSection4 } from "./report_section4.ts";
import { buildSection5 } from "./report_section5.ts";
import {
  ALL_KEYS, ALL_SEC_IDS, getSelection, loadStore, REPORT_SECTIONS, restoreItems, restoreSecs,
  saveSnapshot, signatureOf,
} from "./report_snapshots.ts";
import { loadCurrencies } from "./money.ts";
import { ratesFor } from "./fx.ts";
import {
  bucketLabel, bucketRange, cadenceWord, MONTH_NAMES, PERIOD_OPTS, periodBounds,
  periodLabel, periodPhrase, periodSlug, resolveSelection, VIEW_OPTS, YEAR_MAX, YEAR_MIN,
  type Selection,
} from "./report_period.ts";
import { isSuperUser, type PermUser } from "./permissions.ts";
import type { Json } from "./jwt.ts";
import type { Ctx } from "./session.ts";

/** How a route hands work to the runner — `createJobRoutes(...).enqueue`. */
type Enqueue = (kind: string, params: Json, ctx: Ctx) => Promise<{ id: string; dispatched: boolean } | null>;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * `core.settings.get_year()` — the active review year.
 *
 * It is NOT the calendar year: `app_settings.year` is honoured when it points at the current
 * year or a future one (so a deployment can start populating next year early), and ignored
 * when it has fallen into the past. That last rule is the point of the function — without it
 * a year written once keeps being served after the calendar has moved past it.
 *
 * Global, not tenant-scoped: `year` is not in `_TENANT_SCOPED_KEYS`.
 */
export async function activeYear(db: Db): Promise<number> {
  const current = new Date().getUTCFullYear();
  let stored: number | null = null;
  try {
    const rows = await db.service.get("app_settings", `select=value&key=eq.${q("year")}&limit=1`);
    const raw = rows[0]?.value;
    if (raw !== null && raw !== undefined && String(raw) !== "") {
      const n = Number.parseInt(String(raw), 10);
      stored = Number.isFinite(n) ? n : null;
    }
  } catch {
    // A settings read that fails is the calendar year, exactly as the Python's except does.
    stored = null;
  }
  return stored === null || stored < current ? current : stored;
}

export function createReportRoutes(db: Db, enqueue: Enqueue | null = null) {
  /**
   * The period controls and what the current selection resolves to.
   *
   * The browser does not re-derive any of this. The option lists, the clamping, the bounds
   * and the caption all come from here, so the React controls and the Python page cannot
   * drift into offering different periods or labelling the same one differently.
   *
   * Query params mirror the snapshot keys: period, year, month, view. Absent or unrecognised
   * values fall back the way the Streamlit widgets do (Year to date, Monthly, today's month).
   */
  /**
   * One description of a resolved period, shared by `/report/periods` and the snapshot
   * route — a restored report must be labelled and bucketed exactly as a hand-picked one,
   * and a second copy of this object is how the two would drift.
   */
  function periodPayload(sel: Selection, t: string, currentYear: number) {
    const bounds = periodBounds(sel, t);
    return {
      today: t,
      currentYear,
      options: {
        periods: PERIOD_OPTS, views: VIEW_OPTS, months: MONTH_NAMES,
        yearMin: YEAR_MIN, yearMax: YEAR_MAX,
      },
      selection: sel,
      bounds,
      label: periodLabel(sel),
      phrase: periodPhrase(sel),
      slug: periodSlug(sel),
      cadence: cadenceWord(sel.view),
      bucketLabel: bucketLabel(sel.view),
      // Under All time the window comes from the data, not the period, so there is no
      // bucket range to hand over yet — the series routes compute it from the rows they read.
      buckets: bounds.start && bounds.end ? bucketRange(bounds.start, bounds.end, sel.view) : null,
    };
  }

  async function periods(req: Request, _ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const currentYear = await activeYear(db);
    const sel: Selection = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, currentYear,
    );
    return json(periodPayload(sel, t, currentYear));
  }

  /**
   * Section 1 — Scan activity. Same query params as `/report/periods`.
   *
   * The rows are read and reduced here; the browser gets the numbers. Report reads up to
   * 50,000 submissions and 10,000 scan rows, and shipping those to draw a dozen tiles would
   * cost tens of megabytes per period change.
   *
   * The response carries the resolved period alongside the blocks so the page cannot label a
   * chart with one period while showing another's numbers.
   */
  async function section1(req: Request, ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const sel = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, await activeYear(db),
    );
    const bounds = periodBounds(sel, t);
    const [{ rfps, scans }, nameConfig] = await Promise.all([
      loadSection1(db, ctx.scope, bounds),
      loadNameConfig(db, db.scopeTid(ctx.scope).startsWith("00000000-") ? null : db.scopeTid(ctx.scope)),
    ]);
    const blocks = buildSection1({ rfps, scans, view: sel.view, bounds, nameConfig });
    return gzipped(req, json({
      selection: sel, bounds, label: periodLabel(sel), bucketLabel: bucketLabel(sel.view),
      ...blocks,
    }, 200, { "Cache-Control": "private, max-age=30" }));
  }

  /**
   * Section 2 as displayed — Team & Partnership Activity, section id 4.
   *
   * Same query params as the others. The people and partner blocks run over every Proceed
   * row; only meetings and engagements follow the period, and they follow it in the query.
   */
  async function section2(req: Request, ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const sel = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, await activeYear(db),
    );
    const bounds = periodBounds(sel, t);
    const tid = db.scopeTid(ctx.scope);
    const scoped = tid.startsWith("00000000-") ? null : tid;
    const [frames, nameConfig, org] = await Promise.all([
      loadSection2(db, ctx.scope, bounds, RFP_COLUMNS),
      loadNameConfig(db, scoped),
      loadOrgIdentity(db, scoped),
    ]);
    const blocks = buildSection2({ ...frames, view: sel.view, bounds, nameConfig, org });
    return gzipped(req, json({
      selection: sel, bounds, label: periodLabel(sel), bucketLabel: bucketLabel(sel.view),
      ...blocks,
    }, 200, { "Cache-Control": "private, max-age=30" }));
  }

  /**
   * Section 3 as displayed — the status & eligibility funnel, section id 2.
   *
   * The period is read but barely used: only `discoveredInPeriod` depends on it. Everything
   * else is all-time on purpose, because the Excel-migrated rows have no search_date and a
   * filtered funnel would hide the organisation's whole pre-migration pipeline.
   */
  async function section3(req: Request, ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const sel = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, await activeYear(db),
    );
    const bounds = periodBounds(sel, t);
    const rfps = await db.as(ctx.scope).getAll("rfp_submissions", `select=${RFP_COLUMNS}`, "uid");
    // The same FX source the snapshot and the Pipeline use. A second rate source here would
    // drift from them, and the value funnel would stop agreeing with Outcome.
    const [rates, table] = await Promise.all([
      ratesFor(currenciesUsed(rfps)),
      loadCurrencies(db),
    ]);
    const blocks = buildSection3({ rfps, bounds, rates, table });
    return gzipped(req, json({
      selection: sel, bounds, label: periodLabel(sel), ...blocks,
    }, 200, { "Cache-Control": "private, max-age=30" }));
  }

  /**
   * Section 4 as displayed — Reviews & Decisions, section id 3.
   *
   * Reads the same table as Section 3 and nothing else: no FX, no name config, no partner
   * identity. The period reaches four of the five blocks and is ignored by the other two —
   * the decision distribution is all-time, and so are the donor decisions, because a
   * funder's answer is a durable outcome rather than an event inside a window.
   */
  async function section4(req: Request, ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const sel = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, await activeYear(db),
    );
    const bounds = periodBounds(sel, t);
    const rfps = await db.as(ctx.scope).getAll("rfp_submissions", `select=${RFP_COLUMNS}`, "uid");
    const blocks = buildSection4({ rfps, view: sel.view, bounds });
    return gzipped(req, json({
      selection: sel, bounds, label: periodLabel(sel), bucketLabel: bucketLabel(sel.view),
      ...blocks,
    }, 200, { "Cache-Control": "private, max-age=30" }));
  }

  /**
   * Section 5 — Our Results, section id 5.
   *
   * All-time but for the cumulative curve, which follows the period AND the view. Needs the
   * same FX pair as Section 3, and reads the currency list through Section 3's helper so
   * the two money sections cannot end up asking for different rates.
   */
  async function section5(req: Request, ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const sel = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, await activeYear(db),
    );
    const bounds = periodBounds(sel, t);
    const rfps = await db.as(ctx.scope).getAll("rfp_submissions", `select=${RFP_COLUMNS}`, "uid");
    const [rates, table] = await Promise.all([
      ratesFor(currenciesUsed(rfps)),
      loadCurrencies(db),
    ]);
    const blocks = buildSection5({ rfps, view: sel.view, bounds, rates, table });
    return gzipped(req, json({
      selection: sel, bounds, label: periodLabel(sel), bucketLabel: bucketLabel(sel.view),
      ...blocks,
    }, 200, { "Cache-Control": "private, max-age=30" }));
  }

  /**
   * `GET /report/snapshot?r=<id>` — open a saved report link.
   *
   * Answers the whole of what `views/report.py` does at import time with a `?r=` in the
   * URL: look the id up, seed the period controls from it, work out which sections and
   * metrics come back on, and say whether the link resolved at all.
   *
   * With no `r` — or an id that has aged out of the newest 100 — this is not an error. It
   * is the page's own opening state: every control at its default, every section and metric
   * on, `found: false` so the page can show the "it may have aged out" warning for an id
   * that was asked for and missed. A 404 would make the browser treat a stale link as a
   * failure when the page has something perfectly good to render.
   *
   * The period half of the response is byte-for-byte `/report/periods`, so a restored
   * report and a hand-picked one cannot be labelled differently.
   */
  async function snapshotGet(req: Request, _ctx: Ctx): Promise<Response> {
    const rid = (new URL(req.url).searchParams.get("r") ?? "").trim();
    const t = today();
    const [currentYear, store] = await Promise.all([activeYear(db), loadStore(db)]);
    const saved = getSelection(store, rid);
    const sel = resolveSelection(saved ?? {}, t, currentYear);
    return json({
      ...periodPayload(sel, t, currentYear),
      rid: rid || null,
      // `_has_url_state` / `_snap_missing`. "Asked for an id and it was not there" is the
      // only case that warrants a warning; arriving with no id at all is the normal entry.
      found: saved !== null,
      missing: rid !== "" && saved === null,
      createdAt: rid && store[rid] ? String(store[rid].created_at ?? "") || null : null,
      restored: {
        secs: restoreSecs(saved?.secs, ALL_SEC_IDS),
        items: restoreItems(saved?.items, ALL_KEYS, saved?.all_items),
      },
      // What the link HOLDS, against which the page compares what is on screen to decide
      // whether to offer "✎ Selections changed". Null when there is no snapshot, and also
      // when its stored selection cannot produce one — see signatureOf.
      savedSignature: saved ? signatureOf(saved) : null,
      catalog: { sections: REPORT_SECTIONS, allKeys: ALL_KEYS, allSecIds: ALL_SEC_IDS },
    });
  }

  /**
   * `POST /report/snapshot` — Generate: save the selection, mint the link.
   *
   * The client sends what it has on screen (period, year, month, view, secs, items). It
   * does NOT send `all_items` / `all_secs`: those record which metrics EXISTED at save
   * time, which is a fact about this deployment rather than about the user's selection, and
   * a browser sending its own idea of the universe is how a stale tab would write a
   * snapshot that restores wrong for everyone afterwards.
   *
   * The posted selection is put through `resolveSelection` before it is stored, so a stored
   * period is always one of the real options and a stored year is always inside the
   * picker's range. Streamlit got that from the widgets themselves; an HTTP route has to do
   * it on the way in, or an unopenable snapshot is one curl away.
   *
   * Gated by nothing beyond a session, exactly as the Generate button is: anyone who can
   * open Report can save one. Note the consequence given the shared store — a hundred
   * Generates from any one tenant empty the window for every other.
   */
  async function snapshotPost(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const t = today();
    const sel = resolveSelection(b, t, await activeYear(db));
    const known = (v: unknown, universe: ReadonlyArray<string>): string[] => {
      const u = new Set(universe);
      return [...new Set((Array.isArray(v) ? v : []).map(str).filter((x) => u.has(x)))].sort();
    };
    const { rid, createdAt } = await saveSnapshot(db, {
      period: sel.period,
      year: sel.year,
      month: sel.month,
      view: sel.view,
      // `sorted(_picked_secs)` / `sorted(_selected_items)`, filtered to what exists. The
      // widgets could only ever offer real ids; a route has to drop the rest, or an
      // unknown key is stored and then counted as "deliberately off" by every later
      // restore, because it lands in `all_items` too.
      secs: known(b.secs, ALL_SEC_IDS),
      items: known(b.items, ALL_KEYS),
      all_items: [...ALL_KEYS].sort(),
      all_secs: [...ALL_SEC_IDS].sort(),
    }, str(ctx.user.email) || null);
    return json({ rid, createdAt });
  }

  /**
   * `POST /report/export` — queue the six-sheet workbook for this period.
   *
   * Answers with the job row, which the browser then polls through `GET /jobs/:id`; the
   * finished row's `result` carries a signed URL to the file. A 503 means the job was
   * recorded but never reached a runner, which is a real state on a deployment with no
   * dispatch token and is why the status is not simply 202.
   *
   * The whole point of this route rather than a bare `POST /jobs` is the params: the
   * tenant, the shared-crawl rule and the filename are settled from the session here. See
   * api/report_export.ts.
   */
  async function exportXlsx(req: Request, ctx: Ctx): Promise<Response> {
    if (!enqueue) return json({ error: "Background jobs are not configured on this server." }, 503);
    const p = new URL(req.url).searchParams;
    const b = await body(req).catch(() => ({} as Record<string, unknown>));
    const pick = (k: string) => (b[k] !== undefined ? b[k] : p.get(k));
    const t = today();
    const sel = resolveSelection(
      { period: pick("period"), year: pick("year"), month: pick("month"), view: pick("view") },
      t, await activeYear(db),
    );
    const bounds = periodBounds(sel, t);
    const tid = db.scopeTid(ctx.scope);
    const scoped = /^0{8}-/.test(tid) ? null : tid;
    const org = await loadOrgIdentity(db, scoped);
    const params: ExportParams = {
      tenant_id: scoped,
      start: bounds.start,
      end: bounds.end,
      period: sel.period,
      period_label: periodLabel(sel),
      view: sel.view,
      // `_slug(_org.get("org_short") or _org_name)` — the short name, falling back to the
      // full one, which is what the Streamlit filename uses.
      filename: exportFilename(sel, org.short || org.full, str(pick("r")).trim() || null, "xlsx"),
      // `_load_scan_logs` applies no tenant filter for a super_user or for a deployment
      // with no tenants, and filters to the tenant for a member of one.
      unfiltered_scans: isSuperUser(ctx.user as PermUser) || scoped === null,
      by: str(ctx.user.email),
    };
    const queued = await enqueue("export_report_xlsx", params as unknown as Json, ctx);
    if (!queued) return json({ error: "Export is not available on this server." }, 400);
    const rows = await db.service.get("web_jobs",
      `select=id,kind,status,progress,message,result,created_at,started_at,finished_at,run_url,created_by,tenant_id&id=eq.${q(queued.id)}&limit=1`);
    const job = rows[0] ?? null;
    if (!queued.dispatched) {
      // The job row carries WHY it never started — no dispatch token configured, or the
      // dispatch itself was refused. Passing that through rather than inventing a message
      // here is the difference between "ask an administrator for the token" and "try
      // again", which are different instructions to give somebody.
      return json({
        error: str(job?.message) || "The export could not be started on this server.",
        job, filename: params.filename,
      }, 503);
    }
    return json({ job, filename: params.filename }, 202);
  }

  return {
    periods, section1, section2, section3, section4, section5,
    snapshotGet, snapshotPost, exportXlsx,
  };
}
