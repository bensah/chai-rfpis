"""Export the controlled vocabularies the React frontend needs to `web/src/generated/vocab.json`.

The program-area taxonomy and the geography lists live in Python (core.program_area_classifier,
core.geographies) and are the single source of truth for both the scanner and the forms. The
web app must filter and label donors exactly the way the Streamlit page does, so rather than
retyping those lists in TypeScript (and letting them drift), this script dumps them as JSON.

Re-run it whenever either module changes:

    python scripts/export_web_vocab.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import geographies as geo  # noqa: E402
from core import program_area_classifier as pa  # noqa: E402

OUT = ROOT / "web" / "src" / "generated" / "vocab.json"


def main() -> None:
    keys = list(pa.PROGRAM_AREA_KEYWORDS)
    vocab = {
        "programAreas": {
            # canonical key -> [full category, sub-area label]
            "keys": {k: [pa.category_full(k), pa.subarea_label(k)] for k in keys},
            "categories": list(pa.CATEGORIES),
        },
        "geo": {
            "options": list(geo.GEO_OPTIONS),
            # lowercased region label -> lowercased member countries (geo.expand's table)
            "regionMembers": {k: [c.lower() for c in v] for k, v in geo._REGION_MEMBERS.items()},
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(vocab, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(keys)} program areas, "
          f"{len(geo.GEO_OPTIONS)} geo options)")


if __name__ == "__main__":
    main()
