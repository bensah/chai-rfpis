// Parity check for Report's period model: the TypeScript in
// supabase/functions/_shared/api/report_period.ts against views/report.py's own helpers.
//
//   node scripts/parity/check-report.mjs      (from web/; no database, no network)
//
// Four comparisons, over a matrix rather than a handful of examples:
//
//   1. Option lists and widget fallbacks — what an old or unrecognised snapshot resolves to.
//   2. Bounds, labels, slug, cadence and the full bucket range, for EVERY period option ×
//      EVERY view × a set of "today"s chosen to sit on the awkward dates.
//   3. `_bucket_start` over probe dates: week boundaries, month and quarter edges, the
//      Jun 30 / Jul 1 semester hinge, Feb 29.
//   4. `_in_period`, including NULL — a missing date is OUT with a period active and IN
//      under All time, and nothing else on the page restores a row dropped by that rule.
//
// The Python side lifts the helpers out of report.py by AST (see report_py.py), so this runs
// the real source. Nothing here reads the database: the period model is pure, and a check
// that needed live rows could not be run by someone without credentials.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const P = await import(pathToFileURL(path.join(root, "supabase/functions/_shared/api/report_period.ts")).href);

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = process.env.RFPIS_PYTHON || (existsSync(venv) ? venv : "python");
const py = (what, cases) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "report_py.py"), what], {
      input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 1 << 26,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    // The Python traceback is the useful part; Node's own wrapper repeats it three times.
    console.error(`
The Python side failed on "${what}":
${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0;
let checks = 0;
// Key order is not a difference: Python dicts and JS objects both preserve insertion order,
// and the two sides insert in whatever order they happen to iterate. Arrays stay ordered.
const canon = (v) => (v === null || typeof v !== "object" ? v
  : Array.isArray(v) ? v.map(canon)
  : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])));
const J = (v) => JSON.stringify(canon(v));
const same = (label, ts, pyv) => {
  checks++;
  if (J(ts) !== J(pyv)) {
    diffs++;
    console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
  }
};

// ── 1. Options and the fallbacks a snapshot hits ─────────────────────────────
{
  const d = py("defaults", null);
  same("period options", [...P.PERIOD_OPTS], d.periods);
  same("view options", [...P.VIEW_OPTS], d.views);
  same("month names", [...P.MONTH_NAMES], d.months);

  // The `index=` fallbacks, evaluated from report.py's own expressions on a fixed day.
  const today = "2026-07-15", currentYear = 2026;
  const fallback = P.resolveSelection({}, today, currentYear);
  same("default period", fallback.period, d.periods[d.Period]);
  same("default view", fallback.view, d.views[d["View by"]]);
  same("default month", fallback.month, d.months[d.Month]);
  // The year seed's clamp, and the two ways a bad year is handled.
  same("year clamp low", P.resolveSelection({ year: 1999 }, today, currentYear).year, P.YEAR_MIN);
  same("year clamp high", P.resolveSelection({ year: 9999 }, today, currentYear).year, P.YEAR_MAX);
  same("year non-numeric", P.resolveSelection({ year: "banana" }, today, currentYear).year, currentYear);
  // An option that no longer exists resolves to the default, not an error — this is what
  // keeps a snapshot saved before a rename openable.
  same("unknown period", P.resolveSelection({ period: "Last 7 days" }, today, currentYear).period, "Year to date");
  same("unknown view", P.resolveSelection({ view: "Fortnightly" }, today, currentYear).view, "Monthly");
  same("unknown month", P.resolveSelection({ month: "Smarch" }, today, currentYear).month, "July");
  console.log(`options and fallbacks checked (clamp expr: ${d.defaultExprs._year_seed})`);
}

// ── 2. Bounds, labels and bucket ranges, over the whole matrix ───────────────
// The "today"s are chosen to be awkward: a leap day, the day after one, both year ends, a
// Monday, a Sunday, and a mid-quarter day. Period arithmetic that is only tested in the
// middle of a month passes while being wrong at every edge.
const TODAYS = [
  "2024-02-29", "2024-03-01", "2025-12-31", "2026-01-01",
  "2026-06-29", "2026-06-28", "2026-07-01", "2026-08-13", "2026-11-02",
];
const YEARS = [2020, 2025, 2026, 2027, 2050];
const MONTHS = ["January", "February", "June", "July", "December"];
{
  const cases = [];
  for (const today of TODAYS) {
    for (const period of P.PERIOD_OPTS) {
      for (const view of P.VIEW_OPTS) {
        for (const year of YEARS) {
          for (const month of MONTHS) {
            // Year and month only move the answer for the three year-bearing periods;
            // iterating them for the others would multiply the matrix by 25 for nothing.
            const yearMatters = ["This year", "Year to date", "Specific month"].includes(period);
            const monthMatters = period === "Specific month";
            if (!yearMatters && year !== YEARS[2]) continue;
            if (!monthMatters && month !== MONTHS[0]) continue;
            cases.push({ today, period, year, month, view });
          }
        }
      }
    }
  }
  const want = py("selection", cases);
  for (const [i, c] of cases.entries()) {
    const sel = { period: c.period, year: c.year, month: c.month, view: c.view };
    const bounds = P.periodBounds(sel, c.today);
    const w = want[i];
    const tag = `${c.today} · ${c.period} ${c.year} ${c.month} · ${c.view}`;
    same(`bounds ${tag}`, bounds, { start: w.start, end: w.end });
    same(`label ${tag}`, P.periodLabel(sel), w.label);
    same(`phrase ${tag}`, P.periodPhrase(sel), w.phrase);
    same(`slug ${tag}`, P.periodSlug(sel), w.slug);
    same(`cadence ${tag}`, P.cadenceWord(c.view), w.cadence);
    same(`bucketLabel ${tag}`, P.bucketLabel(c.view), w.bucketLabel);
    const rng = bounds.start && bounds.end ? P.bucketRange(bounds.start, bounds.end, c.view) : null;
    same(`buckets ${tag}`, rng, w.buckets);
  }
  console.log(`${cases.length} selections checked`);
}

// ── 3. Bucket snapping ─────────────────────────────────────────────
// Plain dates and timestamptz values go in SEPARATE series. A column out of the database is
// uniformly one or the other, and `pd.to_datetime(..., errors="coerce")` over a series that
// mixes naive and tz-aware strings coerces the odd ones out to NaT — so a mixed probe list
// would be testing a shape the app never sees, and reading the resulting NaT as a difference.
const PROBES = [
  "2026-01-01", "2026-01-04", "2026-01-05", "2026-02-28", "2024-02-29",
  "2026-03-31", "2026-04-01", "2026-06-30", "2026-07-01", "2026-09-30",
  "2026-10-01", "2026-12-31", "2027-01-03", "2025-12-29",
];
// The late-evening UTC timestamp is the one that matters here: a local-time conversion
// anywhere in the chain moves it to the next day, and into the next bucket at every boundary.
const TS_PROBES = [
  "2026-08-13T23:45:00+00:00", "2026-06-30T23:59:59+00:00", "2026-07-01T00:00:00+00:00",
  "2026-12-31T22:10:00+00:00", "2026-01-01T00:30:00+00:00",
];
{
  const cases = [
    ...P.VIEW_OPTS.map((view) => ({ view, dates: PROBES })),
    ...P.VIEW_OPTS.map((view) => ({ view, dates: TS_PROBES })),
  ];
  const want = py("bucket_start", cases);
  for (const [i, c] of cases.entries()) {
    const kind = i < P.VIEW_OPTS.length ? "date" : "timestamptz";
    same(`bucketStart ${c.view} (${kind})`, c.dates.map((d) => P.bucketStart(d, c.view)), want[i].buckets);
  }
  console.log(`bucket snapping checked over ${PROBES.length} dates and ${TS_PROBES.length} `
    + `timestamps × ${P.VIEW_OPTS.length} views`);
}

// ── 3b. An unparseable or NULL date among them ─────────────────────────────
//
// A bad date is NaT: it groups nowhere and is dropped. All five views, compared strictly.
//
// This block was an EXEMPTION until 2026-10-29. views/report.py::_bucket_start raised for
// Semestrial whenever the series held a NaT — it was the only mode building its date from
// strings, and `s.dt.year` goes float64 the moment one value is missing, so the year rendered
// as "2026.0" and "2026.0-01-01" would not parse. Report crashed outright, not wrongly, at
// View by = Semestrial wherever a row without a search_date was in scope; the Excel-migrated
// rows are exactly those. The check carried the divergence by name, failed if any OTHER view
// started raising, and said when the note could go. report.py was then fixed (Int64 + coerce,
// so Semestrial carries NaT like the other four), the note fired, and this is it going.
//
// Kept as a comment rather than deleted outright: the fault was Semestrial being the one mode
// that did not go through .dt.to_period, and that is the shape to recognise if it recurs.
const BAD_PROBES = ["2026-03-01", "not a date", "2026-09-01", "2026-06-30", "2026-07-01"];
{
  const cases = P.VIEW_OPTS.map((view) => ({ view, dates: BAD_PROBES }));
  const want = py("bucket_start", cases);
  for (const [i, c] of cases.entries()) {
    if (want[i].error) {
      diffs++; checks++;
      console.log(`DIFF bucketStart ${c.view} RAISED in views/report.py: ${want[i].error}`);
      continue;
    }
    same(`bucketStart ${c.view} with a bad date`, BAD_PROBES.map((d) => P.bucketStart(d, c.view)), want[i].buckets);
  }
  console.log(`bad-date snapping checked over ${BAD_PROBES.length} values × ${P.VIEW_OPTS.length} views`);
}

// ── 4. In-period, NULL included ──────────────────────────────────────────────
{
  const values = [null, "", "2025-12-31", "2026-01-01", "2026-06-15", "2026-08-13",
                  "2026-12-31", "2027-01-01", "not a date"];
  const cases = [];
  for (const period of P.PERIOD_OPTS) {
    cases.push({ today: "2026-08-13", period, year: 2026, month: "June", view: "Monthly", values });
  }
  const want = py("in_period", cases);
  for (const [i, c] of cases.entries()) {
    const bounds = P.periodBounds({ period: c.period, year: c.year, month: c.month, view: c.view }, c.today);
    same(`inPeriod ${c.period}`, values.map((v) => P.inPeriod(v, bounds)), want[i]);
  }
  console.log(`in-period checked over ${values.length} values × ${P.PERIOD_OPTS.length} periods`);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
