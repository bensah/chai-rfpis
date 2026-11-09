-- 101 — when a score was computed, and under what profile.
--
-- The owner's decision (2026-10-28) is that the SERVER owns the score: the browser stops
-- computing it and reads what the server holds.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT ADD IS A SCORES TABLE. The first draft of it
-- created `live_scores`, keyed by (tenant, uid), holding the score beside the row. That
-- would have been a SECOND place a score lives — and the bug we spent yesterday removing
-- was one number banded in two places. `rfp_submissions.alignment_score` and
-- `auto_recommendation` are already the stored score, already what every reader selects,
-- and already what scripts/rescore_existing.py rewrites in place. Server-owned scoring is
-- that script, run as a job, on a schedule and after a save. It needs no new home.
--
-- What it does need is a way to tell whether the stored score is CURRENT, because a score
-- is no longer recomputed at the moment it is read:
--
--   scored_at         when the scoring last ran for this row
--   score_profile_sig the org-profile + settings signature it ran under
--
-- The signature is the useful one. core/live_scoring builds it from the org profile and
-- settings, and uses a change in it to bust every row's memo — precisely because a profile
-- edit changes what every score should be. Stored here, a reader can see that a score
-- predates the current profile without recomputing anything to find out.
--
-- THE COST, stated because it is why the plan originally kept scoring in the browser: a
-- score is no longer instant after an edit. It is rewritten by a queued job, which takes
-- about a minute to boot and run. Review must SHOW that it is catching up rather than
-- present a stale number as current — these two columns are what let it.
--
-- Both nullable: every existing row has a score and no record of when it was computed, and
-- that is honestly "unknown", not "stale". A reader treats a null signature as unverified
-- rather than wrong.

alter table rfp_submissions
    add column if not exists scored_at         timestamptz,
    add column if not exists score_profile_sig text;

comment on column rfp_submissions.scored_at is
    'When alignment_score / auto_recommendation were last computed. Null means the row '
    'predates server-owned scoring: its score is unverified, not necessarily stale.';

comment on column rfp_submissions.score_profile_sig is
    'The org-profile + settings signature the score was computed under (core.live_scoring''s '
    'prof_sig). A mismatch with the current signature means a profile change has happened '
    'since, so the score is stale and a re-score is due.';

-- Finding what a profile edit invalidated, per tenant, without scanning the table.
create index if not exists idx_rfp_submissions_score_sig
    on rfp_submissions (tenant_id, score_profile_sig);
