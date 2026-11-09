/**
 * The scoring engine, in a Web Worker.
 *
 * The decision aid is several thousand lines of Python that every RFPIS surface depends on
 * agreeing about. Rather than re-implement that in TypeScript and let the two drift, this
 * runs the repo's OWN `core/` modules under Pyodide: the code that scores here is the code
 * that scores in Streamlit, and `web/scripts/parity/check-scoring.mjs` keeps proving it.
 *
 * The opportunity rail used to be served from here too. It is ranked by the server now —
 * measured to need no scoring at all, only an ordering of values already on the row — so
 * this runtime is downloaded only when someone opens an opportunity.
 *
 * Only the data layer differs. `web/python/*_stub.py` replaces `db/supabase_client.py` and
 * `auth/tenant_context.py` with stand-ins that serve a snapshot the API has already fetched
 * (RLS applied, permissions checked). No scoring module is touched.
 *
 * It lives in a worker because booting costs a few seconds and the first score a few more —
 * once per tab. Pages render from stored values immediately and ask for the live numbers
 * afterwards, so nothing ever blocks on this.
 */
/// <reference lib="webworker" />
import type {
  OpportunityRequest, ScoringSnapshot, WorkerRequest, WorkerResponse,
} from "./protocol";

// Pinned: the engine must not change under us between deploys.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";

type Py = {
  loadPackage: (names: string[]) => Promise<void>;
  runPythonAsync: (code: string) => Promise<unknown>;
  globals: { set: (k: string, v: unknown) => void };
  FS: { mkdirTree: (p: string) => void; writeFile: (p: string, data: string) => void };
};

let py: Py | null = null;
let booting: Promise<void> | null = null;

const post = (m: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const progress = (s: string) => post({ id: 0, progress: s });

/** The bridge between the worker's JSON and the repo's Python. Deliberately thin: every
 * decision it makes is a call into `core/`, never a rule of its own. */
const SHIM = `
import json
from datetime import date, datetime

import db.supabase_client as _sc


def _today():
    """The SERVER's date, from the snapshot. A browser in another timezone must not
    classify a deadline differently from the Streamlit app."""
    try:
        return datetime.strptime(str(_sc.SNAPSHOT.get("today"))[:10], "%Y-%m-%d").date()
    except Exception:
        return date.today()


def _for_web(a):
    """core.opportunity_scoring.analyse, with its keys renamed for the TypeScript page.

    A RENAME AND NOTHING ELSE. Every value is passed through untouched — no rounding, no
    defaulting, no derived field — because the moment this computes anything it becomes a
    second implementation of the scoring rules, which is the drift the whole migration
    exists to end. The names it drops -- composite, labels, blockers, unscored -- are all
    recoverable from the criteria list, which is carried whole.
    """
    if not isinstance(a, dict) or a.get("error"):
        return a
    c = a.get("confidence") or {}
    return {
        "bidStrength": a.get("bid_strength"),
        "fit": a.get("fit"),
        "systemDecision": a.get("system_decision"),
        "suggestedDecision": a.get("suggested_decision"),
        "confidenceNote": a.get("confidence_note") or "",
        "fatal": bool(a.get("fatal")),
        "fatalTrigger": a.get("fatal_trigger") or "",
        "belowAwardFloor": bool(a.get("below_award_floor")),
        "screenedOut": bool(a.get("screened_out")),
        "screenReason": a.get("screen_reason") or "",
        "confidence": {
            "band": c.get("band") or "", "pct": c.get("pct"),
            "callPct": c.get("call_pct"), "donorPct": c.get("donor_pct"),
            "donorMatched": bool(c.get("donor_matched")),
        },
        "criteria": [{
            "key": x.get("key"), "title": x.get("title"), "label": x.get("label"),
            "band": x.get("band"), "countText": x.get("count_text") or "",
            "scored": bool(x.get("scored")), "weight": x.get("weight"),
            "points": x.get("points"),
        } for x in (a.get("criteria") or [])],
    }


def opportunity(payload):
    """app_pages/opportunity.py: resolve the uid, lay the call out in the standard format,
    and score it against this tenant."""
    from core import opportunity_detail as _od
    from core import opportunity_scoring as _osc

    uid = payload["uid"]
    res = _od.load(
        uid,
        pipeline_reader=lambda _u: payload.get("pipelineRow"),
        catalog_reader=lambda _u: payload.get("catalogRow"),
        catalog_by_link_reader=lambda _l: payload.get("extraction"),
    )
    kind, row, ext = res["kind"], res["row"], res["extraction"]
    if not kind:
        return {"found": False, "kind": None}

    view = _od.standard_view(kind, row, ext)
    title, sol = _od.title_line(view)
    dl_txt, dl_tone = _od.deadline_status(view.get("deadline"), view.get("funding_status"))

    chips = [{"text": dl_txt, "tone": dl_tone}]
    if sol:
        chips.append({"text": sol, "tone": ""})
    for f in ("instrument_type", "funding_window"):
        if view.get(f):
            chips.append({"text": _od.display_value(view[f]), "tone": ""})
    decision = _od.pipeline_decision(kind, row)
    if decision:
        tone = {"Proceed": "open", "Park": "soon", "Decline": "closed"}[decision]
        chips.append({"text": "In your pipeline \\u00b7 " + decision, "tone": tone})
    elif kind == _od.KIND_PIPELINE:
        chips.append({"text": "Screened \\u2014 not in a pipeline yet", "tone": ""})
    else:
        chips.append({"text": "Shared catalogue \\u2014 not screened for you", "tone": ""})

    # The decision aid. A catalogue call has no screened row, so score the candidate built
    # from its extraction: same derivation, so the two paths cannot disagree.
    #
    # _for_web only RENAMES — it computes nothing. analyse() speaks snake_case and the
    # page is TypeScript; the alternative was a TS type full of snake_case keys, or the
    # page reading a Record<string, unknown> and casting every field, which is what it did
    # while protocol.ts still described a shape (name/tone/caption) the Python had stopped
    # returning. Renaming here keeps one declaration that is true.
    analysis = None
    try:
        from core import org_profile as _orgp
        from core import settings as _settings
        scored = row if kind == _od.KIND_PIPELINE else _od.to_candidate(row)
        donor = None
        try:
            from core.donor_intel import match_donor
            fa = str(view.get("funder_name") or "").strip()
            if fa:
                donor = match_donor(fa, fuzzy=False)
        except Exception:
            donor = None
        try:
            flags = json.loads(scored.get("call_compliance_flags") or "{}")
            flags = flags if isinstance(flags, dict) else {}
        except Exception:
            flags = {}
        ov = scored.get("criteria_component_overrides")
        if isinstance(ov, str):
            try:
                ov = json.loads(ov or "{}")
            except Exception:
                ov = {}
        analysis = _for_web(_osc.analyse(
            scored, _orgp.get_profile(), donor, _settings.get_org(),
            rfp_compliance=flags, overrides=ov if isinstance(ov, dict) else {}))
    except Exception as exc:
        analysis = {"error": str(exc)}

    out = {
        "found": True,
        "kind": "pipeline" if kind == _od.KIND_PIPELINE else "catalog",
        "title": title,
        "chips": chips,
        "funder": _od.display_value(view.get("funder_name")),
        "reference": _od.display_value(view.get("call_reference")) if view.get("call_reference") else "",
        "awardHeadline": _od.award_headline(view),
        "overview": _od.overview_blocks(view),
        "overviewTruncated": _od.overview_is_truncated(view),
        "pageRows": _od.page_rows(view),
        # NOT narrative_sections. page_rows + overview_blocks already place every
        # NARRATIVE_FIELD (INLINE_PROSE, PROSE_ROWS, OVERVIEW_FIELDS), so sending it too
        # rendered all five of them a second time under their own headings.
        # app_pages/opportunity.py renders overview_text + page_rows and stops.
        "coverage": dict(zip(("filled", "total"), _od.coverage(view)[:2])),
        "analysis": analysis,
        "orgName": (_sc.SNAPSHOT.get("org_identity") or {}).get("name") or "",
        "link": view.get("opportunity_link") or view.get("opportunity_url") or "",
    }
    if payload.get("isSuper"):
        filled, total, missing = _od.coverage(view)
        out["provenance"] = {"sections": _od.technical_sections(view),
                             "filled": filled, "total": total, "missing": missing,
                             "as_published": _od.as_published(view)}
    return out


def dispatch(kind, payload_json):
    payload = json.loads(payload_json)
    fn = {"opportunity": opportunity}[kind]
    return json.dumps(fn(payload), default=str)
`;

async function boot(bundleUrl: string, snapshot: ScoringSnapshot): Promise<void> {
  progress("Loading the scoring engine…");
  // Loaded at runtime from the CDN (no package, so no types).
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`) as
    { loadPyodide: (o: { indexURL: string }) => Promise<unknown> };
  const p = (await loadPyodide({ indexURL: PYODIDE })) as Py;

  progress("Loading Python packages…");
  await p.loadPackage(["pyyaml", "pandas"]);

  progress("Loading the scoring rules…");
  const files = (await (await fetch(bundleUrl)).json()) as Record<string, string>;
  for (const [rel, src] of Object.entries(files)) {
    const dir = rel.split("/").slice(0, -1).join("/");
    if (dir) p.FS.mkdirTree(`/app/${dir}`);
    p.FS.writeFile(`/app/${rel}`, src);
  }

  progress("Starting…");
  p.globals.set("snapshot_json", JSON.stringify(snapshot));
  await p.runPythonAsync(`
import sys, json
sys.path.insert(0, "/app")
import db.supabase_client as _sc
_sc.SNAPSHOT = json.loads(snapshot_json)
_sc.seed_fx()
${SHIM}
`);
  py = p;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const started = performance.now();
  try {
    if (msg.kind === "boot") {
      booting ??= boot(msg.bundleUrl, msg.snapshot);
      await booting;
      post({ id: msg.id, ok: true, result: null, ms: performance.now() - started });
      return;
    }
    if (!py) {
      if (!booting) throw new Error("The scoring engine has not been started.");
      await booting;
    }
    const payload: OpportunityRequest = msg.payload;
    py!.globals.set("payload_json", JSON.stringify(payload));
    py!.globals.set("call_kind", msg.kind);
    const out = (await py!.runPythonAsync("dispatch(call_kind, payload_json)")) as string;
    post({ id: msg.id, ok: true, result: JSON.parse(out), ms: performance.now() - started });
  } catch (err) {
    post({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
