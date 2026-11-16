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


KINDS: dict[str, Callable[[JobRow, dict, str], dict]] = {
    "ping": _ping,
    "rescore": _rescore,
    "record_decision": _record_decision,
    "delete_rfp": _delete_rfp,
    "export_report_xlsx": _export_report_xlsx,
    "submit_followup": _submit_followup,
    "web_search": _web_search,
    "search_action": _search_action,
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
