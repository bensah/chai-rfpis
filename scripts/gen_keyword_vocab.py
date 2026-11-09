"""Generate the API's copy of the Report vocabularies from the modules that own them.

    python scripts/gen_keyword_vocab.py [--check]

`KEYWORD_STEMS` is a CURATED ~80-stem global-health vocabulary that a person edits by hand,
in the Python, when the scanner starts seeing a topic the cloud should name. The Edge
Function needs the same list, and re-typing it into TypeScript would create a second copy
that nobody remembers to update — the cloud and the API would then disagree about which
words exist, which is invisible until a reader notices a topic missing from one of them.

So the list is DATA, generated from the Python, and the algorithm alone is ported. With
--check the script exits non-zero when the generated file is out of date, which is what the
parity check runs: editing the vocabulary without regenerating fails the check rather than
shipping a stale copy.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from core.keyword_cloud import KEYWORD_STEMS            # noqa: E402
from core.program_area_classifier import TAXONOMY      # noqa: E402

OUT = REPO_ROOT / "supabase" / "functions" / "_shared" / "api" / "report_vocab.ts"

HEADER = """\
// GENERATED FILE — do not edit by hand.
//
// The curated Report vocabularies, from the Python modules that own them:
//   KEYWORD_STEMS — core/keyword_cloud.py
//   AREA_SUBS     — core/program_area_classifier.py (TAXONOMY, flattened to sub-areas)
//
// Both are MAINTAINED THERE, by hand, when the scanner starts seeing a topic worth naming.
// Regenerate after changing either:
//
//     python scripts/gen_keyword_vocab.py
//
// web/scripts/parity/check-report.mjs fails when this file is out of date, so a vocabulary
// edit cannot ship with only half the application seeing it.
//
// KEYWORD_STEMS keys are the display labels shown to a reader; values are the lowercased
// surface forms matched in titles and briefs. AREA_SUBS is the taxonomy's own spelling of
// each sub-area, which a stored programme area is snapped onto.

export const KEYWORD_STEMS: Record<string, string[]> = """


def _subs() -> list[str]:
    """TAXONOMY flattened the way views/report.py::_canonical_area flattens it."""
    return [s for v in TAXONOMY.values() for s in v]


def render() -> str:
    stems = json.dumps(KEYWORD_STEMS, indent=2, ensure_ascii=False, sort_keys=False)
    subs = json.dumps(_subs(), indent=2, ensure_ascii=False)
    return f"{HEADER}{stems};\n\nexport const AREA_SUBS: string[] = {subs};\n"


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        current = OUT.read_text(encoding="utf-8") if OUT.exists() else ""
        if current != text:
            print(f"STALE {OUT.relative_to(REPO_ROOT)} — run: python scripts/gen_keyword_vocab.py")
            return 1
        print(f"{OUT.name} is current ({len(KEYWORD_STEMS)} stems, {len(_subs())} areas)")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO_ROOT)} ({len(KEYWORD_STEMS)} stems, {len(_subs())} areas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
