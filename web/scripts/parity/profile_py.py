"""The Python half of the Profile parity check.

Two rules, both lifted from `views/` files that cannot be imported (they execute Streamlit
at module scope):

  * `views/login_history._parse_ua` — the "Browser · OS" label. Lifted with `ast`, the way
    check-actions lifts `_first_name`.
  * `views/account_sections.render_my_profile`'s validation and patch shape. Those live
    INSIDE a 200-line render function with Streamlit calls interleaved, so there is no
    function to lift; the rules are written out here with their line numbers quoted, and
    the check asserts the port against them.

The password policy is NOT re-implemented here: `core.password_policy.password_problems` is
an ordinary module and is imported.

READ ONLY. Nothing here touches the database.
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

from core.password_policy import PASSWORD_RULES_TEXT, password_problems   # noqa: E402

HISTORY_PY = REPO_ROOT / "views" / "login_history.py"
ACCOUNTS_PY = REPO_ROOT / "views" / "account_sections.py"


def _lift(path: Path, want: list[str]) -> dict:
    """Pull named module-level functions out of a Streamlit view without importing it."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    picked = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in want]
    missing = set(want) - {n.name for n in picked}
    if missing:
        raise SystemExit(f"{path.name} no longer defines: {sorted(missing)}")
    ns: dict = {"__builtins__": __builtins__}
    exec(compile(ast.Module(body=picked, type_ignores=[]), str(path), "exec"), ns)
    return ns


H = _lift(HISTORY_PY, ["_parse_ua"])


def editable_columns() -> list[str]:
    """The columns `render_my_profile`'s UPDATE writes, read out of the source.

    Taken from the AST rather than retyped, because the POINT of the comparison is that
    the port writes the same set — and a hand-copied list here would pass while the real
    one grew a column. `account_sections.py` line 574: the only `.update({...})` in that
    function with a `"name"` key.
    """
    tree = ast.parse(ACCOUNTS_PY.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        keys = [k.value for k in node.keys
                if isinstance(k, ast.Constant) and isinstance(k.value, str)]
        if "name" in keys and "state_region" in keys and "program" in keys:
            return sorted(keys)
    raise SystemExit("account_sections.py: the profile UPDATE dict was not found")


def main() -> None:
    payload = json.loads(sys.stdin.read())
    print(json.dumps({
        "devices": [H["_parse_ua"](ua) for ua in payload["agents"]],
        "editable": editable_columns(),
        "password": [password_problems(pw) for pw in payload["passwords"]],
        "rules": PASSWORD_RULES_TEXT,
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
