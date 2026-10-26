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

### `GET /pipelines/track` — proposed

```
{ rows: RfpSubmission[],
  nextActions: { uid: string, action: string, due: string | null }[] }
```

Scoped to rows that are live work rather than a week: the Track filter set
decides which, and that set is pinned by the parity harness. `nextActions` is
derived from meeting notes server-side because it is a join the browser would
otherwise make over data it has no other reason to hold.

### `GET /pipelines/summary` — open, see below

### `GET /pipelines/rfp/:uid` — proposed

The full record for the editor, all editable columns, unprojected. One row at
4.8 KB raw is not worth trimming.

### `PATCH /pipelines/rfp/:uid` — proposed

Body is a sparse object of changed columns only. The route validates column
names against the editable set and rejects unknown keys rather than ignoring
them, so a typo in a field name fails loudly instead of silently not saving.

Applies `score_submission` on save and performs the `applied_funding` upsert.

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

This side's recommendation is to ship rows, bounded by a date window the page
chooses, defaulting to the current year. It keeps Summary consistent with the
rest of the app, which is what parity is for, and makes the payload a function
of the window rather than of how long the deployment has been running. The
alternative silently reintroduces the 70/45 versus 90/70 discrepancy as a
visible disagreement between pages.

Not this side's call alone: it changes what Summary shows. Flagging to the
owner rather than deciding it here.

## Parity traps carried over exactly

Agreed by both sessions, encoded and commented, never quietly corrected:

- `score_submission` applies 70/45 on save, while the composite rule for
  display is 90/70.
- `decision_date` is the "reviewed" flag.

## Behaviours pinned so they are not improved by accident

The effective decision is `decision` falling back to `auto_recommendation`,
lower-cased and stripped, with Proceed matched by `startswith("proceed")` and
not by equality. That is what puts a freshly scanned row in a bucket before
anybody opens Review.

The duplicate count is in-week only: an `is_duplicate` row counts when its
`duplicate_of_uid` is canonical in the same week. Duplicates pointing at other
weeks must not inflate the banner, and KPI denominators use canonical rows.
