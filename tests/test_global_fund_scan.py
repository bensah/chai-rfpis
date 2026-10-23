"""The Global Fund tenders: business page → Oracle Fusion negotiation list.

The Global Fund's Business Opportunities page lists only stale items; its "Open
tenders" button leads to a public Oracle Fusion Sourcing page (Negotiation
Abstracts) that lists every RFP/RFI. The scan starts at the business page on every
run and follows whatever the button points at, so a moved portal is followed and a
dead business page is noticed (falling back to the last known list URL).

The Oracle page is server-rendered once ADF's loopback token is echoed back, and a
row's Details popup is one form postback — both covered here with fixtures shaped
like the live markup (captured 2026-10-23).

Also covered: every tender sits on the SAME page, so the link the deduplicator sees
(query stripped) is shared. Different negotiation numbers on one page are different
calls and must not merge.

Run:  python -m unittest tests.test_global_fund_scan
"""
import os
import sys
import unittest
from datetime import date
from unittest import mock

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
os.environ.setdefault("SUPABASE_URL", "https://dummy.supabase.co")
os.environ.setdefault("SUPABASE_KEY", "sb_secret_dummy")

from core import deduplicator as D                                    # noqa: E402
from core import scraper as S                                         # noqa: E402

ORACLE = ("https://fa-enmo-saasfaprod1.fa.ocs.oraclecloud.com/fscmUI/faces/"
          "NegotiationAbstracts?prcBuId=300000003071579")

BUSINESS_HTML = f"""<html><body>
<a href="/en/sourcing-management/">Sourcing &amp; Management of Health Products</a>
<a href="{ORACLE}&amp;_adf.ctrl-state=dr9zqv7ou_1&amp;_afrLoop=9450745077996282&amp;_afrWindowMode=0&amp;_afrWindowId=null&amp;_afrFS=16&amp;_afrMFO=0" class="button primary">View Open Tenders</a>
</body></html>"""

LOOPBACK_HTML = """<html><script>
var extraParams = {'_adf.ctrl-state':'dvrxcte965oyuy_1'};
query = _addParam(query, "_afrLoop", "8472467325697372");
</script></html>"""


def _row(rk, neg, title, status, posted, close):
    cells = "".join(f'<td class="xen"><span>{c}</span></td>'
                    for c in (neg, title, "RFP", status, posted, posted, close))
    link = (f'<td><a id="pt1:r1:0:pt1:AP1:AT1:_ATp:resId1:{rk}:commandLink1" href="#">'
            f'<img alt="Details"></a></td>')
    return f'<tr _afrrk="{rk}" class="xem">{cells}{link}</tr>'


LIST_HTML = ("""<html><body><form id="f1" action="/fscmUI/faces/NegotiationAbstracts?_adf.ctrl-state=abc_5&amp;prcBuId=300000003071579">
<input type="hidden" name="org.apache.myfaces.trinidad.faces.FORM" value="f1">
<input type="hidden" name="javax.faces.ViewState" value="!vs1">
<table>"""
    + _row(0, "TGF-99-43", "Advocacy and political mobilization", "Active",
           "22/Oct/2099 6:53 PM", "13/Nov/2099 5:00 PM")
    + _row(1, "TGF-99-34,2", "CRG Regional Learning Hubs", "Active",
           "03/Sep/2099 4:45 PM", "27/Sep/2099 5:00 PM")
    + _row(2, "TGF-99-34,1", "CRG Regional Learning Hubs", "Amended",
           "02/Sep/2099 11:13 AM", "21/Sep/2099 5:00 PM")
    + _row(3, "TGF-99-34", "CRG Regional Learning Hubs", "Amended",
           "31/Aug/2099 3:07 PM", "21/Sep/2099 5:00 PM")
    + _row(4, "TGF-99-27-2", "Site Infrastructure Design and Construction for the Installa",
           "Active", "03/Aug/2099 1:41 PM", "03/Aug/2099 1:51 PM")
    + _row(5, "TGF-99-27", "Site Infrastructure Design and Construction for the Installa",
           "Amended", "01/Jul/2099 11:36 AM", "24/Jul/2099 5:00 PM")
    + _row(6, "TGF-99-39", "Procurement of a Community Projects Partner", "Closed",
           "04/Sep/2099 7:41 PM", "27/Sep/2099 5:00 PM")
    + _row(7, "TGF-20-01", "Stale but still marked active", "Active",
           "01/Jan/2020 9:00 AM", "01/Feb/2020 5:00 PM")
    + "</table></form></body></html>")


def _detail_xml(neg, title, synopsis):
    frag = (f"<div><div>Abstract: RFP {neg}</div>"
            f"<div>Title</div><div>{title}</div>"
            "<div>Negotiation Type</div><div>RFP</div>"
            "<div>Status</div><div>Active</div>"
            "<div>Buyer</div><div>VAN RIJSWIJK, Ms. Manon Saskia</div>"
            "<div>Email</div><div>Manon.VanRijswijk@theglobalfund.org</div>"
            f"<div>Synopsis</div><div>{synopsis}</div>"
            f"<div>Attachments</div><div>{neg} RFP Document.pdf</div><div>(379.79 KB)</div>"
            "<div>Open Date</div><div>22/Oct/2099 6:53 PM</div>"
            "<div>Close Date</div><div>13/Nov/2099 5:00 PM</div>"
            "<div>Posting Date</div><div>22/Oct/2099</div>"
            "<div>O</div><div>K</div><div>Search</div><div>Title</div><div>noise</div></div>")
    return ('<?xml version="1.0" ?><content><fragment><![CDATA[' + frag + ']]></fragment>'
            '<fragment><![CDATA[<input type="hidden" name="javax.faces.ViewState" '
            'value="!vs2">]]></fragment></content>')


DETAILS = {
    "0": ("TGF-99-43", "Advocacy and political mobilization efforts in Australia",
          "Promoting engagement with Australian policymakers."),
    "1": ("TGF-99-34,2", "CRG Regional Learning Hubs (Evidence and Learning)",
          "Regional hubs for community, rights and gender learning."),
    "4": ("TGF-99-27-2", "Site Infrastructure Design and Construction for the "
          "Installation of High-Temperature Incinerators", "Design and build."),
}


class _Resp:
    def __init__(self, text, url=""):
        self.text, self.url, self.status_code = text, url, 200
        self.encoding = "utf-8"

    def raise_for_status(self):
        pass


class _FakeOracle:
    """Stands in for requests.Session against the Oracle page."""
    def __init__(self):
        self.headers, self.gets, self.posts = {}, [], []

    def get(self, url, **kw):
        self.gets.append(url)
        return _Resp(LIST_HTML if "_afrLoop=" in url else LOOPBACK_HTML, url)

    def post(self, url, data=None, **kw):
        self.posts.append((url, data))
        rk = data["event"].split(":resId1:", 1)[1].split(":", 1)[0]
        return _Resp(_detail_xml(*DETAILS[rk]), url)


def _scan(fake=None, business=BUSINESS_HTML):
    fake = fake or _FakeOracle()
    with mock.patch.object(S._http, "get", return_value=_Resp(business)), \
            mock.patch.object(S.requests, "Session", return_value=fake):
        rows = S.scan_source({"name": "The Global Fund", "method": "html",
                              "url": S._GF_BUSINESS_PAGE})
    return rows, fake


class FollowsTheBusinessPageTests(unittest.TestCase):
    def test_the_open_tenders_link_is_read_from_the_business_page(self):
        with mock.patch.object(S._http, "get", return_value=_Resp(BUSINESS_HTML)):
            self.assertEqual(S._gf_tenders_url(), ORACLE)       # ADF session noise gone

    def test_a_moved_portal_is_followed(self):
        moved = BUSINESS_HTML.replace("fa-enmo-saasfaprod1", "fa-newpod-saasfaprod2")
        with mock.patch.object(S._http, "get", return_value=_Resp(moved)):
            self.assertIn("fa-newpod-saasfaprod2", S._gf_tenders_url())

    def test_a_dead_business_page_falls_back_to_the_last_known_list(self):
        with mock.patch.object(S._http, "get", side_effect=OSError("down")):
            self.assertEqual(S._gf_tenders_url(), S._GF_TENDERS_FALLBACK)

    def test_a_business_page_without_the_link_falls_back(self):
        with mock.patch.object(S._http, "get", return_value=_Resp("<a href='/x'>Home</a>")):
            self.assertEqual(S._gf_tenders_url(), S._GF_TENDERS_FALLBACK)


class ReadsTheNegotiationListTests(unittest.TestCase):
    def test_the_adf_loopback_token_is_echoed_back(self):
        _, fake = _scan()
        self.assertEqual(fake.gets[0], ORACLE)
        self.assertIn("_afrLoop=8472467325697372", fake.gets[1])
        self.assertIn("_adf.ctrl-state=dvrxcte965oyuy_1", fake.gets[1])

    def test_open_tenders_only_with_amendments_collapsed_to_the_latest(self):
        rows, _ = _scan()
        self.assertEqual([r["opportunity_id"] for r in rows],
                         ["TGF-99-43", "TGF-99-34,2", "TGF-99-27-2"])

    def test_the_details_popup_fills_title_synopsis_and_buyer(self):
        rows, fake = _scan()
        hub = next(r for r in rows if r["opportunity_id"] == "TGF-99-34,2")
        self.assertEqual(hub["opportunity_title"],
                         "CRG Regional Learning Hubs (Evidence and Learning)")
        self.assertEqual(hub["brief_description"],
                         "Regional hubs for community, rights and gender learning.")
        self.assertEqual(hub["_contacts"][0]["email"], "Manon.VanRijswijk@theglobalfund.org")
        self.assertIn("TGF-99-34,2 RFP Document.pdf", hub["_page_text"])
        self.assertNotIn("379.79 KB", hub["_page_text"])
        # The truncated list title is replaced by the full one from the popup.
        site = next(r for r in rows if r["opportunity_id"] == "TGF-99-27-2")
        self.assertTrue(site["opportunity_title"].endswith("High-Temperature Incinerators"))
        # The postback carried the page's ViewState, then the refreshed one.
        self.assertEqual(fake.posts[0][1]["javax.faces.ViewState"], "!vs1")
        self.assertEqual(fake.posts[1][1]["javax.faces.ViewState"], "!vs2")

    def test_dates_funder_and_a_distinct_link_per_tender(self):
        rows, _ = _scan()
        first = rows[0]
        self.assertEqual(first["funding_agency"], "The Global Fund")
        self.assertEqual(first["date_posted"], date(2099, 10, 22))
        self.assertEqual(first["call_submission_deadline"], date(2099, 11, 13))
        self.assertEqual(first["solicitation_type"], "RFP")
        self.assertEqual(first["opportunity_link"], f"{ORACLE}&negotiation=TGF-99-43")
        self.assertEqual(len({r["opportunity_link"] for r in rows}), len(rows))

    def test_an_unreadable_list_returns_nothing_rather_than_raising(self):
        fake = _FakeOracle()
        fake.get = lambda url, **kw: _Resp("<html>maintenance</html>", url)
        rows, _ = _scan(fake)
        self.assertEqual(rows, [])


class SharedListingLinkDedupTests(unittest.TestCase):
    def _r(self, uid, oid, title):
        return {"uid": uid, "opportunity_id": oid, "opportunity_title": title,
                "opportunity_link": f"{ORACLE}&negotiation={oid}",
                "funding_agency": "The Global Fund", "call_submission_deadline": None,
                "call_award_value": None}

    def test_different_negotiations_on_one_page_are_different_calls(self):
        hiv = self._r("a", "TGF-26-37", "HIV - Long-term Support for Community Engagement")
        tb = self._r("b", "TGF-26-38", "TB - Long-term Support for Community Engagement")
        self.assertEqual(D.find_duplicates(hiv, [tb]), [])

    def test_the_same_negotiation_still_matches(self):
        a = self._r("a", "TGF-26-37", "HIV - Long-term Support")
        b = self._r("b", "TGF-26-37", "HIV - Long-term Support")
        self.assertEqual(len(D.find_duplicates(a, [b])), 1)

    def test_an_identical_link_without_ids_is_still_dispositive(self):
        a = {**self._r("a", None, "One call"), "opportunity_link": "https://x.org/call/1"}
        b = {**self._r("b", None, "Another title"), "opportunity_link": "https://x.org/call/1"}
        self.assertEqual(D.find_duplicates(a, [b])[0]["_reason"], "identical link")


if __name__ == "__main__":
    unittest.main()
