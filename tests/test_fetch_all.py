"""A read that must be COMPLETE has to page, and the paging has to be right.

PostgREST caps a response at 1000 rows and says nothing about the rest. `.limit(50000)`
returns 1000, the caller sums it, and a partial total is presented as a complete one. The
failure begins the day a table crosses a thousand rows — long after the code was written and
reviewed — and it looks like nothing at all.

It had already bitten twice. `core.analytics.system_discovery_stats` carries the diagnosis
and its own paging loop. The Report loaders did not: on 2026-10-29 `scan_logs` held 3,082
rows, the page read 1,000, and "RFPs found" showed 7,559 against a real 51,071 — 15% of it,
labelled as the total.

`db.supabase_client.fetch_all` is the shared fix, so these are the cases that make a paging
loop wrong rather than merely untidy:

  * a short final page, which is how the loop knows to stop
  * a total that is an EXACT MULTIPLE of the page size, where a naive loop either stops one
    page early or spins asking for rows that are not there
  * a unique ordering, without which a row can appear on two pages or on none
  * the safety cap, which must say so rather than return a truncated set that looks whole
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from db.supabase_client import fetch_all


class _Q:
    """A query builder that pages for real, the way PostgREST does.

    `range` is INCLUSIVE at both ends, and a request past the end returns fewer rows rather
    than erroring — both of which the loop depends on.
    """

    def __init__(self, rows: list[dict], calls: list[tuple[int, int]], order_seen: list[str],
                 hard_cap: int = 1000):
        self._rows, self._calls, self._order_seen = rows, calls, order_seen
        self._range: tuple[int, int] | None = None
        self._order: str | None = None
        self._hard_cap = hard_cap

    def order(self, col, desc=False):
        self._order = col
        self._order_seen.append(col)
        return self

    def range(self, start, end):
        self._range = (start, end)
        return self

    def execute(self):
        start, end = self._range if self._range else (0, len(self._rows) - 1)
        self._calls.append((start, end))
        # Sort only when the rows actually carry the column. Which column was ASKED for is
        # asserted separately via `order_seen`; the sort here only exists so the windows are
        # a stable partition of the set.
        sortable = self._order and all(self._order in r for r in self._rows)
        rows = sorted(self._rows, key=lambda r: r[self._order]) if sortable else self._rows
        window = rows[start:end + 1]
        # PostgREST will not return more than its own cap however wide the range.
        return mock.Mock(data=window[:self._hard_cap])


def _run(n_rows: int, page: int = 1000, **kw):
    rows = [{"id": i, "v": 1} for i in range(n_rows)]
    calls: list[tuple[int, int]] = []
    order_seen: list[str] = []
    got = fetch_all(lambda: _Q(rows, calls, order_seen, hard_cap=page), page=page, **kw)
    return got, calls, order_seen


class FetchAllTests(unittest.TestCase):

    def test_a_short_page_ends_the_loop(self):
        got, calls, _ = _run(1500, page=1000)
        self.assertEqual(len(got), 1500)
        self.assertEqual(calls, [(0, 999), (1000, 1999)])

    def test_fewer_rows_than_one_page_is_a_single_request(self):
        got, calls, _ = _run(7, page=1000)
        self.assertEqual(len(got), 7)
        self.assertEqual(calls, [(0, 999)])

    def test_an_empty_table_is_one_request_and_no_rows(self):
        got, calls, _ = _run(0, page=1000)
        self.assertEqual(got, [])
        self.assertEqual(calls, [(0, 999)])

    def test_an_exact_multiple_of_the_page_takes_one_more_request(self):
        """The case a naive loop gets wrong in one of two ways.

        At exactly 2000 rows with a 1000-row page, the second page is FULL — so the loop
        cannot tell it is finished and must ask once more. Stopping on a full page would
        drop every row after the first exact multiple; that extra empty request is the
        price of knowing.
        """
        got, calls, _ = _run(2000, page=1000)
        self.assertEqual(len(got), 2000)
        self.assertEqual(calls, [(0, 999), (1000, 1999), (2000, 2999)])
        self.assertEqual([r["id"] for r in got], list(range(2000)))

    def test_every_row_arrives_exactly_once(self):
        """Not just the count: paging can DOUBLE-count as easily as it can drop."""
        got, _, _ = _run(2500, page=1000)
        ids = [r["id"] for r in got]
        self.assertEqual(len(ids), len(set(ids)), "a row was returned on two pages")
        self.assertEqual(set(ids), set(range(2500)))

    def test_it_orders_every_page_by_the_same_key(self):
        """Without a total order Postgres may sequence rows differently per request, so a
        row can land on two pages or on none. Each page must ask for the same ordering."""
        _, calls, order_seen = _run(2500, page=1000)
        self.assertEqual(len(order_seen), len(calls))
        self.assertEqual(set(order_seen), {"id"})

    def test_the_order_column_is_the_callers_choice(self):
        _, _, order_seen = _run(10, page=1000, order="uid")
        self.assertEqual(order_seen, ["uid"])

    def test_the_cap_stops_it_and_warns(self):
        """A table past the cap returns what was read, and SAYS the result is incomplete.

        Returning silently is the original bug wearing a different hat.
        """
        with self.assertLogs("db.supabase_client", level="WARNING") as log:
            got, calls, _ = _run(5000, page=1000, cap=2000)
        self.assertEqual(len(got), 2000)
        self.assertEqual(calls, [(0, 999), (1000, 1999)])
        self.assertTrue(any("incomplete" in m for m in log.output), log.output)

    def test_a_fresh_builder_per_page(self):
        """`.range()` cannot be re-applied to a used builder, which is why fetch_all takes a
        factory. A caller that passed one query would page the same window forever."""
        made = []

        def factory():
            q = _Q([{"id": i} for i in range(1500)], [], [])
            made.append(q)
            return q

        fetch_all(factory, page=1000)
        self.assertEqual(len(made), 2, "each page must get its own builder")


if __name__ == "__main__":
    unittest.main()
