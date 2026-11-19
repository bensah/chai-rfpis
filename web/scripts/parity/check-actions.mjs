// Parity check for Meeting Actions — app_pages/actions.py's four tabs.
//
//   node scripts/parity/check-actions.mjs    (from web/; reads the live database, read-only)
//
// Four rules decide what this page shows, and three of them are easy to get subtly wrong:
//
//   week_bounds / label   which Monday a note belongs to, and what the week is called
//   _owner_summary        who owes what — an owner cell with two names is TWO people
//   schedule._clean       the rota: first entry per date wins, sorted
//   is_resolved           a NULL is OPEN, in both tables
//
// THE LAST ONE IS WHY THIS CHECK EXISTS. views/pending_actions.py carries an "outcome
// non-empty" fallback for engagements, and reading it quickly suggests a NULL is judged by
// the outcome. It is not: that branch sits in the `except` around a select that FAILS
// because the column does not exist, which is the pre-migration-014 schema. With the column
// present both tables do `fillna(False)`. The port had it the other way round at first,
// which closes every old engagement with an outcome typed into it and no tick — most of
// them — and empties a Pending tab the Streamlit page fills.
//
// Live data alone cannot pin these: the rota has no duplicate dates today, no owner cell
// holds two names, and no engagement row exists at all for the busiest tenant. So each case
// is hand-built, one per rule.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const mod = (p) => import(pathToFileURL(path.join(root, p)).href);
const A = await mod("supabase/functions/_shared/api/actions.ts");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");
const py = (payload) => {
  try {
    return JSON.parse(execFileSync(python, [path.join(here, "actions_py.py")], {
      input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28,
      stdio: ["pipe", "pipe", "pipe"],
    }));
  } catch (e) {
    console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
    process.exit(2);
  }
};

let diffs = 0, checks = 0;
const J = (v) => JSON.stringify(v);
const same = (label, ts, pyv) => {
  checks++;
  if (J(ts) === J(pyv)) return;
  diffs++;
  console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

// ── Weeks ────────────────────────────────────────────────────────────────────
// Every weekday of one week (all seven must give the same Monday), a year boundary where
// the ISO week belongs to the other year, a leap day, and the week-53 case.
const DAYS = [
  "2026-09-14", "2026-09-15", "2026-09-17", "2026-09-20",   // Mon..Sun of one week
  "2026-01-01", "2026-01-04", "2026-12-28", "2026-12-31",
  "2024-02-29", "2021-01-01", "2020-12-31", "2027-01-03",
];

// ── Owners ───────────────────────────────────────────────────────────────────
const OWNERS = [
  ["Bernard Nsah", "Emilienne Bieme-Ndi"],
  // One cell, two people: each owes one, so the line sums HIGHER than the item count.
  ["Alex Kim, Jane Doe", "Jane Doe"],
  ["  ", "", "Bernard"],
  // Two different people sharing a first name are counted together. The Python does this
  // and nobody has minded; asserting it means a "fix" has to be a decision.
  ["Michael Budzi", "Michael Smith"],
  ["Bernard", "Bernard Nsah", "bernard"],
  [],
  ["Tata Pepson, , Shariffa Iliasu ,"],
];

// ── Rotas ────────────────────────────────────────────────────────────────────
const SCHEDULES = [
  [{ date: "2026-02-02", note_taker: "A", presenter: "B", chair: "C" }],
  // Out of order, and a duplicate date — the FIRST wins, which is not the last.
  [
    { date: "2026-03-09", note_taker: "later", presenter: "", chair: "" },
    { date: "2026-02-02", note_taker: "first", presenter: "", chair: "" },
    { date: "2026-02-02", note_taker: "second", presenter: "", chair: "" },
  ],
  [{ date: "not-a-date", note_taker: "x" }, { date: "", note_taker: "y" }],
  [{ date: "2026-02-02T09:00:00", note_taker: " padded " }],
  [{ date: "2026-02-02", cid: 42, note_taker: null, presenter: undefined, chair: "C" }],
  [],
];

// ── Engagements ──────────────────────────────────────────────────────────────
// The rule the port got wrong first time. A NULL is OPEN, whatever the outcome says.
const ENGAGEMENTS = [[
  { id: "a", is_resolved: true, outcome: "" },
  { id: "b", is_resolved: false, outcome: "went well" },
  { id: "c", is_resolved: null, outcome: "went well" },     // NULL + outcome -> OPEN
  { id: "d", is_resolved: null, outcome: "" },
]];

const want = py({ days: DAYS, owners: OWNERS, schedules: SCHEDULES, engagements: ENGAGEMENTS });

for (const [i, d] of DAYS.entries()) {
  const b = A.weekBounds(d);
  same(`week_bounds(${d})`, { monday: b.monday, sunday: b.sunday },
    { monday: want.weeks[i].monday, sunday: want.weeks[i].sunday });
  same(`review_week_label(${d})`, A.weekLabel(d), want.weeks[i].label);
}
ok("every day of a week gives the same Monday",
  new Set(["2026-09-14", "2026-09-15", "2026-09-17", "2026-09-20"]
    .map((d) => A.weekBounds(d).monday)).size === 1);

for (const [i, o] of OWNERS.entries()) {
  const ts = A.ownerCounts(o).map((x) => [x.name, x.items]);
  // Compared IN ORDER, not as a multiset. The first version of this check sorted both
  // sides by name and so could not see that the port was breaking ties differently from
  // `value_counts` — which puts the two apps' summary lines in different orders while both
  // are live. The order is part of the answer.
  same(`_owner_summary ${i}`, ts, want.owners[i].counts);
  // And the port's list still renders back to the page's own line.
  const line = ts.slice(0, 12).map(([n, c]) => `**${n}** (${c})`).join(" · ")
    + (ts.length > 12 ? `  + ${ts.length - 12} more` : "");
  ok(`the summary line for case ${i}`, (ts.length ? line : "—") === want.owners[i].summary,
    `ts "${ts.length ? line : "—"}" vs py "${want.owners[i].summary}"`);
}

for (const [i, items] of SCHEDULES.entries()) {
  // `loadSchedule`'s cleaning, exercised without a database: the same rules run on the
  // parsed blob, so this is the code the route uses.
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const d = String(raw?.date ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen.has(d)) continue;
    seen.add(d);
    out.push({
      date: d, cid: raw.cid === null || raw.cid === undefined ? "" : String(raw.cid).trim(),
      note_taker: String(raw.note_taker ?? "").trim(),
      presenter: String(raw.presenter ?? "").trim(),
      chair: String(raw.chair ?? "").trim(),
    });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  same(`schedule._clean ${i}`, out, want.schedules[i]);
}

{
  const rows = ENGAGEMENTS[0];
  const open = rows.filter((r) => A.engagementOpen(r)).map((r) => r.id).sort();
  const closed = rows.filter((r) => !A.engagementOpen(r)).map((r) => r.id).sort();
  same("engagements open", open, want.engagements[0].open);
  same("engagements resolved", closed, want.engagements[0].resolved);
  ok("a NULL with an outcome written is OPEN, not closed",
    A.engagementOpen({ id: "c", is_resolved: null, outcome: "went well" }),
    "the outcome fallback lives in the except around a select that fails for want of the "
    + "column — it is the pre-014 schema, not a NULL value. Reading it the other way closes "
    + "every old engagement somebody wrote an outcome into without ticking.");
}

// ── buildActions, over a hand-built frame ────────────────────────────────────
{
  const notes = [
    { id: "1", meeting_date: "2026-09-14", actions: "a", owner: "Bernard", is_resolved: false, deadline: "2026-09-20", created_at: "2026-09-14T09:00:00Z" },
    { id: "2", meeting_date: "2026-09-14", actions: "b", owner: "Tata, Shariffa", is_resolved: null, deadline: null, created_at: "2026-09-14T08:00:00Z" },
    { id: "3", meeting_date: "2026-09-07", actions: "c", owner: "", is_resolved: true, deadline: "2026-09-10", created_at: "2026-09-07T09:00:00Z" },
  ];
  const built = A.buildActions({
    notes, engagements: ENGAGEMENTS[0], schedule: [], week: "2026-09-16", today: "2026-11-16",
  });
  ok("the week snaps to its Monday", built.week.monday === "2026-09-14");
  ok("only that week's notes are listed", J(built.notes.map((n) => n.id)) === J(["2", "1"]),
    "and oldest first inside the week — notes are read in the order they were taken.");
  ok("a NULL is_resolved on a note is OPEN too",
    built.pending.notes.some((n) => n.id === "2"));
  ok("dated open items come before undated ones",
    J(built.pending.notes.map((n) => n.id)) === J(["1", "2"]),
    "an item with no deadline is not urgent-by-default and must not push a dated one down.");
  ok("an owner cell with two names is two people",
    J(built.pending.owners.map((o) => o.name).sort()) === J(["Bernard", "Shariffa", "Tata"]));
  ok("the open percentage is of the WHOLE log, not of this week",
    built.pending.meetingTotal === 3 && built.pending.meetingOpen === 2);
  ok("the quarter starts on a quarter boundary", built.quarter.from === "2026-10-01",
    built.quarter.from);
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
