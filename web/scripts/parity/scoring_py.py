"""Python half of check-scoring.mjs — the Phase 1 parity proof.

The browser runs the repo's own scoring modules, so those cannot drift. What CAN drift is
the data layer underneath them: the API builds a snapshot, and `web/python/*_stub.py` serves
it to the scoring code in place of a database. If the snapshot is missing something, or the
stand-in answers a query differently, the browser gets different rows and therefore different
answers — silently.

So this runs each surface TWICE in one interpreter:
  A — through the stand-ins, over the snapshot the API produced (what the browser does);
  B — through the real Supabase client, scoped to the tenant (what Streamlit does);
and prints both for the caller to diff.

    python scoring_py.py <artifacts_dir>

`artifacts_dir` holds snapshot.json / feed.json / opportunity-<uid>.json, written by
check-scoring.mjs from the live API. Read-only.
"""
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ART = Path(sys.argv[1])

from importlib import import_module, reload  # noqa: E402


def _reset_modules() -> None:
    """Drop every core/db/auth module so the next import binds the OTHER data layer."""
    for name in [m for m in list(sys.modules)
                 if m.split(".")[0] in ("core", "db", "auth")]:
        sys.modules.pop(name, None)


def run_browser_side(snapshot: dict, feed_req: dict, opps: list[dict]) -> dict:
    """What the browser computes: the stand-ins over the API's snapshot."""
    _reset_modules()
    # `stubs/` is unpacked from the bundle the app actually ships, so this tests the
    # shipped stand-ins rather than a copy that could drift from them.
    sys.path.insert(0, str(ART / "stubs"))
    sys.path.insert(1, str(ROOT))
    import db.supabase_client as sc
    sc.SNAPSHOT = dict(snapshot)
    sc.seed_fx()
    return _compute(sc, feed_req, opps, snapshot["today"])


def run_app_side(snapshot: dict, feed_req: dict, opps: list[dict]) -> dict:
    """What Streamlit computes: the real client, scoped to the tenant."""
    _reset_modules()
    sys.path = [p for p in sys.path if "stubs" not in p]
    sys.path.insert(0, str(ROOT))
    from core.dotenv_compat import load_dotenv
    load_dotenv(ROOT / ".env")
    from auth import tenant_context as tc
    tc.set_tenant_override(snapshot["tenant_id"])
    import db.supabase_client as sc
    return _compute(sc, feed_req, opps, snapshot["today"])


def _compute(sc, feed_req: dict, opps: list[dict], today_str: str) -> dict:
    """The two calls the worker makes, run against whichever data layer is loaded."""
    from core import opportunity_detail as od
    from core import opportunity_feed as of
    from core import opportunity_scoring as osc
    from core.auto_scorer import geographic_exclusion_reject as geo_rej
    from core.policies import get_policies

    today = datetime.strptime(today_str[:10], "%Y-%m-%d").date()
    pol = get_policies()

    # The rail. _tenant_prefs reads rfp_submissions through get_client(), so give the
    # stand-in the same rows the browser would have.
    if hasattr(sc, "SNAPSHOT"):
        sc.SNAPSHOT["rfp_submissions"] = feed_req["pipeline"]
        sc.SNAPSHOT["extracted_solicitations"] = feed_req["catalog"]
    groups = of.classify(feed_req["pipeline"], today=today,
                         geo_reject=lambda r: geo_rej(r, pol)[0])
    prefs = _prefs(sc)
    featured = of.featured(feed_req["catalog"], prefs,
                           seen_keys=set(feed_req["seen"]), today=today)

    out = {"feed": {"featured": featured, **groups}, "prefs": prefs, "opportunities": {}}
    for payload in opps:
        res = od.load(payload["uid"],
                      pipeline_reader=lambda _u, p=payload: p.get("pipelineRow"),
                      catalog_reader=lambda _u, p=payload: p.get("catalogRow"),
                      catalog_by_link_reader=lambda _l, p=payload: p.get("extraction"))
        if not res["kind"]:
            out["opportunities"][payload["uid"]] = {"found": False}
            continue
        view = od.standard_view(res["kind"], res["row"], res["extraction"])
        from core import org_profile as orgp
        from core import settings as st
        scored = res["row"] if res["kind"] == od.KIND_PIPELINE else od.to_candidate(res["row"])
        donor = None
        try:
            from core.donor_intel import match_donor
            fa = str(view.get("funder_name") or "").strip()
            donor = match_donor(fa, fuzzy=False) if fa else None
        except Exception:
            donor = None
        try:
            flags = json.loads(scored.get("call_compliance_flags") or "{}")
        except Exception:
            flags = {}
        ov = scored.get("criteria_component_overrides")
        if isinstance(ov, str):
            try:
                ov = json.loads(ov or "{}")
            except Exception:
                ov = {}
        an = osc.analyse(scored, orgp.get_profile(), donor, st.get_org(),
                         rfp_compliance=flags if isinstance(flags, dict) else {},
                         overrides=ov if isinstance(ov, dict) else {})
        out["opportunities"][payload["uid"]] = {
            "found": True,
            "title": od.title_line(view)[0],
            "award": od.award_headline(view),
            "deadline": od.deadline_status(view.get("deadline"), view.get("funding_status")),
            "pageRows": od.page_rows(view),
            "narrative": od.narrative_sections(view),
            "bid_strength": an["bid_strength"],
            "suggested": an["suggested_decision"],
            "system": an["system_decision"],
            "confidence": an["confidence"],
            "labels": an["labels"],
            "points": [round(c["points"], 4) for c in an["criteria"]],
            "screened_out": an["screened_out"],
            "screen_reason": an["screen_reason"],
        }
    return out


def _prefs(sc) -> dict:
    """views/opportunity_rail._tenant_prefs, against whichever client is loaded."""
    from db.supabase_client import get_client
    prefs = {}
    try:
        from core.policies import get_policies
        pol = get_policies() or {}
        countries = (pol.get("countries") or {})
        prefs["countries"] = countries.get("eligible") or []
        prefs["broad_terms"] = countries.get("broad_terms") or []
        th = pol.get("themes")
        prefs["themes"] = (th.get("required_any") if isinstance(th, dict) else th) or []
    except Exception:
        pass
    try:
        from core import org_profile as orgp
        prof = orgp.get_profile() or {}
        prefs["known_funders"] = (list(prof.get("org_engaged_donors") or [])
                                  + list(prof.get("org_active_donors") or []))
    except Exception:
        prefs.setdefault("known_funders", [])
    try:
        rows = (get_client().table("rfp_submissions")
                .select("funding_agency,call_domain_areas,decision")
                .limit(800).execute().data or [])
        areas, funders = [], []
        for r in rows:
            if str(r.get("decision") or "").lower().startswith("proceed"):
                funders.append(r.get("funding_agency"))
                areas.extend(r.get("call_domain_areas") or [])
        prefs["pursued_areas"] = [a for a in areas if a]
        prefs["known_funders"] = (prefs.get("known_funders") or []) + [f for f in funders if f]
    except Exception:
        pass
    return prefs


def main() -> None:
    snapshot = json.loads((ART / "snapshot.json").read_text(encoding="utf-8"))
    feed_req = json.loads((ART / "feed.json").read_text(encoding="utf-8"))
    opps = [o for o in (json.loads(p.read_text(encoding="utf-8"))
                        for p in sorted(ART.glob("opportunity-*.json"))) if o.get("uid")]

    app = run_app_side(snapshot, feed_req, opps)
    browser = run_browser_side(snapshot, feed_req, opps)
    (ART / "result-app.json").write_text(json.dumps(app, default=str, sort_keys=True), encoding="utf-8")
    (ART / "result-browser.json").write_text(json.dumps(browser, default=str, sort_keys=True), encoding="utf-8")
    print(f"wrote both sides for {len(opps)} opportunities")


if __name__ == "__main__":
    main()
