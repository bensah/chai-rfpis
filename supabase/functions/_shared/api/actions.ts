/**
 * Meeting Actions (app_pages/actions.py) — the server half.
 *
 * Four tabs over two tables and one settings blob:
 *
 *   Meetings     meeting_logs for one week, with the check-in rota on top
 *   Engagements  engagement_logs — every donor-facing touchpoint
 *   Pending      everything still open across BOTH tables, on one screen
 *   Schedule     the Monday check-in rota (tenant_settings.schedule_json)
 *
 * PENDING IS THE POINT OF THE PAGE. The other three are logs; Pending is the screen
 * somebody reads on a Monday morning before the call, which is why unresolved items from
 * two different tables are merged into one list with owners and counts rather than left as
 * two "show unresolved" expanders on two tabs.
 *
 * THE RESOLVED FLAG MEANS THE SAME THING IN BOTH TABLES, and reading the Python carefully
 * is what settles that. `views/pending_actions.py` does carry an "outcome non-empty"
 * fallback for engagements — but it is reached only when the SELECT ITSELF FAILS because
 * `is_resolved` does not exist, which is the pre-migration-014 schema. When the column is
 * there, both tables do `fillna(False)`, so a NULL is OPEN.
 *
 * That distinction is not cosmetic. Treating a NULL as "fall back to the outcome" closes
 * every old engagement somebody wrote an outcome into without ticking it — which is most
 * of them — and the Pending tab then shows an empty list where the Streamlit page shows
 * work outstanding. See `engagementOpen`.
 *
 * One route serves all four tabs. They are read together on every open, they are small
 * (hundreds of rows, not thousands), and four round trips to paint one screen is how a
 * Monday-morning page comes to feel slow.
 */
import { q, type Db } from "./db.ts";

type Row = Record<string, unknown>;

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const day = (v: unknown): string | null => {
  const d = s(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
};

/** `core/review_week.py::week_bounds` — (Monday, Sunday) of the ISO week holding `d`. */
export function weekBounds(iso: string): { monday: string; sunday: string } {
  const [y, m, dd] = iso.slice(0, 10).split("-").map(Number);
  const t = Date.UTC(y, m - 1, dd);
  // getUTCDay is 0 for Sunday; the Python's weekday() is 0 for Monday.
  const weekday = (new Date(t).getUTCDay() + 6) % 7;
  const mon = new Date(t - weekday * 86400000);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return { monday: fmt(mon), sunday: fmt(sun) };
}

/** `core/review_week.py::review_week_label` — "Week 22 (25 May - 31 May)". */
export function weekLabel(iso: string): string {
  const { monday, sunday } = weekBounds(iso);
  const d = new Date(`${monday}T00:00:00Z`);
  // ISO week number: Thursday of this week decides which year's week it is.
  const th = new Date(d.getTime() + 3 * 86400000);
  const jan1 = Date.UTC(th.getUTCFullYear(), 0, 1);
  const week = Math.floor((th.getTime() - jan1) / 86400000 / 7) + 1;
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmt = (x: string) => {
    const [, mm, dd] = x.split("-");
    return `${Number(dd)} ${MON[Number(mm) - 1]}`;
  };
  return `Week ${week} (${fmt(monday)} - ${fmt(sunday)})`;
}

export type Note = {
  id: string;
  meetingDate: string | null;
  rfpUid: string;
  donorTitle: string;
  remarks: string;
  actions: string;
  owner: string;
  deadline: string | null;
  resolved: boolean;
  createdAt: string | null;
};

export type Engagement = {
  id: string;
  date: string | null;
  donor: string;
  type: string;
  format: string;
  internalLead: string;
  donorContacts: string;
  purpose: string;
  outcome: string;
  rfpUid: string;
  /** `fillna(False)`: a NULL reads as not resolved, so this is never null. */
  resolved: boolean;
  open: boolean;
};

export type RotaEntry = { date: string; noteTaker: string; presenter: string; chair: string; cid: string };

/**
 * Is this engagement still open? Anything that is not explicitly resolved.
 *
 * `df["is_resolved"].fillna(False)` — a NULL is False, which is open. The Python's
 * "outcome non-empty" proxy is NOT this branch: it lives in the `except` around a select
 * that fails because the column is missing, i.e. a schema older than migration 014. This
 * deployment has the column, so that path is unreachable here and is deliberately not
 * ported — porting it would silently close every engagement with an outcome typed into it
 * and no tick, which is most of the older ones.
 */
export const engagementOpen = (r: Row): boolean => r.is_resolved !== true;

const note = (r: Row): Note => ({
  id: s(r.id),
  meetingDate: day(r.meeting_date),
  rfpUid: s(r.rfp_uid).trim(),
  donorTitle: s(r.donor_title).trim(),
  remarks: s(r.remarks).trim(),
  actions: s(r.actions).trim(),
  owner: s(r.owner).trim(),
  deadline: day(r.deadline),
  resolved: r.is_resolved === true,
  createdAt: s(r.created_at) || null,
});

const engagement = (r: Row): Engagement => ({
  id: s(r.id),
  date: day(r.engagement_date),
  donor: s(r.donor).trim(),
  type: s(r.engagement_type).trim(),
  format: s(r.format).trim(),
  internalLead: s(r.internal_lead).trim(),
  donorContacts: s(r.donor_contacts).trim(),
  purpose: s(r.purpose).trim(),
  outcome: s(r.outcome).trim(),
  rfpUid: s(r.linked_rfp_uid).trim(),
  resolved: r.is_resolved === true,
  open: engagementOpen(r),
});

/**
 * `_first_name` / `_owner_summary` — who owes what, counted per PERSON.
 *
 * An owner cell holding "Alex Kim, Jane Doe" is two people each owing one, not one owner
 * called "Alex Kim, Jane Doe". Splitting on the comma is what makes the summary line add up
 * to more than the number of items, which is correct and occasionally surprising.
 *
 * A BLANK OWNER CONTRIBUTES NOBODY. `_first_name` does return "(unassigned)", but the
 * Python's explode drops every empty piece before it is ever called, so an unowned action
 * is simply absent from this line rather than attributed to a person called "(unassigned)".
 * The port had it the other way round and invented an owner with two open items out of two
 * blank cells.
 *
 * Counted on the first name alone, because that is how the rota and the team talk about
 * each other — so two people sharing a first name are counted together. The Python does
 * that too; asserting it means changing it has to be a decision.
 *
 * TIES KEEP FIRST-MENTIONED ORDER, which is what `value_counts` leaves behind: its sort is
 * stable over a count that was built in encounter order. Sorting ties by name instead reads
 * better and would put this page's line in a different order from the Streamlit one, for a
 * list the two apps are meant to show identically while both are live.
 */
export function ownerCounts(owners: string[]): { name: string; items: number }[] {
  const counts = new Map<string, number>();
  for (const raw of owners) {
    for (const piece of s(raw).split(",")) {
      const p = piece.trim();
      if (!p) continue;
      const first = p.split(/\s+/)[0];
      if (!first) continue;
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
  }
  // Map iteration is insertion order, so a stable sort on the count alone leaves ties in
  // the order the names were first seen — the Python's order.
  return [...counts.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => b.items - a.items);
}

export type ActionsPayload = {
  week: { monday: string; sunday: string; label: string };
  rota: RotaEntry | null;
  /** Every Monday that has notes, newest first — the week picker's options. */
  weeks: string[];
  notes: Note[];
  engagements: Engagement[];
  pending: {
    notes: Note[];
    engagements: Engagement[];
    meetingTotal: number; meetingOpen: number; meetingPct: number;
    engagementTotal: number; engagementOpen: number; engagementPct: number;
    owners: { name: string; items: number }[];
  };
  schedule: RotaEntry[];
  /** Quarter-to-date engagements — the page's KR2.2 target is 2–4 a quarter. */
  quarter: { from: string; count: number };
};

export function buildActions(input: {
  notes: Row[]; engagements: Row[]; schedule: RotaEntry[]; week: string; today: string;
}): ActionsPayload {
  const { monday, sunday } = weekBounds(input.week);
  const allNotes = input.notes.map(note);
  const allEngagements = input.engagements.map(engagement);

  const openNotes = allNotes.filter((n) => !n.resolved);
  const openEngagements = allEngagements.filter((e) => e.open);
  const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

  // Quarter to date, for the engagement target. The quarter the CALENDAR is in, not a
  // rolling ninety days — the target is set per quarter and read at its end.
  const [ty, tm] = input.today.split("-").map(Number);
  const qStart = `${ty}-${String(Math.floor((tm - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;

  return {
    week: { monday, sunday, label: weekLabel(monday) },
    rota: input.schedule.find((r) => r.date === monday) ?? null,
    weeks: [...new Set(allNotes.map((n) => n.meetingDate).filter((d): d is string => !!d))]
      .sort().reverse(),
    // Oldest first inside a week: a meeting's notes are read in the order they were taken.
    notes: allNotes.filter((n) => n.meetingDate === monday)
      .sort((a, b) => s(a.createdAt).localeCompare(s(b.createdAt))),
    engagements: [...allEngagements].sort((a, b) => s(b.date).localeCompare(s(a.date))),
    pending: {
      notes: [...openNotes].sort((a, b) =>
        // A deadline first, soonest first; undated last. An item with no deadline is not
        // urgent-by-default and should not push a dated one down the list.
        (a.deadline ? 0 : 1) - (b.deadline ? 0 : 1)
        || s(a.deadline).localeCompare(s(b.deadline))
        || s(b.meetingDate).localeCompare(s(a.meetingDate))),
      engagements: [...openEngagements].sort((a, b) => s(b.date).localeCompare(s(a.date))),
      meetingTotal: allNotes.length,
      meetingOpen: openNotes.length,
      meetingPct: pct(openNotes.length, allNotes.length),
      engagementTotal: allEngagements.length,
      engagementOpen: openEngagements.length,
      engagementPct: pct(openEngagements.length, allEngagements.length),
      owners: ownerCounts(openNotes.map((n) => n.owner)),
    },
    schedule: input.schedule,
    quarter: {
      from: qStart,
      count: allEngagements.filter((e) => e.date && e.date >= qStart).length,
    },
  };
}

/** The rota, from the tenant's own `schedule_json` — `core/schedule.py::get_schedule`. */
export async function loadSchedule(db: Db, tenantId: string | null): Promise<RotaEntry[]> {
  if (!tenantId) return [];
  const rows = await db.service.get("tenant_settings",
    `select=value&tenant_id=eq.${q(tenantId)}&key=eq.schedule_json&limit=1`).catch(() => [] as Row[]);
  let items: unknown = [];
  try {
    items = JSON.parse(s(rows[0]?.value) || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  // `_clean`: a valid date, the FIRST entry per date wins, sorted ascending.
  const seen = new Set<string>();
  const out: RotaEntry[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Row;
    const d = day(it.date);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push({
      date: d,
      cid: s(it.cid).trim(),
      noteTaker: s(it.note_taker).trim(),
      presenter: s(it.presenter).trim(),
      chair: s(it.chair).trim(),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export const NOTE_FIELDS = "id,meeting_date,rfp_uid,donor_title,remarks,actions,owner,deadline,is_resolved,created_at";
export const ENGAGEMENT_FIELDS =
  "id,engagement_date,donor,engagement_type,format,internal_lead,donor_contacts,purpose,outcome,linked_rfp_uid,is_resolved";
