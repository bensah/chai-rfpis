"""Python half of check-scoring.mjs: app_pages/home.py's counters, per tenant. Read-only.

LIFTED, NOT RETYPED. This file used to carry a hand-copy of `_kpis`'s body with a docstring
asking the next person to keep the two in step. Nobody can: a copy agrees with itself, so
the check would go on passing while home.py's arithmetic moved underneath it, and the one
thing the check exists to notice is exactly that movement.

The page is a Streamlit script - importing it renders a page and calls st.* at module level
- so it cannot simply be imported. `ast` takes the one function out of the file instead,
without executing anything else in it: parse home.py, pull the `_kpis` FunctionDef, drop its
@st.cache_data decorator (there is no Streamlit runtime here), and compile that alone
against the handful of names its body uses. If `_kpis` changes, this picks the change up on
the next run; if it is renamed or deleted, this fails loudly rather than comparing against a
ghost.
"""
import ast
import json
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core.dotenv_compat import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import pandas as pd                          # noqa: E402

from auth import tenant_context as tc        # noqa: E402
from core.records import clean_df            # noqa: E402
from db.supabase_client import get_client, service_client  # noqa: E402

# BOTH ENDS, EXPLICITLY. On Windows the default codec for stdin and stdout is cp1252, so a
# harness reads UTF-8 JSON as cp1252 and writes its answer back as cp1252 bytes. Node then
# decodes those as UTF-8. Sometimes the two errors cancel and the check passes while
# comparing mojibake; sometimes they do not and it reports differences that are not there —
# check-permissions spent this session reporting 39 false diffs on a single em dash, which
# is how a check stops being read.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _lift(src: Path, name: str):
    """The named module-level function out of `src`, compiled alone and undecorated."""
    tree = ast.parse(src.read_text(encoding="utf-8"), filename=str(src))
    fns = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name]
    if not fns:
        raise SystemExit(f"{src.name} no longer defines {name}() — check-scoring's home "
                         f"section is comparing against a function that has moved or gone.")
    fn = fns[0]
    fn.decorator_list = []      # @st.cache_data wants a Streamlit runtime; there is none here
    ns = {"get_client": get_client, "clean_df": clean_df, "pd": pd,
          "date": date, "timedelta": timedelta}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(src), "exec"), ns)  # noqa: S102
    return ns[name]


kpis = _lift(ROOT / "app_pages" / "home.py", "_kpis")

out = {}
for t in (service_client().table("tenants").select("id").eq("status", "active")
          .execute().data or []):
    tid = str(t["id"])
    tok = tc.set_tenant_override(tid)
    try:
        # `scope` is _kpis's cache discriminator and unused in the body; the tenant id is
        # the honest value for it, and the decorator is gone anyway.
        out[tid] = kpis(tid)
    finally:
        tc.reset_tenant_override(tok)
sys.stdout.write(json.dumps(out))
