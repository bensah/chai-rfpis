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

## 1. LIVE GAP — the review screens open on an empty week

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

So the React Pipeline opens on the current week and reproduces the bug exactly. This is
the only one of the six that is wrong today.

The fix is the default, not the list: the selector should still offer every week, and a
week the user picks must still be honoured. Only the initial value moves.

## 2. LATENT — `"nan"` is a value in this database

`core/pipeline.py::_txt` blanks the literal string `"nan"`:

```python
s = str(v).strip()
return "" if s.lower() == "nan" else s.lower()
```

Rows migrated from the workbook carry it where the cell was empty, and `str(float('nan'))`
produces the same thing. React's `norm()` does not blank it.

It matters in exactly one place, because of an asymmetry worth understanding.
`is_submitted` tests `donor_decision` against an ALLOWLIST — `{"", "not submitted"}` — so
any value it has never seen counts as submitted. That is deliberate: a donor can only
decide on a proposal it received. But it means a `"nan"` reads as blank in Python and as a
real decision in TypeScript:

* Python: `_txt("nan")` → `""` → unsubmitted → row stays on Track
* React: `norm("nan")` → `"nan"` → submitted → row disappears from Track

The `decision` and `progress_status` tests are prefix/equality matches that `"nan"` fails
either way, so only `donor_decision` flips.

**Measured 2026-11-09: 0 of 267 rows carry a literal `"nan"` in any of those columns.** So
this is latent. It is worth closing anyway, because the condition that creates it — an
Excel import — is a thing this system does on purpose.

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

## Ownership

Items 1 and 2 are in `routes_pipelines.ts` and `PipelinePage.tsx`, which the
frontend-migration session holds. Item 3 lands whenever the Review stage is ported.
