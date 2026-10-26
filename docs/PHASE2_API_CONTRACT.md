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

Live scoring stays in the browser, on the Pyodide seam Phase 1 built.
`core.live_scoring.scores_for` produces `alignment_score` and
`auto_recommendation` per row in the worker, over the rows these routes serve
plus the existing `/scoring/snapshot`. The Confidence column likewise:
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

### `GET /pipelines/screen?week=<label>` — agreed

```
{ rows: RfpSubmission[] }
```

`rfp_submissions` where `review_week = week`, with `clean_df` then
`drop_concluded` applied server-side in that order, projected to the columns
Screen draws.

### `GET /pipelines/track?year=<yyyy>` — agreed

```
{ rows: RfpSubmission[],
  leads: { uid: string, proposalLeads: string[] }[],
  nextActions: { uid: string, action: string, due: string | null }[] }
```

Six conditions from `tracking_rfp.py::_fetch`, all load-bearing, applied
server-side:

1. `is_duplicate` is false
2. `decision` is exactly `"Proceed"` or `"Proceed as sub"`
3. the year of `submitted_at` equals `year` (not `review_week`)
4. `donor_decision`, lower-cased, is `""` or `"not submitted"`
5. `progress_status`, lower-cased, is not `"completed"` or `"discontinued"`
6. `call_submission_deadline` is null, or on or after today

**Condition 2 contradicts Screen, deliberately.** Screen uses the EFFECTIVE
decision: stored falling back to `auto_recommendation`, Proceed matched by
`startswith`. Track uses the STORED column only, matched exactly against those
two strings. So a freshly scanned row whose auto-recommendation is Proceed
appears on Screen and must NOT appear on Track until a person has actually
decided. Harmonising the two "for consistency" would fill Track with work
nobody has committed to, which is the opposite of what the page is for.

**Condition 5 overrides condition 2.** A Completed or Discontinued row drops
out entirely even though its decision is still Proceed, and must not appear in
the card, the dropdown or the table.

`leads` is the second query: `duplicate_of_uid,proposal_lead` where
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
browser, over freshly computed scores, like every other page.

### `GET /pipelines/rfp/:uid` — proposed

The full record for the editor, all editable columns, unprojected. One row at
4.8 KB raw is not worth trimming.

### `PATCH /pipelines/rfp/:uid` — proposed

Body is a sparse object of changed columns only. The route validates column
names against the editable set and rejects unknown keys rather than ignoring
them, so a typo in a field name fails loudly instead of silently not saving.

Applies `score_submission` on save, and stamps `decision_overridden_by` and
`decision_overridden_at` from the caller.

**The `applied_funding` write is conditional, not a plain upsert.** It happens
only when the Reporting tab was shown. With a linked row it updates by
`funding_id`. Without one it inserts ONLY if some reporting value is non-empty,
seeding `funding_id` as `G-{uid}` and `form_id_link` back to the RFP. An
unconditional upsert would mint an empty grant row on every save.

**The route must RETURN the completed-without-a-donor-decision condition**, not
merely save:

```
{ row: RfpSubmission,
  warnings: [{ code: "completed_without_donor_decision" }] }
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

### `POST /pipelines/decision` — proposed

```
{ uid: string, decision: "Proceed" | "Park" | "Decline", note?: string }
```

Writes `decision`, `decision_date`, `scan_decisions` and `rfp_seen`. Returns
the updated row so the page does not re-fetch.

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

Encoded and commented, never quietly corrected.

### Track versus Screened — carried, and not a trap to fix

The disagreement documented under `/pipelines/track` is deliberate and stays:
Screened reads the effective decision, Track reads the stored one exactly.

## Behaviours pinned so they are not improved by accident

The effective decision is `decision` falling back to `auto_recommendation`,
lower-cased and stripped, with Proceed matched by `startswith("proceed")` and
not by equality. That is what puts a freshly scanned row in a bucket before
anybody opens Review.

The duplicate count is in-week only: an `is_duplicate` row counts when its
`duplicate_of_uid` is canonical in the same week. Duplicates pointing at other
weeks must not inflate the banner, and KPI denominators use canonical rows.
