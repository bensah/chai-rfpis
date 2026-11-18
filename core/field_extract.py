"""Schema fields read deterministically off the call text. No model call.

WHY THIS EXISTS
---------------
Measured over the 1687 live catalogue rows on 2026-11-18
(`scripts/measure_extraction_coverage.py`), the schema was 41.6% populated and
NOT ONE ROW reached the owner's 80% bar. Eight fields were at exactly 0.0%:

    apply_url  agency_code  grantmaking_entity  total_program_funding
    expected_awards  expected_award_date  time_to_award  focus_themes

…and four more were under 2%: funding_tiers, call_award_floor,
call_award_ceiling, project_duration.

A zero is not a pipeline that performs badly. It is a field with NO WRITER, and
`core/opportunity_detail.py` already says so in its header. What the zeroes have
in common is that each was left to the LLM pass, and the LLM pass has two
failure modes that look identical from the data: it is not configured, or the
provider is out of credit (which is where this repo was that morning — see
`core/llm_providers.py`).

So the division of labour was wrong, not the model. These facts are published in
formulaic language — "grants of between £50,000 and £150,000", "we expect to
fund up to 8 projects", "successful applicants will be notified in March 2027",
"over a period of 24 months" — and a pattern reads them with certainty, for
free, every time, whether or not anyone has paid a model bill. The LLM's job is
the reading and rewriting that regex genuinely cannot do: the overview prose, the
ideal-applicant profile, what is and is not funded in the funder's own terms.

That is the owner's design applied properly, not a retreat from it: "an LLM does
the bulk of turning source material into data **wherever regex hits its limits**".
These are below the limit.

THE RULE EVERY FUNCTION HERE FOLLOWS
------------------------------------
A blank is a true statement about the call; a wrong number is a lie a reviewer
acts on. So each pattern is anchored on an explicit cue phrase and returns None
the moment the reading is ambiguous. Nothing here guesses from context, and
nothing here overwrites a value that is already on the row — `derive_fields`
fills blanks only.

Every function is PURE: text in, typed value out. No network, no database, no
state. That is what makes the whole module testable offline and why
`tests/test_field_extract.py` can pin each pattern against real call phrasing.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# money
# ---------------------------------------------------------------------------
_CCY_SYM = r"(?:US\s?\$|U\.S\.\s?\$|\$|€|£|CHF|USD|EUR|GBP|CAD|AUD|ZAR|NOK|SEK|DKK|JPY)"
# NON-capturing group, not bare alternation: this constant is interpolated into
# larger patterns, and a bare `A|B` there splits the WHOLE pattern at the pipe
# instead of the number. That silently cost `total_program_funding` every match.
_NUM = r"(?:\d{1,3}(?:[,\s]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
_SCALE = {"k": 1e3, "thousand": 1e3, "m": 1e6, "mn": 1e6, "million": 1e6,
          "bn": 1e9, "billion": 1e9}
_SCALE_RE = r"(?:k|thousand|m|mn|million|bn|billion)"

#: A money expression: a currency cue, a number, an optional scale word. The
#: currency may trail the number ("500,000 EUR") as well as lead it.
_MONEY = (rf"(?:{_CCY_SYM}\s?(?P<n1>{_NUM})\s*(?P<s1>{_SCALE_RE})?"
          rf"|(?P<n2>{_NUM})\s*(?P<s2>{_SCALE_RE})?\s?{_CCY_SYM})")


def _money_value(m: re.Match) -> float | None:
    """The float behind a `_MONEY` match, or None if it did not really match one."""
    num = m.groupdict().get("n1") or m.groupdict().get("n2")
    scale = (m.groupdict().get("s1") or m.groupdict().get("s2") or "").lower()
    if not num:
        return None
    try:
        v = float(re.sub(r"[,\s]", "", num))
    except ValueError:
        return None
    v *= _SCALE.get(scale, 1)
    return v if v > 0 else None


def _norm(text: Any) -> str:
    """Whitespace-collapsed text. Every pattern here is written against ONE LINE,
    because a published call breaks a sentence across a table cell or a PDF line
    as often as not, and `.` would otherwise stop at the wrong place."""
    return re.sub(r"\s+", " ", str(text or "")).strip()


# ---------------------------------------------------------------------------
# award range  ->  call_award_floor / call_award_ceiling
# ---------------------------------------------------------------------------
# Anchored on a RANGE cue, never on two amounts that merely sit near each other:
# a call states its budget, its co-financing threshold and last year's spend in
# the same paragraph, and "the first two numbers on the page" is how a 12m
# programme envelope becomes a 12m per-award ceiling.
_BETWEEN_RE = re.compile(
    rf"\b(?:between|from)\s+(?P<lo>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?|{_NUM}\s*{_SCALE_RE}?\s?{_CCY_SYM})"
    rf"\s*(?:and|to|–|—|-)\s*"
    rf"(?P<hi>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?|{_NUM}\s*{_SCALE_RE}?\s?{_CCY_SYM})", re.I)

#: "grants of £50,000 – £150,000" — a dash range with no "between".
_DASH_RANGE_RE = re.compile(
    rf"(?P<lo>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)\s*(?:–|—|--|-|to)\s*"
    rf"(?P<hi>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)", re.I)

#: "up to US$300,000 per award/grant/project" — a ceiling with no floor. The
#: per-award qualifier is REQUIRED: "up to £12 million is available" is the
#: programme envelope, which is a different field (and the mistake that made the
#: SRHR call show a 12m award).
_CEILING_RE = re.compile(
    rf"\bup to\s+(?P<hi>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)"
    rf"(?=[^.]{{0,60}}?\b(?:per|each)\s+(?:award|grant|project|proposal|applicant|"
    rf"recipient|consortium|partner)\b"
    rf"|[^.]{{0,40}}?\b(?:per annum|a year)\b)", re.I)

_ONE_MONEY_RE = re.compile(_MONEY, re.I)


def _one_money(fragment: str) -> float | None:
    m = _ONE_MONEY_RE.search(fragment or "")
    return _money_value(m) if m else None


def award_bounds(text: Any) -> tuple[float | None, float | None]:
    """(floor, ceiling) for a SINGLE award, read off a published range.

    Returns (None, None) unless the call states a range or a per-award ceiling in
    so many words. 0.7% of catalogue rows carried a floor before this existed, and
    the reason is that `core/extract.py` derives bounds only from the LLM's
    `funding_tiers` — a staged-funding concept most calls do not use.
    """
    return find_award_bounds(text)[:2]


def find_award_bounds(text: Any) -> tuple[float | None, float | None, str]:
    """(floor, ceiling, quoted evidence) — `award_bounds` plus the source phrase."""
    body = _norm(text)
    if not body:
        return None, None, ""
    for rx in (_BETWEEN_RE, _DASH_RANGE_RE):
        for m in rx.finditer(body):
            lo, hi = _one_money(m.group("lo")), _one_money(m.group("hi"))
            # A range runs upwards. A pair that does not is a date, a page
            # reference or two unrelated figures that happened to share a dash.
            if lo and hi and lo < hi:
                return lo, hi, m.group(0).strip()
    m = _CEILING_RE.search(body)
    if m:
        hi = _one_money(m.group("hi"))
        if hi:
            return None, hi, body[m.start(): m.end() + 60].strip()
    return None, None, ""


# ---------------------------------------------------------------------------
# total_program_funding
# ---------------------------------------------------------------------------
#: The WHOLE envelope, as distinct from one award. Every cue names the programme
#: or the call, so a per-award figure cannot reach this field.
_TOTAL_RE = re.compile(
    rf"\b(?:total(?:ling|ing)?|overall|indicative|combined|aggregate)\s+"
    rf"(?:budget|envelope|funding|amount|value|allocation|programme funding|program funding)"
    rf"[^.]{{0,40}}?(?P<v>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)"
    rf"|(?P<v2>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)\s+(?:in total|overall|in aggregate)\b"
    rf"|\b(?:a )?total of\s+(?P<v3>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)\s+(?:is|will be|has been)\s+"
    rf"(?:available|committed|allocated|made available)"
    rf"|\b(?:budget|envelope|fund) of\s+(?P<v4>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)\s+"
    rf"for (?:this|the) (?:call|programme|program|round)"
    # "Up to £12 million is available for the programme" — a ceiling on the WHOLE
    # call. The PER-AWARD reading of that exact sentence is what put £12,000,000
    # in the SRHR row's award column, so `_CEILING_RE` demands a per-award
    # qualifier and this branch demands a programme one. A sentence with neither
    # is ambiguous and reaches no field, which is the right answer.
    rf"|\bup to\s+(?P<v5>{_CCY_SYM}\s?{_NUM}\s*{_SCALE_RE}?)\s+(?:is|will be|has been)\s+"
    rf"(?:available|committed|allocated|made available)"
    rf"[^.]{{0,40}}?\b(?:for|across|under)\s+(?:this|the)\s+"
    rf"(?:call|programme|program|round|competition|fund|initiative)\b", re.I)


def total_program_funding(text: Any) -> float | None:
    """The call's whole funding envelope, or None.

    Zero of 1687 rows had this. It matters because the opportunity page shows it
    beside the per-award range, and a reviewer reading "£12,000,000" in the award
    column — which is what the SRHR call stored — concludes something quite
    different about their chances than "£12m across the programme".
    """
    return find_total_program_funding(text)[0]


def find_total_program_funding(text: Any) -> tuple[float | None, str]:
    """(whole funding envelope, quoted evidence)."""
    body = _norm(text)
    m = _TOTAL_RE.search(body)
    if not m:
        return None, ""
    for g in ("v", "v2", "v3", "v4", "v5"):
        if m.groupdict().get(g):
            return _one_money(m.group(g)), m.group(0).strip()
    return None, ""


# ---------------------------------------------------------------------------
# expected_awards
# ---------------------------------------------------------------------------
_WORD_NUM = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
             "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
             "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30}
_COUNT = r"\d{1,4}|" + "|".join(_WORD_NUM)
_AWARD_NOUN = (r"(?:awards?|grants?|projects?|proposals?|applicants?|contracts?|"
               r"recipients?|consortia|teams?|centres?|centers?|fellowships?)")

_EXPECTED_AWARDS_RE = re.compile(
    rf"\b(?:up to|approximately|around|about|expects? to (?:fund|support|make|award)|"
    rf"anticipates? (?:funding|supporting|making)|intends? to (?:fund|support|award)|"
    rf"will (?:fund|support|award)|a maximum of)\s+"
    rf"(?:up to\s+)?(?P<n>{_COUNT})\s*(?:-|–|to)?\s*(?P<n2>{_COUNT})?\s+{_AWARD_NOUN}"
    rf"\b(?!\s*(?:per|of)\s)", re.I)


def _count(v: str | None) -> int | None:
    if not v:
        return None
    s = v.strip().lower()
    if s.isdigit():
        n = int(s)
        # A four-digit "count" is a year or an amount that lost its currency.
        return n if 0 < n <= 999 else None
    return _WORD_NUM.get(s)


def expected_awards(text: Any) -> str | None:
    """How many awards the call expects to make, as published ("up to 8 awards",
    "3-5 grants"). A TEXT field in the schema, because a call states a range as
    often as a number and "3-5" is the honest answer."""
    return find_expected_awards(text)[0]


def find_expected_awards(text: Any) -> tuple[str | None, str]:
    """(how many awards the call expects to make, quoted evidence)."""
    body = _norm(text)
    m = _EXPECTED_AWARDS_RE.search(body)
    if not m:
        return None, ""
    lo, hi = _count(m.group("n")), _count(m.group("n2"))
    if lo is None:
        return None, ""
    ev = m.group(0).strip()
    return (f"{lo}-{hi}" if (hi is not None and hi > lo) else str(lo)), ev


# ---------------------------------------------------------------------------
# dates: expected_award_date, time_to_award
# ---------------------------------------------------------------------------
_MONTHS = {m: i for i, m in enumerate(
    ("january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"), start=1)}
_MONTH_RE = "|".join(_MONTHS) + "|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
_ABBR = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
         "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12}

_DATE_PATTERNS = (
    re.compile(r"\b(?P<y>20\d{2})-(?P<m>\d{1,2})-(?P<d>\d{1,2})\b"),
    re.compile(rf"\b(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s+(?P<mon>{_MONTH_RE})\s*,?\s*(?P<y>20\d{{2}})\b", re.I),
    re.compile(rf"\b(?P<mon>{_MONTH_RE})\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?\s*,?\s*(?P<y>20\d{{2}})\b", re.I),
    # Month + year only ("in March 2027") — the common phrasing for an award
    # announcement, which is rarely pinned to a day. The 1st stands for the month.
    re.compile(rf"\b(?P<mon>{_MONTH_RE})\s+(?P<y>20\d{{2}})\b", re.I),
)

#: The cue must be about the FUNDING DECISION — and nothing else.
#
# A looser first version cost this field its credibility within one sample. It
# accepted "results" and "outcomes", and the EU portal's standard heading is
# "Expected Outcome: Project results are expected to contribute to…", which has
# nothing to do with when an award is announced. Five of six sampled hits were
# that heading, each paired with whatever date happened to follow — including
# 2021 dates on calls that had not opened then.
#
# So the subject must be an AWARD, a GRANT, a SELECTION or an APPLICANT being
# told, and `_EXPECTED_OUTCOME_RE` drops the heading outright before matching.
_AWARD_DATE_CUE = re.compile(
    r"\b(?:award(?:s|ing)?|grant(?:s)? (?:agreement|decision)s?|successful applicants?|"
    r"selection|notification|notified|informed)\b"
    r"[^.]{0,60}?\b(?:will be|to be|are |is |expected|anticipated|communicated|made|"
    r"issued|announced?|by|in|on)\b", re.I)

#: The EU portal heading above, and its siblings. Removed from the text before
#: the award-date search so they cannot supply a cue OR a date.
_EXPECTED_OUTCOME_RE = re.compile(
    r"\bexpected (?:outcomes?|results?|impacts?)\b[^.]{0,400}?(?:\.|$)", re.I)

#: Phrases that make a date near an award word the END of the funded work rather
#: than the announcement of it. "award period of performance is 24 months
#: beginning September 2026 through September 30, 2028" stored 2028 as the award
#: date — the date the project finishes.
_AWARD_DATE_VETO = re.compile(
    r"\bperiod of performance\b|\bend(?:s|ing)? (?:on|by)\b|"
    r"\bcompletion date\b|\bstart (?:date|ing)\b|\bceremony\b|\bpresented on\b|"
    # "…beginning September 2026 THROUGH September 30, 2028" — the end of the
    # funded work. Only vetoes when `through` introduces a DATE: a bare \bthrough\b
    # is one of the commonest words on a call page ("submitted through the online
    # portal") and vetoed perfectly good award dates that merely sat near it.
    r"\bthrough\s+(?:\d{1,2}[/.-]|\d{4}\b|(?:january|february|march|april|may|june|"
    r"july|august|september|october|november|december)\b)", re.I)


def _parse_date(frag: str) -> str | None:
    for rx in _DATE_PATTERNS:
        m = rx.search(frag)
        if not m:
            continue
        gd = m.groupdict()
        y = int(gd["y"])
        if gd.get("m"):
            mo = int(gd["m"])
        else:
            mon = (gd.get("mon") or "").lower()
            mo = _MONTHS.get(mon) or _ABBR.get(mon) or 0
        d = int(gd.get("d") or 1)
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            continue
    return None


def find_expected_award_date(text: Any, *, deadline: Any = None,
                             not_before: Any = None) -> tuple[str | None, str]:
    """(ISO date the funder will announce the award, quoted evidence).

    The cue phrase has to be about the DECISION. "Projects must start by 1 April"
    and "applications close 30 November" are both dates near the word "award" on
    a typical call page, and neither is this field.

    `deadline`, when known, is a free validity check worth more than any amount of
    pattern tuning: **an award cannot be announced before applications close.** A
    date at or before the deadline is therefore not this field, whatever the
    sentence around it said, and it is rejected rather than stored.

    `not_before` (normally the row's `date_posted`) covers the rows with no stored
    deadline, where the same reasoning applies one step weaker: an award for a
    call published this year was not announced in 2018. Without it, an archived
    page describing a past prize ceremony read as a forthcoming award date.
    """
    body = _EXPECTED_OUTCOME_RE.sub(" ", _norm(text))
    floor = max(str(deadline or "").strip()[:10], str(not_before or "").strip()[:10])
    for m in _AWARD_DATE_CUE.finditer(body):
        # Look only at the rest of that sentence — a date two sentences later
        # belongs to whatever that sentence was about.
        tail = body[m.end(): m.end() + 90]
        got = _parse_date(tail)
        if not got:
            continue
        if floor and got <= floor:
            continue
        if _AWARD_DATE_VETO.search(body[max(0, m.start() - 60): m.end() + 90]):
            continue
        return got, body[m.start(): m.end() + 60].strip()
    return None, ""


def expected_award_date(text: Any, *, deadline: Any = None,
                        not_before: Any = None) -> str | None:
    return find_expected_award_date(text, deadline=deadline,
                                    not_before=not_before)[0]


def time_to_award(deadline: Any, award_date: Any) -> str | None:
    """"about 4 months" between closing and announcement, or None.

    Derived rather than read: no call states this, which is why the field sat at
    0.0%, but both ends of it are on the row once `expected_award_date` is read.
    """
    def _d(v):
        s = str(v or "").strip()[:10]
        try:
            return date.fromisoformat(s)
        except ValueError:
            return None
    a, b = _d(deadline), _d(award_date)
    if not a or not b or b < a:
        return None
    days = (b - a).days
    if days < 45:
        return f"about {max(days, 1)} days"
    months = round(days / 30.44)
    return f"about {months} month{'s' if months != 1 else ''}"


# ---------------------------------------------------------------------------
# project_duration (months)
# ---------------------------------------------------------------------------
# THE SUBJECT MUST BE THE FUNDED WORK, not any span of months on the page.
#
# A looser first version keyed on "duration|period|…|over|for" plus a number and
# a unit. Sampled against the live catalogue it returned 24 months for "homeless
# for over two years", 12 for "a service period of six to 12 months" (the
# beneficiary's service, not the grant) and 12 for "remain viable for at least
# one year AFTER the project period" — a figure explicitly about the time after
# the project. Three of five samples were wrong, and a wrong duration is a number
# a reviewer plans a budget against.
#
# Both forms below therefore name the funded thing — project, grant, award,
# contract, programme, activity — on one side of the number or the other.
_PROJECT_NOUN = (r"(?:projects?|grants?|awards?|contracts?|programmes?|programs?|"
                 r"activities|interventions?|proposals?|research)")

_DURATION_RES = (
    # "project duration: 24 months" · "the grant period is up to 36 months" ·
    # "for a maximum period of 24-36 months"
    re.compile(rf"\b{_PROJECT_NOUN}?\s*(?:duration|period|term|timeframe|time frame|"
               rf"length)\b[^.]{{0,30}}?"
               rf"\b(?:up to\s+|a maximum of\s+|approximately\s+|of\s+)?"
               rf"(?P<n>\d{{1,3}}|{'|'.join(_WORD_NUM)})\s*(?:-|–|to)?\s*"
               rf"(?P<n2>\d{{1,3}})?\s*(?P<unit>months?|years?)\b", re.I),
    # "projects may run for up to 24 months" · "grants are awarded for 3 years"
    re.compile(rf"\b{_PROJECT_NOUN}\b[^.]{{0,40}}?"
               rf"\b(?:last|run|runs|be implemented|be delivered|be completed|"
               rf"be carried out|are funded|is funded|are awarded|are supported)\b"
               rf"[^.]{{0,25}}?\b(?:up to\s+|a maximum of\s+|over\s+|for\s+)?"
               rf"(?P<n>\d{{1,3}}|{'|'.join(_WORD_NUM)})\s*(?:-|–|to)?\s*"
               rf"(?P<n2>\d{{1,3}})?\s*(?P<unit>months?|years?)\b", re.I),
    # "a 24-month project" · "three-year grants"
    re.compile(rf"\b(?P<n>\d{{1,3}}|{'|'.join(_WORD_NUM)})[-\s](?P<unit>month|year)\s+"
               rf"{_PROJECT_NOUN}\b(?P<n2>)", re.I),
)

#: Phrases that make a nearby duration about something OTHER than the grant.
_DURATION_VETO = re.compile(
    r"\bafter\s+(?:the\s+)?(?:project|grant|award|funding)\b|\bprior to\b|"
    r"\bhomeless\w*\b|\bservice period\b|\bin the (?:last|past|previous)\b|"
    r"\bexperience\b|\bwithin the last\b", re.I)


def find_project_duration(text: Any) -> tuple[int | None, str]:
    """(funded project length in MONTHS, quoted evidence).

    The column is an integer count of months (`core.opportunity_detail._duration`
    renders it as "36 months"), so a call stating years is converted. When a range
    is published ("24-36 months") the UPPER bound is stored: it is the ceiling a
    reviewer plans against, and storing the floor made a 36-month award look like
    a 24-month one.
    """
    body = _norm(text)
    for rx in _DURATION_RES:
        for m in rx.finditer(body):
            window = body[max(0, m.start() - 70): m.end() + 20]
            if _DURATION_VETO.search(window):
                continue
            lo, hi = _count(m.group("n")), _count(m.group("n2"))
            n = hi if (hi and lo and hi > lo) else lo
            if not n:
                continue
            if m.group("unit").lower().startswith("year"):
                n *= 12
            # A plausible grant runs from a month to a decade. Outside that the
            # match is a page number, a sample size or an age.
            if 1 <= n <= 120:
                return n, m.group(0).strip()
    return None, ""


def project_duration(text: Any) -> int | None:
    return find_project_duration(text)[0]


# ---------------------------------------------------------------------------
# eligibility_applicant_types
# ---------------------------------------------------------------------------
#: (label, pattern). The label vocabulary matches what the donor profile and the
#: Review screen already use, so a reviewer sees one set of words.
_APPLICANT_TYPES = (
    ("NGO / non-profit", r"\bNGOs?\b|non[-\s]?govern?mental organi[sz]ations?|"
                         r"not[-\s]for[-\s]profit|non[-\s]?profit"),
    ("Civil society organisation", r"civil society organi[sz]ations?|\bCSOs?\b|"
                                   r"community[-\s]based organi[sz]ations?|\bCBOs?\b"),
    ("University / research institute", r"universit(?:y|ies)|higher education institutions?|"
                                        r"research (?:institut\w+|organi[sz]ations?|centres?|centers?)|"
                                        r"academic institutions?"),
    ("Government / public body", r"government (?:agenc\w+|departments?|ministr\w+|bodies|institutions?)|"
                                 r"public (?:bodies|institutions?|sector (?:bodies|organi[sz]ations?))|"
                                 r"ministr(?:y|ies) of health"),
    ("Private company", r"private (?:sector )?(?:compan\w+|firms?|entities)|for[-\s]profit|"
                        r"\bSMEs?\b|small and medium[-\s]sized enterprises"),
    ("International organisation", r"international organi[sz]ations?|UN agenc\w+|"
                                   r"multilateral organi[sz]ations?"),
    ("Consortium / partnership", r"consorti(?:um|a)|partnerships? of|joint applications?|"
                                 r"collaborat\w+ of (?:at least|two or more)"),
    ("Individual / researcher", r"individual (?:applicants?|researchers?)|"
                                r"principal investigators?\b"),
)

#: Without this the patterns fire on any mention anywhere — a call that thanks
#: its university partners is not a call open to universities.
_ELIGIBILITY_CUE = re.compile(
    r"\b(?:eligib\w+|who (?:can|may) apply|open to|applicants? must be|"
    r"applications? (?:are|is) (?:invited|welcome|open)|this call is open|"
    r"we (?:invite|welcome) applications)\b", re.I)


def eligibility_applicant_types(text: Any) -> list[str]:
    """Institution types the call says may apply, from an ELIGIBILITY passage only.

    Scoped to a window after an eligibility cue rather than the whole page, for
    the reason above. An empty list means "the call did not say", never "no one".
    """
    body = _norm(text)
    if not body:
        return []
    windows = [body[m.start(): m.start() + 900] for m in _ELIGIBILITY_CUE.finditer(body)]
    if not windows:
        return []
    scope = " ".join(windows[:6])
    out: list[str] = []
    for label, pattern in _APPLICANT_TYPES:
        if re.search(pattern, scope, re.I) and label not in out:
            out.append(label)
    return out


# ---------------------------------------------------------------------------
# what_is_not_funded
# ---------------------------------------------------------------------------
_EXCLUSION_CUE = re.compile(
    r"\b(?:not eligible|ineligible|are excluded|is excluded|exclusions?|"
    r"out of scope|will not (?:be )?(?:fund|support|consider|accept)\w*|"
    r"does not (?:fund|support|cover)|we do not (?:fund|support)|"
    r"not be funded|cannot be funded|ineligible (?:costs?|activit\w+|expenditure))\b", re.I)


def what_is_not_funded(text: Any, *, limit: int = 6) -> str | None:
    """The call's exclusions as newline bullets, or None.

    Sentences, not a summary: these are the lines that disqualify a bid, and a
    paraphrase of an exclusion is exactly the kind of near-miss that costs a team
    a week of proposal writing. `_lines` elsewhere formats model output the same
    way, so the column's shape is unchanged.
    """
    body = _norm(text)
    if not body:
        return None
    out: list[str] = []
    for m in _EXCLUSION_CUE.finditer(body):
        start = body.rfind(". ", 0, m.start())
        sentence = body[(start + 2) if start >= 0 else 0:]
        end = sentence.find(". ")
        sentence = (sentence[:end] if end > 0 else sentence[:300]).strip(" .;:")
        if 25 <= len(sentence) <= 300 and sentence not in out:
            out.append(sentence)
        if len(out) >= limit:
            break
    return "\n".join(out) or None


# ---------------------------------------------------------------------------
# documents in plain text  ->  attachments / resource_links
# ---------------------------------------------------------------------------
# `catalog_synthesis.extract_documents` reads HTML, which the scan does not keep
# (`raw_text` is text). So on a stored row the only documents available are the
# URLs the text itself contains — which is why attachments sat at 1.9%.
_DOC_EXT_RE = re.compile(r"\.(pdf|docx?|xlsx?|pptx?|zip|rtf|odt)(?:\?|#|$)", re.I)
_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_DOC_TYPE = (
    ("Guidelines", r"guid(?:ance|eline)|instructions?|manual|handbook"),
    ("Application form", r"form|template|annex|appendix"),
    ("Terms of reference", r"\btor\b|terms[-_\s]of[-_\s]reference"),
    ("Budget", r"budget|financial"),
    ("FAQ", r"\bfaq\b|questions?[-_\s]and[-_\s]answers?"),
)


def _classify_doc(url: str) -> str:
    tail = url.rsplit("/", 1)[-1].lower()
    for label, pattern in _DOC_TYPE:
        if re.search(pattern, tail, re.I):
            return label
    return "Document"


def documents(text: Any, *, call_url: str | None = None,
              limit: int = 12) -> tuple[list[dict], list[dict]]:
    """(attachments, resource_links) from the URLs present in the call text.

    A link to a FILE is an attachment; any other link on the page is a resource.
    The call's own URL is dropped — a page linking to itself tells a reviewer
    nothing — and so is any link to a social or analytics host, which is page
    furniture rather than part of the call.
    """
    body = str(text or "")
    if not body:
        return [], []
    own = (call_url or "").strip().rstrip("/").lower()
    att: list[dict] = []
    res: list[dict] = []
    seen: set[str] = set()
    for m in _URL_RE.finditer(body):
        url = m.group(0).rstrip(".,;:)”\"'")
        low = url.lower()
        if low in seen or low.rstrip("/") == own:
            continue
        if re.search(r"\b(?:twitter|x\.com|facebook|linkedin|instagram|youtube|"
                     r"google-analytics|doubleclick|googletagmanager)\b", low):
            continue
        seen.add(low)
        item = {"url": url, "label": _classify_doc(url) if _DOC_EXT_RE.search(low)
                else url.rsplit("/", 1)[-1][:80] or url}
        if _DOC_EXT_RE.search(low):
            item["doc_type"] = _classify_doc(url)
            if len(att) < limit:
                att.append(item)
        elif len(res) < limit:
            res.append(item)
    return att, res


# ---------------------------------------------------------------------------
# co-financing, read off the call
# ---------------------------------------------------------------------------
#: `criteria_derive._COST_SHARE_RE` is `cost-share required: <value>` — a KEY=VALUE
#: shape that only ever appears in the Excel-migrated `notes` column. It cannot
#: match a call that states the requirement in prose, which is every scanned call,
#: so the call half of MUST-5 has been blind on auto-scanned rows.
_COFIN_REQUIRED_RE = re.compile(
    r"\b(?:co[-\s]?financ\w+|co[-\s]?funding|cost[-\s]?shar\w+|matching (?:funds?|contribution)|"
    r"counterpart (?:funding|contribution)|own contribution|matched funding)\b"
    r"[^.]{0,80}?\b(?:is |are |will be )?(?:required|mandatory|expected|obligatory|"
    r"a (?:condition|requirement)|must be (?:provided|secured|demonstrated))\b"
    r"|\bapplicants? (?:must|are required to|shall)\b[^.]{0,80}?"
    r"\b(?:co[-\s]?financ\w+|co[-\s]?fund\w+|cost[-\s]?shar\w+|match\w*\s+(?:the|a|this)?\s*"
    r"(?:funding|grant|contribution)|provide (?:a |their )?(?:own )?contribution)\b"
    r"|\bminimum\s+(?:co[-\s]?financ\w+|cost[-\s]?shar\w+|matching)[^.]{0,30}?\d{1,3}\s?%"
    r"|\b\d{1,3}\s?%\s+(?:co[-\s]?financ\w+|cost[-\s]?shar\w+|matching|counterpart)\b", re.I)

_COFIN_NOT_REQUIRED_RE = re.compile(
    r"\bno\s+(?:co[-\s]?financ\w+|co[-\s]?funding|cost[-\s]?shar\w+|matching (?:funds?|contribution)|"
    r"counterpart (?:funding|contribution)|own contribution)\b"
    r"|\b(?:co[-\s]?financ\w+|cost[-\s]?shar\w+|matching funds?)\b[^.]{0,40}?"
    r"\b(?:is |are )?not (?:required|mandatory|expected|a requirement)\b"
    r"|\b(?:100|full)\s?%?\s+(?:of )?(?:the )?(?:project )?costs? (?:are|is|will be) "
    r"(?:covered|funded|met)\b", re.I)


def cost_share_required(text: Any) -> bool | None:
    """Does the CALL itself require co-financing? True / False / None (not stated).

    None is the important return and the common one: it means the call is silent,
    which is a different answer from "no". MUST-5 treats a silent call and an
    explicit "not required" the same way — the component drops out of the
    denominator rather than scoring zero — but a reviewer reading the record
    should be able to tell which it was.

    "Not required" is checked FIRST because a call that says so almost always
    uses the word co-financing to say it, and the requirement patterns would
    otherwise match the denial.
    """
    body = _norm(text)
    if not body:
        return None
    if _COFIN_NOT_REQUIRED_RE.search(body):
        return False
    if _COFIN_REQUIRED_RE.search(body):
        return True
    return None


def call_compliance_flags(text: Any) -> dict[str, bool]:
    """The requirements THIS CALL states, in the bare-key vocabulary MUST-1/MUST-5
    already read (`criteria_derive._eff_column` prefixes them with `donor_`).

    Today the only writer of `rfp_submissions.call_compliance_flags` is the LLM
    synthesis (`core/scan_pipeline.py:972`), so when no model answers, the call
    half of MUST-5 is blind and every requirement falls back to whatever the donor
    record happens to say. `criteria_derive._cost_share_required` does not cover
    it either: its pattern is `cost-share required: <value>`, a key=value shape
    that only ever appears in Excel-migrated `notes`, never in a scanned call's
    prose.

    A SILENT call yields NO KEY, which is not the same as False. `_merge_rfp_
    compliance` treats them differently and must: a missing key leaves the donor
    record standing, while False actively CLEARS a donor record claiming the
    requirement applies. Only an explicit "no co-financing is required" earns
    that.
    """
    out: dict[str, bool] = {}
    cofin = cost_share_required(text)
    if cofin is not None:
        out["cofinancing_required"] = cofin
    return out


# ---------------------------------------------------------------------------
# the orchestrator
# ---------------------------------------------------------------------------
#: Fields `derive_fields` can produce. Named so a caller (and a test) can assert
#: over the set rather than tracking the function list by hand.
DERIVED_FIELDS: tuple[str, ...] = (
    "call_award_floor", "call_award_ceiling", "total_program_funding",
    "expected_awards", "expected_award_date", "time_to_award", "project_duration",
    "eligibility_applicant_types", "eligibility_countries", "what_is_not_funded",
    "attachments", "resource_links", "submission_format", "call_domain_areas",
    "focus_themes", "instrument_type", "solicitation_type",
)


def _blank(v: Any) -> bool:
    if v is None:
        return True
    if isinstance(v, (list, tuple, dict)):
        return len(v) == 0
    return str(v).strip() in ("", "[]", "{}")


# ---------------------------------------------------------------------------
# is the fact even there?  (the evidence behind a removal proposal)
# ---------------------------------------------------------------------------
# The owner's rule: "where a data point is found to be CONSISTENTLY UNAVAILABLE
# across sources, propose removing it from the schema instead of continuing to
# extract it. Measure before proposing."
#
# A field sitting at 0% can mean two opposite things, and they call for opposite
# responses: the funders do not publish the fact (remove the field), or we do not
# read it (fix the extractor). Fill rate alone cannot tell them apart, which is
# why these exist.
#
# Each cue is DELIBERATELY LOOSER than the extraction pattern above — it asks
# only "does this page talk about the thing at all", with no attempt to read a
# value. So a row where the cue fires and the field is blank is OUR gap, and a
# row where the cue never fires is a fact the funder did not publish. Used by
# `scripts/measure_extraction_coverage.py --availability`.
AVAILABILITY_CUES: dict[str, str] = {
    "call_award_floor": r"\bbetween\s+\S{0,12}\d|\brang(?:e|ing) from\b|\bminimum (?:award|grant|request)\b",
    "call_award_ceiling": r"\bup to\b[^.]{0,30}\d|\bmaximum (?:award|grant|request|of)\b|\bno more than\b[^.]{0,20}\d",
    "total_program_funding": r"\btotal\b[^.]{0,30}(?:budget|funding|envelope|available)|"
                             r"\boverall budget\b|\bindicative budget\b|\bfunding envelope\b",
    "expected_awards": r"\b(?:number of (?:awards|grants)|expects? to fund|anticipates? funding|"
                       r"up to \w+ (?:awards|grants|projects)|awards? will be made)\b",
    "expected_award_date": r"\b(?:notification|notified|announced?|announcement|results?|decisions?)\b"
                           r"[^.]{0,60}\b(?:20\d{2}|january|february|march|april|may|june|july|"
                           r"august|september|october|november|december)\b",
    "project_duration": r"\b(?:duration|period of|months?|years?)\b",
    "eligibility_countries": r"\beligib\w+ (?:countr|applicant)|\bcountries\b|\bopen to\b",
    "eligibility_applicant_types": r"\beligib\w+|\bwho (?:can|may) apply\b|\bopen to\b",
    "what_is_not_funded": r"\bnot eligible\b|\bineligible\b|\bexclu\w+\b|\bout of scope\b|"
                          r"\bwill not (?:be )?(?:fund|support)\w*",
    "submission_format": r"\b(?:submit|submission|apply|application)\b",
    "attachments": r"\.(?:pdf|docx?|xlsx?)\b",
    "resource_links": r"https?://",
    "funding_tiers": r"\b(?:tier|stage|phase)\s*\d|\bproof of concept\b|\btransition to scale\b",
    "apply_url": r"\b(?:apply (?:here|now|online)|application (?:portal|form|link))\b",
    "agency_code": r"\b(?:agency code|CFDA|assistance listing)\b",
    "grantmaking_entity": r"\b(?:administered|managed|implemented) (?:by|on behalf of)\b",
}


def fact_is_published(field: str, text: Any) -> bool | None:
    """Does the source text even mention this field's subject?

    True / False, or None when the field has no cue defined (so the caller can
    report "not measured" rather than counting it as absent).
    """
    cue = AVAILABILITY_CUES.get(field)
    if not cue:
        return None
    body = _norm(text)
    return bool(body) and bool(re.search(cue, body, re.I))


def derive_fields(row: dict[str, Any], *, text: str | None = None) -> dict[str, Any]:
    """Every `DERIVED_FIELDS` value this row is MISSING and the text supports.

    Fills blanks only. A value already on the row — read by a source handler,
    answered by a model, or corrected by a person — is never touched, which is
    what makes this safe to run repeatedly over the live catalogue.

    `text` defaults to the row's own stored source text. The caller may pass a
    fuller read (a deep-read page, a guidance PDF) when it has one.
    """
    body = text if text is not None else (row.get("raw_text")
                                          or row.get("_page_text")
                                          or row.get("brief_description") or "")
    body = str(body or "")
    title = str(row.get("opportunity_name") or row.get("opportunity_title") or "")
    out: dict[str, Any] = {}

    # QUOTED EVIDENCE, not just a value. `field_provenance` is an existing column
    # (`core/extract.py` writes method/confidence/source_tier into it), and the
    # fields below are the ones a reviewer is most likely to query — "where does
    # 36 months come from?". Carrying the phrase that produced the number makes
    # that answerable from the row, and makes a bad pattern findable in bulk
    # instead of one surprised reviewer at a time.
    evidence: dict[str, str] = {}

    def _set(field: str, value: Any, quote: str = "") -> None:
        if not _blank(value) and _blank(row.get(field)) and field not in out:
            out[field] = value
            if quote:
                evidence[field] = quote[:300]

    if not body.strip():
        return out

    floor, ceiling, money_ev = find_award_bounds(body)
    _set("call_award_floor", floor, money_ev)
    _set("call_award_ceiling", ceiling, money_ev)
    _set("total_program_funding", *find_total_program_funding(body))
    _set("expected_awards", *find_expected_awards(body))

    # The deadline is a validity check on the award date — see
    # `find_expected_award_date`. Both column spellings are tried because this
    # runs over the catalogue (`deadline`) and the pipeline
    # (`call_submission_deadline`) alike.
    _deadline = row.get("deadline") or row.get("call_submission_deadline")
    award_on, award_ev = find_expected_award_date(
        body, deadline=_deadline, not_before=row.get("date_posted"))
    _set("expected_award_date", award_on, award_ev)
    # `time_to_award` needs both ends. Use whichever award date the row will END UP
    # with — the one just read, or one already stored — so a row that already had
    # the date still gains the span.
    _set("time_to_award", time_to_award(_deadline,
                                        award_on or row.get("expected_award_date")))
    _set("project_duration", *find_project_duration(body))
    _set("eligibility_applicant_types", eligibility_applicant_types(body))
    _set("what_is_not_funded", what_is_not_funded(body))

    # Reuse rather than re-derive: these readers already exist and are already the
    # repo's answer to each question. What was missing is that every one of them
    # sat behind a successful model call.
    try:
        from core.eligible_countries import extract as _countries
        found, _label = _countries(body)
        _set("eligibility_countries", found or None)
    except Exception as exc:
        log.debug("field_extract: country read skipped: %s", exc)

    try:
        from core.catalog_synthesis import extract_submission_format
        _set("submission_format", extract_submission_format(body))
    except Exception as exc:
        log.debug("field_extract: submission format skipped: %s", exc)

    try:
        from core import program_area_classifier as _pac
        areas = _pac.classify_program_areas(f"{title}\n{body}")
        # "Unspecified Program Area" is the classifier's way of saying it could
        # not tell, and it must not be STORED. A column holding it reads as
        # populated to every blank test in the codebase — including
        # `opportunity_detail.coverage`, whose placeholder list does not know the
        # phrase — so writing it would have raised the coverage number by a few
        # points while telling a reviewer precisely nothing. A blank is the honest
        # answer and is what the classifier actually said.
        areas = [a for a in (areas or []) if a and not a.startswith(_pac.UNSPECIFIED)]
        _set("call_domain_areas", areas or None)
        # `focus_themes` is the broader CATEGORY behind those areas — the sector a
        # reviewer filters by — so it is derived from the same classification
        # rather than given a second vocabulary of its own.
        themes: list[str] = []
        for key in areas or []:
            cat = _pac.category_full(key)
            if cat and cat != _pac.UNSPECIFIED and cat not in themes:
                themes.append(cat)
        _set("focus_themes", themes or None)
    except Exception as exc:
        log.debug("field_extract: programme areas skipped: %s", exc)

    try:
        from core import type_detect
        cand = {"opportunity_title": title, "brief_description": body,
                "opportunity_link": row.get("opportunity_url")
                or row.get("opportunity_link") or ""}
        _set("solicitation_type", type_detect.detect_solicitation(cand))
        _set("instrument_type", type_detect.detect_instrument(cand))
    except Exception as exc:
        log.debug("field_extract: type detection skipped: %s", exc)

    att, res = documents(body, call_url=row.get("opportunity_url")
                         or row.get("opportunity_link"))
    _set("attachments", att or None)
    _set("resource_links", res or None)

    # MERGE, never replace: `field_provenance` already carries the deadline's and
    # the amount's method/confidence from `core/extract.py`, and overwriting it
    # with this pass's entries would lose them.
    if evidence:
        prov = dict(row.get("field_provenance") or {}) \
            if isinstance(row.get("field_provenance"), dict) else {}
        for field, quote in evidence.items():
            prov[field] = {"method": "regex", "confidence": "high",
                           "source_tier": "T1", "evidence": quote}
        out["field_provenance"] = prov
    return out
