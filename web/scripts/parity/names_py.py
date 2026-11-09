"""The Python half of the names / vocabulary parity check.

Unlike report_py.py, these ARE importable modules — core/funder_names.py, core/member_names.py
and core/keyword_cloud.py — so they are imported and called directly, no AST lifting.

`core.member_names` reads its roster, nicknames and aliases from the database through
`core.settings`, so this runs against the SAME configuration the TypeScript loads. Feeding
both sides a fixture instead would check the algorithm and miss the thing most likely to be
wrong: which store each map is read from, and whether the tenant's roster or the global one
answers.

    python names_py.py <what>     cases as JSON on stdin, results as JSON on stdout
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

from core.dotenv_compat import load_dotenv   # noqa: E402

for _d in (Path.cwd(), REPO_ROOT, Path("D:/Apps/chai-rfpis")):
    load_dotenv(_d / ".env")

from core import funder_names, keyword_cloud, member_names   # noqa: E402

# BOTH ENDS, EXPLICITLY. On Windows the default codec for stdin and stdout is cp1252, and
# the two errors cancelled: the harness read UTF-8 JSON as cp1252 (so "Française" became
# "FranÃ§aise" INSIDE the Python), then wrote it back as cp1252 bytes that Node decoded as
# UTF-8, landing on "Française" again. The check passed while the Python side had been
# computing on mojibake throughout — and any rule that reads a non-ASCII character, which is
# every rule in this file, was being compared on the wrong input.
#
# Fixing only the output end is worse than fixing neither: it breaks the cancellation and
# turns a silent wrong-input bug into a loud wrong-output one. Both, or the test is a lie.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def do_config(_cases) -> dict:
    """The three maps as the Python resolves them, for the ambient tenant."""
    from core import dropdowns
    return {
        "roster": list(dropdowns.get("team_members") or []),
        "nicknames": member_names._nickname_map(),
        "aliases": member_names._fullname_aliases(),
    }


def do_funders(values: list) -> dict:
    return {
        "canonical": [funder_names.canonical_funder(v) for v in values],
        "key": [funder_names.funder_key(v) for v in values],
        "dominant": funder_names.dominant_spelling(values),
        "groups": funder_names.group_by_funder(values),
    }


def do_members(cases: dict) -> dict:
    return {
        "normalized": [member_names.normalize_member_name(v) for v in cases["singles"]],
        "split": [member_names.split_and_normalize_names(v) for v in cases["raw"]],
        "display": member_names.first_name_display_map(cases["canonical"]),
    }


def do_members_cfg(cases: dict) -> dict:
    """The member helpers against an INJECTED roster / nickname / alias config.

    The live database has an empty nickname map and an empty alias map, so the branches that
    use them are reached by every call and distinguished by none: the check would pass with
    those paths wrong. Both sides are given the same made-up config here, so the comparison
    actually separates a correct implementation from an incorrect one.

    The names are obvious inventions. Real ones are DATA and stay in the database.
    """
    from core import dropdowns

    cfg = cases["config"]
    orig = (member_names._nickname_map, member_names._fullname_aliases, dropdowns.get)
    member_names._nickname_map = lambda: dict(cfg["nicknames"])
    member_names._fullname_aliases = lambda: dict(cfg["aliases"])
    dropdowns.get = lambda key, default=None: (list(cfg["roster"]) if key == "team_members"
                                               else orig[2](key, default))
    try:
        return {
            "normalized": [member_names.normalize_member_name(v) for v in cases["singles"]],
            "split": [member_names.split_and_normalize_names(v) for v in cases["raw"]],
            "display": member_names.first_name_display_map(cases["canonical"]),
        }
    finally:
        member_names._nickname_map, member_names._fullname_aliases, dropdowns.get = orig


def do_keywords(texts: list) -> dict:
    return {
        "tokens": [keyword_cloud._tokenize(str(t or "")) for t in texts],
        "freq_each": [keyword_cloud.extract_keyword_frequencies([str(t or "")]) for t in texts],
        "freq_all": keyword_cloud.extract_keyword_frequencies([str(t or "") for t in texts]),
    }


def do_areas(rows: list) -> dict:
    """_programme_area_freq over rows, plus _canonical_area on each raw label."""
    import pandas as pd
    sys.path.insert(0, str(REPO_ROOT / "web" / "scripts" / "parity"))
    from report_py import NS   # the lifted helpers, so this runs report.py's own source

    df = pd.DataFrame(rows) if rows else pd.DataFrame(columns=["call_domain_areas"])
    return {
        "freq": NS["_programme_area_freq"](df),
        "canonical": {str(k): NS["_canonical_area"](str(k))
                      for k in {str(x) for r in rows for x in _labels(r)}},
    }


def _labels(row: dict) -> list:
    v = row.get("call_domain_areas")
    if isinstance(v, list):
        return v
    return [v] if v else []


HANDLERS = {
    "config": do_config, "funders": do_funders, "members": do_members,
    "members_cfg": do_members_cfg, "keywords": do_keywords, "areas": do_areas,
}

if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "null")
    print(json.dumps(HANDLERS[sys.argv[1]](payload), ensure_ascii=False))
