"""The Python half of the Settings → Setup parity check.

ONE ANSWER KEY. The shapes live here and so do the answers, each produced by the module
that owns the rule — never by a predicate retyped for the test. That is the arrangement
check-provenance and check-rescore use, for the reason a parity check exists at all: a
fixture with two hand-written answer keys is two things to keep in step.

Three of the rules live inside functions that talk to the database, and one lives inside a
Streamlit view that cannot be imported. Both are handled by RUNNING THE REAL CODE rather
than restating it:

  * `settings.set_org` and `org_profile.set_profile` are called with their tenant store
    stubbed out and `set_setting` captured, so what comes back is literally what those
    functions decided to persist — the key filter, the `value or ""` coercion and the
    derived-key strip included. Restating any of them here would mean this file and the
    TypeScript could agree with each other and both be wrong.
  * `_pc` and `_status_list` are nested inside `render_org_setup`. They are lifted from
    the syntax tree and executed, which is what the other harnesses do to view files.

READ ONLY. The stubs are what keep it so: nothing here reaches Supabase.
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

from core import org_profile as op                                   # noqa: E402
from core import settings as st                                      # noqa: E402

EDITOR = REPO_ROOT / "views" / "org_setup.py"
_TREE = ast.parse(EDITOR.read_text(encoding="utf-8"))


# ── Lifting out of the view ──────────────────────────────────────────────────

def _assigned(name: str, *, last: bool = False):
    found = [n.value for n in ast.walk(_TREE) if isinstance(n, ast.Assign)
             for t in n.targets if isinstance(t, ast.Name) and t.id == name]
    if not found:
        raise SystemExit(f"{name} is no longer assigned in views/org_setup.py")
    return ast.literal_eval(found[-1 if last else 0])


def _nested(*names: str) -> dict:
    """The named functions, pulled out of `render_org_setup` and executed.

    `_pc` closes over pandas and `_status_list` over `_STATUS_OPTS`, so both are supplied;
    nothing else in the view's body runs.
    """
    import pandas as pd
    ns: dict = {"_pd": pd, "_STATUS_OPTS": _assigned("_STATUS_OPTS")}
    defs = [n for n in ast.walk(_TREE)
            if isinstance(n, ast.FunctionDef) and n.name in names]
    missing = set(names) - {d.name for d in defs}
    if missing:
        raise SystemExit(f"views/org_setup.py no longer defines {sorted(missing)}")
    exec(compile(ast.Module(body=defs, type_ignores=[]), str(EDITOR), "exec"), ns)
    return ns


_NS = _nested("_pc", "_status_list")
_pc = _NS["_pc"]
_status_list = _NS["_status_list"]


def _save_keys(func_name: str) -> list[str]:
    """The literal dict keys passed to `<something>.<func_name>(...)` in the view.

    These are the two SAVE PAYLOADS, and the reason to read them from the syntax tree
    rather than list them is that `set_profile` REPLACES the blob. A key the Python sends
    and the TypeScript does not is not a missing feature, it is a field that gets wiped
    the first time anybody saves from React.
    """
    for n in ast.walk(_TREE):
        if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == func_name and n.args
                and isinstance(n.args[0], ast.Dict)):
            return [k.value for k in n.args[0].keys if isinstance(k, ast.Constant)]
    raise SystemExit(f"no literal-dict call to {func_name} in views/org_setup.py")


def _identity_keys() -> list[str]:
    """The nine keys of the Profile tab's `_fields` dict — its own order."""
    for n in ast.walk(_TREE):
        if (isinstance(n, ast.Assign) and isinstance(n.value, ast.Dict)
                and any(isinstance(t, ast.Name) and t.id == "_fields" for t in n.targets)):
            return [k.value for k in n.value.keys if isinstance(k, ast.Constant)]
    raise SystemExit("views/org_setup.py no longer builds a literal `_fields` dict")


def _verified_fields() -> list[str]:
    """The fields the editor re-reads after a save — the `_bad` comprehension's tuple.

    Lifted rather than listed because it is a SUBSET chosen for a reason: `get_org`
    substitutes placeholders for blanks, so only fields whose placeholder would be
    mistaken for a failed write belong here. Somebody adding a fifth would mean the React
    save has to check it too, and nothing else would say so.
    """
    for n in ast.walk(_TREE):
        if (isinstance(n, ast.Assign) and isinstance(n.value, ast.ListComp)
                and any(isinstance(t, ast.Name) and t.id == "_bad" for t in n.targets)):
            return list(ast.literal_eval(n.value.generators[0].iter))
    raise SystemExit("views/org_setup.py no longer builds `_bad` from a literal tuple")


# ── Running the real writers with their stores stubbed ───────────────────────

def _persisted_identity(fields: dict) -> dict:
    """What `settings.set_org` actually decides to store, legacy path.

    The legacy path writes one `set_setting` per accepted key, so capturing those calls
    gives the filter AND the coercion as the function itself applies them.
    """
    seen: dict = {}
    real_ctx, real_set = st._tenant_ctx, st.set_setting
    st._tenant_ctx = lambda tenant_id=None: None
    st.set_setting = lambda key, value, updated_by=None, **kw: seen.__setitem__(key, value)
    try:
        st.set_org(fields)
    finally:
        st._tenant_ctx, st.set_setting = real_ctx, real_set
    return seen


def _persisted_profile(profile: dict) -> dict:
    """What `org_profile.set_profile` actually writes — the whole blob, derived key gone."""
    seen: list = []
    real_store, real_set = op._tenant_store, op.set_setting
    op._tenant_store = lambda tenant_id=None: None
    op.set_setting = lambda key, value, updated_by=None, **kw: seen.append(value)
    try:
        op.set_profile(dict(profile))
    finally:
        op._tenant_store, op.set_setting = real_store, real_set
    return json.loads(seen[-1]) if seen else {}


# ── The fixtures ─────────────────────────────────────────────────────────────

IDENTITY_CASES: list[dict] = [
    # The ordinary save: every field filled.
    {"org_name": "Acme Foundation", "org_short": "Acme", "org_country": "Kenya",
     "org_team": "BD Team", "org_contact_email": "bd@acme.org",
     "org_website": "https://acme.org", "org_is_us_entity": "false",
     "org_has_local_board": "yes", "org_has_bd_team": "true"},
    # A key NOT in _ORG_DEFAULTS — a client inventing an identity field.
    {"org_name": "Acme", "org_secret_rank": "9", "tenant_id": "00000000"},
    # None and "" both land as the empty string, never null.
    {"org_country": None, "org_team": "", "org_website": None},
    # The board gate's three stored values, each on its own.
    {"org_has_local_board": ""},
    {"org_has_local_board": "no"},
    # The derived competitiveness keys the FIT tab writes through the same function.
    {"org_is_grassroot": "true", "org_is_multi_country": "false", "org_hq_country": "Kenya"},
    # Nothing at all.
    {},
]

# Profile saves. The blob REPLACES what is stored, so these pin the coercions that decide
# whether a field is scored at all: 0 means unset for the money fields, while 0 is a real
# answer for the indirect-cost rate.
PROFILE_CASES: list[dict] = [
    {"org_legal_type": "nonprofit", "org_annual_budget": 0, "org_indirect_cost_rate": 0.0,
     "org_prefinance_capacity": None, "org_founding_year": 2001},
    {"org_legal_type": "individual", "org_entity_type": "individual",
     "org_indirect_cost_rate": None, "org_largest_grant": 250000},
    # The derived key never persists, however it arrives.
    {"org_user_declared_areas": ["Malaria"], "org_legal_type": "government"},
    {},
]

STATUS_CASES: list = [
    ["Donor", "Collaborator"],
    ["Donor", "Not a status", "  Implementing Partner  "],
    "Donor, Collaborator",
    "Donor,,Nonsense",
    "",
    None,
    [],
    ["donor"],                      # case matters: the stored vocabulary is exact
]

CELL_CASES: list = ["  Acme  ", "nan", "NaN", "None", "none", "", None, "  ", "Kenya", 42]

# The roster textarea. `splitlines` is NOT a newline split, and the paste cases are why:
#   is what a soft line break out of Word becomes.
TEAM_CASES: list[str] = [
    "Jane Doe\nJohn Smith",
    "  Jane Doe  \n\n  John Smith\n",
    "Jane Doe\r\nJohn Smith",
    "Jane John",
    "Jane\x0bJohn",
    "Jane\x85John",
    "",
    "   ",
    "Solo",
]

RENAME_CASES: list[str] = [
    'duplicate key value violates unique constraint "tenants_name_key"',
    "23505",
    "relation already exists",
    "permission denied for table tenants",
    "",
]


def main() -> None:
    sys.stdin.read()
    print(json.dumps({
        # The two save payloads, read from the view itself.
        "identity_keys": _identity_keys(),
        "profile_keys": _save_keys("set_profile"),
        "derived_identity_keys": _save_keys("set_org"),
        # What a profile save must cover: every persistable default.
        "persistable_profile_keys": sorted(set(op.DEFAULT_PROFILE) - {"org_user_declared_areas"}),
        "verified_fields": _verified_fields(),
        "board_options": [list(p) for p in _assigned("_board_opts").items()],
        # Answers, each from the real rule.
        "identity": [{"fields": f, "want": _persisted_identity(f)} for f in IDENTITY_CASES],
        "profile": [{"profile": p, "want": _persisted_profile(p)} for p in PROFILE_CASES],
        "status": [{"value": v, "want": _status_list(v)} for v in STATUS_CASES],
        "cell": [{"value": v, "want": _pc(v)} for v in CELL_CASES],
        "team": [{"text": t,
                  "want": [ln.strip() for ln in t.splitlines() if ln.strip()]}
                 for t in TEAM_CASES],
        "rename": [{"error": e, "want": bool(st._is_duplicate_name(Exception(e)))}
                   for e in RENAME_CASES],
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
