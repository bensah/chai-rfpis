/**
 * Pipeline: the week picker, Screened, and Summary.
 *
 * These routes FETCH and SCOPE. They do not score and they do not decide. Duplicate
 * partitioning, the effective decision, KPI buckets, filters and ordering all belong to
 * the page. The contract is docs/PHASE2_API_CONTRACT.md and the split is the owner's
 * (2026-10-26): web/src to the frontend session, these routes here.
 *
 * `alignment_score` and `auto_recommendation` are now STORED values, written by the
 * `rescore` job (owner, 2026-10-28) — they used to be computed per view in the browser on
 * the Pyodide seam. So a row can be carrying a score from before its last edit, for the
 * minute or so the job takes. Every list below therefore also serves `scored_at` and
 * `score_profile_sig`, which is what lets a page say so instead of presenting an old
 * number as settled. They cost almost nothing on the wire despite the signature being 40
 * characters: it is the SAME 40 characters on every row of a tenant, and these responses
 * are gzipped.
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
import { isOutcome, isSubmitted } from "./donor_decision.ts";
import { ratesFor } from "./fx.ts";
import { gzipped, json, str } from "./http.ts";
import {
  ledgerGap, loadCurrencies, requestedCurrency, submissionWeight, usdValue,
} from "./money.ts";
import type { Json } from "./jwt.ts";
import type { Ctx } from "./session.ts";

/** What Screened draws, PLUS what its Confidence column is computed from. Not `*`: see
 * the file header.
 *
 * applicant_role, key_risks and feasibility are drawn: the first is the Role column and
 * the denominator of the Prime and Sub KPIs, the second is a table column, the third is
 * one of the four filters.
 *
 * brief_description and instrument_type are NOT drawn, and are here anyway. They are two
 * of the seven `_CALL_KEY_FIELDS` that `data_quality.call_completeness` counts, which
 * feeds the Confidence band. Dropping brief_description as "unused" — it is about a
 * fifth of this payload, so it is tempting — would make every row look less complete
 * than it is and quietly shift Confidence down a band. A column being invisible is not
 * the same as a column being unused. */
const SCREEN_FIELDS = "uid,opportunity_title,funding_agency,brief_description," +
  "call_award_value,currency,call_submission_deadline,call_geographic_scope," +
  "call_domain_areas,instrument_type,focus_theme,opportunity_link,date_posted," +
  "search_date,submitted_at,created_at,review_week,alignment_score," +
  "auto_recommendation,scored_at,score_profile_sig," +
  "decision,decision_date,donor_decision,progress_status," +
  "applicant_role,key_risks,feasibility,is_duplicate,duplicate_of_uid";

/** Sections A to E aggregate over these. No prose: Summary counts and sums, it does not
 * render a call's description, and dropping `brief_description` alone takes about a fifth
 * off a payload that is already the widest one here. */
const SUMMARY_FIELDS = "uid,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,call_domain_areas,focus_theme," +
  "submitted_at,review_week,alignment_score,auto_recommendation," +
  "scored_at,score_profile_sig,decision," +
  "decision_date,donor_decision,progress_status,is_duplicate,duplicate_of_uid";

/** What the Reviewed stage draws: the call, the verdict, and who reached it when. Carries
 *  prose (title, note) where Summary does not, because this stage is read one row at a
 *  time rather than counted. */
const REVIEWED_FIELDS = "uid,opportunity_title,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,focus_theme,opportunity_link," +
  "submitted_at,search_date,created_at,review_week,alignment_score," + "auto_recommendation,scored_at," +
  "score_profile_sig,decision,decision_note,decision_date,decision_overridden_by," +
  "decision_overridden_at,donor_decision,progress_status,applicant_role," +
  "is_duplicate,duplicate_of_uid";

/** views/tracking_rfp.py draws these, plus proposal_lead for the duplicate-group leads.
 *
 *  `stage` and the four beside it are what the Bidding stage works on: `stage` is the
 *  application's own position (config/dropdowns.yaml's `stages`), and a bid without its
 *  role, lead, next action and due date is a progress bar with nothing under it. */
const TRACK_FIELDS = "uid,opportunity_title,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,focus_theme,opportunity_link," +
  "submitted_at,review_week,alignment_score,scored_at,score_profile_sig," +
  "decision,donor_decision,date_completed," +
  "stage,applicant_role,assigned_to,next_action,action_deadline," +
  "progress_status,proposal_lead,is_duplicate,duplicate_of_uid";

/** What the Submitted stage draws: the proposal that went in, when, and everything needed
 *  to record the funder's answer without opening the editor.
 *
 *  Wider than Bidding's because this stage has to SHOW the gaps as well as the facts —
 *  `date_completed` is how long we have been waiting, `submissions` is how many times it
 *  went in, and `stage` is here only so the page can notice that a submitted row's
 *  application stage still says it was never started (9 of 14, measured 2026-11-03).
 *  `date_of_approval`, `amount_secured` and `currency_secured` are drawn because recording
 *  an Approved answer writes all three and the form has to open on what is already there. */
const SUBMITTED_FIELDS = "uid,opportunity_title,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,focus_theme,opportunity_link," +
  "submitted_at,review_week,alignment_score,scored_at,score_profile_sig," +
  "decision,decision_overridden_at,donor_decision,progress_status,date_completed," +
  "date_of_approval,amount_secured,currency_secured,amount_requested,submissions," +
  "stage,applicant_role,proposal_lead,assigned_to,donor_program_officer," +
  "expected_award_date,next_action,is_duplicate,duplicate_of_uid";

/** What the Outcome stage draws. Money is the point of this stage, so every column the
 *  two totals are computed from is here — `amount_secured` and `currency_secured` for what
 *  was won, `amount_requested` for what was asked, and `currency` only as the legacy
 *  fallback `requestedCurrency` needs. `submissions` and `progress_status` carry the
 *  submission weight, which is what makes these counts agree with the Streamlit page. */
const OUTCOME_FIELDS = "uid,opportunity_title,funding_agency,call_award_value,currency," +
  "call_submission_deadline,call_geographic_scope,focus_theme,opportunity_link," +
  "submitted_at,review_week,alignment_score,scored_at,score_profile_sig," +
  "decision,donor_decision,progress_status,date_completed,date_of_approval," +
  "amount_secured,currency_secured,amount_requested,submissions,applicant_role," +
  "proposal_lead,donor_program_officer,kickoff_date,project_duration," +
  "is_duplicate,duplicate_of_uid";

/**
 * Wider than the decision vocabulary on purpose, and not a drifted copy of it.
 *
 * `core/pipeline.py::is_active_proceed` tests `_txt(decision).startswith("proceed")`, and
 * `tracking_rfp._fetch` narrows the same way in SQL (`.ilike("decision", "Proceed%")`), so
 * this is a PREFIX match rather than membership of a list. It used to be a two-item set
 * here — {"Proceed", "Proceed as sub"} — which admits exactly the same 40 live rows today
 * and would have quietly dropped any other Proceed wording the Python still shows.
 *
 * "Proceed as sub" was retired on 2026-06-06 — the sub signal moved to `applicant_role`
 * (Prime / Sub / Technical) and the decision stays "Proceed" — so nothing writes it any
 * more and `POST /pipelines/decision` refuses it. Rows decided before that date still
 * carry it, and they are still live work, so the READ stays wide enough to include them.
 */
const isProceed = (v: unknown) => norm(v).startsWith("proceed");

/**
 * Strip and lower-case. DELIBERATELY DOES NOT BLANK THE LITERAL "nan", and that is the
 * question a reader of this line will have, because Excel-migrated rows do carry it.
 *
 * Nothing that needs "nan" blanked still comes through here. The submission test moved to
 * `api/donor_decision.ts::isSubmitted`, which has its own `txt()` mirroring
 * `core/pipeline.py::_txt`, and every membership rule — Track, the awaiting panel,
 * Submitted, Outcome — routes through that. What is left on this helper is `decision` and
 * `progress_status`, which are prefix and equality tests that "nan" fails either way, and
 * `dropConcluded`'s donor_decision test.
 *
 * THAT LAST ONE IS WHY THIS MUST STAY AS IT IS. `core/records.py::drop_concluded` strips
 * and lower-cases and does no nan handling either, so the asymmetry between it and
 * `core/pipeline._txt` is real in the Python and reproduced here on purpose. Teaching this
 * helper about "nan" would make `dropConcluded` disagree with the function it mirrors —
 * an audit proposed exactly that, from reading this line alone.
 */
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

/**
 * The label for the week BEFORE the one containing `d` — `core/review_week.py`'s
 * `previous_review_week_label`, and the week the review screens should OPEN on.
 *
 * This is a statement about how the team works rather than a convenience. A week runs
 * Monday to Sunday, the scan collects calls across it, and the team sits down on the
 * following Monday to review what the week just gone turned up. On that Monday the current
 * week is one day old.
 *
 * Measured on the live table on Monday 2026-11-09: the current week held 0 rows and the
 * previous week 2. So opening on the current week opens on nothing, and every reviewer
 * changes the selector by hand before they can start. The Python moved its screens to this
 * default; this app opens on it because of the measurement above, not because that one did.
 *
 * It moves the DEFAULT only. The selector still offers every week of the year and still
 * honours whatever the reader picks.
 */
export function previousReviewWeekLabel(d: Date = new Date()): string {
  const mon = monday(d);
  return reviewWeekLabel(new Date(mon.getTime() - 7 * 86400_000));
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

/** core/review_week.py::monday_from_week_label — "Week 23 (1 Jun - 7 Jun)" → 2026-06-01.
 *
 * Exported because the browser needs label-to-Monday and must not own a second
 * definition of which week a row belongs to. The period model deliberately refuses to
 * derive it, and the scoring drift we just removed is what two definitions of one number
 * looks like after a year.
 *
 * Resolved by SEARCH rather than by week-number arithmetic, and that is a deliberate
 * divergence from `review_week.monday_from_week_label`. The arithmetic version reads only
 * the number and offsets from the week containing Jan 4, which is wrong for one label a
 * year: `all_weeks_for_year` ends a year with the FOLLOWING year's week 1 — 2024's last
 * label is "Week 1 (30 Dec - 5 Jan)" — and the arithmetic sends that back to the January
 * at the START of the year instead. Harmless in the Streamlit selector, which only round
 * trips what it just rendered, but not harmless here: the range filter on Screened
 * decides membership from these Mondays, so a mis-resolved week would put December's
 * screening in January and break the tiling the half-open ranges exist to guarantee.
 *
 * The labels themselves are unambiguous — they carry their own dates — so the Monday is
 * found by relabelling candidates and taking the exact match. That makes the function
 * self-verifying: it can only return a Monday that renders as the label asked for.
 * Returns an ISO date string, or null for a label nothing matches.
 */
export function mondayFromWeekLabel(label: string, year: number): string | null {
  const want = String(label).trim();
  if (!/^Week\s+\d+\s/.test(want)) return null;
  // A year's labels can start in the previous December and end in the next January, so
  // the candidates span three years. About 157 iterations, on a rarely-called path.
  let d = monday(new Date(Date.UTC(year - 1, 0, 4)));
  const end = Date.UTC(year + 2, 0, 15);
  while (d.getTime() <= end) {
    if (reviewWeekLabel(d) === want) return d.toISOString().slice(0, 10);
    d = new Date(d.getTime() + 7 * 86400_000);
  }
  return null;
}

/** The year's labels paired with the Monday each one starts on. */
export function weekMondays(year: number): { label: string; monday: string }[] {
  return allWeeksForYear(year)
    .map((label) => ({ label, monday: mondayFromWeekLabel(label, year) }))
    .filter((w): w is { label: string; monday: string } => w.monday !== null);
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

/** Conditions 2 to 6 of tracking_rfp.py::_fetch, over rows already narrowed to
 * non-duplicates. Exported as a pure function because this filter, not the HTTP around
 * it, is what parity is about: web/scripts/pipelines.test.mjs drives it directly.
 *
 * `today` is passed in rather than read, so a test can pin the deadline boundary.
 */
/**
 * Proceeds that are still live work: decided by a person, not yet with the funder, not
 * completed or discontinued, deadline not passed. Rules 2, 4, 5 and 6 of the Bidding
 * stage, WITHOUT rule 3's found-date window.
 *
 * Split out so the Dashboard's "Due in 14 days" can ask Bidding's question without
 * inheriting Bidding's period. The period belongs to that stage's own control; a call
 * found last November with a deadline next Tuesday is due next Tuesday, and a card that
 * hid it because of when it was found would be answering a question nobody asked.
 *
 * One rule, two entry points. The alternative was for the caller to pass a sentinel window
 * of 1900-2999, and `selectTrackRows(rows, null, today)` does NOT do it: the else-branch
 * compares against `String(year)`, so a null year becomes the string "null", every row
 * fails, and the card reads 0 for ever without erroring.
 */
export function liveProceeds(rows: Json[], today: string): Json[] {
  return rows.filter((r) => {
    // 2. The STORED decision, and only the stored one.
    //
    // THIS DELIBERATELY DISAGREES WITH SCREENED, which uses the effective decision —
    // stored falling back to auto_recommendation. A freshly scanned row whose
    // auto-recommendation is Proceed belongs on Screened and NOT here, until a person has
    // actually decided. Harmonising the two would fill Track with work nobody committed
    // to, which is the opposite of the page's purpose. The prefix match is the same one
    // both pages use; the difference is which column it is applied to.
    if (!isProceed(r.decision)) return false;

    // 4. ANYTHING that records the proposal reaching the funder, which is the shared
    // `is_submitted` and not a test spelled out again here.
    //
    // This line used to be `donor_decision not in {"", "not submitted"}` alone, and that
    // dropped the third of the Python's three branches: a recorded `date_completed` also
    // proves a submission. The effect was a bid that stayed on the board as "in flight"
    // after somebody wrote down the day it went in — and it disagreed with this file's
    // own `awaiting()`, which did test the date. No live row was in that state when the
    // gap was found, so nothing was ever shown wrongly; the test asserting that Bidding's
    // exit and Submitted's entry are one rule is what caught it.
    if (isSubmitted(r)) return false;

    // 5. progress_status OVERRIDES the decision: a Completed or Discontinued row drops
    // out entirely even though its decision is still Proceed, and must not appear in the
    // card, the dropdown or the table. Completed is also one of `is_submitted`'s
    // branches; Discontinued is this rule's alone.
    const ps = norm(r.progress_status);
    if (ps === "completed" || ps === "discontinued") return false;

    // 6. No deadline, or one that has not passed.
    const dl = str(r.call_submission_deadline).slice(0, 10);
    return dl === "" || dl >= today;
  });
}

/**
 * The Bidding stage's rows: `liveProceeds` plus rule 3, when the row arrived — either the
 * year of `submitted_at`, or an explicit half-open range when the period control supplies
 * one. Read off the ISO prefix rather than parsed to an instant, so a row just inside a new
 * year at a positive UTC offset keeps the year its text says, which is the year the Python
 * reads.
 */
export function selectTrackRows(
  rows: Json[],
  year: number | null,
  today: string,
  window?: { from: string; to: string },
): Json[] {
  return liveProceeds(rows, today).filter((r) => {
    const submitted = str(r.submitted_at);
    if (window) {
      const d = submitted.slice(0, 10);
      return !(d === "" || d < window.from || d >= window.to);
    }
    return submitted.slice(0, 4) === String(year);
  });
}

/**
 * Bids that fail ONLY rule 6 — a Proceed the team never recorded as submitted, whose
 * deadline has since passed.
 *
 * Rule 6 is correct and stays: a call whose deadline has gone is not work you can still
 * do, and `is_active_proceed` is shared with the Meetings note-taker, so weakening it here
 * would make two pages disagree. But measured on the live table, it is what removes 15 of
 * the 16 Proceeds — so a Bidding stage that applied it silently would show one bid and
 * look broken, which is the same fault the Reviewed stage shipped with.
 *
 * These are almost certainly submitted work nobody ticked off. `criteria_derive`'s
 * `needs_submission_check` exists for exactly this population and says why: proposals
 * entered from Excel months after they went to the funder arrive with a deadline already
 * past, and if nothing records the submission they read as missed. Returned so the page
 * can ask, rather than quietly dropping a team's year of work off the board.
 */
export function awaiting(rows: Json[], today: string): Json[] {
  return rows.filter((r) => {
    if (!isProceed(r.decision)) return false;
    if (isSubmitted(r)) return false;                    // rule 4, including date_completed
    const ps = norm(r.progress_status);
    if (ps === "completed" || ps === "discontinued") return false;
    const dl = str(r.call_submission_deadline).slice(0, 10);
    return dl !== "" && dl < today;                      // fails rule 6, and only rule 6
  });
}

/**
 * The proposals that are with a funder and have no answer back.
 *
 * MEMBERSHIP IS BIDDING'S EXIT, NOT A SECOND OPINION ABOUT IT. `is_submitted` is one of the
 * six tests in `core/pipeline.is_active_proceed`, so the moment it goes true a row leaves
 * Bidding — and this is the only thing that catches it. Expressing "submitted" any other
 * way here would open a gap between the two stages that a row falls through silently,
 * which is the Reviewed bug in a new place. views/report.py::_submitted_mask is exactly
 * that other way: see ./donor_decision.ts for the two live rows it would lose.
 *
 * The funder answering is what ends the wait, so `isOutcome` is the exit — Approved and
 * Not Approved belong on Outcome. "Under Review" is NOT an outcome: it is somebody
 * recording that we are still waiting, which is this stage exactly.
 *
 * THERE IS NO CLAUSE FOR Discontinued OR Missed, and that is measured rather than
 * overlooked: no canonical row reaches this filter in either state (2026-11-03), because
 * dropping a bid clears none of the three things that prove a submission and setting one
 * is what the Bidding panel's "we dropped it" writes INSTEAD of a submission. If one ever
 * does appear, the row contradicts itself — dropped, yet with the funder — and showing it
 * where somebody can fix it beats hiding it behind a rule nobody could have checked.
 */
export function selectSubmittedRows(rows: Json[]): Json[] {
  return rows.filter((r) =>
    r.is_duplicate !== true && isSubmitted(r) && !isOutcome(r.donor_decision));
}

/**
 * The date a submission counts under, best evidence first:
 *   date_completed   the day somebody recorded it going in — the real thing
 *   submitted_at     the row's own intake date, so a proposal is never undated
 *
 * `decision_overridden_at` IS DELIBERATELY NOT IN THIS LIST, which is where it differs
 * from `decidedOn` above. That function still resolves a save stamp, but nothing FILES a
 * row by it any more: the Reviewed window keys on `foundOn`, because an edit to a settled
 * row was dragging it into the current review week (owner, 2026-11-09). This docstring used
 * to say a save stamp was decent evidence of when a verdict was reached; it is not, for the
 * same reason given here. Here it is evidence of when somebody did bookkeeping: the owner is working
 * through the Bidding backlog today, marking proposals from June and July as submitted, so
 * every one of those rows carries today's stamp. Using it would file a July submission
 * under November and make "submitted this month" a count of data entry.
 *
 * `submitted_at` is the better fallback for the same population: a backdated intake row was
 * entered close to when the proposal actually went to the funder, which is why
 * `criteria_derive.needs_submission_check` exists at all.
 */
export function submittedOn(r: Json): string | null {
  for (const k of ["date_completed", "submitted_at"]) {
    const v = str(r[k]).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  return null;
}

/**
 * The proposals the funder has answered — the end of the line.
 *
 * Exactly the complement of `selectSubmittedRows` within the submitted set, which is what
 * keeps the last two stages from either double-counting an application or losing one: both
 * test `is_submitted`, and `is_outcome` is the only thing that decides which side a row
 * falls on. "Under Review" is not an outcome, so a row carrying it stays on Submitted.
 *
 * `is_submitted` is still required rather than assumed. A funder cannot answer a proposal it
 * never received, so a row with an outcome and nothing else recording a submission is
 * contradictory — but `is_submitted` reads the decision itself as proof, so every answered
 * row passes it anyway. Writing the test out keeps the pair symmetrical, and if the rule
 * ever narrows, this stage narrows with it rather than quietly becoming the wider one.
 */
export function selectOutcomeRows(rows: Json[]): Json[] {
  return rows.filter((r) =>
    r.is_duplicate !== true && isSubmitted(r) && isOutcome(r.donor_decision));
}

/**
 * The date an outcome counts under, best evidence first:
 *   date_of_approval   the day the funder answered — stamped for a decline too
 *   date_completed     the day it went in; the answer came after, never before
 *   submitted_at       the row's own date, so an answer is never undated
 *
 * `date_of_approval` is the column the Streamlit Summary windows both its approved and its
 * secured-value figures on, and it is NOT approvals-only despite the name: one live
 * Not-Approved row carries it. Measured 2026-11-03, 4 of the 8 answered rows have it, so
 * the fallback is doing real work rather than guarding a corner.
 */
/**
 * One answered application, as the Outcome route serves it: the stored row plus the four
 * values this route derives. Named rather than inferred because the inferred type is wrong
 * in a way that compiles elsewhere — see the annotation on `rows` in `outcome()`.
 */
type AnsweredRow = Json & {
  outcome_on: string | null;
  applications: number;
  usd_requested: number;
  usd_secured: number;
};

export function outcomeOn(r: Json): string | null {
  for (const k of ["date_of_approval", "date_completed", "submitted_at"]) {
    const v = str(r[k]).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  return null;
}

/** The leads on a duplicate group belong to the canonical row: a colleague who picked up
 * the duplicate is still the lead. Blanks and non-strings are dropped, then the set is
 * deduplicated and sorted, as the Python does. */
export function leadsFor(rows: Json[], dups: Json[]): { uid: string; proposalLeads: string[] }[] {
  const extra = new Map<string, string[]>();
  for (const d of dups) {
    const of = str(d.duplicate_of_uid);
    const lead = str(d.proposal_lead).trim();
    if (of && lead) extra.set(of, [...(extra.get(of) ?? []), lead]);
  }
  return rows.map((r) => {
    const uid = str(r.uid);
    const own = str(r.proposal_lead).trim();
    const set = new Set([...(own ? [own] : []), ...(extra.get(uid) ?? [])]);
    return { uid, proposalLeads: [...set].sort() };
  });
}

export function createPipelineRoutes(db: Db) {
  /** The week picker: every label for the year, which week is current, which one to open
   * on, and where the data actually is.
   *
   * `current` and `defaultWeek` are BOTH served, and they are different questions.
   * `current` is the week we are in — a fact, and what an empty state means by "this
   * week". `defaultWeek` is the week a review screen should open on, which is the one
   * before it: see `previousReviewWeekLabel`. Collapsing the two would make the page unable
   * to say "nothing found in the week you are looking at" without lying about which week
   * that is. */
  async function weeks(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const year = Number(url.searchParams.get("year")) ||
      new Date().getUTCFullYear();

    const labels = allWeeksForYear(year);
    const current = reviewWeekLabel(new Date());
    const defaultWeek = previousReviewWeekLabel();
    // screened_rfp.py line 67: a week missing from the year's list is prepended rather
    // than dropped, so a selection always exists as an option. Either can be missing when
    // it belongs to a different year than the one being viewed — and `defaultWeek` is the
    // one that goes missing in the first days of January, which is exactly when nobody
    // would be watching for it. Order preserved: previous week, then current.
    const weeksOut = [
      ...[defaultWeek, current].filter((w) => !labels.includes(w)),
      ...labels,
    ];

    // Counts only — this feeds the empty state's "most recent week with activity", so it
    // must never carry rows.
    // getAll, not get: PostgREST caps a response at 1000 rows silently, and this COUNTS.
    // A truncated read would not look short, it would look like a quieter week.
    const rows = await db.as(ctx.scope)
      .getAll("rfp_submissions", "select=review_week,uid", "uid");
    const counts = new Map<string, number>();
    for (const r of rows) {
      const w = str(r.review_week).trim();
      if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const weeksWithData = [...counts.entries()]
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week.localeCompare(b.week));

    return gzipped(req, json({ year, weeks: weeksOut, current, defaultWeek, weeksWithData }));
  }

  /** Screened: one week's rows, or a date range's, concluded ones removed.
   *
   * BOTH, not one or the other. Two different questions get asked of this page. "Show me
   * Week 43" is the Monday-call case: exact, one label, no mapping needed, so `week=`
   * stays. "Show me October" is the period-spine case, and a label is not a date range,
   * so replacing `week=` would force every lookup through a mapping even when the caller
   * already holds the label.
   *
   * A range selects the review_weeks whose own MONDAY falls inside it, not the rows whose
   * submitted_at does. The review_week is the screening period: a row submitted on the
   * Friday of September's last week belongs to that week's screening, and filtering by
   * submitted_at would push it into October and make the weekly and monthly views
   * disagree. Half-open, so the periods tile and a quarter is the sum of its months.
   */
  async function screen(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const week = str(url.searchParams.get("week")).trim();
    const from = str(url.searchParams.get("from")).trim();
    const to = str(url.searchParams.get("to")).trim();
    const sb = db.as(ctx.scope);

    if (week) {
      const rows = await sb.getAll(
        "rfp_submissions",
        `select=${SCREEN_FIELDS}&review_week=eq.${q(week)}`,
        "uid",
      );
      return gzipped(req, json({ week, rows: dropConcluded(rows) }));
    }

    if (!from || !to) {
      return json({ error: "week, or from and to, are required" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
      return json({ error: "from and to must be ISO dates" }, 400);
    }
    if (to <= from) return json({ error: "to must be after from" }, 400);

    // A range can span a year boundary, so every year it touches contributes labels.
    const years = new Set<number>([
      Number(from.slice(0, 4)),
      Number(to.slice(0, 4)),
    ]);
    const labels = [...years]
      .flatMap((y) => weekMondays(y))
      .filter((w) => w.monday >= from && w.monday < to)
      .map((w) => w.label);
    if (!labels.length) return gzipped(req, json({ from, to, weeks: [], rows: [] }));

    const list = labels.map((l) => `"${l.replace(/"/g, '""')}"`).join(",");
    const rows = await sb.getAll(
      "rfp_submissions",
      `select=${SCREEN_FIELDS}&review_week=in.(${encodeURI(list)})`,
      "uid",
    );
    return gzipped(req, json({ from, to, weeks: labels, rows: dropConcluded(rows) }));
  }

  /** Summary: rows for a date window, aggregated in the browser.
   *
   * Windowed rather than aggregated here (owner, 2026-10-27). The ORIGINAL reason has
   * since been removed: the stored score was written under the 70/45 rule while every
   * other page displayed 90/70 over a freshly computed one, so a server-side total would
   * have visibly disagreed with the rest of the app. The thresholds were reconciled to
   * 90/70 (config/scoring_weights.yaml) and the score is now the job's to write, so the
   * stored value and the displayed one are the same number.
   *
   * It still ships rows, for the reason that outlived the bug: the counts are a function
   * of filters and groupings the page owns, and the window keeps the payload a function of
   * what is being looked at rather than of how long the deployment has been running.
   * Aggregating here is now a real option rather than a broken one — worth taking if this
   * payload becomes the slow part, and not before.
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
    const rows = await db.as(ctx.scope).getAll(
      "rfp_submissions",
      `select=${SUMMARY_FIELDS}&submitted_at=gte.${q(from)}&submitted_at=lt.${q(to)}`,
      "uid",
    );
    return gzipped(req, json({ from, to, rows }));
  }

  /** Track: the active Proceed work for a year, and the leads across each duplicate group.
   *
   * Six conditions from tracking_rfp.py::_fetch, and the first of them is the one to be
   * careful with:
   *
   * TRACK AND SCREENED DELIBERATELY DISAGREE. Screened uses the EFFECTIVE decision —
   * stored falling back to auto_recommendation, Proceed matched by startswith — while
   * this filters the STORED column, matched exactly against the two strings. So a freshly
   * scanned row whose auto-recommendation is Proceed shows on Screened and must NOT show
   * here until a person has actually decided. Harmonising the two "for consistency" would
   * fill Track with work nobody has committed to, which is the opposite of the page's
   * purpose.
   *
   * progress_status OVERRIDES the decision: a Completed or Discontinued row drops out
   * entirely even though its decision is still Proceed, and must not appear in the card,
   * the dropdown or the table.
   *
   * Everything is filtered here rather than in PostgREST because a tenant's whole
   * non-duplicate history is small — 148 rows for the largest, measured — and expressing
   * these six in query syntax would trade exact, readable fidelity for nothing. Days to
   * deadline, deadline status and the USD value stay in the browser, which already holds
   * the FX rates from /scoring/snapshot; a second rate source here would drift from it.
   *
   * `/pipelines/outcome` below converts SERVER-SIDE instead, and that is a reversal rather
   * than an inconsistency. The rule above is about not introducing a second rate source;
   * `ratesFor` is the same function the snapshot calls, so calling it one step earlier adds
   * no source. What it buys is a money total that does not depend on the Pyodide scoring
   * seam the migration is retiring. This route keeps the browser conversion because its
   * money is incidental to it, and changing it would be churn.
   */
  async function track(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const from = str(url.searchParams.get("from")).trim();
    const to = str(url.searchParams.get("to")).trim();
    const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
    const today = new Date().toISOString().slice(0, 10);
    const sb = db.as(ctx.scope);

    if ((from || to) && !(from && to)) {
      return json({ error: "from and to must be given together" }, 400);
    }
    if (from && (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to))) {
      return json({ error: "from and to must be ISO dates" }, 400);
    }
    if (from && to <= from) return json({ error: "to must be after from" }, 400);

    const all = await sb.getAll(
      "rfp_submissions",
      `select=${TRACK_FIELDS}&is_duplicate=is.false`,
      "uid",
    );

    // A range replaces condition 3 only. The other five are unchanged, because they are
    // about whether a row is live work rather than when it arrived. Half-open, like
    // Summary, so the periods tile.
    const rows = from
      ? selectTrackRows(all, null, today, { from, to })
      : selectTrackRows(all, year, today);
    const uids = rows.map((r) => str(r.uid)).filter(Boolean);
    let dups: Json[] = [];
    if (uids.length) {
      const list = uids.map((u) => `"${u.replace(/"/g, '""')}"`).join(",");
      dups = await sb.get(
        "rfp_submissions",
        `select=duplicate_of_uid,proposal_lead&is_duplicate=is.true` +
          `&duplicate_of_uid=in.(${encodeURI(list)})`,
      ).catch(() => []);
    }
    const extra = new Map<string, string[]>();
    for (const d of dups) {
      const of = str(d.duplicate_of_uid);
      const lead = str(d.proposal_lead).trim();
      if (of && lead) extra.set(of, [...(extra.get(of) ?? []), lead]);
    }
    const leads = rows.map((r) => {
      const uid = str(r.uid);
      const own = str(r.proposal_lead).trim();
      const set = new Set([...(own ? [own] : []), ...(extra.get(uid) ?? [])]);
      return { uid, proposalLeads: [...set].sort() };
    });

    return gzipped(req, json({ year, rows, leads, awaitingSubmission: awaiting(all, today) }));
  }

  /** The editor's record: one RFP, every column, and the linked grant when asked for.
   *
   * Unprojected, unlike every other route here. The editor writes about sixty columns
   * across five fixed tabs (Opportunity, Eligibility, Decision & Pipeline, Team,
   * Submission & Award) plus Application and Reporting, so a projection would be a list
   * of nearly the whole table that then has to be kept in step with the form. One row is
   * 4.8 KB raw and the page is opened deliberately, not in bulk.
   *
   * Which tabs appear is the PAGE's decision, not data: `show_application` and
   * `show_reporting` are caller flags in rfp_editor.py, and Reporting is shown only from
   * the Funding page so grant reporting is edited in one place. So this route does not
   * guess — it fetches the linked grant only when `reporting=1` says the tab is open,
   * mirroring `if show_reporting` and leaving the lookup unpaid for otherwise.
   *
   * A missing row and a row scoped away by RLS both answer 404. Distinguishing them would
   * tell a caller that a uid exists in a tenant they cannot see.
   */
  async function rfp(req: Request, ctx: Ctx, uid: string): Promise<Response> {
    const sb = db.as(ctx.scope);
    const rows = await sb.get(
      "rfp_submissions",
      `select=*&uid=eq.${q(uid)}&limit=1`,
    );
    if (!rows.length) return json({ error: "Not found." }, 404);

    const wantsReporting = new URL(req.url).searchParams.get("reporting") === "1";
    let grant: Json | null = null;
    if (wantsReporting) {
      // form_id_link, not uid: the grant points back at the RFP. Absent is normal — it
      // means this RFP has no reporting record yet — so a failure here is not an error
      // for the caller, it is an empty tab.
      const ag = await sb.get(
        "applied_funding",
        `select=*&form_id_link=eq.${q(uid)}&limit=1`,
      ).catch(() => []);
      grant = ag[0] ?? null;
    }
    return gzipped(req, json({ row: rows[0], grant }));
  }

  /** The meeting-log card on one RFP: its notes, every week it could be filed under, and
   * which week to open on.
   *
   * Per RFP and on demand, because that is what tracking_rfp.py does — the card fetches
   * when it opens. An earlier draft of the contract had these as a bulk array on
   * /pipelines/track, which would have been a join for rows nobody expands.
   *
   * `weeks` pairs each label with its Monday, resolved HERE. The browser must not own a
   * second definition of which week a row belongs to: that mapping is jan4 and ISO-week
   * arithmetic in review_week.py, and two definitions of one number is exactly what the
   * scoring drift was. Given the pairs, the page matches strings.
   *
   * `defaultWeek` carries the selection rule, which is not guessable: the week whose
   * Monday is the LATEST note's meeting_date; failing that the current ISO week; failing
   * that the first label. The selector offers every week of the year and not only weeks
   * with notes, because a user picks a week to write into as well as to read.
   */
  async function meetingNotes(req: Request, ctx: Ctx, uid: string): Promise<Response> {
    const url = new URL(req.url);
    const year = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
    const sb = db.as(ctx.scope);

    const raw = await sb.get(
      "meeting_logs",
      `select=meeting_date,actions,owner,deadline&rfp_uid=eq.${q(uid)}` +
        `&order=meeting_date.desc`,
    ).catch(() => []);
    const notes = raw.map((n) => ({
      meetingDate: str(n.meeting_date).slice(0, 10) || null,
      actions: n.actions ?? null,
      owner: n.owner ?? null,
      deadline: n.deadline ?? null,
    }));

    const weeks = weekMondays(year);
    const latest = notes.find((n) => n.meetingDate)?.meetingDate ?? null;
    const byMonday = latest ? weeks.find((w) => w.monday === latest) : undefined;
    const currentMonday = monday(new Date()).toISOString().slice(0, 10);
    const defaultWeek =
      byMonday?.label ??
      weeks.find((w) => w.monday === currentMonday)?.label ??
      weeks[0]?.label ??
      null;

    return gzipped(req, json({ year, notes, weeks, defaultWeek }));
  }

  /**
   * Reviewed: the calls a PERSON has decided on, in a date window.
   *
   * MEMBERSHIP IS A NON-EMPTY `decision`, and the first version of this route got that
   * wrong. It required `decision_date`, reasoning from views/review_rfp.py:212, which only
   * treats a stored decision as a human's when that column is stamped. The rule reads well
   * and is wrong here: measured on the live table, 61 of the 83 decided rows have no
   * `decision_date` at all, because the Excel migration carried the verdict and the written
   * rationale but never a date. The stage showed 22 of 83 and looked broken.
   *
   * Those 61 are unmistakably human: 32 of them DISAGREE with `auto_recommendation`, so
   * they cannot be the engine's own output copied into the column, and 59 carry a written
   * rationale, which the engine never produces. The import worry the old rule defended
   * against is not in this data, and defending against it cost three quarters of the real
   * decisions. A stage that hides what people decided is worse than one that might someday
   * show an imported recommendation.
   *
   * WHICH WEEK A ROW IS REVIEWED UNDER: the week it was FOUND in — `foundOn`, keyed on
   * the write-once `search_date`. Not when it was decided, and never a save stamp.
   *
   * This paragraph used to describe the opposite, and the stale version is worth naming
   * rather than quietly replacing. It read "WHICH DATE A DECISION COUNTS UNDER, best
   * evidence first: decision_date, decision_overridden_at, submitted_at" — and
   * `decision_overridden_at` is an UPDATE timestamp. Editing an RFP found in September
   * re-filed it under the current week, so over half this stage (47 of 87 decided rows
   * carried a later save stamp than their found date) was eligible to move every time
   * somebody touched it. The owner reported it as rows jumping weeks.
   *
   * The comment outliving the behaviour is the second half of that failure. `submittedOn`
   * had already refused the save stamp and said why, and this docstring sat above it
   * asserting the save stamp was "close enough" — so a reader fixing the code would have
   * found a neighbouring comment telling them to put it back. Read `foundOn` for the rule
   * and the write-once argument; `decidedOn` survives ONLY as its fallback, for a row with
   * no found date at all, which no live row is.
   *
   * Windowed HERE rather than in PostgREST because that fallback is a coalesce across
   * columns, which query syntax expresses badly, and because a tenant's whole history is
   * small — the same reasoning /pipelines/track already runs on.
   *
   * Duplicates are kept rather than dropped: deciding on a row is a thing that happened to
   * THAT row, and hiding it would make a decision disappear from the stage that exists to
   * show decisions. The page groups them.
   */
  async function reviewed(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const year = new Date().getUTCFullYear();
    const from = str(url.searchParams.get("from")).trim() || `${year}-01-01`;
    const to = str(url.searchParams.get("to")).trim() || `${year + 1}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
      return json({ error: "from and to must be ISO dates" }, 400);
    }
    if (to <= from) return json({ error: "to must be after from" }, 400);

    // getAll: `total` and `undated` below are counts, and a silently truncated read would
    // report them as facts about the whole history when they were facts about 1000 rows.
    const all = await db.as(ctx.scope).getAll(
      "rfp_submissions", `select=${REVIEWED_FIELDS}&decision=not.is.null`, "uid");
    const decided = all.filter((r) => str(r.decision).trim() !== "");

    const reviewToday = new Date().toISOString().slice(0, 10);
    const dated = decided
      // decidedOn is the LAST resort, not a peer: a row with no found date at all (an
      // old migrated one) still belongs on this stage somewhere, and dropping it would
      // quietly shrink the totals rather than misplace one row. Where a found date
      // exists - every live row has one - it wins, and an edit cannot move the row.
      // WHAT THE REVIEW SCREEN IS FOR. Two exclusions, both the owner's (2026-11-09),
      // and both about relevance rather than correctness:
      //
      //   * A call whose DEADLINE HAS PASSED cannot be bid for, so a decision about it
      //     is not one anybody can still act on. It belongs to the record, not the week.
      //   * A call ALREADY WITH A FUNDER has moved on: its next update is an outcome,
      //     and Submitted and Outcome are where that is read. Leaving it here put a row
      //     the team settled months ago back in front of them, which is what made the
      //     screen untrustworthy - "Decided in 2-8 Nov" listing a decision from April.
      //
      // BEFORE the map, not after: spreading a `Json` into an object literal drops its
      // index signature, so `r.call_submission_deadline` stops existing downstream - the
      // same trap `AnsweredRow` above is annotated to avoid.
      .filter((r) => {
        const dl = str(r.call_submission_deadline).slice(0, 10);
        if (dl !== "" && dl < reviewToday) return false;
        return !isSubmitted(r);
      })
      .map((r) => ({ ...r, decided_on: decidedOn(r), found_on: foundOn(r) ?? decidedOn(r) }))
      .filter((r) => r.found_on);
    // Half-open, matching web/src/pipeline/period.ts, so consecutive windows tile exactly
    // and a row on a boundary date is counted once rather than in both.
    //
    // Filtered on found_on, NOT decided_on — see foundOn(). A row is reviewed in the week
    // after the one it was found in, and an edit years later must not move it there.
    const rows = dated
      .filter((r) => r.found_on! >= from && r.found_on! < to)
      .sort((a, b) => (a.found_on! < b.found_on! ? 1 : -1));

    // So an empty window can say "nothing here, but there are decisions in September"
    // instead of looking like the stage is broken — which is how this route's first
    // version presented itself.
    const latest = dated.reduce<string | null>(
      (best, r) => (!best || r.found_on! > best ? r.found_on! : best), null);

    return gzipped(req, json({
      from, to, rows, latest,
      total: decided.length,
      undated: decided.length - dated.length,
    }));
  }

  /**
   * Submitted: the proposals sitting with a funder, and how long each has been there.
   *
   * THE WINDOW IS NOT THE WHOLE STAGE, and this route is shaped around that. Reviewed and
   * Bidding are windowed because a decision is an event and a bid has a deadline inside
   * the period. Waiting is a STATE: a proposal submitted last March and still unanswered
   * is not less relevant for being old, it is the one most worth chasing. So the period
   * still filters `rows`, because the Pipeline has one period control and a stage that
   * ignored it would be the odd one out — but `total` counts every proposal still waiting
   * whatever its date, and `oldest` is the longest wait anywhere. A page that shows 2 of
   * 14 can then say so and offer to widen, instead of quietly being wrong about how much
   * is outstanding.
   *
   * `undated` is rows with neither a submission date nor an intake date. It is 0 today and
   * counted anyway, for the reason Reviewed counts its own: a dropped row is invisible,
   * and invisible is how that stage shipped broken.
   */
  async function submitted(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const year = new Date().getUTCFullYear();
    const from = str(url.searchParams.get("from")).trim() || `${year}-01-01`;
    const to = str(url.searchParams.get("to")).trim() || `${year + 1}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
      return json({ error: "from and to must be ISO dates" }, 400);
    }
    if (to <= from) return json({ error: "to must be after from" }, 400);

    // NO PostgREST filter at all, deliberately. `is_submitted` is three columns OR-ed with
    // one of them tested against an inverse list, which query syntax expresses badly and
    // would express it DIFFERENTLY from the shared function — the one thing this stage
    // must not do. Not even `is_duplicate=is.false`, which /pipelines/track does use: in
    // Postgres that matches false and NOT null, while the rule below is `!== true`, so the
    // day a row arrives with the column unset the two would disagree about whether it
    // exists. There are none today (11 true, 263 false, 0 null) and the whole read is ~270
    // rows, so the filter would buy nothing and cost a trap.
    //
    // getAll, not get: `total` is a count, and a silently truncated read would report a
    // fact about 1000 rows as a fact about the whole history.
    const all = await db.as(ctx.scope).getAll(
      "rfp_submissions", `select=${SUBMITTED_FIELDS}`, "uid");
    const waiting = selectSubmittedRows(all)
      .map((r) => ({
        ...r,
        submitted_on: submittedOn(r),
        // So the page can mark a wait as approximate rather than presenting an intake date
        // as the day it went to the funder. 8 of 14 are approximate today.
        submitted_on_exact: /^\d{4}-\d{2}-\d{2}$/.test(str(r.date_completed).trim().slice(0, 10)),
      }));
    const dated = waiting.filter((r) => r.submitted_on);

    const rows = dated
      .filter((r) => r.submitted_on! >= from && r.submitted_on! < to)
      // Longest wait first: the stage's whole question is who has not heard back, and the
      // answer is read from the top.
      .sort((a, b) => (a.submitted_on! < b.submitted_on! ? -1 : 1));

    const oldest = dated.reduce<string | null>(
      (best, r) => (!best || r.submitted_on! < best ? r.submitted_on! : best), null);
    const latest = dated.reduce<string | null>(
      (best, r) => (!best || r.submitted_on! > best ? r.submitted_on! : best), null);

    return gzipped(req, json({
      from, to, rows, oldest, latest,
      total: waiting.length,
      undated: waiting.length - dated.length,
    }));
  }

  /**
   * Outcome: what the funder decided, what it was worth, and what the ledger makes of it.
   *
   * Windowed like Reviewed, because an answer IS an event — it happened on a day — where a
   * wait is a state. `total` still counts every answered application regardless of date, so
   * a narrow period can say what it is leaving out.
   *
   * COUNTS ARE SUBMISSION-WEIGHTED, which is the one thing about this route that is not
   * obvious from the column names. A row submitted to a funder twice is TWO applications
   * (`core/records.py::submission_weight`), and one live Not-Approved row carries
   * `submissions = 2` — so counting rows would show 4 losses here against the Streamlit
   * Applied Funding page's 5. Both `rows` and the totals carry the weight so a reader can
   * reconstruct either.
   *
   * THE WIN RATE HERE IS NOT THE FUNDING PAGE'S, deliberately, and both are returned so
   * neither can be mistaken for the other. `app_pages/grants.py` divides approved by
   * EVERYTHING submitted including what is still pending — 17% live — which answers "how
   * much of what we have sent has been won so far". This stage shows only answered
   * applications, so its denominator is the decided ones — 44% live — which answers "when a
   * funder answers, how often is it yes". `pending` is returned as well, so the Funding
   * page's figure is recomputable from this response rather than being a second number
   * nobody can tie back.
   */
  async function outcome(req: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    const year = new Date().getUTCFullYear();
    const from = str(url.searchParams.get("from")).trim() || `${year}-01-01`;
    const to = str(url.searchParams.get("to")).trim() || `${year + 1}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}/.test(from) || !/^\d{4}-\d{2}-\d{2}/.test(to)) {
      return json({ error: "from and to must be ISO dates" }, 400);
    }
    if (to <= from) return json({ error: "to must be after from" }, 400);

    const all = await db.as(ctx.scope).getAll(
      "rfp_submissions", `select=${OUTCOME_FIELDS}`, "uid");
    const answered = selectOutcomeRows(all);

    // One fetch for every currency on the page, then every conversion reads the same map.
    // Both columns, because the request and the award can be in different units and
    // `requestedCurrency` prefers `currency_secured` for the request as well.
    //
    // `table` is the DEPLOYMENT's currency list, not the checked-in YAML's: a deployment
    // can replace it wholesale from Admin → Settings, and this one has (it carries an SEK
    // the file has never heard of). It is only the fallback — the live rate wins — but the
    // fallback is what answers when the network does not, which is exactly when a silently
    // wrong money total would be worst.
    const [rates, table] = await Promise.all([
      ratesFor(answered.flatMap((r) => [r.currency_secured, r.currency])),
      loadCurrencies(db),
    ]);

    // ANNOTATED, and it has to be. `Json` is `Record<string, unknown>`, and TypeScript
    // drops an index signature when the value is spread into an object literal — so
    // `{ ...r, outcome_on }` infers as JUST the four added fields, with no `uid` and no
    // `progress_status`. `ledgerGap` then has nothing in common with its parameter and
    // `r.uid` does not exist. Saying the type out loud keeps the row's own columns.
    const rows: AnsweredRow[] = answered.map((r) => ({
      ...r,
      outcome_on: outcomeOn(r),
      applications: submissionWeight(r),
      usd_requested: usdValue(r.amount_requested, requestedCurrency(r), rates, table),
      usd_secured: usdValue(r.amount_secured, r.currency_secured, rates, table),
    }));
    const dated = rows.filter((r) => r.outcome_on);
    const inWindow = dated
      .filter((r) => r.outcome_on! >= from && r.outcome_on! < to)
      .sort((a, b) => (a.outcome_on! < b.outcome_on! ? 1 : -1));   // newest first

    const won = (r: Json) => norm(r.donor_decision) === "approved";
    const sum = (list: typeof rows, f: (r: typeof rows[number]) => number) =>
      list.reduce((t, r) => t + f(r), 0);
    const approved = inWindow.filter(won);
    const declined = inWindow.filter((r) => !won(r));

    // Pending is NOT in `rows` — those are on the Submitted stage — and is counted here
    // only so the Funding page's win rate stays recomputable from this one response.
    const pending = selectSubmittedRows(all).reduce((t, r) => t + submissionWeight(r), 0);

    return gzipped(req, json({
      from, to,
      rows: inWindow,
      counts: {
        applications: sum(inWindow, (r) => r.applications),
        approved: sum(approved, (r) => r.applications),
        notApproved: sum(declined, (r) => r.applications),
        pending,
      },
      money: {
        requested: sum(inWindow, (r) => r.usd_requested),
        secured: sum(approved, (r) => r.usd_secured),
        // `core/records.py`'s Unsecured: what was asked for on applications that were
        // turned down. Funding lost, not funding not yet won.
        unsecured: sum(declined, (r) => r.usd_requested),
        rates,
      },
      // Answered, yet worth zero applications because `progress_status` never reached
      // Completed. Reported rather than repaired — see money.ts::ledgerGap.
      ledgerGap: ledgerGap(inWindow).map((r) => str(r.uid)),
      total: dated.length,
      undated: rows.length - dated.length,
      latest: dated.reduce<string | null>(
        (best, r) => (!best || r.outcome_on! > best ? r.outcome_on! : best), null),
    }));
  }

  return { weeks, screen, summary, track, reviewed, submitted, outcome, rfp, meetingNotes };
}

/**
 * The date a decision counts under. Exported for the tests, because the fallback order is
 * the rule — a row whose only date is `submitted_at` still has to land in a period, and
 * getting the order wrong files decisions under the wrong month silently.
 */
/** The day this row was FOUND — the only date allowed to decide which period it sits in.
 *
 * THE PERIOD A ROW BELONGS TO IS FIXED WHEN IT IS FOUND. Editing an old row used to move
 * it: the window was filtered on `decidedOn`, whose second candidate is
 * `decision_overridden_at` - an UPDATE timestamp. Touch an RFP found and reviewed in
 * September and it stamps today, the row re-buckets into the current week, and it turns
 * up in the review queue of a team who settled it two months ago.
 *
 * So the window keys on `submitted_at`, which is written once when the row enters the
 * pipeline and never rewritten. What a row has since BECOME - proceed, submitted,
 * approved - is a filter over these weeks, never a new week.
 *
 * `decidedOn` is unchanged and still drives the DECIDED column: when a decision was
 * taken is worth showing, it is just not what the row is filed under.
 */
export function foundOn(r: Json): string | null {
  // `submittedOn` and `outcomeOn` already refuse the save stamp for the same reason, and
  // said so in writing two functions below while this one still used it - worth reading
  // together, because the three stages only tell a coherent story if they agree about
  // which dates describe the CALL and which describe somebody doing data entry.
  //
  // THE EARLIEST DATE ON THE ROW, not a preferred column. Neither candidate is right on
  // its own, and which one is wrong depends on where the row came from. Measured against
  // the date encoded in the uid — stamped once, when the row is created — over 94 live
  // rows:
  //
  //                      auto rows      migrated rows
  //   search_date        21 of 37       52 of 55
  //   submitted_at       37 of 37       10 of 55
  //   EARLIEST of both   37 of 37       53 of 55     (92 of 94 overall, mean gap 0.5d)
  //
  // A scanned row's `search_date` is rewritten when the call is seen again; a migrated
  // row's `submitted_at` is the day the workbook was imported, months after the team
  // found the call. Both errors run the same direction — a later event can only stamp a
  // LATER date — so the earliest evidence on the row is the closest thing to when we
  // first saw it, and that is what a review week should key on.
  //
  // This replaced "search_date first", which filed five months-old migrated rows into the
  // first week of November because one import had stamped them all 2026-11-06, and the
  // screen then offered a decision taken in April as this week's review.
  const dates: string[] = [];
  for (const k of ["search_date", "submitted_at", "created_at"]) {
    const v = str(r[k]).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) dates.push(v);
  }
  return dates.length ? dates.sort()[0] : null;
}

export function decidedOn(r: Json): string | null {
  for (const k of ["decision_date", "decision_overridden_at", "submitted_at"]) {
    const v = str(r[k]).trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  return null;
}
