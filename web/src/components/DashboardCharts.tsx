/**
 * The Dashboard's plotted forms. Hand-rolled like CategoryChart — this app has no
 * charting library and does not need one for three forms.
 *
 * FORM FOLLOWS THE DATA'S JOB, which is why these are the shapes they are:
 *
 *   StageBars      compare magnitude across the pipeline -> bars, ONE hue (sequential).
 *                  Stage order is kept rather than sorted by size: the order is the
 *                  progression, and re-ranking it would hide the drop between stages,
 *                  which is the thing worth seeing.
 *   SegmentedBar   one whole split into three parts, read at a glance -> a tall
 *                  segmented bar, not a donut. Bars on one baseline compare more
 *                  exactly than slices of a circle.
 *   Meter          one ratio against a limit -> a meter on a same-hue track, not a
 *                  two-slice pie.
 *
 * COLOUR. The three decision states carry the app's own status colours, validated
 * rather than eyeballed: good-700 #0f7847, gold-700 #c08e0a, bad-600 #a3303c pass the
 * lightness band, chroma floor, CVD separation (worst adjacent ΔE 13.4 protan) and the
 * normal-vision floor on this surface. The gold sits at 2.88:1 against the page, under
 * the 3:1 bar, so every segment carries a visible label and a figure — that relief is
 * required, not optional, and is why no segment is colour-alone.
 *
 * The same three colours mean the same three things in both bars: good, holding,
 * refused. A reader who learns the decisions bar can read the outcomes one.
 */

const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

export type Part = { label: string; value: number; className: string };

/** The app's status steps, as classes so they stay with the design system. */
export const DECISION_PARTS = {
  good: "bg-good-700",
  holding: "bg-gold-700",
  bad: "bg-bad-600",
} as const;

/**
 * One whole split into parts, as a single bar with a legend beside it.
 *
 * A 2px surface gap separates the segments so two fills never touch — adjacent colour
 * boundaries are where a reader's eye invents an edge that is not in the data.
 */
export function SegmentedBar(
  { parts, total, unit }: { parts: Part[]; total: number; unit: string },
) {
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div
        className="flex h-7 w-full gap-[2px] overflow-hidden rounded-md bg-ink-100"
        role="img"
        aria-label={`${total} ${unit}: ${parts.map((p) => `${p.value} ${p.label}`).join(", ")}`}
      >
        {shown.map((p) => (
          <div
            key={p.label}
            className={`${p.className} flex items-center justify-center transition-[width] duration-500`}
            style={{ width: `${pct(p.value, total)}%` }}
            title={`${p.label}: ${p.value}`}
          >
            {/* Printed on the segment only where it fits; the legend below carries
                every figure, so a narrow segment loses nothing by staying blank. */}
            {pct(p.value, total) >= 12 && (
              <span className="text-xs font-semibold text-white tabular-nums">{p.value}</span>
            )}
          </div>
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${p.className}`} aria-hidden />
            {p.label}
            <span className="font-semibold text-ink-800 tabular-nums">{p.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The pipeline, stage by stage. One hue: these are the same thing measured at five
 * points, not five different things, so colour carries no identity here and the bars
 * are free to be read as pure magnitude.
 */
export function StageBars(
  { stages }: { stages: { label: string; value: number; note?: string }[] },
) {
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <ul className="space-y-2.5" aria-label="The pipeline, stage by stage">
      {stages.map((s) => (
        <li
          key={s.label}
          className="grid grid-cols-[minmax(0,8.5rem)_1fr_3rem] items-center gap-3 text-sm"
        >
          <span className="truncate text-ink-700" title={s.label}>{s.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-ink-100">
            <span
              className="block h-full rounded-full bg-accent-600 transition-[width] duration-500"
              style={{ width: `${pct(s.value, max)}%` }}
            />
          </span>
          <span className="text-right font-semibold text-brand-700 tabular-nums">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** One ratio against a limit, on a same-hue track. */
export function Meter(
  { value, limit, caption }: { value: number; limit: number; caption: string },
) {
  const share = limit > 0 ? Math.min(100, (value / limit) * 100) : 0;
  return (
    <div>
      <div
        className="h-3 w-full overflow-hidden rounded-full bg-accent-100"
        role="img"
        aria-label={caption}
      >
        <div
          className="h-full rounded-full bg-accent-600 transition-[width] duration-500"
          style={{ width: `${share}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-ink-500">{caption}</p>
    </div>
  );
}
