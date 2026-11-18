// Parity check for the Donors page — web/src/donors/model.ts against app_pages/donors.py.
//
//   node scripts/parity/check-donors.mjs      (from web/; reads donor_intel, writes nothing)
//
// THE FIRST CHECK THAT COVERS BROWSER CODE. Every other check in this directory tests a
// module under supabase/functions, which Node can import directly because the Edge
// Function writes Deno-style imports with explicit extensions. web/src is bundler code —
// extensionless specifiers, JSON imports, a path into the shared API directory — so it is
// loaded through VITE'S OWN RESOLVER here, the same way vite.config.ts's devApi plugin
// loads the API module. Checking a rewritten copy would prove something about the copy.
//
// It matters that this is covered at all: the Donors read path is the one body of real
// logic that lives only in the browser. Labels, category folding and the completeness
// percentage are computed there and nowhere else, so until now nothing compared them with
// the Streamlit page they were ported from.
//
// WHAT THE COMPLETENESS NUMBER DEPENDS ON, and why it is the centre of this file: it is a
// percentage whose DENOMINATOR IS DERIVED. donors.py classifies flags negatively —
// anything not named in the text/contact/profile/meta sets is a flag — so both halves must
// first agree about which of the live columns are flags before any percentage can agree.
// The flag list is therefore compared on its own, so a denominator drift is reported as a
// denominator drift rather than as every donor's percentage being wrong at once.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../..");
const root = path.resolve(webRoot, "..");

const venv = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const mainVenv = "D:/Apps/chai-rfpis/.venv/Scripts/python.exe";
const python = process.env.RFPIS_PYTHON
  || (existsSync(venv) ? venv : existsSync(mainVenv) ? mainVenv : "python");

let diffs = 0, checks = 0;
const J = (v) => JSON.stringify(v);
const same = (label, ts, pyv) => {
  checks++;
  if (J(ts) === J(pyv)) return;
  diffs++;
  if (diffs <= 40) console.log(`DIFF ${label}\n   ts: ${J(ts)}\n   py: ${J(pyv)}`);
};
const ok = (label, cond, detail = "") => {
  checks++;
  if (cond) return;
  diffs++;
  console.log(`DIFF ${label}${detail ? `\n   ${detail}` : ""}`);
};

let want;
try {
  want = JSON.parse(execFileSync(python, [path.join(here, "donors_py.py")], {
    input: "{}", encoding: "utf8", maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"],
  }));
} catch (e) {
  console.error(`\nThe Python side failed:\n${e.stderr || e.message}`);
  process.exit(2);
}

// Vite in middleware mode: resolution and transforms exactly as the app gets them, with
// no HTTP server and no browser.
const server = await createServer({
  root: webRoot,
  configFile: path.join(webRoot, "vite.config.ts"),
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
  logLevel: "error",
});
let M;
try {
  M = await server.ssrLoadModule("/src/donors/model.ts");
} finally {
  // Closed even on a throw, or the process hangs on the dev server's watcher.
  if (!M) await server.close();
}

try {
  // 1. Labels. A column name becomes a question somebody answers; the wrong label is a
  //    different question.
  for (const [col, expected] of Object.entries(want.labels)) {
    same(`label(${J(col)})`, M.label(col), expected);
  }

  // 2. Category folding — drives the chart, the filter and the table together.
  for (const c of want.categories) {
    same(`normalizeCategory(${J(c.raw)})`, M.normalizeCategory(c.raw), c.out);
  }

  // 3. toList: ";" and "," split, "/" does NOT.
  for (const c of want.lists) {
    same(`toList(${J(c.raw)})`, M.toList(c.raw), c.out);
  }

  // 4. disp / deshout.
  for (const c of want.disp) {
    same(`disp(${J(c.raw)})`, M.disp(c.raw), c.out);
  }

  // 5. prettyChoice.
  for (const c of want.pretty) {
    same(`prettyChoice(${J(c.raw)})`, M.prettyChoice(c.raw), c.out);
  }

  // 6. The derived denominator, on its own and before the percentages.
  const schema = M.buildSchema(want.rows);
  same("the flag list derived from the live columns", schema.flags, want.flags);
  same("the *_fit flags excluded from completeness",
    schema.groups["Program-area fit"], want.fit);

  // 7. Completeness and the title, over every live row.
  const byKey = new Map(want.rows.map((r) => [r.canonical_key, r]));
  for (const exp of want.completeness) {
    const row = byKey.get(exp.canonical_key);
    if (!row) continue;
    const got = M.completeness(row, schema);
    same(`completeness(${exp.canonical_key})`,
      { pct: got.pct, have: got.have, total: got.total },
      { pct: exp.pct, have: exp.have, total: exp.total });
    same(`titleName(${exp.canonical_key})`, M.titleName(row), exp.title);
    same(`category_clean(${exp.canonical_key})`,
      M.normalizeCategory(row.donor_category), exp.category_clean);
  }

  // 7b. The rounding rule on its own, against CONSTRUCTED ties.
  //
  // This block exists because swapping pyRound for Math.round in model.ts changed
  // NOTHING across every live donor — no row currently lands on a tie, so the live data
  // cannot tell half-to-even from half-up. It will the moment a migration changes the
  // denominator, and then one app would print 12% where the other prints 13% for the
  // same record, with nothing to point at. Half the probes below are ties.
  {
    const R = await server.ssrLoadModule(
      "/../supabase/functions/_shared/api/py_round.ts");
    for (const c of want.rounding) {
      same(`round(100 * ${c.have} / ${c.total})`,
        R.pyRound((100 * c.have) / c.total), c.pct);
    }
    const ties = want.rounding.filter((c) => ((100 * c.have) / c.total) % 1 === 0.5);
    ok("the rounding probes actually contain ties",
      ties.length >= 4,
      "without a tie this block proves only that two round() calls agree on the easy "
      + "cases, which is how the live-data comparison missed the rule entirely.");
    ok("at least one tie rounds DOWN, which is what half-to-even means",
      ties.some((c) => c.pct < Math.round((100 * c.have) / c.total)),
      "if every tie happens to round up, half-even and half-up agree on this fixture "
      + "set and the check is decorative.");
  }

  // 7d. THE SHARE DOCUMENT, line by line, over every live donor.
  //
  // This is the only donor output that LEAVES the product. A user copies it into an
  // email, downloads the markdown, or sends the PDF to a colleague who has no login and
  // cannot compare it with anything. Every other divergence in this file is one a reader
  // of both apps could spot; this one is read by the recipient and by nobody who could.
  //
  // It is also 115 lines of hand-ported layout that nothing compared until now, which is
  // how `Math.round` sat in projectLine where Python rounds half-to-even.
  {
    same("the flag GROUPS the summary reads", schema.groups, want.groups);
    for (const exp of want.summary) {
      const row = byKey.get(exp.canonical_key);
      if (!row) continue;
      const got = M.summaryLines(row, schema);
      // Compared as whole documents, then narrowed: a section inserted or dropped
      // shifts every later line, and forty "DIFF line 63" messages say less than one
      // that names the line that actually differs.
      if (J(got) === J(exp.lines)) { checks++; continue; }
      const at = got.findIndex((l, i) => l !== exp.lines[i]);
      same(`summaryLines(${exp.canonical_key}) line ${at} of ${exp.lines.length}`,
        got[at], exp.lines[at]);
    }

    // The same function over INVENTED rows: the ratings tie-break, the unclamped
    // int(), a priority area with no rating, and a ratings blob that will not parse.
    // None of these appears in the live table, and two of them were wrong.
    for (const p of want.summaryProbes) {
      const got = M.summaryLines(p.row, schema);
      if (J(got) === J(p.lines)) { checks++; continue; }
      const at = got.findIndex((l, i) => l !== p.lines[i]);
      same(`summaryLines(${p.row.canonical_key}) line ${at}`, got[at], p.lines[at]);
    }
    ok("a probe row stores a rating above 5",
      want.summaryProbes.some((p) => /— [6-9]\/5/.test(p.lines.join("\n"))),
      "int(v) does not clamp and the React port did. Without such a probe the two "
      + "agree on every value anybody has actually stored, which is how it survived.");
    ok("a probe row has two priority areas that tie on rating",
      want.summaryProbes.some((p) => {
        const r = p.lines.filter((l) => l.startsWith("- **Priority:**"));
        return r.length >= 2 && new Set(r.map((l) => l.slice(-4))).size < r.length;
      }),
      "the tie-break is the only part of the sort the comparator can get wrong.");
    ok("the empty probe produces a title and nothing else",
      want.summaryProbes.some((p) => p.row.canonical_key === "probe_empty"
        && p.lines.length === 2),
      "a donor with no data must share as a name, not as a page of empty headings.");

    for (const c of want.projectLines) {
      same(`projectLine(${J(c.rec)})`, M.projectLine(c.rec), c.out);
    }
    ok("the project probes contain an amount that rounds half-to-even",
      want.projectLines.some((c) => {
        const n = Number(c.rec.amount);
        return Number.isFinite(n) && Math.abs(n % 1) === 0.5 && c.out.includes(String(Math.floor(n)));
      }),
      "without one, Math.round and Python's ,.0f agree on every probe and this block "
      + "proves nothing about the rule that was actually wrong.");

    for (const c of want.tierLines) {
      same(`tierLine(${J(c.rec)})`, M.tierLine(c.rec), c.out);
    }
    for (const c of want.contactLines) {
      same(`contactLine(${J(c.rec)})`, M.contactLine(c.rec), c.out);
    }
    for (const c of want.shareFilenames) {
      same(`shareFilename(${J(c.row)}, pdf)`, M.shareFilename(c.row, "pdf"), c.pdf);
      same(`shareFilename(${J(c.row)}, md)`, M.shareFilename(c.row, "md"), c.md);
    }
    for (const c of want.shareMarkdown) {
      const row = byKey.get(c.canonical_key);
      if (!row) continue;
      // The contacts fixture is the Python side's own probe list, so this pins the
      // FLATTENING — the hard break becoming an em-dash and the `$` escape coming back
      // out — as well as the block's position after the last section.
      const contacts = want.contactLines.map((p) => p.rec);
      same(`shareMarkdown(${c.canonical_key}) with contacts`,
        M.shareMarkdown(row, schema, contacts), c.md);
    }
    ok("the share markdown carries no leftover Streamlit escapes",
      want.shareMarkdown.every((c) => !c.md.includes("\\$")),
      "`contactLine` escapes `$` because st.markdown reads `$…$` as LaTeX. A file or an "
      + "email is not Streamlit, so the escape has to come back out — otherwise the "
      + "recipient reads 'Budget \\$5,000'.");
  }

  // 7bis. THE FORM'S FIELD COVERAGE, against the Streamlit dialog's own AST.
  //
  // This is the check this file exists for now. A field missing from a form does not
  // look like a bug — it looks like a donor nobody has filled in, and the completeness
  // percentage agrees with that reading. So the React spec is compared against every
  // `edited[...]` column `_edit_dialog` writes, and a field added on one side fails here
  // rather than going quietly missing on the other.
  {
    const S = await server.ssrLoadModule("/src/donors/formSpec.ts");
    const spec = new Set(S.SPEC_COLUMNS);
    const python = new Set(want.editedColumns);

    // Columns the React form deliberately does not edit. Each one is listed here so that
    // "not in the form" is a decision with a reason, not an omission nobody noticed.
    const DELIBERATE = new Map([
      ["donor_priority_ratings",
        "React has no per-area rating matrix. The column is OMITTED from the payload so "
        + "the upsert leaves it alone — sending an empty object would wipe the ratings."],
    ]);

    const missing = [...python].filter((c) => !spec.has(c) && !DELIBERATE.has(c));
    ok("the React form covers every field the Streamlit dialog edits",
      missing.length === 0,
      missing.length ? `absent from formSpec.ts: ${missing.join(", ")}` : "");

    const extra = [...spec].filter((c) => !python.has(c));
    ok("...and invents none that the Streamlit dialog does not",
      extra.length === 0,
      extra.length
        ? `in formSpec.ts but not written by _edit_dialog: ${extra.join(", ")}`
        : "a column the Python form does not write is one the save would send and the "
          + "column intersection would then silently drop.");

    for (const [col, why] of DELIBERATE) {
      ok(`${col} is still deliberately out of the form`,
        python.has(col) && !spec.has(col),
        why + " If the Python stopped writing it, this exception should go too.");
    }

    ok("no spec field is listed twice",
      new Set(S.SPEC_COLUMNS).size === S.SPEC_COLUMNS.length,
      "a duplicated column renders two controls that overwrite each other.");

    ok("the spec is not trivially empty",
      S.SPEC_COLUMNS.length > 50,
      "an empty spec would make the coverage comparison pass by matching nothing.");
  }

  // 7c. The write seam. These routes apply no rules — they queue a donor_action job —
  //     so what is worth pinning is the SHAPE of what they queue. Each of these has a
  //     failure that is silent rather than loud.
  {
    const R = await server.ssrLoadModule(
      "/../supabase/functions/_shared/api/routes_donors.ts");
    const sent = [];
    const enqueue = (kind, params) => {
      sent.push({ kind, params });
      return Promise.resolve({ id: "job-1", dispatched: true });
    };
    const routes = R.createDonorWriteRoutes(null, enqueue);
    const ctx = { user: { email: "someone@example.org" } };
    const post = (b) => new Request("http://x/donors", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });

    sent.length = 0;
    await routes.update(post({ edited: { donor: "X" } }), ctx, "gates");
    ok("an edit queues donor_action, and applies nothing here",
      sent.length === 1 && sent[0].kind === "donor_action"
      && sent[0].params.action === "save" && sent[0].params.canonical_key === "gates",
      "the save rules live in core/donor_write.py so the runner and Streamlit share "
      + "them; a route that wrote directly would be the second copy.");

    ok("an ABSENT contacts list is not sent as an empty one",
      !("contacts" in sent[0].params),
      "the runner REPLACES a donor's contacts with what it is given. Sending [] for "
      + "'this form did not show contacts' would delete every focal person they have.");

    sent.length = 0;
    await routes.update(post({ edited: { donor: "X" }, contacts: [] }), ctx, "gates");
    ok("...but an explicit empty list still is",
      Array.isArray(sent[0].params.contacts) && sent[0].params.contacts.length === 0,
      "clearing the last contact has to be expressible.");

    sent.length = 0;
    const empty = await routes.update(post({ edited: {} }), ctx, "gates");
    ok("an edit that changes nothing is refused rather than queued",
      empty.status === 400 && sent.length === 0,
      "a job with an empty payload still reports 'Saved', and somebody who watched it "
      + "succeed would believe their change landed.");

    sent.length = 0;
    await routes.update(post({ edited: { donor: "X" }, suggest: true }), ctx, "gates");
    ok("the suggest flag picks the proposal action, not the write",
      sent[0].params.action === "suggest");

    sent.length = 0;
    await routes.create(post({ name: "  New Funder  " }), ctx);
    ok("a create trims the name and queues an add",
      sent[0].params.action === "add" && sent[0].params.name === "New Funder");

    sent.length = 0;
    const noName = await routes.create(post({ name: "   " }), ctx);
    ok("a create with no name is refused",
      noName.status === 400 && sent.length === 0);

    sent.length = 0;
    await routes.remove(post({}), ctx, "gates");
    ok("a single delete queues one key",
      sent[0].params.action === "delete"
      && JSON.stringify(sent[0].params.keys) === JSON.stringify(["gates"]));

    sent.length = 0;
    const noKeys = await routes.remove(post({ keys: ["", "  "] }), ctx, null);
    ok("a bulk delete with no usable keys is refused",
      noKeys.status === 400 && sent.length === 0,
      "a delete with no filter would empty the shared catalogue.");

    sent.length = 0;
    const undispatched = R.createDonorWriteRoutes(
      null, () => Promise.resolve({ id: "job-2", dispatched: false }));
    const resp = await undispatched.update(post({ edited: { donor: "X" } }), ctx, "g");
    const payload = await resp.json();
    ok("a queued-but-undispatched job says so instead of reporting success",
      /nothing has been changed/i.test(payload.detail),
      "this is the worst failure mode this product has: nothing errors, the job just "
      + "sits at 'queued' for ever.");

    const none = R.createDonorWriteRoutes(null, null);
    ok("with no runner configured the route refuses rather than pretending",
      (await none.update(post({ edited: { donor: "X" } }), ctx, "g")).status === 503);

    // The PDF route. The one here that queues a READ, and the shape worth pinning is
    // that it does NOT look like the write routes.
    sent.length = 0;
    await routes.pdf(post({ keys: ["gates", " ", "wellcome"] }), ctx);
    ok("a PDF request queues donor_pdf, not donor_action",
      sent.length === 1 && sent[0].kind === "donor_pdf",
      "donor_action's first act is to ask whether the actor may EDIT the shared "
      + "catalogue. A reader asking for a printout of what is already on their screen "
      + "must never be refused on that question.");
    ok("...with the blank keys dropped",
      JSON.stringify(sent[0].params.keys) === JSON.stringify(["gates", "wellcome"]));
    ok("...and the requester named, since the runner has no session",
      sent[0].params.by === "someone@example.org");

    sent.length = 0;
    const noDonors = await routes.pdf(post({ keys: [] }), ctx);
    ok("a PDF of nothing is refused rather than queued",
      noDonors.status === 400 && sent.length === 0);

    sent.length = 0;
    const tooMany = await routes.pdf(
      post({ keys: Array.from({ length: 51 }, (_, i) => `d${i}`) }), ctx);
    ok("a PDF of more donors than the runner's budget is refused UP FRONT",
      tooMany.status === 400 && sent.length === 0,
      "the runner has six minutes and each donor is a page or more of flowables. A job "
      + "killed half-way leaves nothing to download and no explanation.");

    sent.length = 0;
    await routes.pdf(post({ keys: ["gates"], contacts: false }), ctx);
    ok("contacts can be turned off for a bulk render",
      sent[0].params.contacts === false,
      "a combined PDF would otherwise do one donor_contacts read per donor.");
    sent.length = 0;
    await routes.pdf(post({ keys: ["gates"] }), ctx);
    ok("...but they are ON by default",
      sent[0].params.contacts === true,
      "a shared profile missing its focal persons looks like a donor with none.");

    const noPdfRunner = await none.pdf(post({ keys: ["gates"] }), ctx);
    ok("with no runner configured the PDF route refuses too",
      noPdfRunner.status === 503);
  }

  // 7e. The job kind has to exist on the Edge Function's side as well, or `enqueue`
  //     returns null and the caller is told "unknown job kind" for work that exists.
  //     (check-submit compares the whole list against the runner's KINDS; this names
  //     the one this file is about, so a failure here points at the right file.)
  {
    const JR = await server.ssrLoadModule(
      "/../supabase/functions/_shared/api/routes_jobs.ts");
    const kinds = JR.jobKinds();
    ok("donor_pdf is a kind this API will queue", kinds.includes("donor_pdf"));
    ok("donor_action still is", kinds.includes("donor_action"));
  }

  // 8. Claims worth stating outright, which a value-by-value comparison would not catch
  //    if both sides happened to be empty.
  ok("the live table actually produced rows to compare",
    want.rows.length > 0,
    "an empty donor_intel read would let every comparison above pass vacuously.");
  ok("some column was classified as a flag",
    schema.flags.length > 0,
    "a flag list of zero would make every completeness denominator agree trivially.");
  ok("the completeness denominator is the same for every donor",
    new Set(want.completeness.map((c) => c.total)).size <= 1,
    "the denominator comes from the table's columns, not from the row — if it varies "
    + "per donor, one of the two sides is reading per-row keys instead of the schema.");
  ok("a percentage is a percentage",
    want.completeness.every((c) => c.pct >= 0 && c.pct <= 100),
    "");
} finally {
  await server.close();
}

console.log(`\n${checks} comparisons, ${diffs} differing`);
process.exit(diffs ? 1 : 0);
