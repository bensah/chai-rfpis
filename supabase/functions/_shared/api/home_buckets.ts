/**
 * The Dashboard's figures, as SELECTIONS rather than counts.
 *
 * Every number on the Dashboard is now a door: click 17 Awaiting review and you get those
 * seventeen. That only works honestly if the number and the list come from the SAME
 * selection — otherwise the tile says 17, the page lists 19, and a reader has no way to
 * tell which lied. Two counts of one thing is the drift this codebase keeps fighting; a
 * count and a list of one thing is the same hazard wearing a different hat.
 *
 * So each figure is defined once, here, as a function from rows to rows. `/home` counts
 * what these return and `/opportunities/list` tags each row with the buckets it belongs
 * to. Neither owns a predicate of its own.
 *
 * ROWS AND APPLICATIONS ARE NOT THE SAME UNIT, and four of these figures are in the second
 * one. A proposal sent to the same funder twice is TWO applications and ONE row
 * (`submissionWeight`, core/records.py). So "Applications sent 24" can open a list of 21
 * opportunities without anything being wrong, and `kind` says which unit a bucket counts
 * in so the page can tell the reader that rather than look broken.
 *
 * The three stage selectors (`liveProceeds`, `selectSubmittedRows`, `selectOutcomeRows`)
 * are the Pipeline stages' OWN membership tests, imported rather than re-expressed, for
 * the reason routes_phase1 already records: a fresh `.filter()` here is a second opinion,
 * and the first draft of the Dashboard excluded two rows those selectors include.
 */
import type { Json } from "./jwt.ts";
import { str } from "./http.ts";
import { ledgerGap, submissionWeight } from "./money.ts";
import {
  deadlinePassed, liveProceeds, selectOutcomeRows, selectSubmittedRows,
} from "./routes_pipelines.ts";

const norm = (v: unknown) => str(v).trim().toLowerCase();
/** routes_phase1's `truthy`, not `=== true`.
 *
 * The column arrives as a real boolean from PostgREST and as the string "true" from some
 * importers, and the Dashboard's own `unique` has always read it this way. The three stage
 * selectors use `!== true` instead, which is a real (if narrow) difference between them —
 * so this is used only for the buckets that derive from `unique`, and the stage selectors
 * keep their own test. Picking one for both here would silently move a number. */
const truthy = (v: unknown) => v === true || v === "true" || v === "t" || v === 1;
const notDuplicate = (r: Json) => !truthy(r.is_duplicate);

/** The same date coercion routes_phase1 uses for a deadline column that holds an ISO date,
 *  an ISO timestamp, or something unparseable. */
const asDate = (v: unknown): string | null => {
  const s = str(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** What a bucket counts in. `rows` is one call; `applications` weighs each row by how many
 *  times it was actually sent, so the figure can exceed the number of rows behind it. */
export type BucketKind = "rows" | "applications";

export type Bucket = {
  key: string;
  /** What the Dashboard calls it, so the list can say what it is showing. */
  label: string;
  kind: BucketKind;
  /** One line a reader can check the selection against. */
  rule: string;
  select: (rows: Json[], today: string) => Json[];
};

/**
 * Every figure the Dashboard makes clickable, in the order it reads on the page.
 *
 * `rows` here is EVERY row the tenant can see, duplicates included, because the stage
 * selectors drop duplicates themselves and `found` has to do it at a point where it can be
 * counted. Each selector is responsible for its own exclusion, exactly as it is on the
 * stage it came from.
 */
export const BUCKETS: Bucket[] = [
  {
    key: "found", label: "Calls found", kind: "rows",
    rule: "Every call that is not a duplicate of another.",
    select: (rows) => rows.filter(notDuplicate),
  },
  {
    // STILL OPEN, which is the owner's rule (2026-11-10): "flagging undecided should only
    // be for those calls that are still live and open". A call whose deadline went by
    // months ago is not work anybody can do, and listing it as awaiting a decision asks
    // for one that cannot be acted on. It moves to `expired_unreviewed` instead, so the
    // count of what was never looked at is still there to be read — just not as a prompt.
    key: "awaiting_review", label: "Awaiting review", kind: "rows",
    rule: "Still open, and nobody has recorded a decision yet.",
    select: (rows, today) => rows.filter((r) =>
      notDuplicate(r) && norm(r.decision) === "" && !deadlinePassed(r, today)),
  },
  {
    key: "expired_unreviewed", label: "Expired unreviewed", kind: "rows",
    rule: "The deadline passed before anybody decided. Nothing to do, but worth knowing.",
    select: (rows, today) => rows.filter((r) =>
      notDuplicate(r) && norm(r.decision) === "" && deadlinePassed(r, today)),
  },
  {
    /**
     * THE ARCHIVE. Every call whose deadline has gone by, decided or not — the owner's
     * ask, in their words: "move all deadline expired rfps to Archive whether decision is
     * taken or not".
     *
     * IT HIDES NOTHING, because a row belongs to as many buckets as describe it. A
     * proposal submitted before the deadline and still with the funder is archived AND
     * awaiting an answer, so it keeps appearing under `awaiting_answer` and on the
     * Submitted stage. Archiving is a statement about the CALL — its door is shut — not
     * about our work on it, and an exclusive bucket would have quietly buried live
     * applications the moment their deadline passed.
     *
     * A call with no deadline is never archived: see `deadlinePassed`.
     */
    key: "archived", label: "Archived", kind: "rows",
    rule: "The call's deadline has passed. Kept for the record; no longer asking for a decision.",
    select: (rows, today) => rows.filter((r) => notDuplicate(r) && deadlinePassed(r, today)),
  },
  {
    key: "reviewed", label: "Reviewed", kind: "rows",
    rule: "A person has recorded a decision — proceed, park or decline.",
    select: (rows) => rows.filter((r) => notDuplicate(r) && norm(r.decision) !== ""),
  },
  {
    // Prefix, not equality: "Proceed as sub" is proceeding. views/tracking_rfp.py filters
    // the same way, and the Screened stage matches by prefix for the same reason.
    key: "proceed", label: "Proceed", kind: "rows",
    rule: "The team decided to bid, including as a sub-applicant.",
    select: (rows) => rows.filter((r) => notDuplicate(r) && norm(r.decision).startsWith("proceed")),
  },
  {
    key: "parked", label: "Parked", kind: "rows",
    rule: "Set aside — not pursued now, not ruled out.",
    select: (rows) => rows.filter((r) => notDuplicate(r) && norm(r.decision) === "park"),
  },
  {
    key: "declined", label: "Declined", kind: "rows",
    rule: "The team decided not to bid.",
    select: (rows) => rows.filter((r) => notDuplicate(r) && norm(r.decision) === "decline"),
  },
  {
    // BIDDING'S QUESTION, ASKED BIDDING'S WAY — routes_phase1 explains at length why this
    // is `liveProceeds` and not every row whose decision reads Proceed: a call already
    // with the funder, discontinued, or duplicated needs no action before its deadline.
    key: "due_in_14_days", label: "Due in 14 days", kind: "rows",
    rule: "A live bid whose deadline falls within the next fortnight.",
    select: (rows, today) => {
      const soon = new Date(Date.parse(today) + 14 * 86400_000).toISOString().slice(0, 10);
      return liveProceeds(rows.filter(notDuplicate), today)
        .filter((r) => {
          const d = asDate(r.call_submission_deadline);
          return d !== null && d >= today && d <= soon;
        })
        .sort((a, b) =>
          str(a.call_submission_deadline) < str(b.call_submission_deadline) ? -1 : 1);
    },
  },
  {
    key: "applications_sent", label: "Applications sent", kind: "applications",
    rule: "Everything that reached a funder, whether or not they have answered.",
    select: (rows) => [...selectSubmittedRows(rows), ...selectOutcomeRows(rows)],
  },
  {
    key: "awaiting_answer", label: "Awaiting answer", kind: "applications",
    rule: "With a funder, who has not yet approved or declined it.",
    select: (rows) => selectSubmittedRows(rows),
  },
  {
    key: "approved", label: "Approved", kind: "applications",
    rule: "The funder said yes.",
    select: (rows) => selectOutcomeRows(rows).filter((r) => norm(r.donor_decision) === "approved"),
  },
  {
    key: "not_approved", label: "Not approved", kind: "applications",
    rule: "The funder said no.",
    select: (rows) => selectOutcomeRows(rows).filter((r) => norm(r.donor_decision) === "not approved"),
  },
  {
    // Surfaced rather than absorbed: a row a funder has decided on but nobody marked
    // Completed weighs zero applications, so the bars do not add up and the reason is
    // this. The list is how somebody fixes it.
    key: "ledger_gap", label: "Answered but not counted", kind: "rows",
    rule: "A funder has answered, but progress never reached Completed, so it weighs " +
      "nothing in the application figures.",
    select: (rows) => ledgerGap(selectOutcomeRows(rows) as never[]) as Json[],
  },
];

export const BUCKET = new Map(BUCKETS.map((b) => [b.key, b]));

/** What a bucket's figure is: rows counted, or applications weighed. ONE function, so the
 *  tile and the list cannot disagree about the unit any more than about the selection. */
export function measure(b: Bucket, rows: Json[], today: string): number {
  const picked = b.select(rows, today);
  return b.kind === "applications"
    ? picked.reduce((a, r) => a + submissionWeight(r as never), 0)
    : picked.length;
}

/** Which buckets each row belongs to, keyed by uid.
 *
 * Computed server-side and sent with the list so the browser filters by MEMBERSHIP rather
 * than by re-deriving "awaiting review" in TypeScript — which would be the second
 * definition this module exists to prevent, just moved one layer out.
 */
export function membership(rows: Json[], today: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const b of BUCKETS) {
    for (const r of b.select(rows, today)) {
      const uid = str(r.uid);
      if (!uid) continue;
      const got = out.get(uid);
      if (got) got.push(b.key);
      else out.set(uid, [b.key]);
    }
  }
  return out;
}
