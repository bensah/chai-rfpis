"""The donor form's generated vocabulary must still match app_pages/donors.py.

`supabase/functions/_shared/api/donor_vocab.ts` (Edge Function) and
`web/src/generated/donor_vocab.json` (browser) are both emitted by
`scripts/gen_donor_vocab.py` from `core/donor_fields.py`. Generated files go stale in
silence, and these go stale in a way that is hard to see from either app.

WHY A STALE COPY IS WORSE HERE THAN A MISSING ONE. donors.py does not list the form's
fields; it classifies them, and the classification is a NEGATIVE one:

    flags = [c for c in columns if c not in NON_FLAG]       # donor_fields.flag_groups

So a column that falls out of one of these sets does not disappear from the form. It
becomes a flag: a new checkbox nobody added, a new entry in the completeness denominator,
and a completeness percentage that drops for every donor at once with nothing on screen to
explain it. The failure looks like a data problem, not a code problem.

The tri-state map has the same shape of risk for a different reason. A requirement has
four states and blank is NOT "not sure" — blank means unanswered, "not_sure" means
somebody looked and could not tell. They score identically (core.criteria_derive._truthy
fires only on yes/required), so a wrong map is invisible to scoring and visible only in
completeness, which is the number people use to decide whether a record is worth trusting.

This reads the constants through the generator's own accessor and compares, rather than
re-deriving them a second way — a second implementation here would just be a third copy
to keep in step. core/donor_fields.py holds values and pure functions only, so this needs
no Streamlit, no database and no write access.

Run:  python -m unittest tests.test_donor_vocab_is_current
"""
import importlib.util
import json
import os
import re
import sys
import unittest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

_TS = os.path.join(_ROOT, "supabase", "functions", "_shared", "api", "donor_vocab.ts")
_JSON = os.path.join(_ROOT, "web", "src", "generated", "donor_vocab.json")
_GEN = os.path.join(_ROOT, "scripts", "gen_donor_vocab.py")


def _generator():
    """Import gen_donor_vocab as a module without running main()."""
    spec = importlib.util.spec_from_file_location("_gen_donor_vocab", _GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _emitted_ts(name: str):
    """The value of one `export const <name>...= <json>;` in the generated module."""
    with open(_TS, encoding="utf-8") as f:
        src = f.read()
    m = re.search(rf"export const {re.escape(name)}\b[^=]*=\s*(.+?);\s*$",
                  src, re.MULTILINE | re.DOTALL)
    if not m:
        raise AssertionError(f"{name} is not exported from donor_vocab.ts")
    return json.loads(m.group(1))


class DonorVocabIsCurrent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gen = _generator()
        cls.lifted = cls.gen.lift()
        with open(_JSON, encoding="utf-8") as f:
            cls.web = json.load(f)

    def _plain(self, v):
        return sorted(v) if isinstance(v, (set, frozenset)) else v

    # -- the classification sets, which decide what is a flag -------------------
    def test_classification_sets_match_the_python(self):
        for py_name, ts_name in [
            ("META", "META"), ("SHORT_TEXT", "SHORT_TEXT"), ("LONG_TEXT", "LONG_TEXT"),
            ("CONTACT", "CONTACT"), ("PROFILE", "PROFILE"),
            ("HIDDEN_FIELDS", "HIDDEN_FIELDS"), ("ELIG", "ELIG"),
        ]:
            with self.subTest(constant=py_name):
                self.assertEqual(_emitted_ts(ts_name), self._plain(self.lifted[py_name]))

    def test_choice_enums_match_and_keep_the_unset_option_first(self):
        self.assertEqual(_emitted_ts("CHOICE"), self.lifted["CHOICE"])
        self.assertEqual(_emitted_ts("CONDITION_CHOICE"), self.lifted["CONDITION_CHOICE"])
        both = {**_emitted_ts("CHOICE"), **_emitted_ts("CONDITION_CHOICE")}
        for col, opts in both.items():
            with self.subTest(column=col):
                # The leading "" is the UNSET option. If it stops being first, the form's
                # index arithmetic silently preselects a real value for a blank field —
                # which writes an answer nobody gave.
                self.assertEqual(opts[0], "", f"{col} lost its unset option")

    def test_condition_enums_store_keys_not_labels(self):
        """core.criteria_derive matches these strings exactly.

        A form that stored "Grassroot local" instead of "grassroot_local" would satisfy
        no eligibility rule and fail none either, which reads as a donor with no
        conditions at all rather than as a bug.
        """
        cc = _emitted_ts("CONDITION_CHOICE")
        for col, opts in cc.items():
            for opt in opts:
                if not opt:
                    continue
                with self.subTest(column=col, option=opt):
                    self.assertEqual(opt, opt.lower())
                    self.assertNotIn(" ", opt)

    # -- the tri-state map ------------------------------------------------------
    def test_tristate_map_keeps_blank_distinct_from_not_sure(self):
        to_val = _emitted_ts("TRISTATE_TO_VAL")
        self.assertEqual(to_val, self.lifted["TRISTATE_TO_VAL"])
        opts = _emitted_ts("TRISTATE_OPTS")
        self.assertEqual(opts, self.lifted["TRISTATE_OPTS"])
        # Four states, and the blank one maps to null — not to "not_sure". Blank means
        # nobody answered; "not_sure" means somebody looked and could not tell. They
        # score the same and count differently, so only completeness can see a mix-up.
        self.assertEqual(len(opts), 4)
        self.assertIsNone(to_val[opts[0]], "the blank option must map to null")
        self.assertEqual(sorted(v for v in to_val.values() if v is not None),
                         ["no", "not_sure", "yes"])
        back = _emitted_ts("VAL_TO_TRISTATE")
        self.assertEqual(back, self.lifted["VAL_TO_TRISTATE"])
        # Round-trips for every answered state, so an edit that touches nothing stores
        # what it read.
        for word, stored in to_val.items():
            if stored is not None:
                with self.subTest(option=word):
                    self.assertEqual(back[stored], word)

    # -- the dropdown vocabularies and labels -----------------------------------
    def test_dropdowns_and_labels_match(self):
        for py_name, ts_name in [
            ("ACR", "ACR"), ("LABEL_OVERRIDES", "LABEL_OVERRIDES"),
            ("PARTNER_TYPE_OPTIONS", "PARTNER_TYPE_OPTIONS"),
            ("FUNDING_MECHANISMS", "FUNDING_MECHANISMS"),
            ("ROUTE_STATUSES", "ROUTE_STATUSES"),
            ("LOCAL_ORG_ELIGIBLE", "LOCAL_ORG_ELIGIBLE"),
            ("FUNDING_CYCLES", "FUNDING_CYCLES"),
            ("APPLICATION_PROCESSES", "APPLICATION_PROCESSES"),
            ("REPORTING_REQUIREMENTS", "REPORTING_REQUIREMENTS"),
            ("CATEGORIES", "CATEGORIES"), ("CATEGORY_CANON", "CATEGORY_CANON"),
            ("ACRONYMS", "ACRONYMS"), ("LIST_FIELDS", "LIST_FIELDS"),
            ("COMPLETENESS_TEXT", "COMPLETENESS_TEXT"),
            ("COMPLETENESS_JSON", "COMPLETENESS_JSON"),
            ("CONTACT_COLS", "CONTACT_COLS"),
        ]:
            with self.subTest(constant=py_name):
                self.assertEqual(_emitted_ts(ts_name), self._plain(self.lifted[py_name]))

    # -- the browser half -------------------------------------------------------
    def test_browser_json_carries_the_same_values(self):
        """The two runtimes do not share a bundle, so both emissions must be current."""
        for key, py_name in [
            ("meta", "META"), ("shortText", "SHORT_TEXT"), ("longText", "LONG_TEXT"),
            ("contact", "CONTACT"), ("contactCols", "CONTACT_COLS"),
            ("profile", "PROFILE"), ("hidden", "HIDDEN_FIELDS"), ("elig", "ELIG"),
            ("acr", "ACR"), ("labelOverrides", "LABEL_OVERRIDES"),
            ("listFields", "LIST_FIELDS"), ("acronyms", "ACRONYMS"),
            ("completenessText", "COMPLETENESS_TEXT"),
            ("completenessJson", "COMPLETENESS_JSON"),
            ("categoryCanon", "CATEGORY_CANON"), ("choice", "CHOICE"),
            ("conditionChoice", "CONDITION_CHOICE"),
            ("tristateToVal", "TRISTATE_TO_VAL"), ("valToTristate", "VAL_TO_TRISTATE"),
        ]:
            with self.subTest(key=key):
                self.assertEqual(self.web[key], self._plain(self.lifted[py_name]))

    def test_the_em_dash_survived_both_encodings(self):
        """The blank tri-state option is U+2014, and both files are read as UTF-8.

        It is the one key in this vocabulary that is not ASCII. Mangled, it stops
        matching the option list and every requirement renders as unanswered.
        """
        self.assertIn("—", _emitted_ts("TRISTATE_OPTS"))
        self.assertIn("—", self.web["tristateOpts"])
        self.assertIsNone(self.web["tristateToVal"]["—"])

    # -- the split this file exists to keep -------------------------------------
    def test_nothing_live_leaked_into_the_vocabulary(self):
        """Only repo constants belong here; anything per-deployment is derived at runtime.

        _FLAGS/_FIT/_REQ come from donor_intel's live columns, _YEAR_OPTIONS from today's
        date, _PARTNER_OPTIONS from the live donor list. Emitting any of them would freeze
        a deployment's data into the repo and silently stop a migration from adding a
        field to the form.
        """
        with open(_TS, encoding="utf-8") as f:
            src = f.read()
        for leaked in ["_FLAGS", "FLAG_GROUPS", "YEAR_OPTIONS", "HQ_COUNTRY_OPTIONS",
                       "PARTNER_OPTIONS"]:
            with self.subTest(constant=leaked):
                self.assertNotRegex(src, rf"export const {leaked}\b")

    def test_every_wanted_constant_is_still_a_literal(self):
        """The lift raises rather than skipping, so this just pins the WANTED list.

        A constant that becomes computed in donors.py should fail here with its name,
        not vanish from the vocabulary.
        """
        self.assertEqual(sorted(self.lifted), sorted(self.gen.WANTED))


if __name__ == "__main__":
    unittest.main()
