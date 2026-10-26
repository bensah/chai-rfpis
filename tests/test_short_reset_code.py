"""The six-digit code (core.password_tokens): why six digits is safe enough.

A 43-character token can be looked up on its own, because guessing it is not a
strategy. Six digits is one in a million, and a million is small, so the code is
only defensible under two rules. These tests are those rules.
"""
from __future__ import annotations

import unittest
from unittest import mock

from core import password_tokens as PT


class _Tbl:
    """A tiny stand-in for one Supabase table, enough for check_code's queries."""

    def __init__(self, store, name):
        self.store, self.name = store, name
        self._filters = []
        self._payload = None
        self._op = "select"

    def select(self, *_a, **_k):
        self._op = "select"
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def eq(self, col, val):
        self._filters.append((col, "eq", val))
        return self

    def lt(self, col, val):
        self._filters.append((col, "lt", val))
        return self

    def is_(self, col, _val):
        self._filters.append((col, "is_null", None))
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def _match(self, row):
        for col, op, val in self._filters:
            got = row.get(col)
            if op == "eq" and got != val:
                return False
            if op == "is_null" and got is not None:
                return False
            if op == "lt" and not (got is not None and got < val):
                return False
        return True

    def execute(self):
        rows = [r for r in self.store[self.name] if self._match(r)]
        if self._op == "update":
            for r in rows:
                r.update(self._payload)
        return mock.Mock(data=[dict(r) for r in rows])


class _Client:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        return _Tbl(self.store, name)


def _future(hours=2):
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _past():
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()


class ShortCodeTests(unittest.TestCase):
    CODE = "024680"
    OTHER = "111111"

    def _store(self, *, code=CODE, attempts=0, used=None, expires=None,
               active=True, blacklisted=False, uid="u1"):
        return {
            "users": [{"id": uid, "email": "ada@example.org", "name": "Ada",
                       "is_active": active, "is_blacklisted": blacklisted}],
            "user_password_tokens": [{
                "id": "t1", "user_id": uid, "purpose": "reset",
                "token_hash": PT._digest("LONGTOKEN"),
                "code_hash": PT._digest(code),
                "attempts": attempts, "used_at": used,
                "expires_at": expires or _future(),
                "created_at": "2026-10-26T00:00:00+00:00",
            }],
        }

    def _check(self, store, email, code):
        with mock.patch.object(PT, "service_client", return_value=_Client(store)):
            return PT.check_code(email, code)

    # --- rule one: the code is checked against ONE named account ---------------

    def test_the_right_code_with_the_right_address_works(self):
        got = self._check(self._store(), "ada@example.org", self.CODE)
        self.assertIsNotNone(got)
        self.assertEqual(got["user"]["email"], "ada@example.org")

    def test_the_right_code_with_the_wrong_address_is_refused(self):
        self.assertIsNone(
            self._check(self._store(), "someone.else@example.org", self.CODE))

    def test_an_address_with_no_account_is_refused(self):
        store = self._store()
        store["users"] = []
        self.assertIsNone(self._check(store, "nobody@example.org", self.CODE))

    def test_the_code_alone_is_not_a_lookup(self):
        # The signature requires an address; an empty one cannot stand in for it.
        self.assertIsNone(self._check(self._store(), "", self.CODE))

    # --- rule two: attempts are counted and the code is burned ----------------

    def test_a_wrong_code_is_counted(self):
        store = self._store()
        self._check(store, "ada@example.org", self.OTHER)
        self.assertEqual(store["user_password_tokens"][0]["attempts"], 1)

    def test_the_code_dies_after_the_limit(self):
        store = self._store()
        for _ in range(PT.MAX_CODE_ATTEMPTS):
            self.assertIsNone(self._check(store, "ada@example.org", self.OTHER))
        # Burned, so even the CORRECT code is now worthless.
        self.assertIsNotNone(store["user_password_tokens"][0]["used_at"])
        self.assertIsNone(self._check(store, "ada@example.org", self.CODE))

    def test_guessing_is_bounded_to_a_handful_not_a_million(self):
        store = self._store()
        tried = 0
        while self._check(store, "ada@example.org", self.OTHER) is None and tried < 50:
            tried += 1
            if store["user_password_tokens"][0]["used_at"]:
                break
        self.assertLessEqual(tried, PT.MAX_CODE_ATTEMPTS)

    def test_a_correct_code_still_costs_an_attempt(self):
        # Counted before comparing, so a crash between the two cannot hand back a
        # free guess.
        store = self._store()
        self._check(store, "ada@example.org", self.CODE)
        self.assertEqual(store["user_password_tokens"][0]["attempts"], 1)

    # --- the ordinary token rules still apply ---------------------------------

    def test_an_expired_code_is_refused(self):
        self.assertIsNone(
            self._check(self._store(expires=_past()), "ada@example.org", self.CODE))

    def test_a_used_code_is_refused(self):
        self.assertIsNone(
            self._check(self._store(used=_past()), "ada@example.org", self.CODE))

    def test_a_deactivated_account_is_refused(self):
        self.assertIsNone(
            self._check(self._store(active=False), "ada@example.org", self.CODE))

    def test_a_blacklisted_account_is_refused(self):
        self.assertIsNone(
            self._check(self._store(blacklisted=True), "ada@example.org", self.CODE))

    def test_checking_does_not_consume(self):
        # Same as a link: the credential is burned when the password is accepted,
        # not when the screen is rendered, or a refresh would spend it.
        store = self._store()
        self.assertIsNotNone(self._check(store, "ada@example.org", self.CODE))
        self.assertIsNone(store["user_password_tokens"][0]["used_at"])

    # --- what people actually type --------------------------------------------

    def test_spacing_and_stray_whitespace_are_accepted(self):
        for typed in ("024 680", " 024680 ", "024-680", "024680\n"):
            with self.subTest(typed=typed):
                self.assertIsNotNone(
                    self._check(self._store(), "ada@example.org", typed))

    def test_a_wrong_length_is_refused_without_touching_the_row(self):
        store = self._store()
        self.assertIsNone(self._check(store, "ada@example.org", "12345"))
        self.assertEqual(store["user_password_tokens"][0]["attempts"], 0)

    def test_normalise_keeps_leading_zeros(self):
        self.assertEqual(PT.normalise_code(" 000 123 "), "000123")


class GeneratedCodeTests(unittest.TestCase):
    def test_it_is_always_six_digits(self):
        for _ in range(500):
            c = PT._gen_code()
            self.assertEqual(len(c), PT.CODE_DIGITS)
            self.assertTrue(c.isdigit())

    def test_leading_zeros_are_possible_and_kept(self):
        # If zeros were stripped the space would shrink and some emails would print
        # something that does not match what was stored.
        with mock.patch.object(PT.secrets, "randbelow", return_value=7):
            self.assertEqual(PT._gen_code(), "000007")

    def test_the_whole_space_is_reachable(self):
        with mock.patch.object(PT.secrets, "randbelow", return_value=999999):
            self.assertEqual(PT._gen_code(), "999999")


if __name__ == "__main__":
    unittest.main(verbosity=2)
