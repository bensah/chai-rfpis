# Streamlit fixes the React app needs — audit, 2026-11-09

Owner's ask: the Streamlit app has had a run of backend fixes that improve data accuracy.
Make sure the React migration carries them, so the same bugs are not rebuilt. **The
Streamlit UI is explicitly not being copied** — only the rules underneath it.

## How this was scoped

A scan-side fix needs no port: both apps run the same Python in GitHub Actions, so the
fix reaches React the moment it lands. Only a change to a module React has its OWN copy
of can drift. So the audit asks one question per commit — *does this touch a module React
re-implements?* — rather than reading every diff.

The modules React duplicates, and where:

| Python | React |
|---|---|
| `core/permissions.py` | `permissions.ts` |
| `db/supabase_client.py` | `db.ts` |
| `auth/tenant_context.py` | `tenants.ts` |
| `core/funder_names.py`, `core/member_names.py` | `report_names.ts` |
| `core/keyword_cloud.py`, `core/program_area_classifier.py` | `report_vocab.ts` (generated) |
| `views/report.py` | `report_period.ts`, `report_section1.ts` |
| `core/review_week.py` | `routes_pipelines.ts` (week helpers) |
| `core/pipeline.py`, `core/records.py` | `routes_pipelines.ts` (`selectTrackRows`, `dropConcluded`) |
| `core/dropdowns.py::usd_rate` | `money.ts` |

`core/scorer.py` and `core/auto_scorer.py` are deliberately absent: React runs the real
Python through Pyodide and the scoring job calls `auto_score` directly, so there is no
second copy to drift. `check-scoring` holds that.

Over the last 14 days, six commits touched a duplicated module. Everything else —
the Google Alert redirect repair, staged-call deadlines, WordPress listings, screening
without programme areas, the synthesis empty-response retry, the dedup country veto, the
seen-ledger schema drift — is scan-side and already shared.

## 1. FIXED — the review screens opened on an empty week

`4c5b17c` added `core/review_week.py::previous_review_week_label`. Screen, Review and
Track now open on the week BEFORE the current one, because a week runs Monday to Sunday,
the team sits down on the following Monday, and on that Monday the current week is one day
old and holds almost nothing. Every reviewer was changing the selector by hand, every week.

React does not have it. `routes_pipelines.ts::weeks` computes

```ts
const current = reviewWeekLabel(new Date());
```

and `PipelinePage.tsx` selects it:

```ts
setWeek((cur) => cur ?? w.current);
```

So the React Pipeline opened on the current week and reproduced the bug exactly.

**Fixed at 9621372.** Measured before changing anything: on Monday 2026-11-09 the current
week held 0 rows and the previous week 2, so the page was opening blank that morning.

The shape of the fix is worth recording. `current` and `defaultWeek` are both served rather
than one replacing the other, because they answer different questions — `current` is the
week we are in, which is what an empty state means by "this week", and `defaultWeek` is the
week to open on. Collapsing them would leave the page unable to say "nothing found in the
week you are looking at" without lying about which week that is.

And a case neither of us had thought of: the route already prepended `current` when the
viewed year did not contain it, and `defaultWeek` needs the same treatment. In the first
days of January the week just gone belongs to the previous year, a `<select>` whose value
is not among its options renders blank, and the page then fetches a week nobody chose.
There is now an HTTP test driving a different year rather than faking the clock, plus two
unit tests in `pipelines.test.mjs`, one walking 400 consecutive days.

## 2. NOT A GAP — `"nan"`, and the asymmetry that makes it look like one

**This item was wrong when first written, and acting on it would have introduced a
divergence rather than closed one.** Corrected 2026-11-09 after the frontend-migration
session checked it. The correction is kept rather than deleted, because the mistake is
instructive and the next reader will be tempted to make it again.

`"nan"` really is a value in this database: rows migrated from the workbook carry the
literal string where the cell was empty, and `str(float('nan'))` produces the same thing.

Python handles it in **two different ways on purpose**, and this is the part to understand
before touching anything:

| Python | blanks `"nan"`? |
|---|---|
| `core/pipeline.py::_txt` — used by `is_submitted` / `is_active_proceed` | yes |
| `core/records.py::drop_concluded` — `.fillna("").str.strip().str.lower()` | **no** |

React mirrors **both**:

* `api/donor_decision.ts` has its own `txt()` and a `NO_ANSWER` set containing
  `"", "none", "nan", "nat", "null", "not submitted"`. Every membership rule — Track, the
  awaiting panel, Submitted, Outcome — routes through `isSubmitted`, which uses it. So a
  row whose `donor_decision` is `"nan"` stays on Track, matching `_txt`.
* `routes_pipelines.ts::norm` does **not** blank it, and must not: the only place it still
  meets `donor_decision` is `dropConcluded`, which mirrors `drop_concluded` — and that
  function does not blank it either.

The original audit read `norm()`, found no `"nan"` handling, and called it a gap. The error
was checking one helper and generalising: `is_submitted` had moved into its own module
during the Submitted stage and carries its own. Making `norm()` blank `"nan"` would have
made `dropConcluded` disagree with the Python function it exists to mirror.

**Measured 2026-11-09: 0 of 267 rows carry a literal `"nan"`** in `decision`,
`donor_decision`, `progress_status` or `date_completed` — confirmed independently by both
sessions. Nothing is wrong in either app.

The lesson worth keeping: when two Python functions handle the same value differently, a
port that "fixes" one of them to match the other is not closing a gap. Check which rule the
caller is actually on.

## 3. LATENT — a stored decline flag beside a live criteria grid

`2b6edf7` moved the rule into `core/scorer.py::decline_flags(values)` and the docstring
carries the point:

> THE CALLER CHOOSES THE VALUES, AND THAT IS THE WHOLE POINT. Scan-time scoring passes
> what it derived that day; a screen showing the LIVE derivation must pass the live
> values, or it prints a flag that contradicts the criteria directly above it.

The Review page showed five green MUSTs beside "Decline flags: Yes", because the grid was
live and the flag was a column written at scan time.

React does not display decline flags today — `decline_flags_present` appears only in
`pipeline_writes.ts`, in a column allowlist. So nothing is wrong yet. It is recorded here
because the Review stage is still to be ported, and reading the stored column is the
obvious thing to do and the wrong one.

## 4. ALREADY CORRECT — the week-label year boundary

`fb4378b` fixed `monday_from_week_label`: resolving by week NUMBER returned the wrong
Monday, because `all_weeks_for_year` walks from the Monday of the week containing 4
January and a year can both begin and end with a label reading "Week 1". 2025's list does.
The last week of the year came back as a date twelve months earlier.

React already resolves by relabelling each Monday and taking the one that renders as the
label asked for, which is the shape the Python moved to. Verified rather than assumed —
every label round-tripped for 2023 to 2027, including both cases that failed in Python:

```
2024  first "Week 1 (1 Jan - 7 Jan)"   last "Week 1 (30 Dec - 5 Jan)"   0 failures
2025  first "Week 1 (30 Dec - 5 Jan)"  last "Week 1 (29 Dec - 4 Jan)"   0 failures
```

React reproduces the same duplicate-"Week 1" structure, so it is seeing the same shape and
handling it. No action.

## 5. ALREADY CARRIED

* `33fcafc` / `f6027ef` — `is_active_proceed` as the single source of truth. React's
  `selectTrackRows` matches all six conditions; the third branch of `is_submitted`
  (a recorded `date_completed`) was added when a test caught the gap. Only `_txt` differs,
  which is item 2.
* `8f52f10`, `7609aec` — the 1000-row cap and the Semestrial crash. Both already in both
  apps.

## State at the time of the audit

All seven parity checks green on `e930e09`:

```
check-permissions  47064 cases, 0 differences
check-routing      15 users checked, 0 differences
check-shell        6 tenants, 0 with differences
check-scoring      no differences that could change an answer, 6 tenants
check-report       12003 comparisons, 0 differing
check-names        1583 comparisons, 0 differing
check-section1     594 comparisons, 0 differing
```

Those cover permissions, routing, the shell, scoring and Report. They do NOT cover the
Pipeline week default or `_txt`, which is why items 1 and 2 needed reading rather than
running — a rule with no check on it is a rule that drifts quietly.

## Ownership, and how to read this file

Item 3 lands whenever the Review stage is ported. Items 1 and 2 were in
`routes_pipelines.ts` and `PipelinePage.tsx`, which the frontend-migration session holds;
both are closed.

**A caveat about the framing.** This audit was written from an instruction to carry the
Streamlit backend fixes into React. That is a reason to LOOK at each one, not a reason to
apply it: the two apps model several things differently on purpose, and item 2 is a worked
example of a mechanical carry-across making things worse. Each item stands or falls on its
own merits in the React app. Where a Streamlit fix and a React defect happen to coincide —
item 1 — the React defect is the reason to change it, and the measurement is the evidence.
