"""Run one background job queued by the React app (a `web_jobs` row, migration 099).

    python scripts/run_web_job.py <job_id> [--runner github|local]

Started by `.github/workflows/web-job.yml` (production) or by the Vite dev server (local
review). The job row is the only channel back to the user: status, progress, message and
result are written there, and the browser polls them through the API.

THE ACTIONS LOG IS PUBLIC (the repository is public). This script prints the job id, its
kind and its status, and nothing else: no parameters, no tenant data, no exception text.
Errors go into the job row, which only the API can read.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from core.dotenv_compat import load_dotenv   # noqa: E402

import requests                               # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JobRow:
    """The job's row over PostgREST with the service key. Plain HTTP, so a light job does
    not import the whole app."""

    def __init__(self, job_id: str):
        url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_KEY"]
        self.endpoint = f"{url}/rest/v1/web_jobs"
        self.headers = {"apikey": key, "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json", "Prefer": "return=representation"}
        self.id = job_id

    def get(self) -> dict | None:
        r = requests.get(self.endpoint, headers=self.headers, timeout=30,
                         params={"select": "*", "id": f"eq.{self.id}", "limit": "1"})
        r.raise_for_status()
        rows = r.json()
        return rows[0] if rows else None

    def update(self, values: dict, *, only_if_status: tuple[str, ...] | None = None) -> bool:
        params = {"id": f"eq.{self.id}"}
        if only_if_status:
            params["status"] = f"in.({','.join(only_if_status)})"
        r = requests.patch(self.endpoint, headers=self.headers, params=params, json=values, timeout=30)
        r.raise_for_status()
        return bool(r.json())

    def progress(self, pct: int | None, message: str) -> None:
        self.update({"progress": {"pct": pct, "message": message}})


# ── Job kinds ────────────────────────────────────────────────────────────────
# Each handler gets the row and the job's params and returns the result dict. Heavy app
# modules are imported inside the handler, so a light job stays light.

def _ping(job: JobRow, params: dict, runner: str) -> dict:
    job.progress(50, "Runner reached")
    time.sleep(1)
    return {"pong": True, "runner": runner}


def _rescore(job: JobRow, params: dict, runner: str) -> dict:
    """Recompute stored scores for one tenant — a row, or all of them.

    This is what "the server owns the score" means in practice (owner, 2026-10-28). The
    scoring itself does NOT move: this runs the same `auto_score` the scan and every live
    screen run. It changes host, not language, so there is still one implementation of the
    rule rather than two that agree until they don't.

    WHY auto_score DIRECTLY AND NOT assess_row, which is what the screens call: assess_row
    wraps it in a bare `except` that returns the row's STORED score, so a display never
    crashes on a scoring hiccup. That is right for a display and wrong here. If it fired
    inside this job, the job would write back the number it just read, stamp `scored_at`
    and the current signature, and the row would claim to be freshly scored while nothing
    was computed — and a checker comparing stored against fresh could not see it, because
    both would be the same stored value. A job must know when scoring failed. So the call
    is the one assess_row makes, and the swallow is not.

    WHAT IT WILL NOT SCORE: a row a human has assessed (owner, 2026-11-16). `auto_score`
    re-derives all nine criteria from org profile x donor intel x call text and never reads
    the nine stored columns, so on a reviewed row it does not correct the number — it
    answers a different question, "what would this score if nobody had looked at it". On
    live data 48 of 56 reviewed rows hold criteria it does not reproduce and 30 of those
    come out with a different recommendation. `core/scan_pipeline.py:307` has deferred to
    human review since long before scoring moved here ("Otherwise human work wins"); this
    job simply did not know about the rule. See `core/score_stamp.py` for the other half.

    A skipped row has its stamps CLEARED rather than left alone, and that is not tidiness.
    Leaving them says the server verified a number it has now stopped maintaining, and the
    moment the reviewer's next edit changes the criteria that claim is false —
    `web/scripts/parity/check-rescore.mjs` would go red on exactly the rows this skip
    exists to protect. Cleared, the row reads "unverified", which is what it is: the score
    is the reviewer's and the server does not vouch for it.

    params: {"tenant_id": required, "uid": optional}. With a uid, one row — what a save
    queues. Without, the tenant's whole table — what a profile edit or a schedule queues.
    The skip applies to both: a save on a reviewed row is the reviewer editing their own
    assessment, which is the last thing that should trigger a re-derivation of it.

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override
    from core.auto_scorer import auto_score
    from core.policies import get_policies
    from core.score_stamp import STAMP_COLUMNS, human_assessed
    from scripts.rescore_existing import profile_signature, write_with_retry

    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()
    if not tenant_id:
        raise ValueError("rescore needs a tenant_id")
    uid = str(params.get("uid") or "").strip()

    # Everything below reads the AMBIENT tenant — get_client, get_profile, get_org. Without
    # the override a job would score one tenant's rows against another's organisation,
    # which is both wrong and invisible, so the whole body runs inside it.
    token = set_tenant_override(tenant_id)
    try:
        from db.supabase_client import get_client
        sb = get_client()
        job.progress(5, "Loading")
        q = sb.table("rfp_submissions").select("*")
        if uid:
            q = q.eq("uid", uid)
        rows = q.execute().data or []
        if not rows:
            return {"rows": 0, "scored": 0, "changed": 0, "runner": runner}

        _org, _org_set, _donors, sig = profile_signature(sb, tenant_id)
        policies = get_policies()
        scored = changed = failed = skipped = 0
        for i, row in enumerate(rows):
            # HUMAN WORK WINS (see the docstring). `decision_date` is the flag the rest of
            # the app reads as "a human has reviewed this" (web/src/api.ts, and
            # pipeline_writes.ts says so in as many words); `decision_overridden_by` catches
            # a row saved in the Streamlit editor, which stamps the author on every save
            # without necessarily setting a decision date.
            if human_assessed(row):
                skipped += 1
                if row.get("scored_at") or row.get("score_profile_sig"):
                    write_with_retry(sb, str(row.get("uid")),
                                     {c: None for c in STAMP_COLUMNS})
                continue
            # auto_score, NOT rescore_existing.evaluate. Both reach composite_match, but
            # auto_score additionally runs _apply_criteria_keywords over the candidate text
            # and evaluate does not, so the two derive different criteria from the same row:
            # measured on live data, AS-260801-0001393 comes out Park/77 one way and
            # Decline/54.5 the other, and 30 of 266 rows change recommendation between them.
            #
            # This is the call assess_row makes, so a server-written score is identical BY
            # CONSTRUCTION to what the screens compute — see the docstring for why the
            # swallow around it is deliberately not copied.
            try:
                res = auto_score(dict(row), policies)
            except Exception as exc:
                # A row that could not be scored is LEFT ALONE. Stamping it would mark it
                # freshly scored under the current profile while holding whatever it held
                # before, which is a worse state than an obviously old one: nothing
                # downstream could tell the difference.
                failed += 1
                print(f"  row {i}: scoring failed ({type(exc).__name__}) — left unstamped")
                continue
            new_score = res.get("alignment_score")
            new_rec = res.get("auto_recommendation")
            if new_score is None and not new_rec:
                failed += 1
                print(f"  row {i}: scoring returned nothing — left unstamped")
                continue

            # The SCORE is what the server owns. The nine criteria stay the scan's to write:
            # re-deriving them here would rewrite columns the editor shows as the system's
            # assessment, which is a bigger claim than "keep the score current".
            upd: dict = {"scored_at": _now(), "score_profile_sig": sig}
            moved = False
            if new_score is not None and new_score != row.get("alignment_score"):
                upd["alignment_score"] = new_score
                moved = True
            if new_rec and new_rec != row.get("auto_recommendation"):
                upd["auto_recommendation"] = new_rec
                moved = True

            # Stamp every row it DID score, even one whose numbers did not move: "scored,
            # unchanged" and "never scored" are different states and only the stamp tells
            # them apart.
            if write_with_retry(sb, str(row.get("uid")), upd):
                scored += 1
                changed += 1 if moved else 0
            if len(rows) > 20 and i % 25 == 0:
                job.progress(5 + int(90 * i / len(rows)), f"Scored {i} of {len(rows)}")

        # `failed` and `skipped` are reported rather than swallowed: a run that scored most
        # of a tenant and quietly passed over the rest should not look like a clean run,
        # and a save that comes back "scored 0" needs to say WHY — deferred to the
        # reviewer, not broken.
        job.progress(100, f"Scored {scored}"
                     + (f", {skipped} left to the reviewer" if skipped else "")
                     + (f", {failed} failed" if failed else ""))
        return {"rows": len(rows), "scored": scored, "changed": changed,
                "failed": failed, "skipped_human_assessed": skipped, "runner": runner}
    finally:
        reset_tenant_override(token)


def _record_decision(job: JobRow, params: dict, runner: str) -> dict:
    """The two consequences of a human decision that the API cannot carry out itself.

    `decision_log.log_decision` writes the ML training LABEL to scan_decisions, which
    nothing reads at gate time. `seen_ledger.record_decision` writes the operational
    tombstone to rfp_seen, which the SCAN does read. The modules' own docstrings are
    emphatic that neither substitutes for the other, and the second one exists because a
    reviewer's Decline used to be forgotten and the call came back on the next run.

    WHY THIS IS A JOB AND NOT TYPESCRIPT IN THE ROUTE: seen_ledger.column_map() probes the
    live rfp_seen table to learn whether it carries the modern or the legacy column
    spelling, and falls back to identity-only columns when neither answers. Re-deriving
    that in the API would be guessing at a schema, and a wrong guess writes no tombstone
    while reporting success — the exact failure the ledger was built to end.

    params: {"tenant_id": required, "uid": required, "decision": required, "by": optional}

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override

    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()
    uid = str(params.get("uid") or "").strip()
    decision = str(params.get("decision") or "").strip()
    if not tenant_id:
        raise ValueError("record_decision needs a tenant_id")
    if not uid or not decision:
        raise ValueError("record_decision needs a uid and a decision")

    # Both modules read the AMBIENT tenant through get_client, so the whole body runs
    # inside the override — a tombstone written against the wrong tenant would suppress
    # someone else's opportunity, which is worse than not writing one.
    token = set_tenant_override(tenant_id)
    try:
        from core import decision_log, seen_ledger
        from db.supabase_client import get_client
        sb = get_client()
        job.progress(10, "Loading")
        rows = sb.table("rfp_submissions").select("*").eq("uid", uid).execute().data or []
        if not rows:
            # The row is read back rather than passed in: it is the truth, and a decision
            # whose row has since gone is nothing to record.
            return {"found": False, "logged": False, "tombstoned": False, "runner": runner}
        row = dict(rows[0])

        job.progress(50, "Recording")
        logged = decision_log.log_decision(row, decision, by=params.get("by") or None)
        # Returns False for a decision that is not a closing one — Park and Proceed are
        # live work and must NOT be tombstoned. That is the module's call, not this job's.
        tombstoned = seen_ledger.record_decision(row, decision)

        job.progress(100, "Recorded")
        return {"found": True, "logged": bool(logged), "tombstoned": bool(tombstoned),
                "runner": runner}
    finally:
        reset_tenant_override(token)


def _delete_rfp(job: JobRow, params: dict, runner: str) -> dict:
    """Remove one opportunity, in the order `views/rfp_editor.py` removes it.

    THE ORDER IS THE WHOLE JOB. Tombstone, then label, then delete:

      1. `seen_ledger.record_human_close(row, reason="human_reject")` — the fact the SCAN
         reads. Until this existed, deleting a row removed the only live record the
         deduplicator matches against, and the next scan re-found the call and inserted it
         afresh: the reported "we keep declining this and it keeps coming back".
      2. `decision_log.log_human_reject([row], by=...)` — the ML training label. Removal is
         the most decisive judgement a reviewer makes and it used to be the only one the
         system threw away.
      3. The delete itself.

    Both of the first two are read FROM the row, which is why the API cannot delete it and
    leave this to catch up, and why the whole act is one job rather than a delete plus some
    bookkeeping (`supabase/functions/_shared/api/pipeline_writes.ts::deleteRfp` says this
    at length). Steps 1 and 2 are best-effort, exactly as the Streamlit button has them —
    `record_human_close`'s own docstring: "a failed tombstone must never block … the delete
    the user actually asked for" — so what they returned is reported in the result rather
    than raised. The order is not best-effort.

    WHY NOT TYPESCRIPT IN THE ROUTE, the same answer as `_record_decision`:
    `seen_ledger.column_map()` probes the live `rfp_seen` table to learn whether it carries
    the modern or the legacy deadline/value spelling. Re-deriving that in the API would be
    guessing at a schema, and a wrong guess writes no tombstone while reporting success.

    params: {"tenant_id": required, "uid": required, "by": optional}

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override

    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()
    uid = str(params.get("uid") or "").strip()
    if not tenant_id:
        raise ValueError("delete_rfp needs a tenant_id")
    if not uid:
        raise ValueError("delete_rfp needs a uid")

    # Every module below reads the AMBIENT tenant through get_client. Without the override
    # this would delete from, and tombstone against, whichever tenant the runner happened
    # to default to — and a delete is the one job that cannot be undone by re-running it.
    token = set_tenant_override(tenant_id)
    try:
        from core import decision_log, seen_ledger
        from db.supabase_client import get_client
        sb = get_client()
        job.progress(10, "Loading")
        rows = sb.table("rfp_submissions").select("*").eq("uid", uid).execute().data or []
        if not rows:
            # Already gone — someone else's delete, or a re-run of this one. Nothing to
            # tombstone from, and nothing to delete. Reported rather than raised: a job
            # that found its work already done has not failed.
            return {"found": False, "tombstoned": False, "logged": False,
                    "deleted": 0, "runner": runner}
        row = dict(rows[0])

        # 1. The tombstone, FIRST, so a delete that fails cannot leave an un-tombstoned
        #    row behind — and so the row it is made from still exists to be read.
        job.progress(35, "Recording")
        tombstoned = True
        try:
            seen_ledger.record_human_close(row, reason="human_reject")
        except Exception as exc:  # noqa: BLE001 — see the docstring; never blocks the delete
            tombstoned = False
            print(f"  tombstone failed ({type(exc).__name__}) — deleting anyway")

        # 2. The training label.
        logged = 0
        try:
            logged = decision_log.log_human_reject([row], by=params.get("by") or None)
        except Exception as exc:  # noqa: BLE001 — telemetry must not block the removal
            print(f"  label failed ({type(exc).__name__}) — deleting anyway")

        # 3. And only now the row.
        job.progress(75, "Deleting")
        gone = sb.table("rfp_submissions").delete().eq("uid", uid).execute().data or []

        job.progress(100, "Deleted")
        return {"found": True, "tombstoned": bool(tombstoned), "logged": int(logged),
                "deleted": len(gone), "runner": runner}
    finally:
        reset_tenant_override(token)


def _export_report_xlsx(job: JobRow, params: dict, runner: str) -> dict:
    """The Report's six-sheet data export — see scripts/report_export_job.py.

    A thin wrapper on purpose: that module is also what
    web/scripts/parity/check-export.mjs imports, so the five queries the check compares
    against views/report.py's own loaders are the ones this job actually runs, rather than
    a third transcription that agrees with neither.
    """
    from scripts.report_export_job import run as _run
    return _run(job, params, runner)


def _submit_followup(job: JobRow, params: dict, runner: str) -> dict:
    """What a manual submission does AFTER the row is inserted — the Python half.

    `views/submit_form.py` runs both of these inline, each inside its own bare `except`,
    straight after the insert. The React route cannot, and neither can be guessed at from
    TypeScript:

      * `seen_ledger.record_one` writes the permanent tombstone the SCAN reads, so the
        call is remembered and never silently re-ingested even if the row is later
        deleted. `seen_ledger.column_map()` probes the live rfp_seen table to learn
        whether it carries the modern or the legacy column spelling and falls back to
        identity-only columns when neither answers. A wrong guess writes no tombstone
        while reporting success.
      * `extracted_store.upsert_extracted` shares the call to the GLOBAL pool so every
        other tenant's eligibility scan can match it against their own preferences. Its
        uid is `make_uid(url, name)`, a hash; computing it a second way in another
        language would key the same call twice and put it in the pool twice.

    BEST-EFFORT, exactly as the form is. The submitter's row is already saved when this
    runs, so neither failure is theirs to see, and raising here would mark a job failed
    over work the Streamlit app also treats as optional. Both outcomes are REPORTED in the
    result instead, because "tombstoned: false" is how anyone finds out why a call the team
    already captured turned up in next Friday's scan.

    params: {"tenant_id": required, "uid": required, "pool": optional record or null}

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override

    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()
    uid = str(params.get("uid") or "").strip()
    if not tenant_id:
        raise ValueError("submit_followup needs a tenant_id")
    if not uid:
        raise ValueError("submit_followup needs a uid")

    # Both modules read the AMBIENT tenant through get_client, so the whole body runs
    # inside the override — a tombstone written against the wrong tenant suppresses
    # somebody else's opportunity, which is worse than not writing one.
    token = set_tenant_override(tenant_id)
    try:
        from db.supabase_client import get_client
        sb = get_client()
        job.progress(10, "Loading")
        # Read the row back rather than trust the params. It is the truth, the tombstone is
        # built from its identity columns, and a submission since deleted is nothing to
        # record.
        rows = sb.table("rfp_submissions").select("*").eq("uid", uid).execute().data or []
        if not rows:
            return {"found": False, "tombstoned": False, "shared": None, "runner": runner}
        row = dict(rows[0])

        job.progress(40, "Recording")
        tombstoned = True
        try:
            from core import seen_ledger
            seen_ledger.record_one(row, reason="manual")
        except Exception as exc:
            tombstoned = False
            print(f"  seen_ledger failed ({type(exc).__name__}) — the scan may re-find this")

        # Two conditions, each checked where it is known. The route sends `pool: null` for
        # a call with no URL, because the pool's uid is made from the URL and a record
        # without one is refused anyway. Whether multi-tenancy is on at all is an
        # environment fact the Edge Function does not hold, so it is read here.
        job.progress(70, "Sharing")
        shared = None
        pool = params.get("pool")
        if isinstance(pool, dict) and pool:
            try:
                from auth.tenant_context import multitenant_enabled
                if multitenant_enabled():
                    from core import extracted_store
                    shared = extracted_store.upsert_extracted(dict(pool))
            except Exception as exc:
                print(f"  pool share failed ({type(exc).__name__}) — this call stays local")

        job.progress(100, "Recorded")
        return {"found": True, "tombstoned": tombstoned, "shared": bool(shared),
                "runner": runner}
    finally:
        reset_tenant_override(token)


def _web_search(job: JobRow, params: dict, runner: str) -> dict:
    """One web-discovery run for the Search page — `core/web_search.py`.

    WHY THIS IS A JOB. The module holds the provider keys (SERPER / TAVILY / EXA), fans one
    keyword out into several RFP-framed searches, FETCHES candidate pages to read their
    first-posted dates, and filters the hits through seven rules — health theme, RFP signal,
    blacklist, geography, expiry, staleness and language. Measured against the live
    providers on 2026-11-16, one query took 21.4 seconds and returned 12 of 43 hits. No
    Edge Function budget survives that, and the seven rules are the part nobody should own
    a second copy of.

    `available` travels back whether or not anything was searched, because "no provider is
    configured" is an administrator's answer and the browser cannot see the environment to
    work it out. The Streamlit page prints exactly that instead of a button.

    params: {"q": required, "num": optional (30), "fresh": optional, "tenant_id": optional}

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override

    q = str(params.get("q") or "").strip()
    if len(q) < 2:
        raise ValueError("web_search needs a query of at least two characters")
    num = int(params.get("num") or 30)
    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()

    # The blacklist and the geography rules are TENANT-SCOPED — they read the organisation's
    # own blocked domains and its operating countries — so the whole body runs inside the
    # override. Without it one tenant's search would be filtered by another's rules, which
    # is invisible in the results and changes which calls they are shown.
    token = set_tenant_override(tenant_id) if tenant_id else None
    try:
        from core import web_search
        if not web_search.available():
            job.progress(100, "No provider configured")
            return {"available": False, "ok": False, "results": [],
                    "error": "No web-search provider is configured.", "runner": runner}

        if params.get("fresh"):
            # The Streamlit Refresh button's own first line. The cache is 15 minutes, and
            # re-running without clearing it would return the same page of results.
            try:
                web_search.search.clear()
            except Exception:
                pass

        job.progress(15, "Searching")
        res = dict(web_search.search(q, num=num))
        job.progress(85, "Filtering")
        res["available"] = True
        res["runner"] = runner
        # Related searches come back with the results rather than from a second call: they
        # are a pure expansion of the query and the page shows them beside the hits.
        try:
            res["suggest"] = list(web_search.suggest_terms(q))
        except Exception:
            res["suggest"] = []
        kept = len(res.get("results") or [])
        job.progress(100, f"{kept} of {res.get('raw_count', 0)} kept")
        return res
    finally:
        if token is not None:
            reset_tenant_override(token)


def _search_action(job: JobRow, params: dict, runner: str) -> dict:
    """Rate a web result, or track it into Found Records.

    Both halves are Python's and neither is a one-liner behind a REST call:

      * `decision_log.log_feedback(row, verdict, by, reason="search-result")` writes the ML
        training label. `reason` is what keeps a rating on a web hit — which has no rfp_uid
        yet — distinguishable from feedback on a row the app already holds.
      * `found_loader.load_candidate` maps the hit to a candidate, scores it with
        `auto_scorer`, asks `deduplicator` whether something already tracks it, and may
        route it to the Sources registry instead of inserting it. Its four outcomes
        (inserted / routed / rejected / skipped) are what the page reports, and they are
        the module's judgement rather than this job's.

    params: {"action": "feedback"|"track", "result": {...}, "verdict": …, "by": …}

    Prints counts and nothing else: this log is public (the repository is).
    """
    from auth.tenant_context import reset_tenant_override, set_tenant_override

    action = str(params.get("action") or "").strip()
    result = params.get("result")
    if action not in ("feedback", "track"):
        raise ValueError("search_action needs action=feedback or action=track")
    if not isinstance(result, dict) or not result:
        raise ValueError("search_action needs a result to act on")
    tenant_id = str(params.get("tenant_id") or (job.get() or {}).get("tenant_id") or "").strip()

    # A tracked candidate becomes a row in rfp_submissions, so the tenant must be the
    # reader's: inserting against the ambient default would put somebody's find in another
    # organisation's pipeline.
    token = set_tenant_override(tenant_id) if tenant_id else None
    try:
        from core import decision_log, found_loader
        cand = found_loader.candidate_from_web_result(result)
        by = str(params.get("by") or "").strip() or None

        if action == "feedback":
            job.progress(50, "Recording")
            ok = decision_log.log_feedback(
                cand, str(params.get("verdict") or ""), by=by, reason="search-result")
            job.progress(100, "Recorded" if ok else "Not recorded")
            return {"action": "feedback", "logged": bool(ok), "runner": runner}

        job.progress(40, "Scoring")
        res = dict(found_loader.load_candidate(cand, {"email": by} if by else None,
                                               provenance="search"))
        job.progress(100, "Tracked" if res.get("ok") else str(res.get("reason") or "Skipped"))
        res["action"] = "track"
        res["runner"] = runner
        return res
    finally:
        if token is not None:
            reset_tenant_override(token)


def _scan_screen(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Manual Scan → Eligibility Scan: screen the curated store for one tenant.

    WHY A JOB FOR SOMETHING THAT TAKES SECONDS. Not duration — LANGUAGE. `run_screening`
    walks the global extracted store and puts every row through `core/scan_pipeline`:
    the geography gate, the nine MUST/PREFER criteria, the donor-intel joins and the
    org-fit profile. That is thousands of lines of Python that the whole port exists to
    avoid re-implementing, and an Edge Function cannot call it. The alternative is not a
    faster screen, it is a second scoring engine.

    IT RUNS AS ONE TENANT and must: screening reads that tenant's eligibility policies
    and org profile and writes into its pipeline, so an unpinned run would screen the
    shared store against whichever tenant the service client happened to resolve.

    THE TENANT IS PASSED, NOT WRAPPED. `run_screening` takes `tenant_id` for exactly this
    case — its own docstring calls it "runs the screen HEADLESSLY as that tenant (no
    Streamlit session)" — and it sets and resets the override itself, around a resolution
    path that also handles a super_user's view-as. Wrapping the call in another override
    would pin the tenant one layer out and leave that path dead, which is a second answer
    to a question the function already answers.

    `views/admin.py` calls the SAME function; only the host changes, which is the bargain
    `_rescore` struck.
    """
    tenant_id = str(params.get("tenant_id")
                    or (job.get() or {}).get("tenant_id") or "").strip()
    if not tenant_id:
        raise ValueError("scan_screen needs a tenant_id")
    by = str(params.get("by") or "web").strip() or "web"

    job.progress(10, "Screening the curated store against your eligibility")
    from core import scan_pipeline
    # The audit prefix the Streamlit page uses, so a run started here is
    # indistinguishable in scan_logs from one started there EXCEPT for who did it.
    res = scan_pipeline.run_screening(triggered_by=f"match:{by}", tenant_id=tenant_id)

    considered = int(res.get("considered") or 0)
    eligible = int(res.get("eligible") or 0)
    added = int(res.get("added") or 0)
    job.progress(100, f"{eligible} eligible of {considered} considered")
    return {
        "considered": considered, "eligible": eligible, "added": added,
        "already_tracked": int(res.get("already_tracked") or 0),
        "rejected": int(res.get("rejected") or 0),
        # The sentence the page shows, composed here so both apps say the same thing
        # about the same run rather than each phrasing the numbers its own way.
        "summary": (f"Screened {considered} curated solicitations → {eligible} eligible "
                    f"({added} newly added, {int(res.get('already_tracked') or 0)} already "
                    f"in your pipeline) · {int(res.get('rejected') or 0)} not a fit."),
    }


def _scan_extract(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Manual Scan → Extraction: crawl every catalogued source.

    THE SLOW ONE — 25-40 minutes with LLM enrichment — and the reason the job seam exists
    at all. It runs `scripts/run_scan.py --extract-only` as a subprocess, which is exactly
    what `core/scan_runner.run_scan_now` does; that function is not reused because it is
    Streamlit-coupled all the way through (st.spinner, st.session_state, st.cache_data),
    and the parts that are not are the two lines below.

    IT IS CROSS-TENANT ON PURPOSE and takes no tenant override. Extraction writes the
    SHARED global store that every tenant then screens against — pinning it to one tenant
    would be wrong, not safer. The permission gate is on the route, where a developer
    tenant is required, and not here.

    A TIMEOUT IS NOT A FAILURE. Records extracted before the cutoff are already saved, so
    it returns a result saying so rather than raising — a job marked failed invites a
    re-run of work that largely succeeded.
    """
    import subprocess

    by = str(params.get("by") or "web").strip() or "web"
    try:
        timeout_sec = int(os.environ.get("RFPIS_EXTRACT_TIMEOUT_SEC", "2700") or 2700)
    except ValueError:
        timeout_sec = 2700

    job.progress(5, "Crawling the catalogued funding sources (this takes 25-40 minutes)")
    cmd = [sys.executable, "-u", str(REPO_ROOT / "scripts" / "run_scan.py"),
           "--triggered-by", f"extraction:{by}", "--extract-only"]
    timed_out = False
    try:
        proc = subprocess.run(cmd, cwd=str(REPO_ROOT), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=timeout_sec)
        out, code = proc.stdout or "", proc.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        out = (exc.stdout or b"").decode("utf-8", "replace") if isinstance(
            exc.stdout, bytes) else (exc.stdout or "")
        code = -1

    tail = "\n".join((out or "").strip().splitlines()[-40:])
    if timed_out:
        job.progress(100, "Hit the time limit; what was extracted is saved")
        return {"ok": False, "timed_out": True, "minutes": timeout_sec // 60, "tail": tail,
                "summary": (f"Extraction hit the {timeout_sec // 60}-minute limit. Records "
                            "extracted before the cutoff were saved — re-run to continue, "
                            "or raise RFPIS_EXTRACT_TIMEOUT_SEC.")}
    if code != 0:
        # Raised, not returned: a crawl that exited non-zero wrote an unknown amount and
        # the operator needs the job to say so in red.
        raise RuntimeError(f"run_scan.py exited {code}\n{tail[-1500:]}")
    job.progress(100, "Extraction finished")
    return {"ok": True, "timed_out": False, "tail": tail,
            "summary": "Extraction finished. The shared store is refreshed — run an "
                       "Eligibility Scan to screen it against this organisation."}


def _excel_sync(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Manual Scan → Excel Sync: import the master workbook into one tenant.

    TENANT-PINNED, and that is the whole point of the parameter: `excel_sync.sync` stamps
    every imported row with the tenant it is given, and without one the rows land with a
    NULL tenant where nobody's pipeline shows them. The Streamlit page passes the current
    tenant for the same reason.

    It returns `{"ok": False, "error": …}` rather than raising when there is no workbook
    configured, so that case is reported as a result the page can explain rather than as
    a crash.
    """
    tenant_id = str(params.get("tenant_id")
                    or (job.get() or {}).get("tenant_id") or "").strip()
    if not tenant_id:
        raise ValueError("excel_sync needs a tenant_id")
    by = str(params.get("by") or "").strip() or None

    job.progress(20, "Importing the workbook into this organisation's pipeline")
    from core import excel_sync
    res = excel_sync.sync(updated_by=by, tenant_id=tenant_id)
    ok = bool(res.get("ok"))
    job.progress(100, "Imported" if ok else "Import failed")
    return {
        "ok": ok,
        "path": str(res.get("path") or ""),
        "error": str(res.get("error") or ""),
        "summary": (f"Excel synced from {res.get('path')} into this organisation."
                    if ok else
                    f"Excel sync failed: {res.get('error') or 'see the job output'}"),
    }


def _tenant_action(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Accounts → Tenants: one write to the platform's organisation list.

    WHY A JOB, AND NOT SIX ROUTES. Two of these writes have a consequence that is
    invisible from the row they change: setting a tenant's consortium consent or its
    PARENT link must clear `core.applicant_graph`'s cache, because that resolver holds
    the tenant rows it scores co-applicants from. A TypeScript write would change the
    column and leave the resolver answering from the old one — for as long as the process
    lives, with nothing anywhere to suggest why a consortium link was not being honoured.
    The blacklist write also carries a migration-077 audit stamp with a status-only
    fallback, and the parent link leans on a database cycle-guard whose rejection is the
    point rather than an error to retry.

    So every write goes through the functions that know those things, lifted out of
    `views/account_sections.py` — the module imports streamlit, and these helpers call
    `st.error` on failure, which is why they are executed with a stub that collects the
    message instead of drawing it.

    AN UNKNOWN ACTION IS REFUSED. These are the controls that decide which organisations
    exist, who may reach cross-tenant developer tasks, and whose profile may be read to
    score somebody else's call. There is no safe default among them.
    """
    import ast as _ast
    import types as _types
    from datetime import datetime as _dt, timezone as _tz

    from db.supabase_client import service_client

    action = str(params.get("action") or "").strip()
    by = str(params.get("by") or "").strip() or None
    tids = [str(t).strip() for t in (params.get("tenant_ids") or []) if str(t).strip()]
    on = bool(params.get("on"))

    # VALIDATED FIRST, before anything is lifted or any client is built. These actions
    # change which organisations exist and who may reach cross-tenant tasks; a request
    # that cannot name one of them should cost nothing and touch nothing.
    _NEEDS_IDS = {"activate", "suspend", "blacklist", "developer", "consortium"}
    if action not in (_NEEDS_IDS | {"parent"}):
        raise ValueError(f"tenant_action: unknown action {action!r}")
    if action in _NEEDS_IDS and not tids:
        raise ValueError(f"{action} needs tenant_ids")
    if action == "parent" and not str(params.get("child_id") or "").strip():
        raise ValueError("parent link needs a child_id")

    # The helpers, with `st` stubbed: they are module-level in a Streamlit view and call
    # st.error on failure. The stub records what they would have shown, so a failure is
    # reported in the job row rather than swallowed.
    errors: list[str] = []
    stub = _types.SimpleNamespace(error=lambda m: errors.append(str(m)))
    src = (REPO_ROOT / "views" / "account_sections.py").read_text(encoding="utf-8")
    tree = _ast.parse(src)
    wanted = {"_set_many_status", "_set_many_tenant_blacklist", "_set_many_developer",
              "_set_many_consortium_consent", "_set_parent"}
    defs = [n for n in tree.body if isinstance(n, _ast.FunctionDef) and n.name in wanted]
    missing = wanted - {d.name for d in defs}
    if missing:
        raise ValueError(f"views/account_sections.py no longer defines {sorted(missing)}")
    ns: dict = {"st": stub, "datetime": _dt, "timezone": _tz}
    exec(compile(_ast.Module(body=defs, type_ignores=[]), "account_sections", "exec"), ns)

    svc = service_client()
    if action in ("activate", "suspend"):
        job.progress(40, f"Setting {len(tids)} organisation(s) to {action}d")
        ns["_set_many_status"](svc, tids, "active" if action == "activate" else "suspended")
        verb = "reactivated" if action == "activate" else "suspended"
    elif action == "blacklist":
        job.progress(40, f"{'Blacklisting' if on else 'Restoring'} {len(tids)}")
        ns["_set_many_tenant_blacklist"](svc, tids, on, by)
        verb = "blacklisted" if on else "restored"
    elif action == "developer":
        job.progress(40, "Setting the developer flag")
        ns["_set_many_developer"](svc, tids, on)
        verb = "flagged as developer tenants" if on else "cleared of the developer flag"
    elif action == "consortium":
        job.progress(40, "Setting consortium sharing")
        ns["_set_many_consortium_consent"](svc, tids, on)
        verb = "opted into consortium sharing" if on else "opted out of consortium sharing"
    elif action == "parent":
        child = str(params.get("child_id") or "").strip()
        parent = str(params.get("parent_id") or "").strip() or None
        job.progress(40, "Linking the organisations")
        ns["_set_parent"](svc, child, parent)
        tids = [child]
        verb = "linked to a parent" if parent else "unlinked from its parent"

    job.progress(100, "Done" if not errors else "Reported a problem")
    return {
        "ok": not errors,
        "action": action,
        "tenant_ids": tids,
        "errors": errors,
        "summary": (f"{len(tids)} organisation(s) {verb}." if not errors
                    else f"Not applied: {errors[0]}"),
    }


def _registry_action(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Sources → Verify Registry: one write to the shared source registry.

    ONE JOB KIND FOR EVERY WRITE, rather than one route each. `core/source_registry.py`
    owns rules that are small individually and awkward collectively: a column whitelist
    on edits, host normalisation from a URL on adds, an upsert keyed on host, and —
    `push_primaries` — a dedupe-by-host upsert into `donor_sources`, the catalogue EVERY
    tenant's scan crawls. Porting four of those to TypeScript would scatter them; porting
    none keeps the registry's rules in the module named after it.

    The registry is also the right place for that trade. It is a developer surface used
    occasionally, so the latency of a job costs nobody anything, while a second
    implementation of `push_primaries` would quietly seed the scan list differently.

    EVERY ACTION IS NAMED AND UNKNOWN ONES ARE REFUSED. The alternative — falling through
    to a default — would turn a typo in a request into some other write on a shared
    table.
    """
    from core import source_registry as reg

    action = str(params.get("action") or "").strip()
    by = str(params.get("by") or "").strip() or None
    hosts = [str(h).strip() for h in (params.get("hosts") or []) if str(h).strip()]
    fields = params.get("fields") if isinstance(params.get("fields"), dict) else {}

    if action == "update":
        host = str(params.get("host") or "").strip()
        if not host:
            raise ValueError("registry update needs a host")
        job.progress(40, f"Saving {host}")
        ok = reg.update_row(host, fields, by=by)
        return {"ok": bool(ok), "host": host,
                "summary": f"Saved {host}." if ok else f"Nothing saved for {host}."}

    if action == "add":
        target = str(params.get("host") or "").strip()
        if not target:
            raise ValueError("registry add needs a host or URL")
        job.progress(40, f"Adding {target}")
        ok, message = reg.add_row(target, fields, by=by)
        return {"ok": bool(ok), "host": target, "summary": message}

    if action == "classify":
        classification = str(params.get("classification") or "").strip()
        status = str(params.get("status") or "confirmed").strip() or "confirmed"
        if not hosts or not classification:
            raise ValueError("registry classify needs hosts and a classification")
        job.progress(40, f"Classifying {len(hosts)} host(s)")
        done = sum(1 for h in hosts
                   if reg.set_classification(h, classification, status=status, by=by))
        return {"ok": done == len(hosts), "done": done, "total": len(hosts),
                "summary": f"Marked {done} of {len(hosts)} host(s) as "
                           f"{classification} / {status}."}

    if action == "delete":
        if not hosts:
            raise ValueError("registry delete needs hosts")
        job.progress(40, f"Deleting {len(hosts)} host(s)")
        n = reg.delete_hosts(hosts)
        return {"ok": n > 0, "done": n, "total": len(hosts),
                "summary": f"Deleted {n} host(s) from the registry."}

    if action == "push":
        if not hosts:
            raise ValueError("registry push needs hosts")
        job.progress(40, f"Pushing {len(hosts)} host(s) to the catalogue")
        res = reg.push_primaries(hosts, by=by) or {}
        added = list(res.get("added") or [])
        updated = list(res.get("updated") or [])
        skipped = [list(x) for x in (res.get("skipped") or [])]
        job.progress(100, "Pushed")
        return {
            "ok": not res.get("error"), "added": added, "updated": updated,
            "skipped": skipped, "error": res.get("error"),
            # SKIPPED IS NOT A FAILURE and the wording has to say so: push_primaries
            # refuses anything that is not a CONFIRMED PRIMARY, which is the gate that
            # keeps an unverified aggregator out of every tenant's scan list.
            "summary": (f"{len(added)} added and {len(updated)} updated in the "
                        f"catalogue"
                        + (f"; {len(skipped)} skipped as not a confirmed primary."
                           if skipped else ".")),
        }

    raise ValueError(f"registry_action: unknown action {action!r}")


def _create_user(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Accounts → Users: create one invited account.

    WHY THIS IS A JOB. `views/account_sections._create_user_account` is not a row insert
    with an email after it. It inserts the user with a password hash nobody knows (32
    bytes of urandom, hashed and discarded, so there is no interim credential to
    intercept), resolves where the account GOES — the admin's own tenant, an existing one,
    or a NEW tenant it creates — disambiguates an individual account whose name collides
    with an existing tenant, writes the membership, mints the activation token and sends
    the welcome email, collecting structured warnings at every step. It creates TENANTS.
    A TypeScript re-implementation would be a second set of rules about who exists on this
    deployment, and its failures would be accounts in half-states nobody looks for.

    It is imported rather than lifted: `views/account_sections` pulls in streamlit, which
    warns about a missing ScriptRunContext in a bare process and otherwise behaves. The
    function itself touches no widget — it is shared by Add user and Bulk add precisely so
    the two cannot disagree.

    IT NEVER RAISES. The contract is `{"ok", "error", "warnings", "notes", "link",
    "emailed", "mail_error"}`, where `ok` means the account exists and `link` is set
    whenever the activation link has to be handed over by hand. So a "failed" creation is
    reported as a RESULT the page can read, not as a crashed job — and the link, which is
    the only credential this flow produces, is never lost to an exception.

    THE ACTOR IS RE-READ FROM THE USERS TABLE, as in _suggestion_review: by the time a
    runner picks a job up, the only record of who asked is what was written down, and
    `_create_user_account` makes permission decisions from the user dict it is given.
    """
    from db.supabase_client import service_client

    email = str(params.get("email") or "").strip()
    name = str(params.get("name") or "").strip()
    role = str(params.get("role") or "collaborator").strip() or "collaborator"
    by = str(params.get("by") or "").strip()
    if not email or not name:
        raise ValueError("create_user needs an email and a name")
    if not by:
        raise ValueError("create_user needs the inviting administrator's email")

    rows = (service_client().table("users")
            .select("id,email,name,role,is_active,access_overrides")
            .eq("email", by).limit(1).execute().data or [])
    if not rows:
        raise ValueError(f"create_user: no account for {by}")
    actor = rows[0]

    # Where the account goes. The shape `_create_user_account` documents; `mt` says
    # whether this deployment is multi-tenant at all.
    tenant = params.get("tenant")
    if not isinstance(tenant, dict):
        tenant = {}
    try:
        from auth import tenant_context as tc
        tenant.setdefault("mt", bool(tc.multitenant_enabled()))
    except Exception:
        tenant.setdefault("mt", False)
    tenant.setdefault("mode", "own")
    tenant.setdefault("kind", "organization")

    job.progress(30, f"Creating the account for {email}")
    from views.account_sections import _create_user_account
    res = _create_user_account(
        actor, email=email, name=name, role=role,
        dept=params.get("department"), program=params.get("program"),
        tenant=tenant)

    ok = bool(res.get("ok"))
    emailed = bool(res.get("emailed"))
    job.progress(100, "Created" if ok else "Not created")
    return {
        "ok": ok,
        "email": email,
        "emailed": emailed,
        # The activation link, returned ONLY when the email did not go. It is the single
        # credential this flow produces and there is no other copy — swallowing it would
        # leave an account nobody can ever reach.
        "link": res.get("link") if not emailed else None,
        "error": res.get("error"),
        "warnings": list(res.get("warnings") or []),
        "notes": list(res.get("notes") or []),
        "mail_error": res.get("mail_error"),
        "summary": (
            f"{email} created and sent an activation link." if ok and emailed
            else f"{email} created, but no email went out — share the activation link "
                 "below. It works once and expires in 7 days." if ok
            else f"Not created: {res.get('error') or 'see the warnings'}"),
    }


def _suggestion_review(job: JobRow, params: dict, runner: str) -> dict:
    """Settings → Suggestions: approve or reject one proposal to a SHARED resource.

    WHY THIS IS A JOB AND NOT A ROUTE. `core.suggestions.approve` resolves the target
    row, intersects the proposed diff with a per-resource column allow-list, derives a
    slug key from the live table and then writes into donor_intel or donor_sources —
    tables every tenant's scan and scoring read. A second implementation of those rules
    in TypeScript would be a second set of opinions about shared data, sitting where the
    first set cannot see it, and the failure would be a quietly wrong donor record rather
    than an error.

    THE GATE IS CHECKED TWICE, and deliberately. The route requires a developer-tenant
    super_user before queueing, and `approve`/`reject` call `_require_dev_super`
    themselves. The second check is not redundant: a job row carries params, and params
    are data — by the time the runner picks it up, the only evidence of who asked is what
    was written down, so the function re-establishes it from the user record rather than
    trusting the queue.

    An UNKNOWN DECISION is refused rather than defaulted. There is no safe default
    between applying somebody's change to a shared catalogue and discarding it.
    """
    from core import suggestions as sug

    suggestion_id = str(params.get("suggestion_id") or "").strip()
    decision = str(params.get("decision") or "").strip().lower()
    by = str(params.get("by") or "").strip()
    note = params.get("note")
    if not suggestion_id:
        raise ValueError("suggestion_review needs a suggestion_id")
    if decision not in ("approve", "reject"):
        raise ValueError(f"suggestion_review: unknown decision {decision!r}")
    if not by:
        raise ValueError("suggestion_review needs the reviewer's email")

    # The reviewer as the permission layer understands them — read from the users table,
    # not reconstructed from the job params. `_require_dev_super` inside approve/reject
    # then asks the same question of the same record the UI did.
    from db.supabase_client import service_client
    rows = (service_client().table("users")
            .select("id,email,name,role,is_active,access_overrides")
            .eq("email", by).limit(1).execute().data or [])
    if not rows:
        raise ValueError(f"suggestion_review: no account for {by}")
    user = rows[0]

    job.progress(20, f"{decision.title()}ing the suggestion")
    if decision == "approve":
        res = sug.approve(suggestion_id, user)
    else:
        res = sug.reject(suggestion_id, user, note=str(note) if note else None)

    job.progress(100, f"{decision.title()}d")
    return {
        "decision": decision,
        "suggestion_id": suggestion_id,
        "status": str((res or {}).get("status") or decision),
        "summary": (f"Suggestion {decision}d."
                    + (" The shared record has been updated." if decision == "approve"
                       else " Nothing was changed.")),
    }


def _donor_action(job: JobRow, params: dict, runner: str) -> dict:
    """Donor Intelligence: every write to the shared donor catalogue.

    ONE JOB KIND FOR ALL OF THEM, for the reason `_registry_action` and
    `_suggestion_review` give about their own tables, and more sharply here.
    `donor_intel` is cross-tenant data that every tenant's scoring reads, and its write
    rules are not a thin wrapper over an upsert:

      * a payload-cleaning rule where `or None` collapses False and 0, not just "";
      * an intersection with the LIVE columns that NAMES what it drops, because a field
        with no column yet would otherwise vanish after a successful save;
      * a human-verified provenance tag that stops auto-enrichment overwriting a
        reviewer's answers;
      * an upsert that VERIFIES a row came back, because PostgREST answers 200 with an
        empty list when RLS refuses it — "looks saved, nothing changed".

    `core/donor_write.py` holds them, and app_pages/donors.py calls exactly the same
    functions. A TypeScript second copy would drift on the first of those four, and the
    symptom would be a donor record that is quietly wrong rather than an error.

    EVERY ACTION IS NAMED AND UNKNOWN ONES ARE REFUSED, so a typo in a request cannot
    fall through to some other write on a shared table.
    """
    from core import donor_fields as F
    from core import donor_write as W
    from core import permissions
    from db.supabase_client import service_client

    action = str(params.get("action") or "").strip()
    by = str(params.get("by") or "").strip()
    key = str(params.get("canonical_key") or "").strip()
    edited = params.get("edited") if isinstance(params.get("edited"), dict) else {}
    contacts = params.get("contacts") if isinstance(params.get("contacts"), list) else []
    if not by:
        raise ValueError("donor_action needs the acting user's email")

    svc = service_client()
    # The actor as the permission layer understands them — read from the users table,
    # never reconstructed from the job params, so the job asks the same question of the
    # same record the UI did.
    rows = (svc.table("users")
            .select("id,email,name,role,is_active,access_overrides,tenant_id")
            .eq("email", by).limit(1).execute().data or [])
    if not rows:
        raise ValueError(f"donor_action: no account for {by}")
    user = rows[0]
    can_edit = permissions.is_developer_super(user)

    # The live columns, from the table itself. The classification is NEGATIVE — anything
    # not named in donor_fields' sets is a flag — so this has to be the real column list
    # and not a guess, or the provenance pass would tag the wrong set.
    sample = (svc.table("donor_intel").select("*").limit(1).execute().data or [])
    columns = list(sample[0].keys()) if sample else []
    _flags, _fit, req, _groups = F.flag_groups(columns)

    def _row(k: str) -> dict:
        got = (svc.table("donor_intel").select("*")
               .eq("canonical_key", k).limit(1).execute().data or [])
        if not got:
            raise ValueError(f"donor_action: no donor with key {k!r}")
        return got[0]

    if action in ("save", "add"):
        if not can_edit:
            # Not a generic refusal: this is the one surface where a client-tenant admin
            # is deliberately read-only, and "suggest instead" is the real answer.
            raise PermissionError(
                "Only a developer-tenant Super User may edit the shared donor "
                "catalogue directly. Propose the change instead and it will be reviewed.")

    if action == "save":
        if not key:
            raise ValueError("donor_action save needs a canonical_key")
        row = _row(key)
        job.progress(40, f"Saving {row.get('donor') or key}")
        res = W.apply_edit(svc, canonical_key=key, edited=edited, row=row,
                           columns=columns, req_cols=req, contacts=contacts)
        job.progress(100, "Saved")
        return {
            "ok": True, "canonical_key": key, "dropped": res["dropped"],
            "warnings": res["warnings"],
            "summary": f"Saved {row.get('donor') or key}."
                       + (f" {len(res['dropped'])} field(s) could not be stored."
                          if res["dropped"] else ""),
        }

    if action == "add":
        name = str(params.get("name") or "").strip()
        if not name:
            raise ValueError("donor_action add needs a name")
        existing = {r.get("canonical_key") for r in
                    (svc.table("donor_intel").select("canonical_key")
                     .execute().data or [])}
        new_key = W.slug_key(name, {e for e in existing if e})
        payload = W.normalise(W.clean_payload({"donor": name, **edited}), new_key)
        payload, dropped = W.split_columns(payload, columns)
        job.progress(50, f"Creating {name}")
        W.save_donor(svc, payload)
        job.progress(100, "Created")
        return {
            "ok": True, "canonical_key": new_key, "dropped": dropped,
            "warnings": [w for w in [W.dropped_warning(dropped)] if w],
            "summary": f"Added {name}. Open it and edit to complete the profile.",
        }

    if action in ("suggest", "suggest_add"):
        # The MIRROR of the gate above: a developer-Super edits directly and never files
        # a suggestion, so letting one through here would put a proposal in the queue
        # that its own author is the only person able to approve.
        if can_edit:
            raise PermissionError(
                "A developer-tenant Super User edits the record directly rather than "
                "proposing a change.")
        target = key or None
        row = _row(key) if key else {}
        label = row.get("donor") or str(params.get("name") or "").strip() or None
        payload = dict(edited)
        if action == "suggest_add":
            name = str(params.get("name") or "").strip()
            if not name:
                raise ValueError("donor_action suggest_add needs a name")
            payload = {"donor": name, **payload}
            target, label = None, name
        job.progress(50, "Filing the proposal")
        res = W.suggest_edit(canonical_key=target, edited=payload, row=row,
                             columns=columns, rationale=params.get("rationale"),
                             target_label=label, user=user)
        job.progress(100, "Filed" if res["ok"] else "Nothing to propose")
        return {"ok": res["ok"], "count": res["count"],
                "summary": (f"Proposal filed — {res['detail']}" if res["ok"]
                            else "No changes to suggest.")}

    if action == "delete":
        if not can_edit:
            raise PermissionError(
                "Only a developer-tenant Super User may delete from the shared donor "
                "catalogue.")
        keys = [str(k).strip() for k in (params.get("keys") or [key])
                if k is not None and str(k).strip()]
        if not keys:
            raise ValueError("donor_action delete needs at least one canonical_key")
        job.progress(40, f"Deleting {len(keys)} donor(s)")
        n = W.delete_donors(svc, keys)
        job.progress(100, "Deleted")
        return {"ok": n > 0, "done": n, "total": len(keys),
                "summary": f"Deleted {n} donor(s)."}

    raise ValueError(f"donor_action: unknown action {action!r}")


KINDS: dict[str, Callable[[JobRow, dict, str], dict]] = {
    "ping": _ping,
    "rescore": _rescore,
    "record_decision": _record_decision,
    "delete_rfp": _delete_rfp,
    "export_report_xlsx": _export_report_xlsx,
    "submit_followup": _submit_followup,
    "web_search": _web_search,
    "search_action": _search_action,
    # Settings → Manual Scan. Heavy or Python-only work, which is the same thing here.
    "scan_screen": _scan_screen,
    "scan_extract": _scan_extract,
    "excel_sync": _excel_sync,
    # Settings → Suggestions: applying a proposal to a SHARED catalogue.
    "suggestion_review": _suggestion_review,
    # Settings → Accounts → Users: an invited account, which also creates tenants.
    "create_user": _create_user,
    # Settings → Sources → Verify Registry: every write to the shared registry.
    "registry_action": _registry_action,
    # Settings → Accounts → Tenants: the platform organisation list.
    "tenant_action": _tenant_action,
    # Donor Intelligence: every write to the shared donor catalogue.
    "donor_action": _donor_action,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id")
    ap.add_argument("--runner", default="github", choices=["github", "local"])
    args = ap.parse_args()
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", args.job_id):
        print("job id is not a uuid")
        return 2

    # Locally the .env sits in the working directory (the main checkout) or the repo root.
    load_dotenv(Path.cwd() / ".env")
    load_dotenv(REPO_ROOT / ".env")

    job = JobRow(args.job_id)
    row = job.get()
    if not row:
        print(f"job {args.job_id}: not found")
        return 1
    kind = row.get("kind") or ""
    run_url = None
    if os.environ.get("GITHUB_RUN_ID"):
        run_url = (f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
                   f"{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ['GITHUB_RUN_ID']}")
    # Claim it: only a queued or dispatched job starts, so a re-run of the workflow cannot
    # run the same job twice.
    if not job.update({"status": "running", "started_at": _now(), "run_url": run_url},
                      only_if_status=("queued", "dispatched")):
        print(f"job {args.job_id} ({kind}): not claimable, status={row.get('status')}")
        return 0
    print(f"job {args.job_id} ({kind}): running on {args.runner}")

    handler = KINDS.get(kind)
    try:
        if handler is None:
            raise ValueError(f"Unknown job kind {kind!r}")
        result = handler(job, row.get("params") or {}, args.runner)
        job.update({"status": "done", "result": result, "finished_at": _now(),
                    "progress": {"pct": 100, "message": "Done"}})
        print(f"job {args.job_id} ({kind}): done")
        return 0
    except Exception as exc:  # noqa: BLE001 — reported in the row, never in the log
        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
        try:
            job.update({"status": "failed", "message": detail[:2000], "finished_at": _now()})
        except Exception:
            pass
        print(f"job {args.job_id} ({kind}): failed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
