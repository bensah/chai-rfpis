// core/notifications.py's time helpers.

/** Next Friday 06:00 UTC — the auto-scan cron in .github/workflows/scan.yml. */
export function nextScheduledScan(now = new Date()): Date {
  const c = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  c.setUTCDate(c.getUTCDate() + ((5 - now.getUTCDay() + 7) % 7));
  if (c.getTime() <= now.getTime()) c.setUTCDate(c.getUTCDate() + 7);
  return c;
}

/** Compact "in 3d" / "2h ago" label (notifications.relative_time). */
export function relativeTime(ts: number | null, now = Date.now()): string {
  if (ts == null) return "";
  const delta = ts - now;
  const future = delta > 0;
  const secs = Math.abs(delta) / 1000;
  if (secs < 60) return future ? "soon" : "just now";
  const mins = secs / 60;
  const unit = mins < 60 ? `${Math.trunc(mins)}m`
    : mins < 60 * 24 ? `${Math.trunc(mins / 60)}h` : `${Math.trunc(mins / (60 * 24))}d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** strftime('%a %d %b, %H:%M UTC') */
export const fmtScan = (d: Date) =>
  `${DAYS[d.getUTCDay()]} ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;

/** strftime('%a %d %b') of an ISO date */
export function fmtDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${DAYS[d.getUTCDay()]} ${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}
