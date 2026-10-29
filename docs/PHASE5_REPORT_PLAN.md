# Phase 5 — Report

The plan for porting `views/report.py` (~3,200 lines) to the React app. Written before any
code, because Report is the page where the same English word means three different numbers on
purpose, and a porter who tidies that up breaks it.

## Where the work happens, and why

Report reads up to 50,000 `rfp_submissions` rows plus four more tables, then aggregates them
into 21 metric blocks. Three places that could happen:

| | Verdict |
|---|---|
| In the browser, over streamed rows | No. It would ship tens of megabytes to compute a dozen numbers, and every one of the aggregations would have to be re-written in TypeScript anyway. |
| In a background job | No. The period and section controls are interactive; a minute's wait per change is not a report, it is a batch print. |
| **In the API** | **Yes.** The rows never leave the server, the payload is the numbers themselves, and there is exactly one implementation of each aggregation to hold against Python. |

So: `GET /report` takes the period, the grouping and the selected sections, and returns the
computed series. The browser draws them. This matches how Phase 2 split Pipeline, and it
survives the move of scoring to the server rather than fighting it.

The Edge Function's ~2 s CPU budget is the constraint to respect. The aggregations are sums
and counts over at most 50k rows of a few columns — fine — but the two **exports are not**,
and go to GitHub Actions (below).

## The traps — pin these, do not improve them

Every one of these looks like a bug and is not. The parity check exists to keep them.

**"Submitted" is three different numbers.**
- `_submitted_mask` — `progress_status == "completed"` OR `donor_decision` in {approved,
  under review, not approved}. Used by the funnel, the conversion rates and the people stacks.
- `n_submitted` — the sum of the `submissions` column over Proceed + Completed rows. Used by
  the "Applications submitted" tile and the win rate.
- `submission_weights` — used by the headline prose.

The funnel's "Submitted" and the tile's "Applications submitted" are **not** the same figure
and must not be reconciled. Using progress alone would let Approved exceed Submitted.

**"Secured" is two different numbers**, and "win rate" and "Submitted → Approved" use
different denominators.

**Requested USD converts differently by section**: §5 falls back `currency_secured → currency`;
the funnel and the Submitted-Grants table use `currency` alone.

**Period scope is deliberately inconsistent.** Sections 3 and 4 (funnel, progress, decisions)
and the §5 results ignore the period, because Excel-migrated rows have a NULL `search_date`
and would vanish. The cumulative chart, the discovery chart and decisions-over-time respect
it. The focus-area cloud and the donor-decision chart are all-time even inside period-filtered
sections — the captions say so, and the captions must survive the port.

**A NULL date excludes a row when a period is active, and includes it under "All time."**

**Section ids are stable and do not match display order** (id 4 is displayed second, id 2
third). They are persisted in snapshots. Renumbering them breaks saved reports.

**Silent fallbacks** that must stay silent: an unknown or missing currency converts at 1.0,
i.e. as USD. §5 shows a warning badge for it; nowhere else does.

**Decision matching is asymmetric**: `startswith("proceed")`, but `== "park"` and
`== "decline"` exactly. "No decision" is the remainder, so an unexpected string lands there.

**Blank `progress_status` on a Proceed row reads "Not Started"**, never "(unset)".

**Weekly and Semestrial buckets deliberately start before the period** (a week at `start-6d`,
a half-year up to 180 days back). Empty buckets are zero-filled so an empty period draws a
flat line rather than disappearing.

## Snapshots

"Generate report" stores the selection under a generated id and puts `?r=<id>` in the URL.
Two things carry over exactly:

- The store is `app_settings.report_snapshots_json` — **global, shared across tenants,
  last-write-wins, newest 100 kept**. That is a known caveat in the Python, not a bug to fix
  inside this port. Worth raising with the owner separately; it is not Phase 5's to change.
- `restore_items`: a metric added *after* a snapshot was saved comes back **on**. For
  snapshots that recorded the full item universe, a deliberate de-selection stays off; for
  older ones it does not. Port the rule, not an improved version of it.

Without a valid `?r=` the Streamlit page stops before rendering. The React page should do the
same rather than render an unrequested report.

## Exports

**XLSX** — six sheets (Summary, Scan logs, RFPs, Meeting logs, Engagement logs, Applied
Funding), raw frames, all columns. Too big to build in an Edge Function and pointless to build
in the browser when the rows are server-side. It becomes a **job**: the runner produces the
file with the same `openpyxl` code, puts it in the private bucket, and the API hands back a
signed URL. The cell-level sanitising (`_safe_for_excel`: drop timezones, inf→NaN,
lists/dicts→JSON) comes along unchanged.

**PDF** — Chromium through Playwright, 240 s, with a self-contained HTML fallback. Already
impossible anywhere but Actions. Same job mechanism. **It needs `RFPIS_GH_DISPATCH_TOKEN`,
still unset**, so until that exists the PDF button reports that background jobs are not
configured. The browser's own print dialog covers the common case meanwhile, and the HTML
fallback is worth keeping as a download.

## Charts

Plotly in Python; the React app will use its own chart components on the API's series. What
must port exactly is the logic *behind* the picture, not the picture: bucketing and zero-fill,
the cumulative sum, funder-identity grouping (`funder_key` / `dominant_spelling`), partner
splitting and org-name canonicalisation, the top-15-by-total selection with forced zero rows,
and the fixed semantic colour orders for decision / progress / donor-decision.

The word cloud is the one raster. Python already falls back to a ranked table when the library
is missing; the React page can simply use that table and drop the cloud, which loses nothing a
reader acts on.

## Build order

1. `GET /report/periods` and the period model — the smallest thing with a real rule in it
   (`_period_bounds`, `_bucket_start`, `_bucket_range`), and everything else depends on it.
2. `GET /report` for sections 1 and 2, with the parity check alongside from the first commit.
3. Sections 3, 4 and 5, which carry the three-way "Submitted" and the two-way "Secured".
4. The snapshot routes and `?r=` handling.
5. The XLSX job.
6. The PDF job, or the honest "not configured" state if the token is still missing.

## Parity

`web/scripts/parity/check-report.mjs`, from step 2 onward: runs the API's aggregation and
`views/report.py`'s own helpers over the same live rows, for **every period option × every
grouping**, and diffs every number. The traps above are precisely the things that a plausible
re-implementation gets wrong, so the check is the only thing that will catch it.
