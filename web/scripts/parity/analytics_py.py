"""The Python half of the Settings → Analytics parity check.

Unlike most of the harnesses here there are no FIXTURES: these are rollups over the live
database, so the fixture is the database and the answer is whatever `core/analytics.py`
says about it right now. The TypeScript reads the same rows through the same service role
and the two are compared.

That makes one thing matter more than usual: the two sides must read at nearly the same
moment. A scan finishing between them would change `found` and `last_run` honestly, and
the check would report a drift that is really a clock. The runner calls this FIRST and
compares immediately after, and the volatile fields are compared with that in mind — see
check-analytics.mjs, which says which are pinned exactly and which are not.

READ ONLY.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core import analytics                                           # noqa: E402


def main() -> None:
    sys.stdin.read()
    try:
        from core.scan_pipeline import MATCH_RUN_LABEL
    except Exception:                                   # pragma: no cover
        MATCH_RUN_LABEL = "\U0001F3AF Find my matches"

    print(json.dumps({
        # The label that tells a tenant's screening run apart from a crawl row in the
        # same table. A drift here reports every tenant as never having screened.
        "match_run_label": MATCH_RUN_LABEL,
        "discovery": analytics.system_discovery_stats(),
        "tenants": analytics.tenant_activity(),
        "users": analytics.user_stats(),
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
