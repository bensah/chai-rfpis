/**
 * Pipeline: the week picker, Screened, and Summary.
 *
 * These routes FETCH and SCOPE. They do not score and they do not decide. Live scoring
 * runs in the browser on the Pyodide seam, so `alignment_score` and `auto_recommendation`
 * are computed there over the rows served here; duplicate partitioning, the effective
 * decision, KPI buckets, filters and ordering all belong to the page. The contract is
 * docs/PHASE2_API_CONTRACT.md and the split is the owner's (2026-10-26): web/src to the
 * frontend session, these routes here.
 *
 * Two things measured on the live table decide the shape of this file. The table is 99
 * columns and a row is 4.8 KB raw, so a route that selects `*` ships a fifth of its weight
 * in `brief_description` alone. And Screened is bounded by a week while Summary grows
 * without limit as scanning continues, so they cannot share a payload: one route would
 * make the cheap page pay for the expensive one permanently. Hence a projection per route
 * and a window on Summary.
 *
 * `clean_df` is deliberately NOT ported. It exists because
 * `pd.DataFrame([...dicts...])` backfills missing cells with NaN, which then crashes
 * `(row.get("x") or "").strip()`. PostgREST returns real nulls, so the condition it
 * repairs cannot arise here. `drop_concluded` IS ported, below, because that one is a
 * rule rather than an artefact.
 */
import { q, type Db } from "./db.ts";
import { gzipped, json, str } from "./http.ts";
import type { Json } from "./jwt.ts";
import type { Ctx } from "./session.ts";

/** views/screened_rfp.py draws these. Not `*`: see the file header. */
const SCREEN_FIELDS = "uid,opportunity_title,funding_agency,brief_description," +
  "call_award_value,currency,call_submission_deadline,call_geographic_scope," +
  "call_domain_areas,focus_theme,opportunity_link,date_posted,search_date," +
  "submitted_at,created_at,review_week,alignment_score,auto_recommendation," +
  "decision,decision_date,donor_decision,progress_status,is_duplicate," +
  "duplicate_of_uid";

/** Sections A to E aggregate over these. No prose: Summary counts and sums, it does not
 * render a call's description, and dropping `brief_description` alone takes about a fifth
 * off a payload that is already the widest one here. */
const SUMMARY_FIELDS = "uid,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,call_domain_areas,focus_theme," +
  "submitted_at,review_week,alignment_score,auto_recommendation,decision," +
  "decision_date,donor_decision,progress_status,is_duplicate,duplicate_of_uid";

const norm = (v: unknown) => str(v).trim().toLowerCase();

/** core/review_week.py::week_bounds — the Monday of the ISO week containing `d`. */
function monday(d: Date): Date {
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // getUTCDay is 0 for Sunday; Python's weekday() is 0 for Monday.
  const weekday = (out.getUTCDay() + 6) % 7;
  out.setUTCDate(out.getUTCDate() - weekday);
  return out;
}

/** date.isocalendar().week */
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week determines the ISO year and week number.
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const jan4Thu = new Date(jan4);
  jan4Thu.setUTCDate(jan4Thu.getUTCDate() + 3 - ((jan4.getUTCDay() + 6) % 7));
  return 1 + Math.round((t.getTime() - jan4Thu.getTime()) / (7 * 86400_000));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** core/review_week.py::_fmt_day — "%d %b" with the leading zero stripped. */
const fmtDay = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/** core/review_week.py::review_week_label */
export function reviewWeekLabel(d: Date): string {
  const mon = monday(d);
  const sun = new Date(mon);
  sun.setUTCDate(sun.getUTCDate() + 6);
  return `Week ${isoWeek(mon)} (${fmtDay(mon)} - ${fmtDay(sun)})`;
}

/** core/review_week.py::all_weeks_for_year — every label for the year, in order.
 *
 * Starts from the week containing Jan 4, which is always week 1, and walks Mondays. The
 * stop condition is the Python's: once the Monday has rolled into the next year AND its
 * ISO week is 1, the year is finished. A year whose last days belong to next year's week
 * 1 therefore ends correctly, and a 53-week year keeps its 53rd. */
export function allWeeksForYear(year: number): string[] {
  const labels: string[] = [];
  let mon = monday(new Date(Date.UTC(year, 0, 4)));
  while (mon.getUTCFullYear() <= year) {
    labels.push(reviewWeekLabel(mon));
    mon = new Date(mon.getTime() + 7 * 86400_000);
    if (mon.getUTCFullYear() > year && isoWeek(mon) === 1) break;
  }
  return labels;
}

/** core/records.py::drop_concluded — a rule, so it is ported rather than left to the page.
 *
 * A concluded solicitation is one the funder has answered, or one the team has finished
 * with. Those live under Funding and must not clutter the active lists. Blank and "not
 * submitted" are the only donor decisions that count as still open, which is the Python's
 * set and not a judgement made here. */
function dropConcluded(rows: Json[]): Json[] {
  return rows.filter((r) => {
    const dd = norm(r.donor_decision);
    if (dd !== "" && dd !== "not submitted") return false;
    const ps = norm(r.progress_status);
    return ps !== "completed" && ps !== "discontinued";
  });
}

export function createPipelineRoutes(db: Db) {
  /** The week picker: every label for the year, which week is current, and where the data
   * actually is. */
  async function weeks(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const year = Number(url.searchParams.get("year")) ||
      new Date().getUTCFullYear();

    const labels = allWeeksForYear(year);
    const current = reviewWeekLabel(new Date());
    // screened_rfp.py line 67: a current week missing from the year's list is prepended
    // rather than dropped, so the default selection always exists as an option. It can be
    // missing when the current week belongs to a different year than the one being viewed.
    const weeksOut = labels.includes(current) ? labels : [current, ...labels];

    // Counts only — this feeds the empty state's "most recent week with activity", so it
    // must never carry rows.
    const rows = await db.as(ctx.scope)
      .get("rfp_submissions", "select=review_week");
    const counts = new Map<string, number>();
    for (const r of rows) {
      const w = str(r.review_week).trim();
      if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const weeksWithData = [...counts.entries()]
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week.localeCompare(b.week));

    return gzipped(req, json({ year, weeks: weeksOut, current, weeksWithData }));
  }

  /** Screened: one week's rows, concluded ones removed. Everything else is the page's. */
  async function screen(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const week = str(url.searchParams.get("week")).trim();
    if (!week) return json({ error: "week is required" }, 400);

    const rows = await db.as(ctx.scope).get(
      "rfp_submissions",
      `select=${SCREEN_FIELDS}&review_week=eq.${q(week)}`,
    );
    return gzipped(req, json({ week, rows: dropConcluded(rows) }));
  }

  /** Summary: rows for a date window, aggregated in the browser.
   *
   * Windowed rather than aggregated here (owner, 2026-10-27). Aggregating server-side from
   * the STORED alignment_score would be cheap and bounded, but that value is what
   * score_submission wrote under the 70/45 rule while every other page displays the
   * composite 90/70 rule over a freshly computed score — so Summary would visibly disagree
   * with the rest of the app. Shipping rows keeps one scoring implementation, and the
   * window keeps the payload a function of what is being looked at rather than of how long
   * the deployment has been running.
   *
   * Concluded rows are NOT dropped here: Summary reports on the whole year including what
   * was won and closed, which is the opposite of what the active lists want. */
  async function summary(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const year = new Date().getUTCFullYear();
    const from = str(url.searchParams.get("from")).trim() || `${year}-01-01`;
    const to = str(url.searchParams.get("to")).trim() || `${year + 1}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
      return json({ error: "from and to must be ISO dates" }, 400);
    }
    if (to <= from) return json({ error: "to must be after from" }, 400);

    // Half-open, so consecutive windows meet exactly and a row on the boundary is counted
    // once rather than in both.
    const rows = await db.as(ctx.scope).get(
      "rfp_submissions",
      `select=${SUMMARY_FIELDS}&submitted_at=gte.${q(from)}&submitted_at=lt.${q(to)}`,
    );
    return gzipped(req, json({ from, to, rows }));
  }

  return { weeks, screen, summary };
}
