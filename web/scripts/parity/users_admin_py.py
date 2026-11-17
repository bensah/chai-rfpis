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


def _lift(name: str):
    """One module-level function out of views/account_sections.py, executed alone.

    The module imports streamlit and builds dialogs at import time, so it cannot be
    imported for `_new_user_problems`. Lifting the single function is the same trick the
    other harnesses use on view files.
    """
    tree = ast.parse(SECTIONS.read_text(encoding="utf-8"))
    defs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name]
    if not defs:
        raise SystemExit(f"views/account_sections.py no longer defines {name}")
    ns: dict = {}
    exec(compile(ast.Module(body=defs, type_ignores=[]), str(SECTIONS), "exec"), ns)
    return ns[name]


_new_user_problems = _lift("_new_user_problems")


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
