"""The Python half of the Search parity check.

`core/site_search.py` is an ordinary module, so `search_nav` is imported rather than
lifted. The two DATA functions are wrapped in `@st.cache_data`, which needs a Streamlit
script context to call — so the decorator is stripped the way check-export strips
`@st.cache_data` off the report loaders, and the undecorated function runs against the
live database.

The nav HREFS are deliberately not compared: the Python's registry carries Streamlit module
paths and the port carries React routes. What must agree is the INDEX — the labels, the
keyword strings, the admin flags — and the RANKING, because that is what decides which hit
a reader sees first.

READ ONLY. Nothing here writes a row.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core import site_search                                     # noqa: E402

SITE_PY = REPO_ROOT / "core" / "site_search.py"
_WANT = ["search_opportunities", "search_donors"]


def _undecorated() -> dict:
    """`search_opportunities` / `search_donors` without `@st.cache_data`.

    The decorator wants a script context and a cache key; calling it from a bare process
    either warns on every call or refuses outright. Stripping `node.decorator_list` gives
    the function body itself, which is the thing being compared — and the module's own
    globals are reused, so `get_client`, `safe_execute` and `_sanitize` are the real ones.
    """
    tree = ast.parse(SITE_PY.read_text(encoding="utf-8"))
    picked = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _WANT:
            node.decorator_list = []
            picked.append(node)
    missing = set(_WANT) - {n.name for n in picked}
    if missing:
        raise SystemExit(f"core/site_search.py no longer defines: {sorted(missing)}")
    ns = dict(site_search.__dict__)
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(SITE_PY), "exec"), ns)
    return ns


P = _undecorated()


def main() -> None:
    payload = json.loads(sys.stdin.read())

    registry = [{"label": label, "keywords": keywords, "admin_only": bool(admin_only)}
                for label, keywords, _path, admin_only in site_search._NAV]

    nav = []
    for case in payload["nav"]:
        hits = site_search.search_nav(case["q"], bool(case["admin"]))
        nav.append([label for label, _path in hits])

    opps = []
    for q in payload["queries"]:
        opps.append([{"title": r["title"], "funder": r["funder"], "deadline": r["deadline"],
                      "decision": r["decision"], "source": r["source"]}
                     for r in P["search_opportunities"](q)])

    donors = [[d["name"] for d in P["search_donors"](q)] for q in payload["queries"]]

    print(json.dumps({
        "registry": registry,
        "nav": nav,
        "opportunities": opps,
        "donors": donors,
        "sanitized": [site_search._sanitize(s) for s in payload["sanitize"]],
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
