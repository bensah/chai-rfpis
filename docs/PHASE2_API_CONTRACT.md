# Phase 2: the contract between the pipelines API and the React pages

Agreed before either side writes, because the pages consume the routes and
discovering a mismatch halfway costs more than settling it here. Owner's split
(2026-10-26): `web/src` belongs to the frontend session, the routes under
`supabase/functions/_shared/api/` and the Python-side parity harness belong to
this one.

Status per route: **agreed** means both sides have signed off, **proposed**
means this side has specified it and is waiting, **open** means a decision is
outstanding and is named below.

## What the measurements say

Taken from the live table, not estimated:

| | |
|---|---|
| Columns on `rfp_submissions` | 99 |
| One row | 4.8 KB raw, 2.2 KB gzipped |
| Busiest single (tenant, week) | 78 rows, 363 KB raw, **54 KB gzipped** |
| One whole tenant, all history | 148 rows, 702 KB raw, **108 KB gzipped** |
| `brief_description` alone | 76 KB of a week payload, about a fifth |

Three conclusions follow, and they decide the shape of everything below.

**Separate routes per tab, not one payload.** Screen is bounded by a week;
Summary reads a tenant's whole history and therefore grows without limit as
scanning continues. Serving both from one route would make the cheap page pay
for the expensive one forever. This answers the question put to this side:
separate, and the reason is the unbounded one, not today's 2x difference.

**Column projection matters more than route count.** Of 99 columns the long
prose fields dominate, and no tab renders all of them. Each route selects only
what its page draws. This is the single biggest lever and it is free.

**Gzip everything.** `gzipped()` already exists in `http.ts` and gets about
6.7x on this data. Every route below wraps its response in it.

## Conventions

- Responses are `json()` from `http.ts`, wrapped in `gzipped(req, res)`.
- Errors keep the existing shape: `json({ error: "..." }, status)`. No new
  error vocabulary for this phase.
- Reads go through the RLS-scoped client, so tenant scoping is the session's,
  never a query parameter. A route never takes a `tenant_id`.
- Rows are returned in database order unless a route says otherwise. Ordering
  for display belongs to the page.
- `week` is the label string (`review_week`), never a number.

## What this side does NOT compute

Settled, so neither side builds it twice:

**Scoring moved to the server** (owner, 2026-10-28), superseding what this
section said when it was written. `alignment_score` and `auto_recommendation`
are STORED columns, written by the `rescore` background job, which runs the one
`core.auto_scorer.auto_score` the weekly scan runs. The browser no longer
computes them per view; it reads what the database holds. Neither this API nor
the page re-implements the rule — the job changes the HOST of the scoring, not
the language, so there is still one implementation.

What that costs, and what the contract owes a page because of it: a save can
change the answer, and the job lands a minute or so later. Every row-serving
route below therefore also returns `scored_at` and `score_profile_sig`
(migration 101), and `PATCH /pipelines/rfp/:uid` returns the job it queued. A
page that shows a score while a re-score is in flight must say so rather than
presenting the old number as settled. On the wire this is almost free despite
the signature being 40 characters: it is the same 40 characters on every row of
a tenant, and the responses are gzipped.

The Confidence column is unaffected and stays in the browser:
`data_quality.donor_completeness`, `call_completeness` and
`donor_intel.match_donor` are pure Python over data the browser already holds.

Everything after `clean_df` and `drop_concluded` on Screen is the page's:
duplicate partitioning, the effective-decision fallback, KPI buckets, filters,
ordering.

## Routes

### `GET /pipelines/weeks` — agreed

```
{ year: number,
  weeks: string[],
  current: string,
  weeksWithData: { week: string, count: number }[] }
```

`current` is `review_week_label()`, prepended to `weeks` when missing, matching
`screened_rfp.py` line 67. `weeksWithData` feeds only the empty state, so the
counts are a cheap aggregate and carry no rows.

### `GET /pipelines/screen?week=<label>` or `?from=&to=` — agreed

```
{ week, rows }              // by label
{ from, to, weeks, rows }   // by range
```

`rfp_submissions` with `drop_concluded` applied server-side, projected.

**Both parameters, not one.** "Show me Week 43" is exact and needs no mapping,
so `week=` stays. "Show me October" is the period-spine case, and a label is
not a date range, so replacing `week=` would push every lookup through a
mapping even when the caller already holds the label.

A range selects the review_weeks whose own **Monday** falls inside it, not the
rows whose `submitted_at` does. The review_week is the screening period: a row
submitted on the Friday of September's last week belongs to that week's
screening, and filtering by `submitted_at` would move it into October and make
the weekly and monthly views disagree. Half-open, so periods tile.

#### The projection, and why `brief_description` stays

Three fields are drawn and were missing: `applicant_role` (the Role column,
and the denominator of the Prime and Sub KPIs), `key_risks` (a table column)
and `feasibility` (one of the four filters).

`brief_description` and `instrument_type` are NOT drawn and are carried
anyway, which looks like exactly the waste the projection exists to remove. It
is not. Both are among the seven `_CALL_KEY_FIELDS` that
`data_quality.call_completeness` counts, and that feeds the table's Confidence
band. Dropping `brief_description` would make every row look less complete
than it is and quietly shift Confidence down. **A column being invisible is
not the same as a column being unused.**

Measured on the busiest week, 78 rows:

| Projection | gzipped | columns |
|---|---|---|
| `select=*` | 54 KB | 99 |
| previous | 34 KB | 24 |
| **revised** | **36 KB** | 28 |
| revised without `brief_description` | 11 KB | 27 |

So the four additions cost 1.8 KB, and dropping `brief_description` would save
24 KB — real, but it buys that by breaking Confidence unless the band is
computed server-side instead. That would mean porting `call_completeness`,
`donor_completeness`, `match_donor` and the blend into TypeScript: a second
implementation of donor matching, which is the same class of drift as the
70/45 banding this phase just finished removing. 36 KB for a page load is not
worth that. If the payload ever does become the problem, the answer is a
server-computed `confidence` held to the Python by the parity harness, not an
untested port done to save 24 KB.

### `GET /pipelines/track?year=<yyyy>` or `?from=&to=` — built

```
{ year | from+to, rows, leads: { uid, proposalLeads[] }[],
  awaitingSubmission: RfpSubmission[] }
```

A range replaces condition 3 below and nothing else: the other five are about
whether a row is live work, not about when it arrived. Half-open, like
Summary, so the periods tile.

`nextActions` is NOT here. An earlier draft had it as a bulk array, which was
wrong: `tracking_rfp.py` fetches meeting logs per RFP when the card opens, so
a bulk array would be a join for rows nobody expands. See the notes route.

Six conditions from `tracking_rfp.py::_fetch`, all load-bearing, applied
server-side:

1. `is_duplicate` is false
2. `decision`, lower-cased, starts with `"proceed"`
3. the year of `submitted_at` equals `year` (not `review_week`)
4. nothing records a submission — `core/pipeline.py::is_submitted`
5. `progress_status`, lower-cased, is not `"completed"` or `"discontinued"`
6. `call_submission_deadline` is null, or on or after today

**Condition 2 contradicts Screen, deliberately, but not in the way an earlier
version of this document said.** Screen uses the EFFECTIVE decision: stored
falling back to `auto_recommendation`. Track uses the STORED column only. That
is the whole difference — WHICH COLUMN, not how it is matched. Both prefix-match,
because `is_active_proceed` tests `startswith("proceed")` and `_fetch` narrows
with `.ilike("decision", "Proceed%")` before it. This route matched exactly
against `{"Proceed", "Proceed as sub"}` until 2026-11-03, which admits the same
40 live rows and would have silently dropped any other Proceed wording the
Streamlit page still shows.

So a freshly scanned row whose auto-recommendation is Proceed appears on Screen
and must NOT appear on Track until a person has actually decided. Harmonising
*that* "for consistency" would fill Track with work nobody has committed to,
which is the opposite of what the page is for.

**Condition 4 is three columns, not one.** It was `donor_decision not in {"",
"not submitted"}` alone until 2026-11-03, which is two thirds of
`is_submitted`: a recorded `date_completed` proves a submission as well, and
that branch was missing, so a bid stayed on the board as "in flight" after
somebody wrote down the day it went in. It also disagreed with this route's own
`awaitingSubmission`, which did test the date. No live row was in that state
when the gap was found, so nothing was ever shown wrongly — it was caught by
the test that asserts Bidding's exit and Submitted's entry are one rule.

Every column is read through `_txt`: stripped, lower-cased, with the Excel
import's literal `"nan"` treated as blank. An earlier note here claimed
`donor_decision` was lower-cased but not stripped. It is stripped; `_fetch`
does none of this comparing itself, it hands each row to `is_active_proceed`.

**Condition 5 overrides condition 2.** A Completed or Discontinued row drops
out entirely even though its decision is still Proceed, and must not appear in
the card, the dropdown or the table. Completed is also one of `is_submitted`'s
branches; Discontinued is condition 5's alone.

**`awaitingSubmission` — the Proceeds that fail ONLY condition 6.** Measured on
the live table, condition 6 removed 15 of 16 Proceeds, so a stage that applied
it silently would have shown one bid and looked like a year of work had
vanished. These are the `criteria_derive.needs_submission_check` population:
backdated intake, where a proposal entered from Excel months after it went to
the funder arrives with the deadline already past. Returned so the page can ask
rather than drop them. The owner has since answered 13 of the 15 through that
panel.

### `GET /pipelines/rfp/:uid/meeting-notes?year=<yyyy>` — agreed

```
{ year,
  notes: { meetingDate, actions, owner, deadline }[],   // meeting_date desc
  weeks: { label, monday }[],
  defaultWeek: string | null }
```

Per RFP and on demand, matching the card. `weeks` pairs every label of the
year with its Monday, resolved **server-side**, because the browser must not
own a second definition of which week a row belongs to — that mapping is
jan4 and ISO-week arithmetic in `review_week.py`, and two definitions of one
number is what the scoring drift was. Given the pairs, the page matches
strings and adds seven days for the default due date.

`defaultWeek` is the week whose Monday equals the latest note's
`meeting_date`; failing that the current ISO week; failing that the first
label. The selector offers every week of the year, not only weeks with notes,
because a user picks a week to write into as well as to read.

**One deliberate divergence from `review_week.monday_from_week_label`.** That
helper reads only the week number and offsets from the week containing Jan 4,
which is wrong for exactly one label a year: `all_weeks_for_year` ends a year
with the FOLLOWING year's week 1 (2024's last label is "Week 1 (30 Dec - 5
Jan)") and the arithmetic sends it back to the January at the start of the
year. Harmless in the Streamlit selector, which only round-trips what it just
rendered. Not harmless here, where these Mondays decide range membership on
Screened: a mis-resolved week would put December's screening in January and
break the tiling. Resolved by relabelling candidates and taking the exact
match instead, so the function can only return a Monday that renders as the
label asked for. Caught by a round-trip test across four years.

---

`leads` on the track route is the second query: `duplicate_of_uid,proposal_lead` where
`is_duplicate` is true and `duplicate_of_uid` is among the result uids, so the
leads on a duplicate group reach the canonical row. Server-side for the same
reason as `nextActions`: a join over rows the browser has no other reason to
hold.

Days-to-deadline, deadline status and `_usd` all stay in the browser. `_usd`
needs FX rates, and the browser already has them: `/scoring/snapshot` returns
`fx_rates` from `ratesFor()` for exactly the currencies the tenant's rows use.
Computing it here would mean a second rate source to keep in step with that
one.

### `GET /pipelines/summary?from=<iso>&to=<iso>` — agreed

```
{ rows: RfpSubmission[], from: string, to: string }
```

Rows whose `submitted_at` falls in the half-open window, projected to the
columns sections A to E aggregate over. The window defaults to the current
calendar year when the page sends neither bound. Aggregation happens in the
browser, over the stored scores the `rescore` job writes.

### `GET /pipelines/reviewed?from=<iso>&to=<iso>` — built

```
{ rows: (RfpSubmission & { decided_on: string })[],
  from: string, to: string,
  latest: string | null,     // most recent decision anywhere
  total: number,             // decisions in all
  undated: number }          // decisions carrying no usable date
```

What a PERSON has decided, in a half-open window, newest first. Defaults to the
current calendar year.

**Membership is a non-empty `decision`, and the first version of this got it
wrong.** It required `decision_date`, reasoning from `views/review_rfp.py:212`,
which only treats a stored decision as a human's when that column is stamped.
The rule reads well and is wrong against this data: of 83 decided rows, **61
have no `decision_date` at all** — the Excel migration carried the verdict and
the rationale but never a date — so the stage showed 22 of 83 and looked broken.

Those 61 are unmistakably human: **32 disagree with `auto_recommendation`**, so
they cannot be the engine's own output copied into the column, and **59 carry a
written rationale**, which the engine never produces. The import the old rule
defended against is not in this data, and defending against it cost three
quarters of the real decisions.

**Which date a decision counts under**, best evidence first:

| column | written by |
|---|---|
| `decision_date` | `POST /pipelines/decision` — the real thing |
| `decision_overridden_at` | any save; close enough to when it was decided |
| `submitted_at` | the row's own date, so a dated row is never lost |

Resolved server-side into `decided_on` so the page does not own a second opinion
about which period a decision belongs to. A row with none of the three is
counted in `undated` rather than dropped — dropping decisions is the bug this
route just had. The window is applied in TypeScript rather than PostgREST
because that fallback is a coalesce across three columns, and because a tenant's
whole history is small; `/pipelines/track` already filters on the same grounds.

`latest` exists so an empty window can say *where* the decisions are. "Nothing
this week" and "nothing ever" look identical on screen and mean entirely
different things.

Carries prose — `opportunity_title`, `decision_note` — where `/pipelines/summary`
deliberately does not, because this stage is read a row at a time rather than
counted.

**Duplicates are NOT dropped.** Deciding on a row is something that happened to
that row, and hiding it would make a decision vanish from the stage whose whole
job is to show decisions. The page groups them instead.

### `GET /pipelines/submitted?from=<iso>&to=<iso>` — built

```
{ rows: (RfpSubmission & { submitted_on: string,
                           submitted_on_exact: boolean })[],
  from: string, to: string,
  total: number,             // every proposal still waiting, ANY date
  oldest: string | null,     // the longest wait anywhere
  latest: string | null,
  undated: number }          // waiting, but with no usable date at all
```

The proposals sitting with a funder and no answer back, longest wait first.
Defaults to the current calendar year.

**Membership is Bidding's exit, not a second opinion about it.** `is_submitted`
is one of the six tests in `is_active_proceed`, so the moment it goes true a row
leaves `/pipelines/track` — and this is the only thing that catches it. Both
routes call one function (`api/donor_decision.ts`, ported from
`core/pipeline.py`), and one test drives both routes over one fixture, because a
gap between them is a row that falls off the line silently. That is the Reviewed
bug in a new place.

The exit is `is_outcome`: Approved or Not Approved belong on Outcome. **"Under
Review" is NOT an outcome** — somebody put it there to record that we are
waiting, which is this stage exactly.

**The inverse list is load-bearing.** `is_submitted` treats ANY `donor_decision`
outside `{"", "not submitted"}` as proof of submission, because a funder can only
decide on a proposal it received. `views/report.py::_submitted_mask` names the
three decisions it accepts instead, which is right for a historical total but
reads a value it has never seen as unsubmitted. Two live rows carry
`"Submitted"`, which is not one of `config/dropdowns.yaml`'s four values at all.
This route counts them; that mask would not.

**No clause for Discontinued or Missed**, and that is measured rather than
overlooked: no canonical row reaches the filter in either state. Dropping a bid
clears none of the three things that prove a submission, and setting
Discontinued is what the Bidding panel writes INSTEAD of a submission. If one
ever appears, the row contradicts itself — dropped, yet with the funder — and
showing it where somebody can fix it beats hiding it behind a rule nobody could
have checked.

**Which date the wait is measured from**, best evidence first:

| column | meaning |
|---|---|
| `date_completed` | the day somebody recorded it going in — the real thing |
| `submitted_at` | the row's own intake date, so a proposal is never undated |

**`decision_overridden_at` is deliberately absent, unlike `decided_on`.** For
Reviewed, a save stamp is decent evidence of when a verdict was reached. Here it
is evidence of when somebody did bookkeeping: the owner spent 2026-11-03 working
through the Bidding backlog, marking June and July submissions, so every one of
those rows carries today's stamp. Using it would file a July submission under
November and turn "submitted this month" into a count of data entry.
`submitted_on_exact` is false whenever the fallback was used — **8 of 14 rows**
— so the page marks the wait approximate instead of presenting a guess as the
day it reached the funder.

**`total` is not `rows.length`, and that is the point.** Reviewed and Bidding
are windowed because a decision and a deadline are events. Waiting is a STATE: a
proposal submitted last March and still unanswered is the one most worth
chasing, not the least. The period still filters `rows`, because the Pipeline
has one period control — but `total` counts every waiting proposal whatever its
date, and `oldest` points at the longest wait, so a page showing 2 of 14 can say
so and offer to widen rather than quietly understating what is outstanding.

**There is no `POST /pipelines/outcome`.** Recording a funder's answer is a plain
`PATCH /pipelines/rfp/:uid`, unlike a go/no-go, which has its own route because
it writes a training label and the scan's tombstone. Nothing in
`core/decision_log.py` logs a funder outcome, so a dedicated route would carry no
rule — only symmetry.

Live, 2026-11-03: 14 waiting, all in one tenant; longest wait 292 days; 7 with
no answer recorded; 9 whose `stage` still says the application was never
started.

### `GET /pipelines/rfp/:uid?reporting=1` — agreed

```
{ row: RfpSubmission, grant: AppliedFunding | null }
```

Unprojected, unlike every other route here. The editor writes about sixty
columns across five fixed tabs (Opportunity, Eligibility, Decision & Pipeline,
Team, Submission & Award) plus Application and Reporting, so a projection
would be a list of nearly the whole table that then has to be kept in step
with the form. One row is 4.8 KB raw and the page is opened deliberately
rather than in bulk.

Which tabs appear is the PAGE's decision and not the data's: `show_application`
and `show_reporting` are caller flags in `rfp_editor.py`, and Reporting is
shown only from the Funding page so grant reporting is edited in one place.
The route therefore does not guess. `reporting=1` says the tab is open and
only then is the linked grant fetched, by `form_id_link` rather than `uid`
because the grant points back at the RFP. `grant` is null when the RFP has no
reporting record yet, which is the normal case and not an error.

A missing row and a row scoped away by RLS both answer 404. Distinguishing
them would tell a caller that a uid exists in a tenant they cannot see.

### `PATCH /pipelines/rfp/:uid` — proposed

Body is a sparse object of changed columns only. The route validates column
names against the editable set and rejects unknown keys rather than ignoring
them, so a typo in a field name fails loudly instead of silently not saving.

Stamps `decision_overridden_by` and `decision_overridden_at` from the caller.

**Does NOT apply `score_submission` on save** — that is what the Python editor
did, and it is where the 70/45 banding entered the database. The route queues
the `rescore` job for the saved row instead, and the job writes the score.

Only when the save could have moved it. A denylist of 19 columns the team uses
to record its own work on a bid (`assigned_to`, `next_action`, `amount_secured`
and the like) queues nothing. A denylist and not a list of scoring inputs, so
that a new input added in Python costs a redundant job rather than a score that
silently never updates. `progress_status`, `donor_decision` and `date_completed`
look like workflow state and are NOT on it: `criteria_derive._is_completed`
reads all three, so marking a bid submitted genuinely moves its score.

Queueing is non-fatal — the save succeeded — and a failure to queue comes back
as a warning saying the score still reflects the opportunity as it was.

**The `applied_funding` write is conditional, not a plain upsert.** It happens
only when the Reporting tab was shown. With a linked row it updates by
`funding_id`. Without one it inserts ONLY if some reporting value is non-empty,
seeding `funding_id` as `G-{uid}` and `form_id_link` back to the RFP. An
unconditional upsert would mint an empty grant row on every save.

**The route must RETURN the completed-without-a-donor-decision condition**, not
merely save:

```
{ row: RfpSubmission,
  warnings: [{ code: "completed_without_donor_decision" | "rescore_not_queued",
               detail: string }],
  rescore: { job_id: string } | null }
```

This is a feature and not a side effect, and it is the one thing in this phase
most likely to be lost in translation. Saving `progress_status` Completed while
`donor_decision` is blank means the row will not reach Applied Funding. The
Python warns on screen, and the comment above it (owner, 2026-08-17) records
that this REPLACED code which silently forced "Under Review" — and that the
invisible write is how a grant went missing once. The whole point was to stop
the app deciding quietly and say it out loud. A route that just saves
reintroduces the silent failure with extra steps, and nobody finds out until
another grant goes missing.

Checked against the Python before writing this, because the frontend session
flagged that the settings and users save paths deliberately DROP columns that
no longer exist (`PGRST204` / schema-cache handling in `core/settings.py` and
`views/account_sections.py`) so a schema change cannot break a save, and
rejecting loudly here would then be a behaviour change rather than a
hardening.

It is not, because the two cases are different. `rfp_editor.py` builds an
explicit `update` dict from its widgets and calls `.update()` with it
(line 630); it has no drop-unknown handling, so a column that vanished would
already surface as an error rather than a silent partial save. And rejecting
unknown keys here is validation of a CLIENT payload, not tolerance of schema
drift: it catches a mistyped field name in the React code, which the Python
form cannot produce because its payload is built from the widgets themselves.
Schema drift, if it ever reaches this route, still fails the same way it fails
in the editor today.

### `POST /pipelines/decision` — built

```
request   { uid: string, decision: "Proceed" | "Park" | "Decline", note?: string }
response  { row: RfpSubmission,
            warnings: [{ code: "decision_not_recorded", detail: string }],
            recorded: { job_id: string } | null }
```

Writes `decision`, `decision_date` and the two override stamps, and queues the
`record_decision` job for `scan_decisions` and `rfp_seen`. Returns the updated
row so the page does not re-fetch.

**`decision_date` is stamped here and only here.** It is the flag the rest of
the app reads as "a human has reviewed this" — `views/review_rfp.py:212` only
honours a stored decision as a human's when this is set. UTC, matching the
deployment the Python runs in.

**`decision` is validated against `config/dropdowns.yaml`'s `decisions`**, not
accepted free-form, because it decides who appears in Track
(`views/tracking_rfp.py` filters `in.(Proceed, Proceed as sub)`) and whether the
scan tombstones the row. The API carries a copy of that list, since it also runs
as a Deno Edge Function with no filesystem; a test re-reads the YAML and fails
if the two drift. The Python additionally PREPENDS a row's existing decision
when the vocabulary no longer contains it, so an old value stays selectable —
that is a display rule, and this write route does not honour it.

So `Proceed as sub` is refused, and that is right rather than a gap. It was
dropped on 2026-06-06 (`core/auto_scorer.py`, above `_detect_applicant_role`):
the sub signal moved to `applicant_role` — Prime / Sub / Technical — and the
decision stays `Proceed`. `views/tracking_rfp.py`, `views/meetings.py` and
`TRACK_FIELDS`' reader all still filter `in.(Proceed, Proceed as sub)`, which is
a READ staying wide enough for rows decided before that date. A write route
must not put the retired value back into circulation.

**`note` omitted leaves the previous rationale; `note: ""` clears it.** A
reviewer who changes their verdict and says nothing should not be left with the
rationale for the verdict they abandoned, so clearing is a thing the client can
say rather than a thing the route guesses.

**The two Python consequences are queued, not ported.** `decision_log` writes
the ML training label to `scan_decisions`, which nothing reads at gate time;
`seen_ledger` writes the operational tombstone to `rfp_seen`, which the scan
does read. Neither substitutes for the other, and `seen_ledger.column_map()`
PROBES the live table for the modern-versus-legacy column spelling — a guess at
that from TypeScript writes no tombstone while reporting success, which is
exactly the reported bug it exists to fix ("we keep declining this and it keeps
coming back"). Queueing is non-fatal and the warning says what the reviewer
loses: a declined opportunity may be found again by the next scan.

## The open question: how Summary is scoped

Summary's sections A to E aggregate over decisions and scores for a tenant's
whole history. That collides with scoring living in the browser, and the two
resolutions are genuinely different products:

**Aggregate server-side**, using the STORED `alignment_score` and `decision`
columns. Cheap, bounded, one small payload however much history accumulates.
But the stored score is the one `score_submission` wrote at save time under the
70/45 rule, and Summary would then disagree with every other page, which
displays the composite 90/70 rule over a freshly computed score.

**Ship rows and aggregate in the browser**, consistent with every other page
and with the live scoring seam. But the payload is the unbounded one: 108 KB
gzipped today for the largest tenant, growing with every scan, and the page
cannot render until Pyodide has scored the lot.

**Decided: ship rows, windowed, default current year** (owner, 2026-10-27).

The original argument was that aggregating from the stored score would
reintroduce the 70/45 versus 90/70 discrepancy as a visible disagreement
between pages. That argument has since gone: the two bandings were reconciled
the same day, so a stored score now bands the same way a fresh one does.

The decision still holds on the remaining grounds, which are the stronger ones
anyway. Aggregating in the browser keeps ONE scoring implementation rather
than a second one in TypeScript that must be kept in step. Phase 5's Report
already commits to exactly this shape — aggregation in the browser, the API
streaming rows, gzipped — so this applies a decision already made rather than
setting a new precedent. And the owner has since asked for selectable periods
(daily, weekly, monthly, quarterly, semester, yearly, plus explicit ranges)
across found, review and track, not only Summary, which wants a windowed-rows
spine rather than a fixed server-side aggregate per page.

## Parity traps

### 70/45 versus 90/70 — RESOLVED, no longer carried (owner, 2026-10-27)

This was treated as a trap to preserve. It was drift, and the owner reversed
it. Both numbers banded the SAME quantity, `alignment_score` over the nine
weighted criteria: `auto_scorer.recommend_from_composite` at 90/70, which
every live display uses, and `config/scoring_weights.yaml` at 70/45, which
Submit and the RFP editor wrote through. A row scoring 75 was Park if the scan
found it and Proceed if a person submitted it by hand.

Reconciled to 90/70 everywhere in `b608d7d`. Verified on live data from this
side before the contract was changed: of 266 scored rows, **95 band
differently** — 65 Park to Decline, 30 Proceed to Park. Of those, 63 have no
human decision and so visibly move; the other 32 already carry one, which
overrides the engine everywhere. By tenant, the visible moves are 34, 14, 9
and 6.

Nothing in this contract depends on the old banding any more. Do not
reintroduce it as a compatibility shim.

### `decision_date` is the "reviewed" flag — still carried

Encoded and commented, never quietly corrected. `POST /pipelines/decision` is
now its only writer — it is deliberately absent from the editor's editable set.

But note what it is NOT, learned the hard way on the Reviewed stage: it is not a
reliable test of whether a human decided, because 61 of the 83 decided rows
predate it. It is the best evidence when present and absent far more often than
it is there. Read it as "we know exactly when", never as "a person decided".

### Track versus Screened — carried, and not a trap to fix

The disagreement documented under `/pipelines/track` is deliberate and stays:
Screened reads the effective decision — stored falling back to
`auto_recommendation` — and Track reads the stored column only. Both match the
value by prefix; the column is the difference, not the matching.

## Behaviours pinned so they are not improved by accident

The effective decision is `decision` falling back to `auto_recommendation`,
lower-cased and stripped, with Proceed matched by `startswith("proceed")` and
not by equality. That is what puts a freshly scanned row in a bucket before
anybody opens Review.

The duplicate count is in-week only: an `is_duplicate` row counts when its
`duplicate_of_uid` is canonical in the same week. Duplicates pointing at other
weeks must not inflate the banner, and KPI denominators use canonical rows.
