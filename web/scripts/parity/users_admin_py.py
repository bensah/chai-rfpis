"""The Python half of the Settings → Accounts → Users parity check.

ONE ANSWER KEY, as elsewhere: the shapes live here and the answers come from the modules
that own the rules — `core.user_lifecycle`, `core.permissions`, and the validation lifted
out of `views/account_sections.py`.

WHY THIS ONE IS WORTH MORE THAN THE REST. Everywhere else a drift costs a score or a
number on a page. Here it costs ACCESS, and in a direction nothing reports: a role
assigned one step too high, an override granted beyond the grantor's own, an account that
reads Active while it has never been used. The three gates — can-manage, the self lock,
the override ceiling — are the only thing between a request and somebody else's account,
and a client is not bound by whatever the dialog disabled.

`account_status` gets the longest case list because its bug already happened once: a None
`last_login_at` arrives from pandas as the float nan, whose str() is "nan" — truthy — so
the inline version never reported anybody as Pending, and a structural test grepping the
source for "Pending" passed happily.

READ ONLY. It touches no database.
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

from core import permissions                                          # noqa: E402
from core.user_lifecycle import (                                     # noqa: E402
    STATUS_ACTIVE, STATUS_INACTIVE, STATUS_PENDING, account_status)

SECTIONS = REPO_ROOT / "views" / "account_sections.py"


def _lift(*names: str) -> dict:
    """Module-level functions out of views/account_sections.py, executed together.

    The module imports streamlit and builds dialogs at import time, so it cannot be
    imported for these. Lifting them is the same trick the other harnesses use on view
    files — and they go in ONE namespace because `_bulk_problems` calls
    `_new_user_problems`: lifted separately, it would find no such name.
    """
    import pandas as pd

    tree = ast.parse(SECTIONS.read_text(encoding="utf-8"))
    defs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    missing = set(names) - {d.name for d in defs}
    if missing:
        raise SystemExit(f"views/account_sections.py no longer defines {sorted(missing)}")
    # `_bulk_rows` takes a DataFrame and calls `.to_dict("records")` on it.
    ns: dict = {"pd": pd}
    exec(compile(ast.Module(body=defs, type_ignores=[]), str(SECTIONS), "exec"), ns)
    return ns


_NS = _lift("_new_user_problems", "_bulk_rows", "_bulk_problems")
_new_user_problems = _NS["_new_user_problems"]
_bulk_rows = _NS["_bulk_rows"]
_bulk_problems = _NS["_bulk_problems"]


# ── Fixtures ─────────────────────────────────────────────────────────────────

# account_status. The nan cases are the ones that bit: a blank arriving as a STRING.
STATUS_CASES: list[tuple] = [
    (True, True, None),            # invited, never used        → Pending
    (True, True, ""),              # same, blank from a join
    (True, True, "nan"),           # same, through pandas       → the bug
    (True, True, "NaT"),
    (True, True, "None"),
    (True, True, "null"),
    (True, True, "<NA>"),
    (True, True, "   "),
    (True, True, "2026-11-01T09:00:00+00:00"),   # signed in, rotation due → Active
    (True, False, None),           # flag cleared, never used   → Active, not Pending
    (True, False, "2026-11-01T09:00:00+00:00"),
    (False, True, None),           # inactive beats everything
    (False, False, "2026-11-01T09:00:00+00:00"),
    (None, True, None),
    (0, 1, None),
    (1, 0, ""),
]

# can_manage_user, across every role pairing plus the self cases.
ROLES = ["collaborator", "reviewer", "admin", "super_user", ""]
MANAGE_CASES: list[tuple[dict, dict]] = []
for a in ROLES:
    for t in ROLES:
        MANAGE_CASES.append(({"role": a, "email": "actor@x.org"},
                             {"role": t, "email": "target@x.org"}))
        MANAGE_CASES.append(({"role": a, "email": "same@x.org"},
                             {"role": t, "email": "same@x.org"}))

# The override ceiling, per surface, per actor role.
OVERRIDE_CASES: list[tuple[dict, str, str, object]] = []
for role in ("collaborator", "reviewer", "admin", "super_user"):
    for surface in list(permissions.ACCESS_MATRIX)[:6]:
        for cap in ("edit", "view", "view+add", "trigger", "hidden"):
            for current in (None, "edit", "hidden"):
                OVERRIDE_CASES.append(
                    ({"role": role, "email": "a@x.org"}, surface, cap, current))

NEW_USER_CASES: list[tuple] = [
    ("jane@example.org", "Jane Doe"),
    ("", "Jane Doe"),
    ("no-at-sign", "Jane Doe"),
    ("has space@example.org", "Jane Doe"),
    ("  jane@example.org  ", "Jane Doe"),
    ("jane@example.org", ""),
    ("jane@example.org", "   "),
    ("", ""),
]


# The bulk table. `_bulk_rows` takes a DataFrame, so each case is the list of row dicts a
# DataFrame is built from — the shape the data editor hands back.
#
# THE CASES ARE ABOUT WHAT COUNTS AS A ROW. The table always offers more rows than anybody
# uses, so an empty one is spare capacity rather than a mistake; reporting "email
# required" for it would bury the real typos. But a row with only a DEPARTMENT typed is
# somebody who forgot the email, and that must be reported.
BULK_CASES: list[list[dict]] = [
    # Two good rows and three untouched ones.
    [{"Email": "a@x.org", "Full name": "A", "Role": "collaborator", "Department": "BD",
      "Program areas": []},
     {"Email": "b@x.org", "Full name": "B", "Role": "reviewer", "Department": "",
      "Program areas": []},
     {"Email": "", "Full name": "", "Role": "collaborator", "Department": "",
      "Program areas": []},
     {"Email": "", "Full name": "", "Role": "collaborator", "Department": "",
      "Program areas": []},
     {"Email": "", "Full name": "", "Role": "collaborator", "Department": "",
      "Program areas": []}],
    # A row with only a department: used, and missing its email and name.
    [{"Email": "", "Full name": "", "Role": "", "Department": "Finance",
      "Program areas": []}],
    # A row with only program areas: also used.
    [{"Email": "", "Full name": "", "Role": "", "Department": "",
      "Program areas": ["IDs - Malaria & NTDs"]}],
    # Whitespace everywhere, which the cell cleaner strips.
    [{"Email": "  c@x.org  ", "Full name": "  C  ", "Role": " admin ",
      "Department": "  Ops  ", "Program areas": []}],
    # Duplicate addresses differing in case.
    [{"Email": "d@x.org", "Full name": "D", "Role": "", "Department": "",
      "Program areas": []},
     {"Email": "D@X.ORG", "Full name": "D again", "Role": "", "Department": "",
      "Program areas": []}],
    # An unassignable role.
    [{"Email": "e@x.org", "Full name": "E", "Role": "super_user", "Department": "",
      "Program areas": []}],
    # Program areas as a COMMA STRING, which is what a paste produces.
    [{"Email": "f@x.org", "Full name": "F", "Role": "", "Department": "",
      "Program areas": "IDs - Malaria & NTDs, HSS - Health Financing"}],
    [],
]

# Roles an ADMIN may assign, and one address already taken — the two things
# `_bulk_problems` is given besides the rows.
BULK_ROLES = ["collaborator", "reviewer", "admin"]
BULK_EXISTING = {"taken@x.org"}


def _bulk_case(rows: list[dict]) -> dict:
    import pandas as pd
    df = pd.DataFrame(rows) if rows else pd.DataFrame(
        columns=["Email", "Full name", "Role", "Department", "Program areas"])
    parsed = _bulk_rows(df)
    return {
        "rows": rows,
        "parsed": parsed,
        "problems": _bulk_problems(parsed, BULK_ROLES, BULK_EXISTING),
    }


def main() -> None:
    sys.stdin.read()
    print(json.dumps({
        "labels": {"pending": STATUS_PENDING, "active": STATUS_ACTIVE,
                   "inactive": STATUS_INACTIVE},
        "surfaces": list(permissions.ACCESS_MATRIX),
        "override_options": list(permissions.OVERRIDE_OPTIONS),
        "use_default": permissions.USE_DEFAULT,
        "status": [{"args": list(c), "want": account_status(*c)} for c in STATUS_CASES],
        "manage": [{"actor": a, "target": t,
                    "want": bool(permissions.can_manage_user(a, t))}
                   for a, t in MANAGE_CASES],
        "assignable": {r: list(permissions.assignable_roles({"role": r}))
                       for r in ROLES},
        "override": [{"actor": a, "surface": s_, "cap": c, "current": cur,
                      "want": bool(permissions.can_assign_override(a, s_, c, cur))}
                     for a, s_, c, cur in OVERRIDE_CASES],
        "new_user": [{"email": e, "name": n, "want": _new_user_problems(e, n)}
                     for e, n in NEW_USER_CASES],
        "bulk_roles": BULK_ROLES,
        "bulk_existing": sorted(BULK_EXISTING),
        "bulk": [_bulk_case(c) for c in BULK_CASES],
        # Every capability the matrix can hold, plus one it cannot — the fallback is the
        # interesting case, because the wrong fallback describes a grant as its opposite.
        "capability_labels": {
            cap: permissions.capability_label(cap)
            for cap in ["edit", "view", "view+add", "trigger", "self", "all", "hidden",
                        "telepathy"]},
        # The option list the editor offers, per actor role and surface, with an existing
        # grant that may sit above the actor's own ceiling.
        "override_options_by": [
            {"actor": {"role": r, "email": "a@x.org"}, "surface": sf, "current": cur,
             "want": list(permissions.assignable_override_options(
                 {"role": r, "email": "a@x.org"}, sf, cur))}
            for r in ("collaborator", "reviewer", "admin", "super_user")
            for sf in list(permissions.ACCESS_MATRIX)[:6]
            for cur in (None, "edit", "hidden", "Use role default")],
        # What each role group gets by default on each surface — the "default: …" caption
        # beside every override row.
        "role_defaults": {
            sf: {g: caps.get(g, "hidden") for g in ("admin", "user")}
            for sf, caps in permissions.ACCESS_MATRIX.items()},
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
