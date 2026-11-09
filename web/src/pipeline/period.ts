/**
 * The period a Pipeline page is showing.
 *
 * One control across Screened, Review, Track and Summary rather than a different time
 * widget per tab: the owner's point is that a week's work should flow from found through
 * to summarised without changing how you ask for a period. So the period is a value, it
 * lives above the stages, and every stage reads the same one.
 *
 * Ranges are HALF-OPEN — `from` inclusive, `to` exclusive. Matching the API's
 * `gte.from & lt.to` is the smaller reason. The real one is that half-open periods TILE:
 * one period's `to` is exactly the next one's `from`, so a quarter's rows are precisely the
 * sum of its three months' rows and nothing is counted twice or missed at a boundary. That
 * property is what makes a summary agree with the pages underneath it. A closed range would
 * drop or double-count the boundary day depending on whether a timestamp carried a time,
 * and the error would show up only as a total that is quietly one row out.
 *
 * "To date" is not a separate kind. A period whose range contains today is to-date by
 * definition, and `isToDate` only changes how it is labelled.
 *
 * Note what is NOT here: the review-week label. Screened is keyed by `review_week`
 * ("Week 43"), a label the API hands out, not by dates — so that page selects a week from
 * `/pipelines/weeks` and the date grains below drive the date-ranged pages. Deriving the
 * label from a date here would mean reimplementing core/review_week.py in TypeScript and
 * owning a second definition of which week a row belongs to.
 */

export type Grain = "day" | "week" | "month" | "quarter" | "half" | "year";

export type Period =
  | { kind: "grain"; grain: Grain; anchor: string }   // anchor: any ISO date inside it
  | { kind: "custom"; from: string; to: string };     // explicit, half-open

export const GRAINS: { grain: Grain; label: string }[] = [
  { grain: "day", label: "Day" },
  { grain: "week", label: "Week" },
  { grain: "month", label: "Month" },
  { grain: "quarter", label: "Quarter" },
  { grain: "half", label: "Half-year" },
  { grain: "year", label: "Year" },
];

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// Everything is computed in UTC. The alternative is a period that changes which rows it
// covers depending on the reader's timezone, which is worse than being an hour out.
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};
const addDays = (d: Date, n: number) => utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);

/** Monday — the week the team's rhythm actually starts on (the Monday call). */
function startOfWeek(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7;     // Mon = 0 … Sun = 6
  return addDays(d, -day);
}

export const today = (): string => iso(new Date());

/** The week the team is reviewing right now: the one that ENDED last Sunday.
 *
 * A week runs Monday to Sunday. The scan finds calls across that week; the team sits
 * down on the following Monday and reviews what the week just gone turned up. So on
 * that Monday the current week is one day old and holds almost nothing, and opening on
 * it shows an empty screen by construction - every reviewer then changes the selector by
 * hand before they can start.
 *
 * `core/review_week.py::previous_review_week_label` states the same rule for the Python
 * screens and has done since before this app existed; this is that rule, here.
 */
export const previousWeekAnchor = (now = new Date()): string =>
  iso(addDays(startOfWeek(now), -7));

/** Default anchor for a grain. Only WEEK looks back: a month or a quarter has enough in
 *  it that the current one is worth opening on, while a week does not. */
export const defaultAnchor = (grain: Grain): string =>
  grain === "week" ? previousWeekAnchor() : today();

export const periodOf = (grain: Grain, anchor: string = ""): Period =>
  ({ kind: "grain", grain, anchor: anchor || defaultAnchor(grain) });

/** The half-open range a period covers. */
export function rangeOf(p: Period): { from: string; to: string } {
  if (p.kind === "custom") return { from: p.from, to: p.to };
  const d = parse(p.anchor);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (p.grain) {
    case "day": return { from: iso(d), to: iso(addDays(d, 1)) };
    case "week": {
      const s = startOfWeek(d);
      return { from: iso(s), to: iso(addDays(s, 7)) };
    }
    case "month": return { from: iso(utc(y, m, 1)), to: iso(utc(y, m + 1, 1)) };
    case "quarter": {
      const q = Math.floor(m / 3) * 3;
      return { from: iso(utc(y, q, 1)), to: iso(utc(y, q + 3, 1)) };
    }
    case "half": {
      const h = m < 6 ? 0 : 6;
      return { from: iso(utc(y, h, 1)), to: iso(utc(y, h + 6, 1)) };
    }
    case "year": return { from: iso(utc(y, 0, 1)), to: iso(utc(y + 1, 0, 1)) };
  }
}

/** True while the period is still running — what makes a year read "to date". */
export function isToDate(p: Period): boolean {
  const { from, to } = rangeOf(p);
  const now = today();
  return from <= now && now < to;
}

export function labelOf(p: Period): string {
  if (p.kind === "custom") return `${fmtDay(p.from)} – ${fmtDay(addDaysIso(p.to, -1))}`;
  const d = parse(p.anchor);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const running = isToDate(p);
  switch (p.grain) {
    case "day": return running ? "Today" : fmtDay(iso(d));
    case "week": {
      const { from, to } = rangeOf(p);
      const span = `${fmtDay(from)} – ${fmtDay(addDaysIso(to, -1))}`;
      return running ? `This week · ${span}` : span;
    }
    case "month": return `${MONTHS[m]} ${y}${running ? " (to date)" : ""}`;
    case "quarter": return `Q${Math.floor(m / 3) + 1} ${y}${running ? " (to date)" : ""}`;
    case "half": return `${m < 6 ? "H1" : "H2"} ${y}${running ? " (to date)" : ""}`;
    case "year": return `${y}${running ? " (to date)" : ""}`;
  }
}

/** Step the period by whole units. A custom range shifts by its own length. */
export function shift(p: Period, delta: number): Period {
  if (p.kind === "custom") {
    const days = Math.round(
      (parse(p.to).getTime() - parse(p.from).getTime()) / 86_400_000) || 1;
    return { kind: "custom", from: addDaysIso(p.from, days * delta), to: addDaysIso(p.to, days * delta) };
  }
  const d = parse(p.anchor);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const at = (nd: Date): Period => ({ kind: "grain", grain: p.grain, anchor: iso(nd) });
  switch (p.grain) {
    case "day": return at(addDays(d, delta));
    case "week": return at(addDays(d, 7 * delta));
    case "month": return at(utc(y, m + delta, 1));
    case "quarter": return at(utc(y, Math.floor(m / 3) * 3 + 3 * delta, 1));
    case "half": return at(utc(y, (m < 6 ? 0 : 6) + 6 * delta, 1));
    case "year": return at(utc(y + delta, m, 1));
  }
}

/** Keeping the anchor, show the same moment at a different grain. */
export const atGrain = (p: Period, grain: Grain): Period =>
  ({ kind: "grain", grain, anchor: p.kind === "custom" ? p.from : p.anchor });

/** There is nothing to show after the current period — don't offer to walk into it. */
export const canGoForward = (p: Period): boolean => rangeOf(p).to <= today();

const addDaysIso = (s: string, n: number) => iso(addDays(parse(s), n));

function fmtDay(s: string): string {
  const d = parse(s);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}
