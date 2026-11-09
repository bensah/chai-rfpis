// The Pipeline's write rules, driven directly rather than through HTTP and a session.
//
//   node --test scripts/pipeline-writes.test.mjs        (from web/)
//
// These are the rules that lose data quietly when they are wrong: a mistyped column that
// saves nothing, an empty grant row created on every save, and a completed row with no
// funder decision that nobody is told about.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const W = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/pipeline_writes.ts")).href);
// The shared donor-decision rules, and the read side that now depends on them. Imported
// directly because the thing worth asserting is that ONE function decides whether a
// proposal has gone to the funder — the write route's warning and the stage a row lands
// on both hang off it.
const D = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/donor_decision.ts")).href);
const P = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/routes_pipelines.ts")).href);
// The money rules the Outcome stage adds up with, and the FX normaliser they look rates
// up through. Both are ports of Python the Streamlit Funding page uses, so the tests below
// pin them to that behaviour and to config/dropdowns.yaml.
const M = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/money.ts")).href);
const F = await import(pathToFileURL(
  path.join(root, "supabase/functions/_shared/api/fx.ts")).href);

// ── core/donor_decision.py ───────────────────────────────────────────────────

test("the default counts as no answer; Under Review does not", () => {
  // The subtlety that file names: "Not submitted" is the default every row carries, not a
  // judgement anybody made. "Under Review" somebody put there deliberately.
  for (const v of ["", null, undefined, "Not submitted", "NOT SUBMITTED", " none ", "nan", "null"]) {
    assert.equal(W.isNoAnswer(v), true, `${JSON.stringify(v)} should read as no answer`);
  }
  assert.equal(W.isNoAnswer("Under Review"), false);
  assert.equal(W.isNoAnswer("Approved"), false);
});

test("Under Review is not an outcome either — it records that we are waiting", () => {
  assert.equal(W.isOutcome("Under Review"), false);
  assert.equal(W.isOutcome("Approved"), true);
  assert.equal(W.isOutcome("not approved"), true);
  assert.equal(W.isOutcome(""), false);
  // Which is why a row carrying it belongs in Applied Funding but not a win/loss count.
  assert.equal(W.isNoAnswer("Under Review"), false);
});

// ── Which columns the editor may write ───────────────────────────────────────

test("a mistyped column is named back, not dropped", () => {
  const { unknown, stamped } = W.checkFields({ opportunity_title: "ok", oportunity_title: "typo" });
  assert.deepEqual(unknown, ["oportunity_title"]);
  assert.deepEqual(stamped, []);
});

test("the nine criteria are writable — the editor spreads them in with **vals", () => {
  const criteria = ["qualification", "strategic_fit", "capacity", "geographic_fit",
    "cofinancing", "funding_quality", "funder_relationship", "competitiveness", "bid_effort"];
  const fields = Object.fromEntries(criteria.map((c) => [c, "Yes"]));
  assert.deepEqual(W.checkFields(fields).unknown, []);
});

test("the score columns are writable, though the server now owns the answer", () => {
  // rfp_editor.py writes them, so refusing them here would break the save. What they are
  // NOT any more is the last word: a save that touches them queues a re-score, and the
  // job's number replaces whatever arrived. See the rescore tests below.
  assert.deepEqual(W.checkFields({ alignment_score: 82, auto_recommendation: "Park" }).unknown, []);
});

test("the server's own stamps are refused, and said to be stamps", () => {
  const { unknown, stamped } = W.checkFields({ decision_overridden_by: "someone@else.org" });
  assert.deepEqual(unknown, ["decision_overridden_by"]);
  assert.deepEqual(stamped, ["decision_overridden_by"]);
});

test("a column from another table is not writable here", () => {
  // report_due_date lives on applied_funding and arrives under `reporting`, not `fields`.
  assert.deepEqual(W.checkFields({ report_due_date: "2026-01-01" }).unknown, ["report_due_date"]);
  assert.deepEqual(W.checkFields({ uid: "RFP-9" }).unknown, ["uid"]);
  assert.deepEqual(W.checkFields({ tenant_id: "other" }).unknown, ["tenant_id"]);
});

// ── The warning that must not be lost ────────────────────────────────────────

test("completed with no funder decision is reported", () => {
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "Completed", donor_decision: null }), true);
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "completed", donor_decision: "Not submitted" }), true,
    "the default is not an answer");
});

test("nothing to warn about once somebody has recorded a funder response", () => {
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "Completed", donor_decision: "Under Review" }), false,
    "Under Review is deliberate, so the gap is closed");
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "Completed", donor_decision: "Approved" }), false);
  assert.equal(W.completedWithoutDonorDecision(
    { progress_status: "In progress", donor_decision: null }), false,
    "not completed, so Applied Funding is not expecting it yet");
});

// ── applied_funding: conditional, not an upsert ──────────────────────────────

test("a tab that was never shown leaves the grant row alone", () => {
  // The Reporting tab is reachable from Funding, not from the editor, so an ordinary save
  // omits `reporting` entirely and must not touch applied_funding.
  assert.deepEqual(W.reportingAction(undefined, null), { kind: "none" });
  assert.deepEqual(W.reportingAction(undefined, "G-RFP-1"), { kind: "none" });
});

test("an empty reporting tab never creates a grant row", () => {
  assert.deepEqual(W.reportingAction({}, null), { kind: "none" });
  assert.deepEqual(W.reportingAction({ status: "", owner: "   " }, null), { kind: "none" },
    "blank strings are not values");
  assert.deepEqual(W.reportingAction({ status: null, report_type: null }, null), { kind: "none" });
});

test("the first real value creates the grant; afterwards it is updated", () => {
  const made = W.reportingAction({ status: "Reporting due", owner: "Ama" }, null);
  assert.equal(made.kind, "insert");
  assert.equal(made.payload.status, "Reporting due");
  assert.equal(made.payload.owner, "Ama");
  // Every reporting column is present, so clearing one writes null rather than leaving
  // the previous value behind.
  assert.deepEqual(Object.keys(made.payload).sort(),
    ["owner", "remarks", "report_due_date", "report_type", "status"]);

  const again = W.reportingAction({ status: "Submitted" }, "G-RFP-1");
  assert.equal(again.kind, "update");
  assert.equal(again.fundingId, "G-RFP-1");
  assert.equal(again.payload.status, "Submitted");
  assert.equal(again.payload.owner, null, "a field left out is cleared, not kept");
});

// ── Which saves have to re-score ─────────────────────────────────────────────
// The expensive mistake here is NOT queueing when the score moved: the row then shows a
// number computed from the opportunity as it used to be, with nothing on screen to say so.
// Queueing when it did not move costs one redundant Actions run.

test("editing what the call says re-scores", () => {
  for (const f of [
    { brief_description: "new text" },      // _full_text, and criteria_derive's notes blob
    { opportunity_title: "new title" },     // _full_text
    { funding_agency: "Wellcome" },         // _full_text, and the donor match
    { call_submission_deadline: "2027-01-01" },
    { call_award_ceiling: 500000 },
    { call_geographic_scope: ["Kenya"] },
    { notes: "a note" },                    // criteria_derive reads notes twice
    { strategic_fit: "Strongly aligns" },
  ]) {
    assert.equal(W.needsRescore(f), true, `${Object.keys(f)[0]} should re-score`);
  }
});

test("recording what the team is doing about a bid does not re-score", () => {
  assert.equal(W.needsRescore({ assigned_to: "Ama", next_action: "Draft budget" }), false);
  assert.equal(W.needsRescore({ amount_secured: 120000, date_of_approval: "2026-11-02" }), false);
  assert.equal(W.needsRescore({}), false, "a reporting-only save changes no column here");
});

test("one scoring field among workflow fields is enough", () => {
  // The whole save is one write, so the question is whether ANY of it could move the score.
  assert.equal(W.needsRescore({ assigned_to: "Ama", brief_description: "new" }), true);
});

test("marking a bid submitted re-scores — it is not workflow state", () => {
  // The trap this guards: all three read like project tracking, and criteria_derive's
  // _is_completed reads all three to decide the deadline runway is moot. Score moves.
  assert.equal(W.needsRescore({ progress_status: "Completed" }), true);
  assert.equal(W.needsRescore({ donor_decision: "Under Review" }), true);
  assert.equal(W.needsRescore({ date_completed: "2026-10-02" }), true);
});

test("a client's own score is replaced rather than trusted", () => {
  // The migration finishing: a page still computing in Pyodide may send a number, and the
  // queued job overwrites it with the server's. Not a conflict — one owner, arriving late.
  assert.equal(W.needsRescore({ alignment_score: 91, auto_recommendation: "Proceed" }), true);
});

test("no workflow-only column is a scoring input", () => {
  // Re-derives the claim the denylist makes, from the Python itself, so the day somebody
  // feeds `remarks` to the scorer this fails instead of the score quietly going stale.
  // Matches a READ of the row (.get("col") or ["col"]), not a dict key the scorer returns
  // — matching.py builds an output called "decision", which is not a read of the column.
  const sources = [
    "core/criteria_derive.py", "core/auto_scorer.py", "core/matching.py",
    "core/scorer.py", "core/assessment.py",
  ].map((p) => [p, readFileSync(path.join(root, p), "utf8")]);

  for (const col of W.workflowOnlyColumns()) {
    const read = new RegExp(String.raw`(\.get\(|\[)\s*["']${col}["']`);
    for (const [file, src] of sources) {
      assert.equal(read.test(src), false,
        `${file} reads "${col}", so a save touching it changes the score — ` +
        "take it out of WORKFLOW_ONLY in pipeline_writes.ts");
    }
  }
});

// ── The decision vocabulary ──────────────────────────────────────────────────

/**
 * One `key:` list out of config/dropdowns.yaml, inline or block form.
 *
 * CRLF-aware on purpose: the working tree is checked out with CRLF here, and JS `.` does
 * not match `\r`, so the obvious `.+\n` block pattern matches nothing and the test reports
 * "the key is gone" when the key is right there. That cost a debugging detour once.
 */
function yamlList(key) {
  const yaml = readFileSync(path.join(root, "config/dropdowns.yaml"), "utf8")
    .replace(/\r\n/g, "\n");
  const inline = yaml.match(new RegExp(String.raw`^${key}:[ \t]*\[([^\]]*)\]`, "m"));
  if (inline) return splitItems(inline[1].split(","));
  const block = yaml.match(new RegExp(String.raw`^${key}:[ \t]*\n((?:[ \t]*-[ \t]*.+\n)+)`, "m"));
  return block ? splitItems(block[1].split("\n").map((l) => l.replace(/^[ \t]*-[ \t]*/, ""))) : null;
}
const splitItems = (parts) =>
  parts.map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

test("the stage vocabulary matches config/dropdowns.yaml, in order", () => {
  // Order carries meaning here: the Bidding progress bar reads left to right, so a
  // reordered YAML would redraw what "further along" means without anything failing.
  // deepEqual rather than a set comparison is the whole point.
  const want = yamlList("stages");
  assert.ok(want, "config/dropdowns.yaml no longer declares `stages`");
  assert.deepEqual([...W.STAGES], want);

  // The five-item fallback in views/tracking_rfp.py is NOT the vocabulary. If this ever
  // matches, somebody has copied the short list over the real one and two steps that live
  // rows sit in have gone missing.
  assert.equal(W.STAGES.length, 7);
  assert.ok(W.STAGES.includes("Budgeting development"));
  assert.ok(W.STAGES.includes("Review, compliance check & approvals"));
});

test("the decision vocabulary matches config/dropdowns.yaml", () => {
  // The API copies the list because it also runs as a Deno Edge Function with no
  // filesystem to read the YAML from. This is what keeps the copy honest: `decision`
  // decides who appears in Track and whether the scan tombstones the row, so a value the
  // app offers but the API refuses would be a save that fails for no visible reason.
  const want = yamlList("decisions");
  assert.ok(want, "config/dropdowns.yaml no longer declares `decisions`");
  assert.deepEqual([...W.DECISIONS], want);
});

test("an existing grant is updated even when the tab is emptied", () => {
  // Clearing the reporting fields on a linked grant is a real edit, so it must write —
  // unlike the no-grant case, where the same emptiness means "do not create one".
  const a = W.reportingAction({ status: "", owner: "" }, "G-RFP-1");
  assert.equal(a.kind, "update");
  assert.equal(a.payload.status, "");
});

test("the donor-decision vocabulary matches config/dropdowns.yaml", () => {
  // The funder's answer, which is a different column and a different act from `decisions`.
  // Unlike that one it is NOT validated by the PATCH route — live rows carry values the
  // vocabulary never had — so this list is only what the Submitted stage OFFERS. It still
  // has to match the YAML: an app that offers one spelling while the Report counts
  // another is how "Approved" stops being counted as approved.
  const want = yamlList("donor_decision");
  assert.ok(want, "config/dropdowns.yaml no longer declares `donor_decision`");
  assert.deepEqual([...W.DONOR_DECISIONS], want);
});

test("the two outcomes are the exit from Submitted, and Under Review is not one", () => {
  // The Submitted stage's membership is `is_submitted && !isOutcome`, so anything this
  // call reads as an outcome leaves the stage. Treating "Under Review" as one would make
  // saying "we are still waiting" look like the funder had answered — and the row would
  // vanish into Outcome with nothing recorded there.
  for (const v of D.OUTCOMES) assert.equal(D.isOutcome(v), true, `${v} is an outcome`);
  assert.equal(D.isOutcome("Under Review"), false);
  assert.equal(D.isOutcome("Not submitted"), false);
  assert.equal(D.isOutcome("Submitted"), false, "not an outcome, whoever typed it");
  // Every outcome must be a value the app offers, or recording one would put a row in a
  // state the dropdown cannot express.
  for (const v of D.OUTCOMES) assert.ok(W.DONOR_DECISIONS.includes(v));
});

test("anything but blank or Not submitted proves the proposal went in", () => {
  // core/pipeline.py::is_submitted, and the INVERSE LIST is the point: a funder can only
  // decide on a proposal it received. views/report.py::_submitted_mask names the three
  // decisions it accepts instead, and would read a word added to the dropdown next year —
  // or one somebody typed — as unsubmitted. Two live rows say "Submitted".
  assert.equal(D.isSubmitted({ donor_decision: "Submitted" }), true);
  assert.equal(D.isSubmitted({ donor_decision: "Under Review" }), true);
  assert.equal(D.isSubmitted({ donor_decision: "Approved" }), true);
  assert.equal(D.isSubmitted({ progress_status: "Completed" }), true);
  assert.equal(D.isSubmitted({ date_completed: "2026-07-31" }), true);

  // And the states that prove nothing.
  assert.equal(D.isSubmitted({}), false);
  assert.equal(D.isSubmitted({ donor_decision: "Not submitted" }), false);
  assert.equal(D.isSubmitted({ progress_status: "In Progress" }), false);
  // The Excel import's empty cell, which arrives as the literal string. Reading it as a
  // value would mark every migrated row as submitted.
  assert.equal(D.isSubmitted({ donor_decision: "nan", date_completed: "nan" }), false);
  assert.equal(D.isSubmitted({ donor_decision: "  Not submitted  " }), false, "stripped");
});

test("is_submitted is the one test both Bidding and Submitted use", () => {
  // Bidding's exit and Submitted's entry have to be the same rule or a row falls off the
  // line. This asserts they are literally the same function rather than two that agree
  // today: routes_pipelines.ts imports it from the shared module, and the HTTP pair test
  // in api-flows.test.mjs drives both routes over one fixture.
  assert.equal(P.selectSubmittedRows([
    { uid: "a", progress_status: "Completed" },
    { uid: "b", progress_status: "In Progress", donor_decision: "Not submitted" },
    { uid: "c", date_completed: "2026-01-01" },
    { uid: "d", donor_decision: "Approved" },
    { uid: "e", progress_status: "Completed", is_duplicate: true },
  ]).map((r) => r.uid).join(","), "a,c");

  // The date chain, which is NOT decidedOn's: a save stamp says when somebody did the
  // bookkeeping, not when the proposal went in.
  assert.equal(P.submittedOn({ date_completed: "2026-07-31", submitted_at: "2026-02-01" }),
    "2026-07-31");
  assert.equal(P.submittedOn({
    submitted_at: "2026-06-25T00:00:00+00:00",
    decision_overridden_at: "2026-11-03T08:00:00+00:00",
  }), "2026-06-25");
  assert.equal(P.submittedOn({ decision_overridden_at: "2026-11-03T08:00:00+00:00" }), null);
});

// ── money.ts — core/dropdowns.usd_rate, core/pipeline.usd_value, core/records ─────────

/** The `currencies:` block, as a list of {code,label,aliases,usdRate}. Its own reader
 *  because `yamlList` above only handles a flat list of scalars. CRLF-normalised first,
 *  for the reason the stage-vocabulary test learned the hard way: this tree is checked out
 *  CRLF and JS `.` does not match `\r`. */
function yamlCurrencies() {
  const yaml = readFileSync(path.join(root, "config/dropdowns.yaml"), "utf8")
    .replace(/\r\n/g, "\n");
  const block = yaml.match(/^currencies:[ \t]*\n((?:[ \t]+.*\n|\n)+)/m);
  if (!block) return null;
  const out = [];
  for (const line of block[1].split("\n")) {
    const start = line.match(/^[ \t]*-[ \t]*code:[ \t]*(.+?)[ \t]*$/);
    if (start) { out.push({ code: unquote(start[1]), aliases: [] }); continue; }
    if (!out.length) continue;
    const cur = out[out.length - 1];
    const kv = line.match(/^[ \t]+(\w+):[ \t]*(.+?)[ \t]*$/);
    if (!kv) continue;
    const [, k, raw] = kv;
    const v = raw.replace(/[ \t]*#.*$/, "").trim();
    if (k === "label") cur.label = unquote(v);
    else if (k === "usd_rate") cur.usdRate = Number(v);
    else if (k === "aliases") {
      cur.aliases = v.startsWith("[")
        ? v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean)
        : [];
    }
  }
  return out;
}
const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");

test("the default currency table matches config/dropdowns.yaml, rates and all", () => {
  // Copied because this module also runs as a Deno Edge Function with no filesystem. The
  // RATES matter as much as the codes: these are the fallback when the live rate does not
  // answer, so a stale one here is a wrong money total rather than a failure anybody sees.
  const want = yamlCurrencies();
  assert.ok(want && want.length, "config/dropdowns.yaml no longer declares `currencies`");
  assert.deepEqual(
    M.DEFAULT_CURRENCIES.map((c) => ({ code: c.code, label: c.label, aliases: c.aliases, usdRate: c.usdRate })),
    want.map((c) => ({ code: c.code, label: c.label, aliases: c.aliases, usdRate: c.usdRate })),
  );
});

test("the deployment's own currency table REPLACES the file's", async () => {
  // THE REASON loadCurrencies EXISTS, and the thing a copied YAML gets wrong.
  // core/dropdowns.py::load does `data = {**data, "currencies": overrides}` — a
  // replacement, not a merge — so `app_settings.currencies_json` is the table a deployment
  // actually converts at. This one carries six entries where the file has five: an admin
  // added SEK through Admin → Settings, and no copy of the YAML would ever mention it.
  const stored = JSON.stringify([
    { code: "USD", label: "USD", symbol: "$", aliases: ["USD $"], usd_rate: 1.0 },
    { code: "SEK", label: "SEK", symbol: "kr", aliases: ["SEK kr"], usd_rate: 0.11 },
  ]);
  const db = fakeSettingsDb(stored);
  const table = await M.loadCurrencies(db);
  assert.deepEqual(table.map((c) => c.code), ["USD", "SEK"],
    "replaced wholesale — GBP and EUR are gone because the override does not list them");
  assert.equal(M.staticRate("SEK kr", table), 0.11, "and a currency the file never had");
  assert.equal(M.staticRate("GBP", table), null, "while one it dropped is genuinely gone");

  // Unset, malformed, and a list of nothing usable all leave the defaults in place —
  // load()'s bare `except Exception: pass`. Converting everything at 1.0 because a setting
  // is broken would be the worst of the available answers.
  for (const bad of [null, "", "{not json", "[]", '["nonsense"]', '{"a":1}']) {
    const d = await M.loadCurrencies(fakeSettingsDb(bad));
    assert.deepEqual(d, M.DEFAULT_CURRENCIES, `fallback for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(await M.loadCurrencies(brokenDb()), M.DEFAULT_CURRENCIES,
    "and a read that throws never takes the stage down with it");
});

/** The smallest thing `loadCurrencies` needs: `db.service.get`. GLOBAL app_settings, which
 *  is the Python's routing — `currencies_json` is not in `_TENANT_SCOPED_KEYS`. */
function fakeSettingsDb(value) {
  return {
    service: {
      get: async (table, query) => {
        assert.equal(table, "app_settings",
          "currencies_json is global; reading tenant_settings would find nothing");
        assert.ok(query.includes("currencies_json"));
        return value === null ? [] : [{ value }];
      },
    },
  };
}
const brokenDb = () => ({ service: { get: async () => { throw new Error("network"); } } });

test("a currency written with its symbol still resolves, by code, label or alias", () => {
  // Every spelling the live table actually uses. core/dropdowns.usd_rate resolves all of
  // them; a table lookup that only knew the ISO code would read "GBP £" as USD and
  // understate a £200,000 award by a third.
  assert.equal(M.staticRate("GBP"), 1.33);
  assert.equal(M.staticRate("GBP £"), 1.33, "alias");
  assert.equal(M.staticRate("£"), 1.33, "symbol alone");
  assert.equal(M.staticRate("Euro €"), 1.16);
  assert.equal(M.staticRate("FCFA"), 0.00166, "label, not code");
  assert.equal(M.staticRate("F CFA"), 0.00166, "alias with a space");
  assert.equal(M.staticRate("CAD $"), 0.73);
  assert.equal(M.staticRate("ZZZ"), null, "unknown stays unknown rather than becoming 1.0");
});

test("the live rate wins over the table, and a symbol does not hide it", () => {
  // THE BUG THIS FIXES. fx.ts::normaliseCurrency did not split the first token the way
  // core/dropdowns.usd_rate does, so every cell carrying a symbol failed its ISO test, got
  // no live rate, and silently used the table instead. 13 live rows.
  for (const [raw, key] of [["GBP", "GBP"], ["GBP £", "GBP"], ["Euro €", "EUR"],
                            ["CAD $", "CAD"], ["FCFA", "XAF"], ["F CFA", null],
                            ["USD", null], ["USD $", null], ["", null], ["ZZZ", "ZZZ"]]) {
    assert.equal(F.normaliseCurrency(raw), key, `normaliseCurrency(${JSON.stringify(raw)})`);
  }
  // "F CFA" reaches no live rate either way — neither the whole string nor the first token
  // is an ISO code — and the static table catches it, exactly as the Python does.
  assert.equal(M.usdRate("F CFA", {}), 0.00166);

  const live = { GBP: [1.340956, "Tue, 03 Nov 2026"], EUR: [1.119485, null] };
  assert.equal(M.usdRate("GBP £", live), 1.340956, "the live rate, not the table's 1.33");
  assert.equal(M.usdRate("Euro €", live), 1.119485);
  assert.equal(M.usdRate("GBP £", {}), 1.33, "and the table when nothing answered");
  assert.equal(M.usdRate("USD $", live), 1.0, "USD never needs a rate");
  assert.equal(M.usdRate("ZZZ", {}), 1.0, "unknown means no conversion, as the Python ends");
});

test("a non-numeric amount is worth nothing rather than poisoning a total", () => {
  // The Excel import leaves empty cells, and `usd_value` returns 0.0 for them. A NaN that
  // reached a sum would make every figure on the stage read NaN.
  const live = { GBP: [1.340956, null] };
  assert.equal(M.usdValue(200000, "GBP £", live), 200000 * 1.340956);
  assert.equal(M.usdValue(null, "USD", live), 0);
  assert.equal(M.usdValue("", "USD", live), 0);
  assert.equal(M.usdValue(undefined, "USD", live), 0);
  assert.equal(M.usdValue("nan", "USD", live), 0);
  assert.equal(M.usdValue(NaN, "USD", live), 0);
  assert.equal(M.usdValue("1500", "USD", live), 1500, "a numeric string still counts");
});

test("the request's currency is the one we submitted in", () => {
  // core/records.requested_currency. `currency` is what the CALL was advertised in and is
  // only the legacy fallback — conflating them rendered a USD 715,400 request as $509,530.
  assert.equal(M.requestedCurrency({ currency_secured: "USD", currency: "CAD $" }), "USD");
  assert.equal(M.requestedCurrency({ currency: "CAD $" }), "CAD $", "legacy fallback");
  assert.equal(M.requestedCurrency({ currency_secured: "  ", currency: "EUR" }), "EUR");
  assert.equal(M.requestedCurrency({}), "");
});

test("only a Completed row counts as an application, and it counts at least once", () => {
  // core/records.submission_weight, and the gate is the owner's rule rather than an
  // oversight: a donor decision alone once resurrected counts migration 089 had reset.
  assert.equal(M.submissionWeight({ progress_status: "Completed" }), 1, "null submissions");
  assert.equal(M.submissionWeight({ progress_status: "Completed", submissions: 0 }), 1,
    "the floor migration 089 enforces");
  assert.equal(M.submissionWeight({ progress_status: "completed", submissions: 3 }), 3);
  assert.equal(M.submissionWeight({ progress_status: "  Completed  ", submissions: 2 }), 2);
  assert.equal(M.submissionWeight({ progress_status: "In Progress", submissions: 5 }), 0);
  // The incident core/records.py records: a donor decision over a stale progress field.
  assert.equal(M.submissionWeight({ progress_status: "Not Started", donor_decision: "Approved" }), 0);
  assert.deepEqual(
    M.ledgerGap([{ uid: "a", progress_status: "Completed" },
                 { uid: "b", progress_status: "Not Started" }]).map((r) => r.uid),
    ["b"]);
});
