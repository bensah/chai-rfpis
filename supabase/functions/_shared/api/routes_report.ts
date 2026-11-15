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
import { gzipped, json } from "./http.ts";
import { loadNameConfig } from "./report_names.ts";
import { buildSection1, loadSection1, RFP_COLUMNS } from "./report_section1.ts";
import { buildSection2, loadOrgIdentity, loadSection2 } from "./report_section2.ts";
import { buildSection3, currenciesUsed } from "./report_section3.ts";
import { buildSection4 } from "./report_section4.ts";
import { loadCurrencies } from "./money.ts";
import { ratesFor } from "./fx.ts";
import {
  bucketLabel, bucketRange, cadenceWord, MONTH_NAMES, PERIOD_OPTS, periodBounds,
  periodLabel, periodPhrase, periodSlug, resolveSelection, VIEW_OPTS, YEAR_MAX, YEAR_MIN,
  type Selection,
} from "./report_period.ts";
import type { Ctx } from "./session.ts";

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

export function createReportRoutes(db: Db) {
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
  async function periods(req: Request, _ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const t = today();
    const currentYear = await activeYear(db);
    const sel: Selection = resolveSelection(
      { period: p.get("period"), year: p.get("year"), month: p.get("month"), view: p.get("view") },
      t, currentYear,
    );
    const bounds = periodBounds(sel, t);
    return json({
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
    });
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

  return { periods, section1, section2, section3, section4 };
}
