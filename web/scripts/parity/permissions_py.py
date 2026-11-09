"""Python half of check-permissions.mjs: evaluate each case with core.permissions.

    python permissions_py.py <cases.json>   → prints [result, ...] as JSON

Each case is {"fn": name, "args": [...], "dev": bool}. `dev` is whether the session's home
tenant is a developer tenant — patched in, since the real lookup needs a live session.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from core import permissions as P          # noqa: E402
from core import password_policy as PW     # noqa: E402
from core import suggestions as S          # noqa: E402

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


FNS = {
    "isSuperUser": P.is_super_user,
    "isAdmin": P.is_admin,
    "canEditStatus": P.can_edit_status,
    "roleGroup": P.role_group,
    "isDeveloperSuper": P.is_developer_super,
    "isDeveloperAdmin": P.is_developer_admin,
    "isDeveloperMember": P.is_developer_member,
    "canSuggest": S.can_suggest,
    "roleLabel": P.role_label,
    "canManageUser": P.can_manage_user,
    "assignableRoles": P.assignable_roles,
    "access": P.access,
    "assignableOverrideOptions": P.assignable_override_options,
    "canAssignOverride": P.can_assign_override,
    "canView": P.can_view,
    "canEdit": P.can_edit,
    "passwordProblems": PW.password_problems,
}


def main() -> None:
    cases = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = []
    for c in cases:
        dev = bool(c.get("dev"))
        P._active_tenant_is_developer = lambda dev=dev: dev
        try:
            out.append(FNS[c["fn"]](*c["args"]))
        except Exception as exc:     # a crash is a result too: the port must crash alike
            out.append({"error": type(exc).__name__})
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
