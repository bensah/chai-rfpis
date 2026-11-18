"""TED notices arrive with their body and their real language.

WHY
---
`scraper._scan_ted` asked the TED API for the title, the dates and the country,
then set `brief_description: None` explicitly. Every TED row therefore reached
the store with no source text: measured 2026-11-19, all 50 live TED rows hold
under 400 characters and the median is zero, which is below the floor synthesis
will spend a call on. Nothing could read a call out of them.

It was never a crawling problem. Probing the same endpoint with
`description-proc` in the field list, 25 of 25 health notices returned one. We
had not asked.

The second finding is the one that shapes the code: TED auto-translates TITLES
into every EU language and leaves the DESCRIPTION in the language it was
published in. Of those 25, exactly ONE had an English description — and all 25
were being stored with `solicitation_language` hardcoded to "English".

Every payload below is the real shape returned by api.ted.europa.eu/v3: a
multilingual dict keyed by ISO 639-2, whose value is a STRING for a
procurement-level field and a LIST for a per-lot one. Offline — no network.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import scraper  # noqa: E402

GERMAN = ("Es soll ein Gutachten vergeben werden, das in Berichtsform den "
          "Sachverhalt in Bezug auf die Anwendung des nicht invasiven "
          "Pränataltests darstellt.")
ENGLISH = "Supply of laboratory reagents and consumables for the national programme."


# ---------------------------------------------------------------------------
# the body
# ---------------------------------------------------------------------------
def test_an_english_description_is_preferred():
    text, lang = scraper._ted_text(
        {"description-proc": {"deu": GERMAN, "eng": ENGLISH}})
    assert text == ENGLISH
    assert lang == "English"


def test_the_original_language_is_kept_and_named_when_english_is_absent():
    """The common case. A German tender described in German is a true record of
    that tender and far more use than the blank we stored before."""
    text, lang = scraper._ted_text({"description-proc": {"deu": GERMAN}})
    assert text == GERMAN
    assert lang == "German"


def test_a_per_lot_description_arrives_as_a_list():
    text, lang = scraper._ted_text(
        {"description-lot": {"ita": ["SERVIZI SOCIALI", "Gestione RSA"]}})
    assert "SERVIZI SOCIALI" in text and "Gestione RSA" in text
    assert lang == "Italian"


def test_lot_detail_is_added_to_the_procurement_description():
    """A multi-lot tender puts the substance per lot and leaves the
    procurement-level description a single line."""
    text, _lang = scraper._ted_text({
        "description-proc": {"ita": "Procedura aperta."},
        "description-lot": {"ita": ["Servizio 1 gestione RSA", "Servizio 2 CIAF"]},
    })
    assert "Procedura aperta." in text
    assert "Servizio 1 gestione RSA" in text


def test_the_same_text_is_not_stored_twice():
    """TED frequently repeats the procurement description verbatim as the single
    lot's description."""
    text, _ = scraper._ted_text({"description-proc": {"ita": GERMAN},
                                 "description-lot": {"ita": [GERMAN]}})
    assert text.count(GERMAN) == 1


def test_a_notice_with_no_description_yields_nothing_rather_than_an_empty_string():
    assert scraper._ted_text({}) == ("", "")
    assert scraper._ted_text({"description-proc": {}}) == ("", "")
    assert scraper._ted_text({"description-proc": {"deu": "   "}}) == ("", "")


def test_an_unmapped_language_code_is_passed_through_rather_than_guessed():
    _text, lang = scraper._ted_text({"description-proc": {"zzz": "Text."}})
    assert lang == "zzz"


# ---------------------------------------------------------------------------
# the buyer and the money
# ---------------------------------------------------------------------------
def test_the_buyer_name_comes_out_of_its_multilingual_list():
    assert scraper._ted_first_text(
        {"deu": ["Bundesministerium für Gesundheit"]}) == "Bundesministerium für Gesundheit"


def test_the_buyer_name_prefers_english():
    assert scraper._ted_first_text(
        {"ita": ["Ministero"], "eng": ["Ministry of Health"]}) == "Ministry of Health"


def test_a_missing_buyer_is_an_empty_string_not_a_crash():
    assert scraper._ted_first_text(None) == ""
    assert scraper._ted_first_text({}) == ""


def test_the_contract_value_and_its_currency():
    amount, currency = scraper._ted_value(
        {"total-value": 61939319, "estimated-value-cur-proc": "EUR"})
    assert (amount, currency) == (61939319.0, "EUR")


def test_a_notice_with_no_value_reports_none_for_both():
    assert scraper._ted_value({"estimated-value-cur-proc": "EUR"}) == (None, None)
    assert scraper._ted_value({}) == (None, None)


# ---------------------------------------------------------------------------
# and the language reaches the record
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def policies():
    from core.policies import get_policies
    return get_policies()


def _record(policies, **extra):
    from core import extract
    cand = {
        "opportunity_title": "Germany — Health services — Gutachten NIPT",
        "opportunity_link": "https://ted.europa.eu/en/notice/800206-2026",
        "funding_agency": "Bundesministerium für Gesundheit",
        "source": "Tenders Electronic Daily (EU TED)",
        "_source_class": "primary",
        "call_submission_deadline": "2027-02-01",
        "_page_text": (GERMAN + " ") * 12,
    }
    cand.update(extra)
    rec, reason = extract.build_record(cand, policies, scan_year=2026, use_llm=False)
    assert rec is not None, f"the extraction gate rejected the fixture: {reason}"
    return rec


def test_a_handlers_language_is_stored_not_overwritten_with_english(policies):
    assert _record(policies, solicitation_language="German")["solicitation_language"] == "German"


def test_english_is_still_the_default_when_no_handler_says_otherwise(policies):
    assert _record(policies)["solicitation_language"] == "English"


def test_a_blank_language_falls_back_rather_than_storing_nothing(policies):
    assert _record(policies, solicitation_language="  ")["solicitation_language"] == "English"
