/**
 * The Report page's period model — `views/report.py`'s period selectors, `_period_bounds`,
 * `_bucket_start` and `_bucket_range`, with nothing else attached.
 *
 * It is pure: no database, no clock of its own. `today` is always passed in, because the
 * Streamlit page reads `date.today()` on the machine it runs on and this runs in an Edge
 * Function in UTC — a model that fetched its own "today" would be a second source of truth
 * and the parity check could never pin it.
 *
 * Dates are `YYYY-MM-DD` strings throughout and every calculation is UTC. A `Date` built
 * from `new Date(y, m, d)` is local, so in any timezone west of UTC it is the previous day
 * once formatted back with `toISOString()` — which is exactly the kind of off-by-one that
 * moves a row into the wrong month and is invisible until a reader notices a total is wrong.
 *
 * WHAT PANDAS DOES, SPELLED OUT, because that is what is being ported:
 *   * `to_period("W-SUN").start_time` — a W-SUN period ENDS on Sunday, so it STARTS on
 *     Monday. Weekly buckets are Monday-based.
 *   * `date_range(start, end, freq="MS"|"QS")` yields only bucket starts at or after `start`.
 *     When the period does not begin on a bucket boundary — "Last 90 days" viewed monthly —
 *     the first partial bucket is NOT in the range, so reindexing DROPS those rows from the
 *     chart. That is live behaviour, not a bug being carried: see `bucketRange`.
 */

export const PERIOD_OPTS = [
  "This year", "Year to date", "Specific month",
  "Last 90 days", "Last 12 months", "All time",
] as const;

export const VIEW_OPTS = [
  "Weekly", "Monthly", "Quarterly", "Semestrial", "Annually",
] as const;

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** The `number_input` bounds on the year picker. A snapshot outside them is clamped. */
export const YEAR_MIN = 2020;
export const YEAR_MAX = 2050;

export type PeriodMode = (typeof PERIOD_OPTS)[number];
export type BucketMode = (typeof VIEW_OPTS)[number];

export type Selection = {
  period: PeriodMode;
  year: number;
  month: string;      // one of MONTH_NAMES
  view: BucketMode;
};

export type Bounds = { start: string | null; end: string | null };

// ── UTC date arithmetic ──────────────────────────────────────────────────────
// Everything below works in whole UTC days. `ymd` and `parse` are the only places a
// string becomes numbers or back, so there is one place for a timezone to be got wrong.

const ymd = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** `YYYY-MM-DD` → {y, m, d}. Accepts a longer ISO timestamp and keeps its date part. */
export function parseDate(v: unknown): { y: number; m: number; d: number } | null {
  const s = String(v ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

const toEpochDay = (s: string): number => Date.parse(`${s}T00:00:00Z`) / 86400_000;
const fromEpochDay = (n: number): string => new Date(n * 86400_000).toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => fromEpochDay(toEpochDay(s) + n);

/** 0 = Monday … 6 = Sunday. 1970-01-01 was a Thursday, hence the +3. */
const weekdayMon0 = (s: string): number => (((toEpochDay(s) + 3) % 7) + 7) % 7;

const lastDayOfMonth = (y: number, m: number): string =>
  m === 12 ? ymd(y, 12, 31) : addDays(ymd(y, m + 1, 1), -1);

// ── Selection: defaults, clamping, and the fallbacks a bad snapshot hits ─────

/** `_opt_index`: the value when it is one of the options, otherwise the fallback. */
function pick<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  const s = String(value ?? "");
  return (options as readonly string[]).includes(s) ? (s as T) : fallback;
}

/**
 * Resolve a raw selection — from the URL, or from a restored snapshot — the way the
 * Streamlit widgets do.
 *
 * The defaults are the widget `index=` arguments: period 1 (Year to date) and view 1
 * (Monthly), NOT the first option. An unrecognised value falls back to those rather than
 * erroring, which is what makes an old snapshot with a renamed option still open.
 *
 * `currentYear` is `core.settings.get_year()`, not the calendar year: an `app_settings.year`
 * pointing at a future year is honoured, a past one is ignored.
 */
export function resolveSelection(
  raw: Record<string, unknown> | null | undefined,
  today: string,
  currentYear: number,
): Selection {
  const r = raw ?? {};
  const t = parseDate(today)!;

  // `int(_sel("year", current_year))` inside a try/except, then clamped to the picker's
  // range: a non-numeric year is the current one, an out-of-range year is pulled to the edge.
  let year = Number.parseInt(String(r.year ?? currentYear), 10);
  if (!Number.isFinite(year)) year = currentYear;
  year = Math.min(Math.max(year, YEAR_MIN), YEAR_MAX);

  return {
    period: pick(PERIOD_OPTS, r.period, "Year to date"),
    year,
    // `index=min(today.month - 1, 11)` — today's month.
    month: pick(MONTH_NAMES, r.month, MONTH_NAMES[t.m - 1]),
    view: pick(VIEW_OPTS, r.view, "Monthly"),
  };
}

// ── Bounds and labels ────────────────────────────────────────────────────────

/** `_period_bounds`. Both ends inclusive; All time is open at both ends. */
export function periodBounds(sel: Selection, today: string): Bounds {
  const y = sel.year;
  switch (sel.period) {
    case "This year":
      return { start: ymd(y, 1, 1), end: ymd(y, 12, 31) };
    case "Year to date":
      return { start: ymd(y, 1, 1), end: today };
    case "Specific month": {
      const m = MONTH_NAMES.indexOf(sel.month as (typeof MONTH_NAMES)[number]) + 1;
      return { start: ymd(y, m, 1), end: lastDayOfMonth(y, m) };
    }
    case "Last 90 days":
      return { start: addDays(today, -90), end: today };
    case "Last 12 months":
      // 365 days, not a calendar year: a leap year is 366 days back from today.
      return { start: addDays(today, -365), end: today };
    default:
      return { start: null, end: null };
  }
}

/**
 * Whether a row's date falls in the period. A NULL or unparseable date is OUT when a
 * period is active and IN under All time — the asymmetry `views/report.py` relies on so
 * that Excel-migrated rows with no `search_date` still appear somewhere.
 */
export function inPeriod(value: unknown, bounds: Bounds): boolean {
  if (bounds.start === null && bounds.end === null) return true;
  const d = parseDate(value);
  if (!d) return false;
  const s = ymd(d.y, d.m, d.d);
  if (bounds.start !== null && s < bounds.start) return false;
  if (bounds.end !== null && s > bounds.end) return false;
  return true;
}

/** `_period_label` — what the chart titles echo. */
export function periodLabel(sel: Selection): string {
  switch (sel.period) {
    case "Specific month": return `${sel.month} ${sel.year}`;
    case "This year": return `${sel.year} (full year)`;
    case "Year to date": return `YTD ${sel.year}`;
    case "All time": return "All time";
    default: return sel.period;
  }
}

/** `_period_phrase` — the label as a reader says it. Drives the export subtitle. */
export function periodPhrase(sel: Selection): string {
  const label = periodLabel(sel);
  const low = label.toLowerCase();
  if (low.startsWith("ytd")) return "Year-to-date " + label.split(/\s+/).pop();
  if (low.startsWith("last 90")) return "Last 90 days";
  if (low.startsWith("last 12")) return "Last 12 months";
  if (low.startsWith("all")) return "All time";
  return label;
}

/** `_period_slug` — goes in the export filename so two periods don't collide on disk. */
export function periodSlug(sel: Selection): string {
  const mode = String(sel.period ?? "").trim().toLowerCase();
  if (mode.includes("year to date") || mode === "ytd") return "ytd";
  if (mode.includes("last 90")) return "last90d";
  if (mode.includes("last 12")) return "last12m";
  if (mode.includes("all time")) return "alltime";
  // Substring tests on the option's own words, in Python's order: "Specific month" matches
  // "month", "This year" matches "year". Reversing the two would slug a specific month as a
  // bare year and collide every month of that year onto one filename.
  if (mode.includes("month")) {
    return (String(sel.month ?? "").toLowerCase().slice(0, 3) || "month") + String(sel.year);
  }
  if (mode.includes("year")) return String(sel.year);
  return mode.replace(/ /g, "") || "period";
}

/** `_bucket_label` — the x-axis word. */
export function bucketLabel(mode: BucketMode | string): string {
  return ({
    Weekly: "Week", Monthly: "Month", Quarterly: "Quarter",
    Semestrial: "Semester", Annually: "Year",
  } as Record<string, string>)[String(mode)] ?? "Period";
}

/** `_cadence_word` — names the report after the cadence it was cut at. */
export function cadenceWord(mode: BucketMode | string): string {
  const m = String(mode ?? "").trim().toLowerCase();
  const known: Record<string, string> = {
    weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly",
    semestrial: "Semi-annual", annually: "Annual",
  };
  if (known[m]) return known[m];
  // Python's str.title(): every word's first letter up, the rest down.
  const titled = m.replace(/[A-Za-z]+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  return titled || "Periodic";
}

// ── Bucketing ────────────────────────────────────────────────────────────────

/**
 * `_bucket_start` — snap a date to the start of its bucket.
 *
 * Weekly is Monday-based (`to_period("W-SUN")` ends on Sunday). Semestrial is the CALENDAR
 * half-year, Jan–Jun and Jul–Dec, not a fiscal one. An unparseable date returns null, which
 * is pandas' NaT: it groups nowhere and is dropped.
 */
export function bucketStart(value: unknown, mode: BucketMode | string): string | null {
  const d = parseDate(value);
  if (!d) return null;
  switch (mode) {
    case "Weekly": return addDays(ymd(d.y, d.m, d.d), -weekdayMon0(ymd(d.y, d.m, d.d)));
    case "Monthly": return ymd(d.y, d.m, 1);
    case "Quarterly": return ymd(d.y, d.m - ((d.m - 1) % 3), 1);
    case "Semestrial": return ymd(d.y, d.m <= 6 ? 1 : 7, 1);
    case "Annually": return ymd(d.y, 1, 1);
    default: return ymd(d.y, d.m, d.d);
  }
}

/**
 * `_bucket_range` — every bucket start between `start` and `end`, used to reindex an
 * aggregate so an empty bucket draws a zero instead of vanishing.
 *
 * THE PARTIAL FIRST BUCKET IS DELIBERATELY ABSENT for Monthly and Quarterly. `date_range`
 * with `MS`/`QS` starts at the first boundary AT OR AFTER `start`, so "Last 90 days" viewed
 * monthly produces no bucket for the month the period starts inside, and the rows that snap
 * there disappear from the chart on reindex. Weekly compensates by starting six days early
 * and Semestrial by reaching 180 days back; Monthly and Quarterly do not, and the two charts
 * disagreeing about their own first bucket is live behaviour. Changing it here would make
 * the React page quietly report different totals from the Streamlit one.
 *
 * Annually ignores `start`'s month entirely and runs from Jan 1 of its year.
 */
export function bucketRange(start: string, end: string, mode: BucketMode | string): string[] {
  const s = parseDate(start), e = parseDate(end);
  if (!s || !e) return [];
  const startS = ymd(s.y, s.m, s.d), endS = ymd(e.y, e.m, e.d);
  const out: string[] = [];

  if (mode === "Weekly") {
    const from = addDays(startS, -6);
    // The first Monday at or after `from`, then every seventh day — pandas' W-MON.
    const skew = weekdayMon0(from);
    let cur = skew === 0 ? from : addDays(from, 7 - skew);
    while (cur <= endS) { out.push(cur); cur = addDays(cur, 7); }
    return out;
  }
  if (mode === "Monthly" || mode === "Quarterly") {
    const step = mode === "Monthly" ? 1 : 3;
    // The first boundary at or after `start` — the partial bucket it sits inside is skipped.
    let y = s.y, m = mode === "Monthly" ? s.m : s.m - ((s.m - 1) % 3);
    if (ymd(y, m, 1) < startS) {
      m += step;
      while (m > 12) { m -= 12; y += 1; }
    }
    while (ymd(y, m, 1) <= endS) {
      out.push(ymd(y, m, 1));
      m += step;
      while (m > 12) { m -= 12; y += 1; }
    }
    return out;
  }
  if (mode === "Semestrial") {
    // Materialised explicitly in Python, with a window that reaches back half a year so a
    // period starting inside H2 still gets its H2 bucket — the compensation Monthly lacks.
    const floor = addDays(startS, -180);
    for (let y = s.y; y <= e.y; y++) {
      for (const m of [1, 7]) {
        const d = ymd(y, m, 1);
        if (d >= floor && d <= endS) out.push(d);
      }
    }
    return out;
  }
  if (mode === "Annually") {
    for (let y = s.y; y <= e.y; y++) out.push(ymd(y, 1, 1));
    return out;
  }
  return [];
}

/**
 * The window a time series is actually drawn over. Under All time the period has no bounds,
 * so the data's own first and last dates stand in — which is why an All-time chart's x-axis
 * moves as rows are added.
 */
export function seriesWindow(bounds: Bounds, dates: readonly string[]): Bounds {
  if (bounds.start !== null && bounds.end !== null) return bounds;
  const valid = dates.map((d) => parseDate(d)).filter(Boolean)
    .map((d) => ymd(d!.y, d!.m, d!.d)).sort();
  if (!valid.length) return { start: null, end: null };
  return { start: valid[0], end: valid[valid.length - 1] };
}
