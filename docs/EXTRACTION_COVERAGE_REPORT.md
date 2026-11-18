# Extraction coverage: the measurement, what moved, and what the schema should drop

Measured 2026-11-18 over the live stores. Reproduce any figure here with:

```bash
python scripts/measure_extraction_coverage.py
python scripts/measure_extraction_coverage.py --availability
```

Both are read-only.

## What is being measured

`core.opportunity_detail._COVERAGE_FIELDS` — the 41 fields of `DATA_SCHEMA_ETL.md`
§4 that carry CALL CONTENT. That list is used rather than a new one because
coverage has to mean the same thing here and on the opportunity page, and the page
is what the owner is looking at when they say a discovered call lands empty.

Two populations:

| | what it is |
|---|---|
| **catalog** | `extracted_solicitations` — what extraction produced |
| **pipeline** | `rfp_submissions`, joined to its extraction by call URL exactly as the opportunity page joins it — what a reviewer sees |

## The baseline

| | rows | coverage | rows at ≥80% |
|---|---|---|---|
| catalog | 1687 | **41.6%** | **0** |
| pipeline | 271 | **48.2%** | **0** |

Not one row of 1958 met the 80% bar, and eight fields were populated on **no row at
all**: `apply_url`, `agency_code`, `grantmaking_entity`, `total_program_funding`,
`expected_awards`, `expected_award_date`, `time_to_award`, `focus_themes`.

## Why those eight were zero

Not a pipeline performing badly — a field with **no writer**.
`core/opportunity_detail.py` has said so in its header since August. Each had been
left to the LLM pass, and that pass has two failure modes which look identical from
the data: not configured, or out of credit.

On the day of the measurement it was the second. The configured endpoint answered

```
402 — Add usage credits or subscribe
```

to `gpt-oss:120b` **and** `gpt-oss:20b` — the whole model chain. Every call site
handles that correctly (one shot, no retry, fall back to regex), so nothing logged
an error a human would read, and the LLM half of extraction had simply stopped.
The rows written while the credit lasted are still visible in the numbers:
`full_description` 36.6%, `what_is_funded` 36.8%, `applicant_fit_profile` 39.0%,
and nothing since.

## What changed

**1. A provider chain, not just a model chain** (`core/llm_providers.py`).
Carried back from Opportunova, which has run `gemini,zai,ollama,claude` since
2026-10-12. Every model in RFPIS's chain sat behind one base URL and one key, so
the chain survived "this model is unavailable" and nothing else.
`chat_with_fallback` now continues across providers once the caller's own endpoint
is exhausted. With `RFPIS_LLM_PROVIDERS` unset the behaviour is exactly today's.

**2. The fields regex can read are read** (`core/field_extract.py`). The owner's
design is that an LLM does the bulk of the work *wherever regex hits its limits*.
These facts are published in formulaic language — "grants of between £50,000 and
£150,000", "we expect to fund up to 8 projects", "over a period of 24 months" — and
are below that limit. They are now read for free, whether or not anyone has paid a
model bill, and each value carries the phrase it came from into `field_provenance`.

**3. The call's own requirements reach the score without a model**
(`core/scan_pipeline.py::_apply_call_compliance`). That loop used to sit inside
`if _syn:`, so a provider outage silently reverted every scanned row to deciding
co-financing from donor intel alone — on a corpus where 10 of 190 donor records
answer the co-financing question at all.

### Before → after

**Applied to the live catalogue on 2026-11-18**, with the owner's go-ahead: 1463 of
1687 rows updated. One row lost its connection mid-write; a second pass picked it
up and wrote nothing to the other 1686, which is the blanks-only rule holding.
Both figures below are MEASURED before and after the write, not projected — they
match the dry run to a tenth of a point.

| | before | after | |
|---|---|---|---|
| catalog | 41.6% | **48.3%** | +6.6 pts, 1463 of 1687 rows updated |
| pipeline | 48.2% | **51.1%** | +3.0 pts, 1 row now at ≥80% |

| field | before | after |
|---|---|---|
| `focus_themes` | 0.0% | 80.0% |
| `call_domain_areas` | 28.3% | 86.0% |
| `submission_format` | 25.8% | 57.0% |
| `solicitation_type` | 66.3% | 89.8% |
| `resource_links` | 18.8% | 40.5% |
| `what_is_not_funded` | 4.7% | 23.0% |
| `attachments` | 1.9% | 13.3% |
| `total_program_funding` | 0.0% | 10.2% |
| `eligibility_applicant_types` | 27.7% | 34.5% |
| `project_duration` | 1.9% | 8.4% |
| `call_award_ceiling` | 0.8% | 1.8% |
| `call_award_floor` | 0.7% | 1.6% |
| `expected_award_date` | 0.0% | 0.7% |
| `time_to_award` | 0.0% | 0.7% |
| `expected_awards` | 0.0% | 0.4% |
| `eligibility_countries` | 7.1% | 7.4% |

On the opportunity the owner opened to show the problem — AS-261113-143730, the
FCDO SRHR call — the page gained three blocks that had been empty: how to submit
("Online portal: SmartSimple (queries: rcc@3ieimpact.org)"), who may apply (NGO /
non-profit, university / research institute, private company, consortium) and the
call's exclusions. Its coverage is 19 of 41.

Also written: `donor_key` / `donor_intel_id` on 176 rows, which were NULL on all
1687. The scorer already resolves the donor by funder name on every pass; the
row has never recorded which donor it resolved to, so nothing downstream can audit
why MUST-5 activated. Exact matching only — `core/donor_intel.py` says why the
fuzzy fallback (which would reach 37.3% of rows) is the wrong trade on a gate path.

## **80% was not reachable against the schema as it stood — and why**

This is the finding that mattered more than the +6.6 points, and it is what the
owner acted on. It is recorded as it was measured, before the removal below.

A field can be blank for two opposite reasons, and fill rate alone cannot tell them
apart. `--availability` asks a looser question of each row's source text — *does
this page mention the subject at all* — over the 1517 catalogue rows with ≥200
characters of text to judge by:

| field | subject appears on | reading |
|---|---|---|
| `agency_code` | **0.9%** | a US-federal concept; `funding_opportunity_number` already carries the reference |
| `expected_awards` | **0.9%** | funders publish a budget, not a count |
| `total_program_funding` | **1.6%** | published as the award figure or not at all |
| `grantmaking_entity` | **2.8%** | equals `funder_name` except in rare pass-through grants |
| `call_award_floor` | **3.0%** | calls publish a ceiling, rarely a range |
| `funding_tiers` | **5.6%** | staged funding is a real feature of a small minority of calls |
| `apply_url` | 20.5% mentioned, **0% ever stored** | "a different shape on every portal (a form POST, a JS modal, a login wall)" — `opportunity_detail.apply_url` already falls back to the call page |

Against those, the fields where the subject IS published and we were missing it —
`project_duration` 38.0% published, `resource_links` 49.5%, `submission_format`
53.9%, `what_is_not_funded` 34.7%, `eligibility_countries` 33.0% — are the ones the
change above went after, and they are where the points came from.

### The arithmetic

41 fields. Seven of them (the table above) describe facts the sources do not
publish; no extractor will ever fill them. That is **17% of the schema that is
structurally unreachable**, so the ceiling on measured coverage is about 83% even
if everything else were perfect.

Five more — `full_description`, `what_is_funded`, `applicant_fit_profile`,
`eligibility_other`, `project_stages` — are genuine reading-and-rewriting and only a
model can produce them. They sit around 36% today because the provider ran out of
credit. Restoring a working provider is worth roughly **+7 points** on its own, and
is the single largest remaining lever.

Removing the seven and restoring a working model would put coverage over the
remaining 34 fields in the high sixties. Reaching 80% beyond that would require the
mid-range fields to be near total, and `--availability` says the sources do not
support that.

### The decision (owner, 2026-11-18): the seven are out

Per the owner's rule — *where a data point is consistently unavailable across
sources, propose removing it from the schema instead of continuing to extract it;
measure before proposing* — these seven left
`core.opportunity_detail._COVERAGE_FIELDS`:

`apply_url`, `agency_code`, `grantmaking_entity`, `total_program_funding`,
`expected_awards`, `call_award_floor`, `funding_tiers`

They are listed in `_REMOVED_FROM_COVERAGE` beside the schema, with the measured
figure that justified each one, so the removal is auditable rather than folklore.

**What that did to the number — and what it did not do.**

| | 41-field schema | 34-field schema |
|---|---|---|
| catalog | 48.3% | **57.8%** |
| pipeline | 51.1% | **58.1%** |
| rows at ≥80% | 1 | **70** (64 catalogue, 6 pipeline) |

That is not the measurement improving; it is the measurement starting to mean
something. Nothing about any call changed. What stopped is a standing 17%
deduction for facts no funder publishes, which no extractor could ever have
recovered and which made "extraction is poor" impossible to act on.

**Nothing was deleted.** The columns stay, the extractors stay, and five of the
seven still render. Two points on that, because "remove from the schema" could
have been read as "take off the page":

* `total_program_funding` and `expected_awards` **stay on the page**. Both are
  hand-editable — `views/rfp_editor.py:422` and its React twin offer them as typed
  inputs — so dropping the rows would let a reviewer enter a figure the page then
  refuses to show back. `total_program_funding` is also the field that keeps a £12m
  PROGRAMME from reading as a £12m AWARD, which is the confusion the SRHR call
  demonstrated. Rare is a reason not to GRADE the pipeline on a field; it is not a
  reason to hide the value when it is there.
* `call_award_floor` keeps its extractor and its row, because
  `core/criteria_derive.below_award_floor` SCORES on it and the "Award range" row
  shows it beside the ceiling. `apply_url` keeps driving the Apply button through
  its existing fallback.

Only the two nobody can type left the layout: **`funding_tiers`** (0.1% populated,
LLM-only — and where tiers are found, `extract.tiers_to_bounds` turns them into the
award range, which still renders) and **`agency_code`** (never populated, a
super_user row that could only print a dash).

### What 80% would now take

Over the 34 remaining fields, five are genuine reading-and-rewriting that only a
model can produce — `full_description`, `what_is_funded`, `applicant_fit_profile`,
`eligibility_other`, `project_stages` — and they sit near 36% because the provider
ran out of credit. Restoring a working provider is worth roughly **+9 points** on
this schema and is the single largest remaining lever. That would put coverage in
the high sixties, with the rest in the fields `--availability` shows are published
on a third to a half of pages: `project_duration` (38.0%), `resource_links`
(49.5%), `submission_format` (53.9%), `what_is_not_funded` (34.7%),
`eligibility_countries` (33.0%).

## What is covered

- `tests/test_field_extract.py` — 46 cases. The negative ones matter most: each
  pins a false positive the first, looser version of a pattern actually produced
  when it was sampled against the live corpus ("homeless for over two years" had
  become a 24-month project duration; the EU portal's "Expected Outcome" heading
  had become an award date).
- `tests/test_cofinancing_donor_complement.py` — 10 cases over the donor-complement
  rule end to end: donor requires + we can → 1, donor requires + we cannot → 0,
  donor does not require → the component leaves the denominator rather than
  scoring zero, and the call's own statement overriding a donor record either way.
- `web/scripts/parity/check-extraction.mjs` — a coverage floor over the live
  catalogue, plus the contract: every derived field is a real column, no
  placeholder is ever stored, and the pass fills blanks only.
