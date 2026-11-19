"""One-off repair: drop the freshness stamp from rows whose stamp is lying.

    python scripts/repair_editor_stamps.py            # read-only report (default)
    python scripts/repair_editor_stamps.py --apply    # clear those rows' stamps

WHAT WENT WRONG. Until 2026-11-16 the three Streamlit write paths (`views/rfp_editor.py`,
`views/review_rfp.py`, `views/submit_form.py`) wrote `core.scorer.score_submission`'s
coarser number into `alignment_score` / `auto_recommendation` and left `scored_at` and
`score_profile_sig` exactly as the `rescore` job had set them. The row then claimed to hold
a score the job had computed under the current profile while holding the editor's answer.
`core/score_stamp.py` is the fix; this is the rows the fix came too late for.

WHICH ROWS. The ones where the stamp's claim is FALSE: the row carries a signature, and the
number beside it is not what `core.auto_scorer.auto_score` produces from that same row
today. That is `_rescore`'s own rule ("a stamped row must hold a number the stamped profile
actually produced") and it is exactly what `web/scripts/parity/check-rescore.mjs` fails on.
Measured 2026-11-16: 5 rows, all chai-cameroon, all reproducing EXACTLY under
`score_submission` and none under `auto_score`, each saved by the same reviewer days after
its `scored_at`.

WHY NOT "every row saved after it was stamped". That set is bigger (8) and the extra three
are not broken. Two of them — AS-260925-115409 and AS-260629-213704 — hold `auto_score`'s
answer, not the editor's, and their save timestamps match `record_decision` jobs in
`web_jobs`: those are React saves, which write the decision and never touch the score, so
their stamps are true. The third, BN-260804-2358, was a Streamlit save whose two scorers
happened to agree (Proceed/100 both ways), so what the stamp claims is still what the row
holds. Clearing a truthful stamp throws away real information about when the job last ran.

WHAT IT DOES NOT DO. It does not re-score anything. Writing `auto_score`'s answer over these
rows would move five live recommendations (three Proceed→Park, one Proceed→Decline, one
Decline→Park) in an app the team is using today — the server's job to do on its own
schedule, not a repair script's call to make. A cleared row reads "unverified" (migration
101's own word for a null signature), keeps the number the reviewer saved, stops
`web/src/api.ts::scoreIsBehind` showing it a recalculation spinner that can never resolve,
and is picked up and stamped honestly by the next `rescore` job.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from auth import tenant_context as tc              # noqa: E402
from core.auto_scorer import auto_score            # noqa: E402
from core.policies import get_policies             # noqa: E402
from core.score_stamp import STAMP_COLUMNS         # noqa: E402
from core.scorer import CRITERIA, score_submission  # noqa: E402
from db.supabase_client import service_client      # noqa: E402

# `scripts/rescore_existing._evaluate` only writes a score that moved by at least this much,
# and check-rescore compares on the same epsilon. Anything smaller could never have been
# written by either path, so it is not a disagreement worth clearing a stamp over.
EPSILON = 0.05


def _rounded(value) -> float | None:
    return None if value is None else round(float(value), 1)


def _differs(stored: tuple, fresh: tuple) -> bool:
    if stored[0] != fresh[0]:
        return True
    a, b = stored[1], fresh[1]
    return a is not None and b is not None and abs(a - b) >= EPSILON


def main(argv: list[str]) -> int:
    apply = "--apply" in argv
    sb = service_client()
    policies = get_policies()
    tenants = (sb.table("tenants").select("id,slug").eq("status", "active")
               .execute().data or [])
    stamped = lying = editors_number = cleared = 0

    for tenant in tenants:
        tid = str(tenant["id"])
        slug = tenant.get("slug") or tid
        token = tc.set_tenant_override(tid)
        try:
            rows = (sb.table("rfp_submissions").select("*")
                    .eq("tenant_id", tid).limit(5000).execute().data or [])
            for row in rows:
                if not row.get("score_profile_sig"):
                    continue          # unverified, not wrong: nothing to repair
                stamped += 1
                stored = (row.get("auto_recommendation"),
                          _rounded(row.get("alignment_score")))
                if stored == (None, None):
                    continue
                try:
                    res = auto_score(dict(row), policies)
                except Exception as exc:                      # pragma: no cover - live data
                    print(f"{slug:<16}{str(row.get('uid')):<20}"
                          f"could not be scored ({type(exc).__name__}) - left alone")
                    continue
                fresh = (res.get("auto_recommendation"),
                         _rounded(res.get("alignment_score")))
                if not _differs(stored, fresh):
                    continue
                lying += 1

                # Reported, not used as the test: it names the AUTHOR of the stored number
                # when the two scorers happen to differ, which is what makes the diagnosis
                # legible rather than just the disagreement.
                values = {c: row.get(c) for c in CRITERIA}
                e_score, e_rec = score_submission(
                    values, bool(row.get("decline_flags_present")))
                editor = (e_rec, _rounded(e_score))
                by_editor = editor == stored
                editors_number += 1 if by_editor else 0

                print(f"{slug:<16}{str(row.get('uid')):<20}"
                      f"stored={str(stored):<20}fresh={str(fresh):<20}"
                      f"editor={str(editor):<20}"
                      f"{'stored IS the editor answer' if by_editor else 'author unclear'}")
                print(f"{'':16}scored_at={row.get('scored_at')}  "
                      f"saved_at={row.get('decision_overridden_at')}  "
                      f"by={row.get('decision_overridden_by')}")

                if apply:
                    # Only the two stamps. The score the reviewer saved stays exactly as it
                    # is - this repair changes no number anybody is looking at.
                    sb.table("rfp_submissions").update(
                        {c: None for c in STAMP_COLUMNS}
                    ).eq("uid", row.get("uid")).execute()
                    cleared += 1
        finally:
            tc.reset_tenant_override(token)

    print(f"\n{stamped} stamped rows checked; {lying} hold a number the stamp did not earn "
          f"({editors_number} of them reproduce exactly under the editor's scorer).")
    print(f"{cleared} stamps cleared." if apply
          else "Read-only. Re-run with --apply to clear their stamps.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
