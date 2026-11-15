/**
 * The Report's plotted forms. Hand-rolled, like the Dashboard's — this app has no charting
 * library and the Report needs seven forms, not a framework.
 *
 * FORM FOLLOWS THE DATA'S JOB:
 *
 *   RankedBars     magnitude across many names -> horizontal bars, ONE hue. Colour carries
 *                  no identity: these are the same measure at different names, so the bars
 *                  are free to be read as pure length.
 *   SplitBars      one whole split in two, repeated down a ranking -> a stacked bar per row
 *                  in TWO STEPS OF ONE HUE. Two steps, not two hues, because the parts are
 *                  halves of one total rather than two things being compared.
 *   TimeBars       a count per period -> bars on a shared baseline, one hue.
 *   TimeArea       a running total -> a 2px line over a faint fill. The fill says
 *                  "accumulated", the line carries the value.
 *   Dumbbell       two readings per category -> see the note on it. NOT grouped bars.
 *   DivergingBars  signed money about a zero line -> two status hues and a neutral axis.
 *   DataTable      rows a reader will scan and sort -> a table. Not every answer is a chart.
 *
 * COLOUR, computed rather than eyeballed (dataviz validator, light mode, white card):
 *
 *   The single-series hue is accent-600 #117996, the app's chart colour everywhere else.
 *   The status trio is good-700 #0f7847, gold-700 #c08e0a, bad-600 #a3303c: lightness band,
 *   chroma floor, CVD separation (worst adjacent ΔE 13.4 protan) and the normal-vision
 *   floor (23.0) all pass. The gold sits at 2.95:1 against white, under the 3:1 bar, so
 *   every segment that uses it carries a visible label and a figure — that relief is
 *   required, not decorative.
 *
 *   THERE IS NO TWO-HUE CATEGORICAL PALETTE HERE, and that is a finding rather than an
 *   omission. Both of this app's ramps are blue (Dark Blue #003E78, Turquoise #117996), so
 *   every pair of steps from them either falls outside the lightness band or lands under
 *   the normal-vision ΔE floor of 15 — two blues cannot carry two series a reader must tell
 *   apart. Where the Streamlit page drew grouped bars in two colours, this one uses a form
 *   that needs no second hue: see Dumbbell.
 */
import { useState, type ReactNode } from "react";

const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

export const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (n: number, dp = 1) => `${n.toFixed(dp)}%`;

/** Dollars, shortened once past a million — a report tile is read, not audited. */
export function fmtUsd(n: number, full = false): string {
  const a = Math.abs(n);
  if (full || a < 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (a < 1_000_000) return `$${(n / 1000).toFixed(a < 10_000 ? 1 : 0)}k`;
  if (a < 1_000_000_000) return `$${(n / 1_000_000).toFixed(a < 10_000_000 ? 2 : 1)}M`;
  return `$${(n / 1_000_000_000).toFixed(2)}B`;
}

/** A bucket's ISO start, said the way its cadence reads. */
export function bucketText(iso: string, cadence: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const c = cadence.toLowerCase();
  if (c.startsWith("year") || c.startsWith("annual")) return String(y);
  if (c.startsWith("quarter")) return `Q${Math.floor((mo - 1) / 3) + 1} ${String(y).slice(2)}`;
  if (c.startsWith("semester") || c.startsWith("semestr")) return `H${mo <= 6 ? 1 : 2} ${String(y).slice(2)}`;
  if (c.startsWith("week")) return `${d} ${MON[mo - 1]}`;
  return `${MON[mo - 1]} ${String(y).slice(2)}`;
}

// ── Tiles ────────────────────────────────────────────────────────────────────

/**
 * One headline figure. Not a chart, and deliberately so: a single number compared against
 * nothing is read fastest as the number itself.
 *
 * `tone` is for a figure that is itself a state. It never decorates a neutral count.
 */
export function Tile({ label, value, note, tone = "brand" }: {
  label: string; value: ReactNode; note?: ReactNode; tone?: "brand" | "good" | "warn" | "bad";
}) {
  const colour = { brand: "text-brand-700", good: "text-good-700", warn: "text-gold-700", bad: "text-bad-600" }[tone];
  return (
    <div className="rounded-lg border border-ink-200 bg-white px-4 py-3">
      <div className="text-xs leading-tight text-ink-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${colour}`}>{value}</div>
      {note !== undefined && note !== null && <div className="mt-0.5 text-xs text-ink-400">{note}</div>}
    </div>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

/** A chart and its question. The title names the single series, so no legend box is drawn. */
export function Plot({ title, hint, right, children, empty }: {
  title: string; hint?: string; right?: ReactNode; children: ReactNode; empty?: string;
}) {
  return (
    <section className="rounded-lg border border-ink-200 bg-white p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-brand-700">{title}</h4>
          {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
        </div>
        {right}
      </div>
      {empty ? <p className="py-6 text-center text-sm text-ink-400">{empty}</p> : children}
    </section>
  );
}

// ── Ranked bars ──────────────────────────────────────────────────────────────

export type RankRow = {
  label: string;
  value: number;
  /** A short suffix beside the figure — "of 3,682". Anything longer belongs in `sub`. */
  note?: string;
  /** A second line under the label, for a phrase that would otherwise wrap the figure. */
  sub?: string;
  title?: string;
};

/**
 * Magnitude down a ranking. One hue, 4px rounded data-end anchored to the baseline, the
 * figure direct-labelled at the right so no reader has to measure a bar against an axis.
 *
 * The figure column does not wrap. A number that reflows onto three lines stops being a
 * number you can scan down, which is the only reason to put it there — so explanation goes
 * under the label (`sub`) and only a short suffix (`note`) rides beside the figure.
 */
export function RankedBars({ rows, unit, fmt = fmtInt }: {
  rows: RankRow[]; unit: string; fmt?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2" aria-label={unit}>
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,40%)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,18rem)_1fr_auto]">
          <span className="min-w-0" title={r.title ?? r.label}>
            <span className="block truncate text-ink-700">{r.label}</span>
            {r.sub && <span className="block truncate text-xs text-ink-400">{r.sub}</span>}
          </span>
          <span className="h-2.5 overflow-hidden rounded-full bg-ink-100">
            <span className="block h-full rounded-full bg-accent-600 transition-[width] duration-500"
              style={{ width: `${pct(r.value, max)}%` }} />
          </span>
          <span className="whitespace-nowrap text-right text-sm font-semibold tabular-nums text-brand-700">
            {fmt(r.value)}
            {r.note && <span className="ml-1 font-normal text-ink-400">{r.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A ranking whose every row is one total split in two — submitted and not, for one person.
 *
 * TWO STEPS OF ONE HUE, not two hues. The parts are halves of a whole rather than two
 * things being compared, so a sequential pair reads correctly and sidesteps the fact that
 * this app has no validated two-hue categorical pair (see the file header). A 2px surface
 * gap keeps the two fills from touching, because an adjacent colour boundary is where a
 * reader's eye invents an edge the data does not have.
 */
export function SplitBars({ rows, aLabel, bLabel }: {
  rows: { label: string; a: number; b: number; total: number }[];
  aLabel: string; bLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.label} className="grid grid-cols-[minmax(0,40%)_1fr_auto] items-center gap-3 text-sm sm:grid-cols-[minmax(0,14rem)_1fr_4rem]">
            <span className="truncate text-ink-700" title={r.label}>{r.label}</span>
            <span className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-ink-100"
              style={{ width: `${pct(r.total, max)}%` }}
              title={`${r.label}: ${r.a} ${aLabel.toLowerCase()}, ${r.b} ${bLabel.toLowerCase()}`}>
              <span className="block h-full rounded-l-full bg-accent-600" style={{ width: `${pct(r.a, r.total)}%` }} />
              <span className="block h-full rounded-r-full bg-accent-200" style={{ width: `${pct(r.b, r.total)}%` }} />
            </span>
            <span className="text-right font-semibold tabular-nums text-brand-700">{r.total}</span>
          </li>
        ))}
      </ul>
      <Legend items={[{ label: aLabel, className: "bg-accent-600" }, { label: bLabel, className: "bg-accent-200" }]} />
    </div>
  );
}

export function Legend({ items }: { items: { label: string; className: string; value?: ReactNode }[] }) {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5 text-xs text-ink-600">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${i.className}`} aria-hidden />
          {i.label}
          {i.value !== undefined && <span className="font-semibold text-ink-800 tabular-nums">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

// ── Over time ────────────────────────────────────────────────────────────────

const AXIS = "text-[10px] fill-ink-400";

/** How many x labels fit without colliding — every nth, never all of them. */
const strideFor = (n: number, width: number) => Math.max(1, Math.ceil(n / Math.max(2, Math.floor(width / 54))));

/**
 * A count per period. Bars on a shared baseline with a 2px gap, one hue, and a hover
 * tooltip: an SVG chart in a browser is interactive, so the detail behind a bar does not
 * need a second chart to live in.
 *
 * `detail` turns a bar's hover into the breakdown behind it — which is how a dozen
 * submitters are shown without a dozen hues that no palette here can supply.
 */
export function TimeBars({ points, cadence, unit, detail, height = 160 }: {
  points: { bucket: string; value: number }[];
  cadence: string; unit: string;
  detail?: (b: string) => { label: string; value: number }[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = height, padL = 36, padB = 22, padT = 8;
  const max = Math.max(1, ...points.map((p) => p.value));
  const innerW = W - padL - 8, innerH = H - padB - padT;
  const slot = innerW / Math.max(1, points.length);
  const barW = Math.max(2, Math.min(40, slot - 2));
  const stride = strideFor(points.length, innerW);
  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`${unit} per ${cadence.toLowerCase()}, ${points.length} periods`}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const y = padT + innerH - (t / max) * innerH;
          return (
            <g key={t}>
              <line x1={padL} x2={W - 8} y1={y} y2={y} className="stroke-ink-200" strokeWidth={1} />
              <text x={padL - 6} y={y + 3} textAnchor="end" className={AXIS}>{fmtInt(t)}</text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const bh = (p.value / max) * innerH;
          const x = padL + i * slot + (slot - barW) / 2;
          return (
            <g key={p.bucket}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent"
                onMouseEnter={() => setHover(i)} />
              <rect x={x} y={padT + innerH - bh} width={barW} height={Math.max(bh, p.value > 0 ? 2 : 0)}
                rx={Math.min(4, barW / 2)}
                className={hover === i ? "fill-accent-700" : "fill-accent-600"} pointerEvents="none" />
              {i % stride === 0 && (
                <text x={padL + i * slot + slot / 2} y={H - 6} textAnchor="middle" className={AXIS}>
                  {bucketText(p.bucket, cadence)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <Tooltip index={hover!} count={points.length}>
          <div className="font-semibold">{bucketText(h.bucket, cadence)}</div>
          <div className="tabular-nums">{fmtInt(h.value)} {unit}</div>
          {detail?.(h.bucket).slice(0, 8).map((d) => (
            <div key={d.label} className="flex justify-between gap-3 text-ink-300">
              <span className="truncate">{d.label}</span><span className="tabular-nums">{d.value}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/**
 * A running total. A 2px line over a faint fill of the same hue, with an 8px marker and a
 * crosshair on hover — the fill says "this accumulates", the line carries the value.
 */
export function TimeArea({ points, cadence, unit, fmt = fmtInt }: {
  points: { bucket: string; value: number }[]; cadence: string; unit: string;
  fmt?: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 190, padL = 68, padB = 22, padT = 10;
  const max = Math.max(1, ...points.map((p) => p.value));
  const innerW = W - padL - 10, innerH = H - padB - padT;
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${padT + innerH} L${x(0).toFixed(1)},${padT + innerH} Z`;
  const stride = strideFor(points.length, innerW);
  const ticks = [0, max / 2, max];
  const h = hover !== null ? points[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label={`${unit}, cumulative over ${points.length} periods`}
        onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - 10} y1={y(t)} y2={y(t)} className="stroke-ink-200" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" className={AXIS}>{fmt(t)}</text>
          </g>
        ))}
        <path d={area} className="fill-accent-100" />
        <path d={line} className="stroke-accent-600" strokeWidth={2} fill="none"
          strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <g key={p.bucket}>
            <rect x={x(i) - innerW / Math.max(1, points.length) / 2} y={padT}
              width={innerW / Math.max(1, points.length)} height={innerH} fill="transparent"
              onMouseEnter={() => setHover(i)} />
            {hover === i && <line x1={x(i)} x2={x(i)} y1={padT} y2={padT + innerH} className="stroke-ink-300" strokeWidth={1} />}
            <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 5 : 4}
              className="fill-accent-600 stroke-white" strokeWidth={2} pointerEvents="none" />
            {i % stride === 0 && (
              <text x={x(i)} y={H - 6} textAnchor="middle" className={AXIS}>{bucketText(p.bucket, cadence)}</text>
            )}
          </g>
        ))}
      </svg>
      {h && (
        <Tooltip index={hover!} count={points.length}>
          <div className="font-semibold">{bucketText(h.bucket, cadence)}</div>
          <div className="tabular-nums">{fmt(h.value)} {unit}</div>
        </Tooltip>
      )}
    </div>
  );
}

/** Follows the hovered mark, and flips side near the right edge so it never leaves the card. */
function Tooltip({ index, count, children }: { index: number; count: number; children: ReactNode }) {
  const left = count <= 1 ? 50 : (index / (count - 1)) * 100;
  const flip = left > 62;
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 min-w-36 max-w-60 rounded-md bg-ink-900/95 px-2.5 py-1.5 text-xs text-white shadow-float"
      style={{ left: `${Math.min(Math.max(left, 2), 98)}%`, transform: `translateX(${flip ? "-100%" : "0"})` }}
    >
      {children}
    </div>
  );
}

// ── Two readings per category ────────────────────────────────────────────────

/**
 * Auto-scorer against the team, one row per decision.
 *
 * A DUMBBELL, NOT GROUPED BARS, and for a reason worth keeping: grouped bars need two hues
 * a reader can tell apart, and this app's two ramps are both blue, so no pair of steps
 * clears the normal-vision ΔE floor (see the file header). Here identity comes from shape
 * and a direct label instead — a hollow mark for the engine, a solid one for the team —
 * so it survives any colour vision, and greyscale printing, intact.
 *
 * It also answers the question better. What a reader wants from this chart is where the
 * engine and the people DISAGREE, and a dumbbell draws that disagreement as the length of
 * the connector rather than leaving it to be inferred from two bar heights.
 */
export function Dumbbell({ rows, aLabel, bLabel }: {
  rows: { label: string; a: number; b: number }[]; aLabel: string; bLabel: string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const head = "text-[10px] font-semibold uppercase tracking-wide text-ink-400";
  return (
    <div>
      {/* The two figures live in FIXED COLUMNS rather than beside their marks. Floating
          labels collide whenever the two readings are close — which is precisely the case a
          reader is looking at this chart to judge — and a label that has been nudged clear
          of its mark starts to look as if it belongs to the row above. */}
      <div className="grid grid-cols-[minmax(0,5.5rem)_1fr_2.75rem_2.75rem] items-end gap-3 pb-1 text-sm">
        <span />
        <span />
        <span className={`${head} text-right`}>Engine</span>
        <span className={`${head} text-right`}>Team</span>
      </div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const [lo, hi] = [Math.min(r.a, r.b), Math.max(r.a, r.b)];
          return (
            <li key={r.label} className="grid grid-cols-[minmax(0,5.5rem)_1fr_2.75rem_2.75rem] items-center gap-3 text-sm">
              <span className="truncate text-ink-700">{r.label}</span>
              <span className="relative block h-6" title={`${r.label}: ${aLabel} ${r.a}, ${bLabel} ${r.b}`}>
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-100" />
                <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent-200"
                  style={{ left: `${pct(lo, max)}%`, width: `${pct(hi - lo, max)}%` }} />
                <Mark at={pct(r.a, max)} hollow />
                <Mark at={pct(r.b, max)} />
              </span>
              <span className="text-right tabular-nums text-ink-600">{r.a}</span>
              <span className="text-right font-semibold tabular-nums text-brand-700">{r.b}</span>
            </li>
          );
        })}
      </ul>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        <li className="flex items-center gap-1.5 text-xs text-ink-600">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-accent-600 bg-white" aria-hidden />{aLabel}
        </li>
        <li className="flex items-center gap-1.5 text-xs text-ink-600">
          <span className="h-2.5 w-2.5 rounded-full bg-accent-600" aria-hidden />{bLabel}
        </li>
      </ul>
    </div>
  );
}

function Mark({ at, hollow = false }: { at: number; hollow?: boolean }) {
  return (
    <span
      className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white ${hollow ? "border-2 border-accent-600 bg-white" : "bg-accent-600"}`}
      style={{ left: `${at}%` }}
    />
  );
}

// ── Signed money ─────────────────────────────────────────────────────────────

/**
 * One bar per application, about a zero line: secured and pending to the right, declined to
 * the left. Polarity is the job, so this is the one chart here with two hues — and they are
 * the app's status colours, because these bars ARE states.
 *
 * Every bar carries its figure, which the gold's 2.95:1 against white makes a requirement
 * rather than a nicety.
 */
export function DivergingBars({ rows }: {
  rows: { label: string; funder: string; value: number; outcome: string }[];
}) {
  const span = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const tone = (o: string) =>
    o.startsWith("Secured") ? "bg-good-700" : o.startsWith("Unsecured") ? "bg-bad-600" : "bg-gold-700";
  return (
    <div>
      <ul className="space-y-1.5">
        {rows.map((r) => {
          const w = (Math.abs(r.value) / span) * 50;
          const neg = r.value < 0;
          return (
            <li key={`${r.label}-${r.funder}`} className="grid grid-cols-[minmax(0,34%)_1fr] items-center gap-3 text-sm sm:grid-cols-[minmax(0,16rem)_1fr]">
              <span className="truncate text-ink-700" title={`${r.label} — ${r.funder}`}>{r.label}</span>
              <span className="relative block h-5">
                <span className="absolute left-1/2 top-0 h-full w-px bg-ink-300" aria-hidden />
                <span
                  className={`absolute top-1/2 h-3 -translate-y-1/2 ${tone(r.outcome)} ${neg ? "rounded-l" : "rounded-r"}`}
                  style={neg ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }}
                  title={`${r.outcome}: ${fmtUsd(r.value, true)}`}
                />
                <span className={`absolute top-1/2 -translate-y-1/2 text-[11px] font-semibold tabular-nums text-ink-600 ${neg ? "text-right" : ""}`}
                  style={neg ? { right: `calc(50% + ${w}% + 6px)` } : { left: `calc(50% + ${w}% + 6px)` }}>
                  {fmtUsd(r.value)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      <Legend items={[
        { label: "Secured", className: "bg-good-700" },
        { label: "Requested (pending)", className: "bg-gold-700" },
        { label: "Unsecured (declined)", className: "bg-bad-600" },
      ]} />
    </div>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** Rows a reader scans rather than compares — not every answer is a chart. */
export function DataTable<T>({ rows, cols, keyOf, empty }: {
  rows: T[];
  cols: { head: string; cell: (r: T) => ReactNode; align?: "right"; width?: string }[];
  keyOf: (r: T, i: number) => string;
  empty?: string;
}) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-ink-400">{empty ?? "Nothing to show."}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-152 border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            {cols.map((c) => (
              <th key={c.head} scope="col"
                className={`px-3 py-2 font-semibold ${c.align === "right" ? "text-right" : ""}`}
                style={c.width ? { width: c.width } : undefined}>{c.head}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyOf(r, i)} className="border-b border-ink-100 last:border-0 hover:bg-ink-50">
              {cols.map((c) => (
                <td key={c.head} className={`px-3 py-2.5 ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
