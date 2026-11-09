"""Every narrative field reaches the opportunity page exactly once.

THE REPORTED CASE. The React opportunity page rendered `full_description`, `how_to_apply`,
`what_is_funded`, `what_is_not_funded` and `compliance_requirements` TWICE — once where
`core/opportunity_detail` composes them into the layout, and again underneath as
`narrative_sections`. On a thinly-extracted call that meant five extra headings each
followed by a dash, which is how a page ends up looking broken rather than honest.

`app_pages/opportunity.py` never did that: it renders `overview_text` + `page_rows` and
stops, because the composition already places all five —

    OVERVIEW_FIELDS   full_description
    INLINE_PROSE      how_to_apply (under "How to apply"),
                      compliance_requirements (under "Eligibility requirements")
    PROSE_ROWS        what_is_funded, what_is_not_funded

The fix was to stop sending `narrative_sections` to the browser. That is only safe while
the composition stays COMPLETE, and nothing made it stay complete: a sixth entry added to
NARRATIVE_FIELDS and not to one of the three above would simply never be rendered, and the
symptom would be a field silently missing from the page rather than an error.

So this pins the property rather than the fix. Both directions:
  * every narrative field is placed somewhere — nothing can go missing;
  * no narrative field is placed twice — the duplication cannot come back.

Run:  python -m unittest tests.test_opportunity_detail_places_every_narrative
"""
import os
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import opportunity_detail as OD                     # noqa: E402


def composed_fields() -> set[str]:
    """The fields the page's own layout places, as the layout itself declares them."""
    placed = {field for _, field in OD.OVERVIEW_FIELDS}
    for fields in OD.INLINE_PROSE.values():
        placed.update(fields)
    for prose_row in OD.PROSE_ROWS:
        placed.update(field for _, field in prose_row)
    return placed


def rendered_text(view: dict) -> str:
    """Everything the page would show for `view`, flattened — overview plus page_rows.

    Exactly what the React page renders (web/src/scoring/worker.ts) and what
    app_pages/opportunity.py renders. If a sentinel is missing from this, it is missing
    from the page.
    """
    parts: list[str] = []
    for heading, lines, _missing in OD.overview_blocks(view):
        parts.append(heading)
        parts.extend(lines)
    for row in OD.page_rows(view):
        for col in row:
            for block in col:
                parts.append(block.get("title") or "")
                if block.get("kind") == "prose":
                    parts.extend(block.get("lines") or [])
                else:
                    for label, value in block.get("rows") or []:
                        parts.extend([label, str(value)])
                    parts.extend(block.get("prose") or [])
    return "\n".join(parts)


class TheCompositionIsComplete(unittest.TestCase):
    def test_every_narrative_field_is_placed_by_the_layout(self):
        placed = composed_fields()
        for heading, field in OD.NARRATIVE_FIELDS:
            with self.subTest(section=heading, field=field):
                self.assertIn(
                    field, placed,
                    f"{field!r} is in NARRATIVE_FIELDS but no OVERVIEW_FIELDS entry, "
                    f"INLINE_PROSE entry or PROSE_ROWS pair places it — so it would not "
                    f"appear on the opportunity page at all. Add it to the layout, or the "
                    f"page loses a field.")

    def test_a_narrative_field_with_content_actually_reaches_the_page(self):
        """The declaration above could be right while the rendering is not, so this drives
        the real functions and looks for the text."""
        for _heading, field in OD.NARRATIVE_FIELDS:
            with self.subTest(field=field):
                mark = f"SENTINEL-{field.upper().replace('_', '-')}"
                text = rendered_text({field: mark})
                self.assertIn(mark, text, f"{field} did not reach the page")

    def test_no_narrative_field_is_rendered_twice(self):
        """The regression itself. One sentinel per field, counted in the whole page."""
        view = {field: f"SENTINEL-{field.upper().replace('_', '-')}"
                for _h, field in OD.NARRATIVE_FIELDS}
        text = rendered_text(view)
        for _heading, field in OD.NARRATIVE_FIELDS:
            mark = f"SENTINEL-{field.upper().replace('_', '-')}"
            with self.subTest(field=field):
                self.assertEqual(
                    1, text.count(mark),
                    f"{field} appears {text.count(mark)} times on the page. Twice is the "
                    f"bug this test exists for: the layout places it, and something is "
                    f"placing it again.")


class TheBrowserPageDoesNotAddASecondCopy(unittest.TestCase):
    """The duplication was not in the composition — it was the React worker sending
    `narrative_sections` ALONGSIDE the composed page, so the page had both. The tests above
    cannot see that, because they drive the Python the browser calls rather than the
    browser. This reads the source, the way tests/test_decline_is_remembered.py does."""

    def test_the_worker_sends_the_composed_page_and_not_narrative_sections(self):
        src = os.path.join(_ROOT, "web", "src", "scoring", "worker.ts")
        with open(src, encoding="utf-8") as f:
            text = f.read()
        self.assertIn("_od.page_rows(view)", text, "the composed page must still be sent")
        self.assertIn("_od.overview_blocks(view)", text)
        self.assertNotIn(
            "_od.narrative_sections(", text,
            "narrative_sections repeats every field page_rows and overview_blocks already "
            "place, which rendered all five of them twice on the opportunity page. "
            "app_pages/opportunity.py sends overview_text + page_rows and stops.")


class TheSkeletonStaysConstant(unittest.TestCase):
    """The owner's rule, 2026-08-11: the whole skeleton renders on every call, dash and
    all, so a reader can tell "this funder did not state it" from "this app does not track
    it" and two calls can be compared by eye. The redesigned page leans on this — it quiets
    a missing value rather than removing it — so it is worth a test of its own."""

    def test_an_empty_call_renders_the_same_sections_as_a_full_one(self):
        empty = OD.page_rows({})
        full = OD.page_rows({field: "something" for _h, field in OD.NARRATIVE_FIELDS})
        shape = lambda rows: [[[b["title"] for b in col] for col in row] for row in rows]  # noqa: E731
        self.assertEqual(shape(empty), shape(full))

    def test_a_silent_field_is_a_dash_rather_than_an_absent_row(self):
        labels = [label
                  for row in OD.page_rows({}) for col in row for b in col
                  for label, _v in (b.get("rows") or [])]
        self.assertTrue(labels, "an empty call still lists the fields it tracks")
        values = {str(v)
                  for row in OD.page_rows({}) for col in row for b in col
                  for _l, v in (b.get("rows") or [])}
        self.assertEqual({OD.MISSING}, values,
                         "every row of an empty call should read as the missing marker")


if __name__ == "__main__":
    unittest.main()
