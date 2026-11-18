"""The Python half of the Scan Preferences parity check.

ONE ANSWER KEY. The shapes live here and the answers come from the modules that own the
rules: `core.policies` for the document and the geo seeder, `core.dropdowns` for the
currency aliases, and the editor's own save block lifted from `views/org_setup.py` for the
set of keys a save actually writes.

WHY THE KEY SET IS LIFTED RATHER THAN LISTED. `set_policies` "stores the FULL blob (not a
delta)", so the editor's save payload IS the stored policy. A key the Python writes and
the TypeScript does not is not a missing feature: it is a field wiped on the first React
save, and it comes back as whatever the merge base happens to hold. The one key the editor
deliberately omits — `scoring_rules` — survives ONLY because `_blank_policies()` carries
the same funding-quality tiers, which is a safety that holds by accident until somebody
tidies the base. Both halves of that are asserted.

READ ONLY. The policy functions are called with a tenant that does not exist, so the
seeding paths run against an empty profile and nothing is written.
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

from core import dropdowns, policies as P                              # noqa: E402
from core.scorer import CRITERIA                                       # noqa: E402

EDITOR = REPO_ROOT / "views" / "org_setup.py"


def saved_policy_keys() -> dict:
    """The literal dict the editor passes to `set_policies`, as a key map.

    Lifted from the syntax tree: the module imports streamlit and runs widgets at import
    time, and this dict is built inside `render_org_setup`.
    """
    tree = ast.parse(EDITOR.read_text(encoding="utf-8"))
    for n in ast.walk(tree):
        if (isinstance(n, ast.Assign) and isinstance(n.value, ast.Dict)
                and any(isinstance(t, ast.Name) and t.id == "new_pol" for t in n.targets)):
            top = [k.value for k in n.value.keys if isinstance(k, ast.Constant)]
            # The criteria entry is a dict COMPREHENSION over the nine criteria, so its
            # keys are not literals — the comprehension's own tuple is read instead.
            crit = []
            for key, val in zip(n.value.keys, n.value.values):
                if isinstance(key, ast.Constant) and key.value == "criteria":
                    if isinstance(val, ast.DictComp):
                        crit = list(ast.literal_eval(val.generators[0].iter))
            return {"top": top, "criteria": crit}
    raise SystemExit("views/org_setup.py no longer builds a literal `new_pol` dict")


# Policy forms, chosen to pin the defaults and the coercions rather than the happy path.
POLICY_CASES: list[dict] = [
    {},                                              # nothing sent at all
    {"countries": {"eligible": ["  Mali  ", "", "Cameroon"]}},
    {"countries": {"broad_terms": ["Sub-Saharan Africa"], "permissive_when_silent": False}},
    {"themes": {"required_any": ["malaria"], "excluded_any": ["loans"]}},
    {"exclusions": {"reject_loans": False}},         # one flag off, the rest default TRUE
    {"eligibility": {"org_applicant_types": []}},    # empty must become ["nonprofit"]
    {"eligibility": {"org_applicant_types": ["nonprofit", "higher_ed"],
                     "reject_applicant_type_mismatch": False}},
    {"criteria": {"bid_effort": {"positive": [" team "], "negative": []}}},
]

# Currency rows. The alias key is the one that matters: `aliases` is canonical and
# `donor_aliases` is what the editor used to write, so both are read and only the first
# is written (see core/dropdowns.currency_aliases).
CURRENCY_CASES: list = [
    [{"code": "gbp", "label": "GBP", "symbol": "£",
      "aliases": ["GBP £", "£"], "usd_rate": 1.33}],
    [{"code": "XAF", "label": "FCFA", "symbol": None,
      "donor_aliases": ["FCFA", "F CFA"], "usd_rate": 0.00166}],
    [{"code": "USD", "usd_rate": 1.0}, {"code": "usd", "usd_rate": 2.0}],   # duplicate
    [{"code": "", "usd_rate": 1.0}],                 # no code
    [{"code": "EUR", "usd_rate": 0}],                # a zero rate is not a rate
    [{"code": "EUR", "usd_rate": -1}],
    [{"code": "EUR", "usd_rate": "not a number"}],
    [{"code": "EUR"}],                               # missing rate
    ["not a row", None, 42],
    [],
]

TERM_CASES: list = [
    ["malaria", "  tuberculosis  ", "", "   "],
    "one\ntwo\n\n  three  ",                         # the defensive string branch
    [],
    None,
]


def main() -> None:
    sys.stdin.read()
    keys = saved_policy_keys()
    blank = P._blank_policies()
    print(json.dumps({
        "criteria": list(CRITERIA),
        # The keys the editor's save writes, and the ones DEFAULT_POLICIES has.
        "saved_top_keys": keys["top"],
        "saved_criteria_keys": keys["criteria"],
        "default_top_keys": sorted(P.DEFAULT_POLICIES),
        # The key the editor omits, and the base that rescues it.
        "omitted": sorted(set(P.DEFAULT_POLICIES) - set(keys["top"])),
        "blank_has_scoring_rules": "scoring_rules" in blank,
        "blank_scoring_rules": blank.get("scoring_rules"),
        "default_scoring_rules": P.DEFAULT_POLICIES.get("scoring_rules"),
        # The geo seeder, against a policy that already has a scope and one that does not.
        # tenant_id is a uuid that matches no row, so the profile lookup finds nothing and
        # the seeder correctly no-ops — which is itself the case worth pinning.
        "seed_noop_when_set": P._seed_geo_from_profile(
            {"countries": {"eligible": ["Mali"], "broad_terms": []}},
            "00000000-0000-0000-0000-000000000000"),
        "seed_noop_when_no_profile": P._seed_geo_from_profile(
            {"countries": {"eligible": [], "broad_terms": []}},
            "00000000-0000-0000-0000-000000000000"),
        "currency": [{"rows": c, "want": [dropdowns.currency_aliases(r)
                                          for r in c if isinstance(r, dict)]}
                     for c in CURRENCY_CASES],
        "terms": [{"value": t,
                   "want": ([x.strip() for x in t.splitlines() if x.strip()]
                            if isinstance(t, str)
                            else [str(x).strip() for x in (t or []) if str(x).strip()])}
                  for t in TERM_CASES],
        "policy_cases": POLICY_CASES,
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
