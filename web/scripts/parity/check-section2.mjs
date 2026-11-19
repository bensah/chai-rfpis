// Parity check for Report Section 2 as displayed — Team & Partnership Activity (id 4).
//
//   node scripts/parity/check-section2.mjs    (from web/; reads the live database, read-only)
//
// Every block, for every period × every view. The period matters here even though most
// blocks ignore it: meetings and engagements follow it, the people and partner charts do
// not, and running the matrix is what catches one of those being brought into line with the
// other.
//
// Both halves get the SAME ROWS: this fetches once and sends them to the Python.
//
// THE LIMIT, stated. report.py's section-4 blocks are inline in the Streamlit script and
// cannot be lifted. section2_py.py lifts `_bucketed_count` and `_submitted_mask` and imports
// `partner_names` / `member_names`; the groupby arithmetic around them is transcribed with
// line ranges quoted. Green means the TypeScript agrees with that transcription.
//
// AND A SECOND LIMIT THAT IS SPECIFIC TO THIS SECTION: `engagement_logs` is EMPTY in this
// database. Four of the blocks — the donor KPIs, the engagement series and the top-donor
// table — therefore run on no rows and prove only that both sides agree about nothing.
// Constructed cases below exercise them properly, because an agreement over zero rows is
// not evidence.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireEnv } from "./_env.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const D = await mod("supabase/functions/_shared/api/db.ts");
const P = await mod("supabase/functions/_shared/api/report_period.ts");
const S1 = await mod("supabase/functions/_shared/api/report_section1.ts");
const S = await mod("supabase/functions/_shared/api/report_section2.ts");
const N = await mod("supabase/functions/_shared/api/report_names.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "section2_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;
const canon = (v) => (v === null || typeof v !== "object" ? v
  : Array.isArray(v) ? v.map(canon)
  : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])));
const J = (v) => JSON.stringify(canon(v));
const near = (a, b) => typeof a === "number" && typeof b === "number"
  && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
function equal(a, b) {
  if (near(a, b)) return true;
  const x = canon(a), y = canon(b);
  if (JSON.stringify(x) === JSON.stringify(y)) return true;
  if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) return x.every((v, i) => equal(v, y[i]));
  if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) {
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => equal(x[k], y[k]));
  }
  return false;
}
const same = (label, ts, pyv) => {
  checks++;
  if (equal(ts, pyv)) return;
  diffs++;
  const a = J(ts), b = J(pyv);
  console.log(`DIFF ${label}\n   ts: ${a.length > 500 ? a.slice(0, 500) + "…" : a}\n   py: ${b.length > 500 ? b.slice(0, 500) + "…" : b}`);
};

/** A ranked list whose tie ORDER is a numpy introsort artefact — see check-section1.mjs. */
const tieBands = new Set();
function sameRanked(label, tsTop, pyTop, valueOf, nameOf) {
  checks++;
  const tsV = tsTop.map(valueOf), pyV = pyTop.map(valueOf);
  if (J(tsV) !== J(pyV)) {
    diffs++;
    console.log(`DIFF ${label} count sequence\n   ts: ${J(tsV)}\n   py: ${J(pyV)}`);
    return;
  }
  if (!tsTop.length) return;
  const cut = tsV[tsV.length - 1];
  const above = (l) => l.filter((x) => valueOf(x) > cut).map(nameOf).sort();
  checks++;
  if (J(above(tsTop)) !== J(above(pyTop))) {
    diffs++;
    console.log(`DIFF ${label} membership above the tie band\n   ts: ${J(above(tsTop))}\n   py: ${J(above(pyTop))}`);
    return;
  }
  const band = (l) => l.filter((x) => valueOf(x) === cut).map(nameOf).sort();
  const t = band(tsTop), p = band(pyTop);
  checks++;
  if (t.length !== p.length) {
    diffs++;
    console.log(`DIFF ${label} took ${t.length} from the tie band, report.py took ${p.length}`);
    return;
  }
  if (J(t) !== J(p)) {
    tieBands.add(`${label.split(" ")[0]}: ${t.length} tied at ${cut}; this port shows ${J(t)}, report.py ${J(p)}`);
  }
}

// ── Rows, read once ──────────────────────────────────────────────────────────
const env = requireEnv(root, "check-section2");
const db = D.createDb({
  supabaseUrl: env.SUPABASE_URL, supabaseKey: env.SUPABASE_KEY,
  jwtSecret: env.SUPABASE_JWT_SECRET ?? "",
});
const allRfps = await db.service.getAll("rfp_submissions", `select=${S1.RFP_COLUMNS}`, "uid");
const allMeetings = await db.service.getAll("meeting_logs", "select=*", "id");
const allEng = await db.service.getAll("engagement_logs", "select=*", "id");
const nameConfig = await N.loadNameConfig(db, null);
const org = await S.loadOrgIdentity(db, null);
console.log(`${allRfps.length} submissions, ${allMeetings.length} meetings, ${allEng.length} engagements`);
console.log(`org identity: full=${JSON.stringify(org.full)} short=${JSON.stringify(org.short)}`);

const today = new Date().toISOString().slice(0, 10);
const inRange = (rows, col, bounds) => rows.filter((r) => {
  const d = String(r[col] ?? "").slice(0, 10);
  if (!d) return false;
  if (bounds.start && d < bounds.start) return false;
  if (bounds.end && d > bounds.end) return false;    // lte(end), no +1 day
  return true;
});

// ── The matrix ───────────────────────────────────────────────────────────────
const matrix = [];
for (const period of P.PERIOD_OPTS) {
  for (const view of P.VIEW_OPTS) {
    const sel = P.resolveSelection({ period, year: 2026, month: "June", view }, today, 2026);
    const bounds = P.periodBounds(sel, today);
    matrix.push({
      period, view, sel, bounds,
      meetings: inRange(allMeetings, "meeting_date", bounds),
      engagements: inRange(allEng, "engagement_date", bounds),
    });
  }
}
const wants = py({
  rfps: allRfps,
  cases: matrix.map((m) => ({ view: m.sel.view, bounds: m.bounds, meetings: m.meetings, engagements: m.engagements, org })),
});
for (const [i, m] of matrix.entries()) {
  const ts = S.buildSection2({
    rfps: allRfps, meetings: m.meetings, engagements: m.engagements,
    view: m.sel.view, bounds: m.bounds, nameConfig, org,
  });
  const w = wants[i];
  const tag = `${m.period} · ${m.view}`;
  same(`meetings ${tag}`, ts.meetings, w.meetings);
  same(`donors ${tag}`, ts.donors, w.donors);
  same(`engagements ${tag}`, ts.engagements, w.engagements);
  same(`topDonors grouping ${tag}`, ts.topDonors.all, w.topDonors.all);
  sameRanked(`topDonors ${tag}`, ts.topDonors.top, w.topDonors.top, (x) => x.touchpoints, (x) => x.donor);
  same(`leads grouping ${tag}`, ts.leads.all, w.leads.all);
  sameRanked(`leads ${tag}`, ts.leads.top, w.leads.top, (x) => x.total, (x) => x.name);
  same(`contributors grouping ${tag}`, ts.contributors.all, w.contributors.all);
  sameRanked(`contributors ${tag}`, ts.contributors.top, w.contributors.top, (x) => x.total, (x) => x.name);
  for (const side of ["lead", "sub"]) {
    same(`partners.${side} grouping ${tag}`, ts.partners[side].all, w.partners[side].all);
    sameRanked(`partners.${side} ${tag}`, ts.partners[side].top, w.partners[side].top, (x) => x.rfps, (x) => x.org);
  }
  same(`proceedRows ${tag}`, ts.proceedRows, w.proceedRows);
}
console.log(`${matrix.length} period × view combinations checked`);
for (const n of tieBands) console.log(`NOTE ${n}`);

// ── The blocks the live data cannot exercise ─────────────────────────────────
//
// engagement_logs is empty, so four blocks above compared zero against zero. These rows are
// invented — obviously so — purely to make the donor KPIs, the bucketed series and the
// top-donor table express something. Without them a green run says nothing about them.
{
  const ENG = [
    { id: 1, donor: "Alpha Trust", engagement_date: "2026-02-10", engagement_type: "Call", linked_rfp_uid: "u1" },
    { id: 2, donor: "Alpha Trust", engagement_date: "2026-02-20", engagement_type: "Email", linked_rfp_uid: null },
    { id: 3, donor: "Alpha Trust", engagement_date: "2026-05-01", engagement_type: "Call", linked_rfp_uid: "u2" },
    { id: 4, donor: "Beta Fund", engagement_date: "2026-03-05", engagement_type: "Meeting", linked_rfp_uid: null },
    { id: 5, donor: "Beta Fund", engagement_date: "2026-03-06", engagement_type: null, linked_rfp_uid: "u3" },
    { id: 6, donor: "Gamma", engagement_date: null, engagement_type: "Call", linked_rfp_uid: null },
    { id: 7, donor: "Gamma", engagement_date: "2026-11-01", engagement_type: "", linked_rfp_uid: null },
    // A donor whose type list is long enough to meet the 80-character cut.
    { id: 8, donor: "Delta", engagement_date: "2026-06-01", engagement_type: "A very long engagement type name indeed", linked_rfp_uid: null },
    { id: 9, donor: "Delta", engagement_date: "2026-06-02", engagement_type: "Another long engagement type name as well", linked_rfp_uid: null },
    { id: 10, donor: "Delta", engagement_date: "2026-06-03", engagement_type: "Yet a third long engagement type entry", linked_rfp_uid: null },
  ];
  const MEET = [
    { id: 1, meeting_date: "2026-02-01", is_resolved: true },
    { id: 2, meeting_date: "2026-02-02", is_resolved: false },
    { id: 3, meeting_date: "2026-02-03", is_resolved: null },   // null is NOT resolved
  ];
  const cases = [];
  for (const view of P.VIEW_OPTS) {
    for (const period of ["All time", "This year"]) {
      const sel = P.resolveSelection({ period, year: 2026, month: "June", view }, today, 2026);
      cases.push({ period, view, sel, bounds: P.periodBounds(sel, today) });
    }
  }
  const want = py({
    rfps: allRfps,
    cases: cases.map((c) => ({ view: c.sel.view, bounds: c.bounds, meetings: MEET, engagements: ENG, org })),
  });
  for (const [i, c] of cases.entries()) {
    const ts = S.buildSection2({
      rfps: allRfps, meetings: MEET, engagements: ENG,
      view: c.sel.view, bounds: c.bounds, nameConfig, org,
    });
    const tag = `constructed ${c.period} · ${c.view}`;
    same(`meetings ${tag}`, ts.meetings, want[i].meetings);
    same(`donors ${tag}`, ts.donors, want[i].donors);
    same(`engagements ${tag}`, ts.engagements, want[i].engagements);
    same(`topDonors grouping ${tag}`, ts.topDonors.all, want[i].topDonors.all);
    sameRanked(`topDonors ${tag}`, ts.topDonors.top, want[i].topDonors.top, (x) => x.touchpoints, (x) => x.donor);
  }
  const probe = S.buildSection2({
    rfps: allRfps, meetings: MEET, engagements: ENG, view: "Monthly",
    bounds: P.periodBounds(P.resolveSelection({ period: "All time" }, today, 2026), today),
    nameConfig, org,
  });
  console.log(`constructed engagements exercised: ${probe.donors.engagements} engagements, `
    + `${probe.donors.donors} donors, ${probe.donors.tiedToRfp} tied, `
    + `${probe.engagements.length} buckets, ${probe.topDonors.top.length} donors ranked`);
  // The two traps that only these rows reach.
  checks++;
  const gamma = probe.topDonors.top.find((d) => d.donor === "Gamma");
  if (!gamma || gamma.touchpoints !== 1) {
    diffs++;
    console.log(`DIFF a dateless engagement should not count as a touchpoint (Gamma=${JSON.stringify(gamma)})`);
  }
  checks++;
  const delta = probe.topDonors.top.find((d) => d.donor === "Delta");
  if (!delta || delta.types.length !== 80) {
    diffs++;
    console.log(`DIFF the engagement-type list should be cut to 80 chars (got ${delta?.types.length})`);
  }
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
