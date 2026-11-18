# The nine criteria: audit and proposal

Written 2026-11-18, from reading `core/scorer.py`, `core/criteria_derive.py`,
`core/opportunity_scoring.py`, `core/matching.py` and `core/criteria_review.py`
against the owner's statement of what the scoring is supposed to do.

The owner's principle, in their words:

> if org has entries that match what the call + donor is looking for, we score 1,
> if it doesn't we give it a 0, if we are unsure we leave it as unsure and don't
> score it (drops from denominator).

**The code does not do the last part**, and three defects follow from it. They are
set out first, because two are cheap to fix and one is a decision only the owner
can take.

---

## 1. What the screenshot is actually showing

> "Note MUST 1, it shows 'Not sure' + not scored, but we note a bar read, and
> 7.5 / 15. This is contradictory. if there is a score, then a component was scored."

Correct, and it is three different rules disagreeing about one word.
`core/opportunity_scoring.py:124-137`:

```python
unsure = criterion_score(label) is None          # the label cannot be scored
num, total, pct = _crev.criterion_count(...)     # how many COMPONENTS were found
sc   = criterion_score(label)                    # 2 / 1 / 0 / None
frac = 0.5 if sc is None else sc / 2.0           # <-- unknown still earns HALF
"scored": bool(total),                           # <-- a different question
"points": WEIGHTS[key] * frac * 100.0,           # 15 * 0.5 = 7.5
```

* `"Not sure"` is the **label** — nothing could be determined.
* `"not scored"` is `bool(total)` — **no components were found**.
* `7.5 / 15` is `frac = 0.5` — an undeterminable criterion is **awarded half marks**.

So all three are true at once and the page is reporting them faithfully. The fault
is upstream: a criterion nobody could assess is paid half its weight.

`core/scorer.py:244` states this as settled policy:

> ALL 9 criteria count toward the denominator. A response of "Not sure" / unscored
> (criterion_score → None) is rated value 1 (0.5) — the Park midpoint — so an
> UNKNOWN criterion reads as "needs review", not a hard fail.

That is a defensible design. It is **not** the owner's design, and the two produce
materially different numbers. On the SRHR call, MUST 1 contributes 7.5 of the 80.

### The decision to take

| | Unknown criterion | Effect |
|---|---|---|
| **A — today** | scores 0.5, stays in the denominator | an unmeasured call drifts toward 50; thin records look mediocre rather than unknown |
| **B — the owner's rule** | drops from numerator **and** denominator | the score means "of what we could assess, this is the fit"; a call assessed on 5 of 9 says so |

B is the more honest number and the one the owner has asked for twice. It needs one
guard: a composite computed from very few criteria must not be presented as
equivalent to one computed from nine, so B requires the **denominator to be shown**
("80 / 100 on 5 of 9 criteria") and a floor below which no suggestion is offered at
all. Without that guard B is worse than A, because two criteria both scoring 1 would
read 100.

**Recommendation: B, with the denominator on the page and a minimum of 5 assessed
criteria (including at least 3 MUSTs) before any suggestion is shown.**

---

## 2. The editor dropdown is showing a value from another criterion

> "you build and mixed up the form pickers with redundant responses"

The MUST 1 picker in the screenshot offers six options:

```
Not recorded · Yes, fully · Mostly, one item unclear · No, not eligible · Not sure · Yes, comfortably
```

The real vocabulary is four (`core/scorer.py:173`):

```python
"qualification": ["Yes, fully", "Mostly, one item unclear", "No, not eligible", "Not sure"]
```

* **"Not recorded"** is correct — it is the editor's blank option, not a stored value.
* **"Yes, comfortably" is MUST 3's vocabulary** (`capacity`, line 177), and it is in
  that list because **the row stores it**. `web/src/opportunity/controls.tsx::Choice`
  appends a stored value the vocabulary does not contain, deliberately, so a row
  always reads honestly rather than silently resetting.

So the picker is not mixed up — it is **reporting corrupt data faithfully**. The bug
is whatever wrote `qualification = "Yes, comfortably"`. `criterion_score` maps it to
2, so the row has been scoring MUST 1 as a full pass on a capacity answer.

**Action:** find and fix the writer, then sweep `rfp_submissions` for any of the nine
columns holding a value outside its own vocabulary. This is measurable and should be
a parity check, not a one-off script.

### A correction to the owner's recollection

> "Yes, comfortably" (2), "No, not eligible" (1) and "Not sure" (0)

The adopted values are **2 / 1 / 0 / None**, and for MUST 1 they are:

| Answer | Score |
|---|---|
| Yes, fully | 2 |
| Mostly, one item unclear | 1 |
| No, not eligible | **0** |
| Not sure | None (today: treated as 0.5) |

"No, not eligible" is 0, not 1 — it is the hard-fail that gates a MUST. And
"Yes, comfortably" belongs to MUST 3, not MUST 1.

---

## 3. Human submissions cannot be reconciled with the engine

> "user can select MUST 1 as Yes, comfortably ... but system on calculating score
> via components gets a different answer ... the system should flag this against
> user who can then confirm this score or edit. I haven't seen this wired in the
> react app."

Confirmed absent. What exists today:

* **Streamlit** has the component editor — `views/criteria_editor.py`, with
  per-component `—/0/0.5/1` controls and a live gauge.
* **React** has nine plain dropdowns (`RfpEditor.tsx`, the Eligibility tab) and no
  component view at all.
* On submit, `supabase/functions/_shared/api/scorer.ts` runs `score_submission`,
  which the module's own docstring calls a **coarser** rule than `auto_score` — no
  fatal gate, no award-floor cap — so it is an upper bound, not the engine's answer.
* Nothing compares the two and nothing surfaces a disagreement.

**Proposal:** on a human submission, run both and store both — the user's answers as
the decision, the engine's as `auto_*` (which already exists and is already kept for
audit). Where they differ by a band on any criterion, show a reconciliation panel:
the criterion, the user's answer, the engine's, and the components behind the
engine's. The user confirms or edits. This is the same shape as the existing
suggestion queue and needs no new storage.

---

## 4. Component-by-component review

The owner's test for keeping a component: **can we get the data from the call or the
donor, and is there something on the organisation's side to match it against?** A
component that fails either half cannot be defended and should be merged or dropped.

What each criterion is derived from today (`criteria_derive.derive_criteria`, line 2401):

| # | Criterion | call | donor | org | Verdict |
|---|---|---|---|---|---|
| MUST 1 | Legal status & qualification | ✓ | ✓ | ✓ | **Keep.** Well matched: donor states the requirement, org profile states its status |
| MUST 2 | Strategic fit | ✓ | ✓ | ✓ | **Keep.** Program-area keys match org areas; the taxonomy is shared |
| MUST 3 | Implementation capacity | ✓ | ✓ | ✓ | **Keep**, but see note below |
| MUST 4 | Geographic fit | ✓ | ✓ | ✓ | **Keep.** The cleanest match in the set |
| MUST 5 | Cofinancing & compliance | ✓ | ✓ | ✓ | **Keep.** Already implements the drop-from-denominator rule correctly — see below |
| PREFER 6 | Funding quality | ✓ | ✗ | ✓ | **Revise.** Reads no donor data, though `donor_intel` holds award ranges and funding tiers |
| PREFER 7 | Donor relationship | ✓ | ✓ | ✓ | **Keep.** Matches org's funder history against the donor |
| PREFER 8 | Competitiveness | ✓ | ✓ | ✓ | **Keep**, but it is the weakest evidentially — see below |
| PREFER 9 | Bid effort | ✓ | ✗ | settings only | **Revise.** No donor input and no org *profile* input |

### MUST 5 is already the model to copy

`cofinancing_bid_strength` (line 1515) does exactly what the owner describes:

```python
items = [f for f in compliance_factors(...) if f["active"] and f["score"] is not None]
return sum(f["score"] for f in items), len(items)
```

Inactive components leave **both** numerator and denominator. If the donor requires
no co-financing, the component is not scored 0 — it is not scored at all. Nothing
active at all → "Not sure".

**This is the pattern. The other eight should follow it, and the composite should
follow it too (§1, option B).** The architecture the owner described is already
implemented, once, in one criterion.

### PREFER 9 — Bid effort is the weakest

Derived from `(rfp, org_settings)` only: time-to-deadline × whether a BD team exists.
No donor input, and the org side is a single settings flag. It cannot express team
bandwidth, competing deadlines, or whether this funder's process is heavy — all of
which `donor_intel` knows (`donor_application_process`, `donor_reporting_requirements`).

**Proposal:** fold the donor's process burden in, or merge PREFER 9 into PREFER 8 as
a single "cost of bidding vs chance of winning" measure. Two weak indicators defended
separately are worse than one defended well.

### PREFER 6 — Funding quality should read the donor

Bands the award value against the org's own targets. The donor's published award
range and funding tiers are in `donor_intel` and are not consulted, so a call that
states no value scores on nothing when the donor could have supplied it.

---

## 5. Proposed plan, in order

1. **Fix the corrupt stored values** (§2) and add a parity check that no criterion
   column holds a value outside its own vocabulary. Cheap, measurable, stops the
   misleading dropdown at source.
2. **Decide §1.** If B, change `alignment_score` to drop unscorable criteria from
   the denominator, show the denominator on the page, and suppress the suggestion
   below the floor. This moves live numbers and needs the owner's word before it
   lands.
3. **Make the other eight follow MUST 5's active-component pattern**, so "not
   applicable" and "not known" stop being the same thing.
4. **Wire the reconciliation panel** (§3) so a human submission and the engine can
   disagree visibly.
5. **Revise PREFER 6 and PREFER 9** to read donor data, or merge 9 into 8.

Steps 1 and 4 are independent of the others and can go first. Step 2 is the one that
changes every score in the database and should be measured before and after, on the
same before/after discipline the extraction work used.

---

## What this audit did not check

* Whether `donor_org_extras` (the 20% in `composite_match`) still earns its weight.
  `criteria_derive`'s own comments say the old extras were dropped in 2026-06 for
  duplicating MUST-2/4/5; `matching.py:287` still computes some.
* The two composites. `opportunity_scoring` prefers `composite_match` and falls back
  to `sum(points)`; those are different arithmetic and I have not confirmed they
  agree.
* Any of this against live rows. The database was unreachable while this was written.
