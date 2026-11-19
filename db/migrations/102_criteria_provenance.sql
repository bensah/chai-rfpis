-- 102 — which of the nine criteria a PERSON answered, and when.
--
-- THE PROBLEM THIS CLOSES. `core.auto_scorer.auto_score` bases all nine criteria to None
-- and re-derives them from org profile x donor intel x call text. It never reads the nine
-- stored columns. That is right for a scanned row and wrong for a reviewed one, and since
-- 2026-10-28 the derived answer has been the STORED score — so on a row a person had
-- assessed, the number on screen answered "what would this score if nobody had looked at
-- it". Measured 2026-11-16: of 56 rows carrying a human decision, 48 held criteria the
-- derivation does not reproduce and 30 of those came out on a different recommendation.
--
-- The scorer could not defer to those answers even in principle, because nothing records
-- WHO SET A CRITERION. Two writers fill the same nine columns:
--
--   core/scan_pipeline.py   writes auto_score's own output at scan time
--   views/rfp_editor.py     writes the reviewer's dropdown answers on save
--   views/review_rfp.py     writes the derived-plus-override label on save
--
-- A reader of `qualification` cannot tell a human's answer from the scan's earlier guess,
-- so `scripts/run_web_job.py::_rescore` was given a blunt instrument instead: skip any row
-- a human has decided on (`core.score_stamp.human_assessed`). That protects the row by
-- refusing to score it at all, which also means a reviewed row's score stops tracking the
-- org profile for ever. This column is what lets that skip eventually go away: once the
-- scorer can see which answers are a person's, it can honour those and re-derive the rest.
--
-- WHY A NEW COLUMN AND NOT `criteria_component_overrides`. That one already carries human
-- verdicts and is the right shape for the Review screen, which records a reviewer at
-- COMPONENT level ("Authorized signatory (this donor)"), not at criterion level. The
-- editor records whole-criterion answers from a dropdown, which has no component to hang
-- itself on. Overloading the overrides column would mean inventing a fake component for
-- every dropdown answer. `core.criteria_provenance` reads BOTH and treats a criterion as
-- human-set if either names it, so the two channels stay in their own shapes.
--
-- SHAPE: {"<criterion>": {"by": "<email>", "at": "<iso8601>"}}, one key per criterion a
-- person actually ANSWERED. Deliberately not one key per criterion the save happened to
-- carry: an editor save round-trips all nine whether or not the reviewer touched them, and
-- recording those would re-badge the scan's own values as human judgement within one save
-- of every row. The writers compare against what the row held and record the changes.
--
-- NULL means "no criterion on this row has a recorded author" — which, the day this lands,
-- is every row. The scorer's behaviour is unchanged until somebody edits something, by
-- design: this adds a channel, it does not reinterpret existing data.

alter table rfp_submissions
    add column if not exists criteria_provenance jsonb;

comment on column rfp_submissions.criteria_provenance is
    'Per-criterion record of a HUMAN answer: {"qualification": {"by": "a@b.org", "at": '
    '"2026-11-16T12:00:00Z"}, ...}. Written by the editors for criteria a save actually '
    'changes, never for the ones it round-trips. core.auto_scorer.auto_score overlays '
    'these answers on top of its own derivation instead of discarding them; a criterion '
    'absent here is the derivation''s to decide. See core/criteria_provenance.py.';

-- Finding the reviewed rows without scanning the table — the re-score job's eventual
-- "score this row, honouring what a person answered" pass needs exactly this set.
create index if not exists idx_rfp_submissions_criteria_provenance
    on rfp_submissions using gin (criteria_provenance)
    where criteria_provenance is not null;
