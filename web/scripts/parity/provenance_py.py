"""The Python half of the criteria-provenance parity check.

`core.criteria_provenance` is an ordinary module, so `record` is imported rather than
lifted. The CASES live here and the answers come from the Python's own `record`, so there
is one answer key — the same arrangement check-rescore uses for `human_assessed`, and for
the same reason: a shared fixture with two hand-written answer keys is two things to keep
in step, which is the problem a parity check exists to solve.

READ ONLY. It touches no database.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT))

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from core.criteria_provenance import COLUMN, record                  # noqa: E402
from core.scorer import CRITERIA                                     # noqa: E402

AT = "2026-11-17T09:00:00+00:00"
BY = "ben@example.org"

# Each case is (what the row holds now, what the save is about to write). Chosen to pin the
# three refusals the rule turns on, plus the ordinary cases around them.
CASES: list[tuple[dict, dict]] = [
    # A genuine change on a criterion that held a real answer.
    ({"qualification": "Mostly, one item unclear"}, {"qualification": "Yes, fully"}),
    # ROUND-TRIPPED: the save carries all nine; this one did not move.
    ({"qualification": "Yes, fully"}, {"qualification": "Yes, fully"}),
    # Whitespace is not a change.
    ({"qualification": "Yes, fully"}, {"qualification": "  Yes, fully  "}),
    # THE EMPTY COLUMN: `_elig` falls to option 0 when nothing maps, so any save writes a
    # default into a blank. Refused — that is the form choosing, not a person.
    ({"capacity": None}, {"capacity": "Yes, comfortably"}),
    ({"capacity": ""}, {"capacity": "Yes, comfortably"}),
    ({"capacity": "   "}, {"capacity": "Yes, comfortably"}),
    # "Not sure" is a stored NON-ANSWER, not an empty: answering one IS a change.
    ({"capacity": "Not sure"}, {"capacity": "Yes, comfortably"}),
    # ...and moving TO "Not sure" is a change too.
    ({"capacity": "Yes, comfortably"}, {"capacity": "Not sure"}),
    # CLEARING drops the entry: nobody authors a blank.
    ({"capacity": "Yes, comfortably",
      COLUMN: {"capacity": {"by": "old@x.org", "at": "2026-01-01T00:00:00+00:00"}}},
     {"capacity": ""}),
    # An existing entry on a DIFFERENT criterion survives this save.
    ({"qualification": "Yes, fully", "capacity": "Yes, comfortably",
      COLUMN: {"capacity": {"by": "old@x.org", "at": "2026-01-01T00:00:00+00:00"}}},
     {"qualification": "Mostly, one item unclear"}),
    # Several at once, mixed outcomes.
    ({"qualification": "Yes, fully", "capacity": "Not sure", "strategic_fit": None},
     {"qualification": "No, not eligible", "capacity": "No, beyond us",
      "strategic_fit": "Strongly aligns"}),
    # A save that touches no criterion at all.
    ({"qualification": "Yes, fully"}, {"next_action": "Draft budget"}),
    # An empty save on an empty row.
    ({}, {}),
    # Provenance stored as a JSON STRING rather than jsonb.
    ({"capacity": "Yes, comfortably",
      COLUMN: '{"capacity": {"by": "old@x.org", "at": "2026-01-01T00:00:00+00:00"}}'},
     {"capacity": "No, beyond us"}),
    # Junk in the column is no provenance, not an error.
    ({"capacity": "Yes, comfortably", COLUMN: "{not json"}, {"capacity": "No, beyond us"}),
    # A non-criterion key in `values` is ignored.
    ({"qualification": "Yes, fully"}, {"decision": "Proceed", "remarks": "x"}),
]


def main() -> None:
    sys.stdin.read()          # the shapes live here; the TS side takes them from us
    print(json.dumps({
        "criteria": list(CRITERIA),
        "column": COLUMN,
        "at": AT,
        "by": BY,
        "cases": [{"row": row, "values": values,
                   "want": record(row, values, BY, AT)}
                  for row, values in CASES],
    }, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
