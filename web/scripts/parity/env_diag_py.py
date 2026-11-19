"""The Python half of the deployment-diagnostics parity check.

`core.env_diag` imports cleanly — no Streamlit at module scope for these three — so the
answers come straight from it.

WHY THE AGREEMENT MATTERS MORE THAN USUAL. The whole point of a fingerprint is that one
computed in Streamlit and one computed in the Edge Function can be COMPARED. Two correct
deployments showing different fingerprints for the same secret would read as a mismatch,
and somebody would go hunting a configuration problem that does not exist. Same for the
key class: a publishable key reported as service-role explains none of the RLS failures
it causes, and the reverse sends somebody looking for a permissions problem there isn't.

NO REAL SECRET IS USED. Every fixture is invented, and the JWTs below are unsigned
payloads assembled here — they prove the `role` claim is read, not that anything is
valid.

READ ONLY. It touches no database.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core import env_diag                                            # noqa: E402


def _jwt(claims: dict) -> str:
    """An unsigned JWT-shaped string. Only its middle segment is ever read."""
    def seg(d: dict) -> str:
        return base64.urlsafe_b64encode(
            json.dumps(d).encode("utf-8")).decode("ascii").rstrip("=")
    return f"{seg({'alg': 'HS256', 'typ': 'JWT'})}.{seg(claims)}.not-a-signature"


# Keys, covering both formats and every way the class can be unreadable.
KEY_CASES = [
    None, "", "   ",
    "sb_secret_abc123",
    "sb_publishable_abc123",
    _jwt({"role": "service_role", "iss": "supabase"}),
    _jwt({"role": "anon", "iss": "supabase"}),
    _jwt({"role": "authenticated"}),
    _jwt({"iss": "supabase"}),              # a JWT with NO role claim
    "eyJ-not-really-a-jwt",                 # the prefix without the structure
    "random-nonsense",
]

# URLs, including the shapes a mistyped environment variable actually takes.
URL_CASES = [
    None, "", "https://abc123.supabase.co", "https://abc123.supabase.co/",
    "http://abc123.supabase.co", "abc123.supabase.co",
    "https://abc123.supabase.co/rest/v1", "  https://abc123.supabase.co  ",
    "https://localhost:54321", "not a url at all",
]

# Values to fingerprint. Unicode included: the two runtimes must encode it the same way
# before hashing, or every non-ASCII secret would compare as a mismatch.
FINGERPRINT_CASES = [
    None, "", "sb_secret_abc123", "a", "a" * 500,
    "paßwort", "中文テスト", "sp ace", "\n\t",
]


def main() -> None:
    sys.stdin.read()
    print(json.dumps({
        "keys": [{"key": k,
                  "label": env_diag.key_class(k)[0],
                  "is_service_role": env_diag.key_class(k)[1]}
                 for k in KEY_CASES],
        "urls": [{"url": u, "ref": env_diag.project_ref(u)} for u in URL_CASES],
        "fingerprints": [{"value": v, "fp": env_diag._fingerprint(v)}
                         for v in FINGERPRINT_CASES],
        "secret_names": list(env_diag._SECRET_NAMES),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
