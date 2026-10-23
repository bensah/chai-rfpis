// Build the RFPIS team-training deck (assets/help/RFPIS_Training_Deck.pptx).
//
//   npm install pptxgenjs@3.12.0 jszip     (once, anywhere on NODE_PATH)
//   node docs/user-manual/build_deck.js
//
// Uses the same screenshots as the manual (docs/user-manual/img). Tenant-agnostic:
// the example organisation is "RFPIS APP", the example address user@example.com.
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");

const HERE = __dirname;
const IMG = (n) => path.join(HERE, "img", `${n}.jpg`);
const OUT = path.join(HERE, "..", "..", "assets", "help", "RFPIS_Training_Deck.pptx");

const THEME = {
  name: "RFPIS",
  headFontFace: "Calibri",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "1B1F24", lt1: "FFFFFF", dk2: "14254F", lt2: "F4F7F5",
    accent1: "00703C", accent2: "1F3A7A", accent3: "E6F2EB",
    accent4: "A15C00", accent5: "A4262C", accent6: "9FD8B8",
    hlink: "00703C", folHlink: "1F3A7A",
  },
};

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
pres.title = "RFPIS Team Training";
pres.author = "RFPIS";
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;
const W = 13.333;

// ── Layouts ────────────────────────────────────────────────────────────────
pres.defineSlideMaster({
  title: "DARK_TITLE",
  background: { color: C.text2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.35, w: 9.2, h: 1.5,
        fontSize: 48, bold: true, color: C.background1, valign: "bottom", align: "left", margin: 0 },
      text: "Title" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.0, w: 9.2, h: 1.4,
        fontSize: 20, color: C.accent6, valign: "top", align: "left", margin: 0 }, text: "Subtitle" } },
  ],
});

pres.defineSlideMaster({
  title: "SECTION",
  background: { color: C.accent1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.9, w: 11.5, h: 1.2,
        fontSize: 40, bold: true, color: C.background1, align: "left", margin: 0 }, text: "Section" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.15, w: 11.5, h: 0.9,
        fontSize: 20, color: C.background1, align: "left", margin: 0 }, text: "What this part covers" } },
  ],
});

pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: C.background1 },
  margin: [0.5, 0.6, 0.6, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.35, w: 12.1, h: 0.85,
        fontSize: 32, bold: true, color: C.text2, valign: "middle", align: "left", margin: 0 }, text: "Title" } },
    { text: { text: "RFPIS · Team training", options: { x: 0.6, y: 7.0, w: 5, h: 0.3,
        fontSize: 10, color: "8A94A3", margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 7.0, w: 0.5, h: 0.3, fontSize: 10, color: "8A94A3", align: "right" },
});

// ── Helpers ────────────────────────────────────────────────────────────────
const SHOT_RATIO = 1125 / 1800;

function shot(slide, name, x, y, w, label) {
  const h = w * SHOT_RATIO;
  slide.addShape(pres.shapes.RECTANGLE, {
    x: x - 0.02, y: y - 0.02, w: w + 0.04, h: h + 0.04,
    fill: { color: C.background1 }, line: { color: "D5DBE2", width: 1 },
    shadow: { type: "outer", color: "14254F", opacity: 0.18, blur: 10, offset: 3, angle: 90 },
    objectName: `frame-${name}`,
  });
  slide.addImage({ path: IMG(name), x, y, w, h, objectName: `shot-${name}`,
    altText: label || name });
  if (label) {
    slide.addText(label, { x, y: y + h + 0.08, w, h: 0.3, fontSize: 11, color: "5B6573",
      align: "center", italic: true, isTextBox: true, margin: 0 });
  }
  return h;
}

function steps(slide, items, x, y, w, opts = {}) {
  const gap = opts.gap || 0.66;
  const size = opts.size || 15;
  items.forEach((it, i) => {
    const yy = y + i * gap;
    slide.addShape(pres.shapes.OVAL, { x, y: yy, w: 0.4, h: 0.4,
      fill: { color: C.accent1 }, line: { color: C.accent1 }, objectName: `step-dot-${i + 1}` });
    slide.addText(String(i + 1), { x, y: yy, w: 0.4, h: 0.4, fontSize: 14, bold: true,
      color: C.background1, align: "center", valign: "middle", margin: 0, isTextBox: true });
    slide.addText(it, { x: x + 0.55, y: yy - 0.06, w: w - 0.55, h: gap, fontSize: size,
      color: C.text1, valign: "top", margin: 0, isTextBox: true });
  });
  return y + items.length * gap;
}

// tone: "green" | "amber" | "blue"
function callout(slide, title, body, x, y, w, h, tone = "green") {
  const fills = { green: "E6F2EB", amber: "FFF4E0", blue: "EEF3FB" };
  const lines = { green: "CFE6DA", amber: "F3D9A8", blue: "D6E1F3" };
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12,
    fill: { color: fills[tone] }, line: { color: lines[tone], width: 1 }, objectName: `callout-${tone}` });
  slide.addText([
    { text: title, options: { bold: true, breakLine: true, color: tone === "amber" ? C.accent4 : C.text2 } },
    { text: body, options: { color: C.text1 } },
  ], { x: x + 0.2, y: y + 0.12, w: w - 0.4, h: h - 0.24, fontSize: 14, valign: "top",
    margin: 0, isTextBox: true, paraSpaceAfter: 4 });
}

function tag(slide, text, x, y, tone = "amber") {
  const fill = tone === "amber" ? "FFF4E0" : "E6F2EB";
  const color = tone === "amber" ? C.accent4 : C.accent1;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 1.55, h: 0.34, rectRadius: 0.17,
    fill: { color: fill }, line: { color: fill } });
  slide.addText(text, { x, y, w: 1.55, h: 0.34, fontSize: 11, bold: true, color,
    align: "center", valign: "middle", margin: 0, isTextBox: true, charSpacing: 1 });
}

function content(section, title) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  return s;
}

function divider(section, title, sub) {
  pres.addSection({ title: section });
  const s = pres.addSlide({ masterName: "SECTION", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  s.addText(sub, { placeholder: "body" });
  rings(s, 11.2, 3.75, C.background1);
  return s;
}

// The deck's motif: concentric rings, the same mark as the manual's cover.
function rings(slide, cx, cy, color) {
  [3.2, 2.4, 1.6].forEach((d, i) => slide.addShape(pres.shapes.OVAL, {
    x: cx - d / 2, y: cy - d / 2, w: d, h: d, fill: { type: "none" },
    line: { color, width: 1.5, transparency: 40 + i * 10 }, objectName: `ring-${i}` }));
  slide.addShape(pres.shapes.OVAL, { x: cx - 0.4, y: cy - 0.4, w: 0.8, h: 0.8,
    fill: { color, transparency: 20 }, line: { color, transparency: 20 }, objectName: "ring-core" });
}

// ── 1. Opening ─────────────────────────────────────────────────────────────
pres.addSection({ title: "Opening" });
{
  const s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Opening" });
  s.addText("RFPIS Team Training", { placeholder: "title" });
  s.addText("Find, screen and decide on funding opportunities — together, every week.",
    { placeholder: "body" });
  rings(s, 10.6, 2.2, C.accent6);
  s.addText("RFPIS · RFP Intelligence System", { x: 0.8, y: 6.4, w: 8, h: 0.4, fontSize: 14,
    color: C.accent6, bold: true, margin: 0, isTextBox: true, charSpacing: 2 });
  s.addNotes("Welcome. This session takes about 45 minutes. By the end everyone should be able to "
    + "run the Eligibility Scan, update a decision, search, submit an RFP the scan missed, and "
    + "capture meeting notes and actions. The full user manual is under Help in the app.");
}
{
  const s = content("Opening", "What we'll cover today");
  const items = [
    ["How RFPIS works", "Where opportunities come from, and your part in it"],
    ["Getting started", "Sign in, find your way around, read the alerts"],
    ["Screening & decisions", "Run the Eligibility Scan, review, update a decision"],
    ["Finding more", "Search inside RFPIS and the web; submit what the scan missed"],
    ["Team meetings", "Meeting notes, actions, engagements and follow-ups"],
    ["Reports & help", "Generate a report; where the manual lives"],
  ];
  items.forEach(([h, b], i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.6 + col * 4.1, y = 1.55 + row * 2.6;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 3.8, h: 2.3, rectRadius: 0.12,
      fill: { color: C.background2 }, line: { color: "E3E7EC" }, objectName: `agenda-${i + 1}` });
    s.addShape(pres.shapes.OVAL, { x: x + 0.25, y: y + 0.25, w: 0.55, h: 0.55,
      fill: { color: C.accent1 }, line: { color: C.accent1 } });
    s.addText(String(i + 1), { x: x + 0.25, y: y + 0.25, w: 0.55, h: 0.55, fontSize: 18, bold: true,
      color: C.background1, align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(h, { x: x + 0.25, y: y + 0.95, w: 3.3, h: 0.45, fontSize: 19, bold: true,
      color: C.text2, margin: 0, isTextBox: true });
    s.addText(b, { x: x + 0.25, y: y + 1.4, w: 3.3, h: 0.75, fontSize: 14, color: "5B6573",
      margin: 0, valign: "top", isTextBox: true });
  });
  s.addNotes("Six parts. The two the team will use most are Screening & decisions, and Team meetings.");
}

// ── 2. How RFPIS works ─────────────────────────────────────────────────────
divider("How RFPIS works", "How RFPIS works", "Where opportunities come from, and where you come in");
{
  const s = content("How RFPIS works", "From the web to a team decision");
  const nodes = [
    ["SUPER USER", "Extraction", "A separate crawl of every donor source, run by the platform owner", "FDECEE", C.accent5],
    ["AUTOMATIC", "Friday scan", "Every Friday 06:00 UTC the sources are crawled again", "FDECEE", C.accent5],
    ["YOU ARE ALERTED", "New calls ready", "The bell shows “Scan completed”; an email lists new Proceed / Park calls", "F4F7F5", C.accent1],
    ["YOU", "Eligibility Scan", "Screens the raw records against your organisation", "E6F2EB", C.accent1],
    ["THE TEAM", "Review & decide", "Proceed, Park or Decline — then track it", "E6F2EB", C.accent1],
  ];
  const nw = 2.25, gap = 0.2;
  nodes.forEach(([k, h, b, fill, kc], i) => {
    const x = 0.6 + i * (nw + gap), y = 1.7;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: nw, h: 2.6, rectRadius: 0.12,
      fill: { color: fill }, line: { color: "CFE6DA", width: 1.25 }, objectName: `flow-${i + 1}` });
    s.addText(k, { x: x + 0.18, y: y + 0.2, w: nw - 0.36, h: 0.3, fontSize: 11, bold: true,
      color: kc, margin: 0, isTextBox: true, charSpacing: 1 });
    s.addText(h, { x: x + 0.18, y: y + 0.55, w: nw - 0.36, h: 0.5, fontSize: 18, bold: true,
      color: C.text2, margin: 0, isTextBox: true });
    s.addText(b, { x: x + 0.18, y: y + 1.1, w: nw - 0.36, h: 1.35, fontSize: 14, color: "5B6573",
      margin: 0, valign: "top", isTextBox: true });
    if (i < nodes.length - 1) {
      s.addText("›", { x: x + nw - 0.02, y: y + 1.0, w: 0.24, h: 0.5, fontSize: 26, bold: true,
        color: C.accent1, align: "center", valign: "middle", margin: 0, isTextBox: true,
        objectName: `arrow-${i + 1}` });
    }
  });
  callout(s, "Raw records vs. your pipeline",
    "Raw records are every call the crawl found — all countries, all themes, before any screening. "
    + "They sit in one shared pool. The Eligibility Scan reads that pool against YOUR organisation's "
    + "rules and adds only what fits to your pipeline.", 0.6, 4.75, 12.1, 1.55, "blue");
  s.addNotes("Two separate jobs. Collecting is done for us: the Super User runs a separate extraction "
    + "elsewhere, and the Friday cron at 06:00 UTC crawls again. When raw records are ready you get "
    + "alerted in the bell, and everyone gets an email listing new Proceed / Park calls. Then it's on us to run the Eligibility Scan.");
}
{
  const s = content("How RFPIS works", "The weekly rhythm");
  const days = [
    ["FRIDAY", "Scan runs", "The automatic scan refreshes the store. Watch the bell and your inbox."],
    ["FRIDAY – SUNDAY", "Screen & submit", "Run the Eligibility Scan. Submit any RFP you found outside the scan."],
    ["MONDAY CALL", "Team meeting", "Walk through Screen, agree decisions, capture notes and actions."],
    ["MID-WEEK", "Follow through", "Work the Track tab, log donor engagements, close pending actions."],
  ];
  days.forEach(([d, h, b], i) => {
    const x = 0.6 + i * 3.08;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 1.75, w: 2.85, h: 3.6, rectRadius: 0.12,
      fill: { color: i === 2 ? C.accent3 : C.background2 }, line: { color: "E3E7EC" }, objectName: `day-${i + 1}` });
    s.addText(d, { x: x + 0.25, y: 2.0, w: 2.4, h: 0.3, fontSize: 12, bold: true, color: C.accent1,
      margin: 0, isTextBox: true, charSpacing: 1 });
    s.addText(h, { x: x + 0.25, y: 2.4, w: 2.4, h: 0.55, fontSize: 22, bold: true, color: C.text2,
      margin: 0, isTextBox: true });
    s.addText(b, { x: x + 0.25, y: 3.1, w: 2.4, h: 2.0, fontSize: 15, color: "5B6573",
      margin: 0, valign: "top", isTextBox: true });
  });
  s.addText("The Monday call is where most of us work in RFPIS — decisions, notes and actions.",
    { x: 0.6, y: 5.75, w: 12.1, h: 0.5, fontSize: 16, italic: true, color: C.accent1, margin: 0, isTextBox: true });
  s.addNotes("Anchor the week: Friday scan, weekend screening and submissions, Monday team call, "
    + "mid-week follow-through.");
}
{
  const s = content("How RFPIS works", "Roles: what you can and can't do");
  const hdr = ["What you want to do", "Contributor", "Reviewer", "Admin", "Super User"]
    .map((t) => ({ text: t, options: { bold: true, color: C.text2, fill: { color: C.background2 } } }));
  const Y = "✓", N = "—";
  const rows = [
    ["Run the Eligibility Scan, search, read the pipeline", Y, Y, Y, Y],
    ["Submit an RFP, update a decision, edit an RFP", Y, Y, Y, Y],
    ["Log engagements, resolve pending actions, reports", Y, Y, Y, Y],
    ["Add, edit and resolve meeting notes", Y, Y, Y, Y],
    ["Delete an RFP; edit the organisation profile", N, N, Y, Y],
    ["Open Settings: users, scan preferences, records", N, N, Y, Y],
    ["Run the full Extraction; manage organisations", N, N, N, Y],
  ].map((r) => r.map((c, j) => ({ text: c, options: j === 0 ? {} : {
    align: "center", bold: c === Y, color: c === Y ? C.accent1 : "B0B7C0" } })));
  s.addTable([hdr, ...rows], { x: 0.6, y: 1.5, w: 12.1, colW: [5.7, 1.6, 1.6, 1.6, 1.6],
    fontSize: 14, color: C.text1, border: { type: "solid", pt: 0.75, color: "E3E7EC" },
    rowH: 0.52, valign: "middle", margin: 0.08 });
  callout(s, "See a greyed-out button?",
    "Your role doesn't allow it. Ask your administrator — Settings → Accounts → Users.",
    0.6, 5.85, 12.1, 0.85, "amber");
  s.addNotes("Most of the team are Contributors or Reviewers. Anyone can take, edit and resolve "
    + "meeting notes, whatever their role.");
}

// ── 3. Getting started ─────────────────────────────────────────────────────
divider("Getting started", "Getting started", "Sign in, find your way around, read the alerts");
{
  const s = content("Getting started", "Activate your account, then sign in");
  steps(s, [
    "Open the “Activate your RFPIS APP account” email (sent to e.g. user@example.com)",
    "Click Activate my account — the link works for 7 days",
    "Choose your password twice → Save password → Go to sign in",
    "Sign in: Username = your email, then your password → Login",
    "Forgot it? Forgot password? → Request password reset (an admin approves it)",
  ], 0.6, 1.6, 5.6, { gap: 0.95 });
  shot(s, "01-login", 6.6, 1.55, 6.1, "The sign-in screen");
  s.addNotes("Nobody signs themselves up — admins create accounts and RFPIS emails the invitation. "
    + "A session lasts about 8 hours.");
}
{
  const s = content("Getting started", "Finding your way around");
  shot(s, "06-sidebar", 0.6, 1.5, 7.4);
  const bx = 8.4;
  callout(s, "Left sidebar", "Home · Pipelines · Grants · Actions · Report · Donors · Tenant · Submit. "
    + "Your role is at the bottom.", bx, 1.5, 4.3, 1.45, "green");
  callout(s, "Top bar", "Search · Notifications bell · Person menu (Help, Tenant, Profile, Sign Out).",
    bx, 3.15, 4.3, 1.3, "blue");
  callout(s, "Admins only", "Settings appears in the sidebar and person menu for administrators only.",
    bx, 4.65, 4.3, 1.3, "amber");
  s.addNotes("Click the double-arrow at the top of the sidebar to expand labels. Most pages have tabs "
    + "along the top — that's where the detail lives.");
}
{
  const s = content("Getting started", "The bell is your alert");
  shot(s, "08-bell", 0.6, 1.5, 7.4);
  steps(s, [
    "A red number = new items since you last looked",
    "Next auto-scan: Friday 06:00 UTC; Next call: this week's rota",
    "“Scan completed” → raw records are ready: go and run the Eligibility Scan",
    "“New opportunity” → a teammate submitted an RFP",
    "Mark all as read clears the count",
  ], 8.4, 1.6, 4.3, { gap: 0.95, size: 14 });
  s.addNotes("This is how you know raw records are ready. The new-opportunities email is the other signal (next slide).");
}

{
  const s = content("Getting started", "The new-opportunities email");
  // Portrait capture (1140 x 1197 px): fit by height.
  const h = 5.25, w = h * 1140 / 1197;
  s.addShape(pres.shapes.RECTANGLE, { x: 0.58, y: 1.43, w: w + 0.04, h: h + 0.04,
    fill: { color: C.background1 }, line: { color: "D5DBE2", width: 1 },
    shadow: { type: "outer", color: "14254F", opacity: 0.18, blur: 10, offset: 3, angle: 90 },
    objectName: "frame-email" });
  s.addImage({ path: IMG("40-email-digest"), x: 0.6, y: 1.45, w, h, objectName: "shot-email",
    altText: "New funding opportunities email" });
  steps(s, [
    "Sent after the Friday scan, when it adds Proceed or Park calls for your organisation",
    "Counts at the top: Proceed, Park, Declined",
    "Each call: funder, amount, deadline, Bid Strength and a short note",
    "Open in RFPIS lands on that opportunity (sign in first if asked)",
    "No Proceed or Park calls that week? No email",
  ], 6.3, 1.6, 6.4, { gap: 0.95, size: 15 });
  s.addNotes("Everyone in the organisation gets this from the RFPIS no-reply address. Ratings are the "
    + "system's suggestion until the team updates the decision on Monday.");
}

// ── 4. Screening & decisions ───────────────────────────────────────────────
divider("Screening & decisions", "Screening & decisions", "Run the Eligibility Scan, review, update a decision");
{
  const s = content("Screening & decisions", "Run the Eligibility Scan");
  tag(s, "KEY TASK", 11.15, 0.6, "green");
  steps(s, [
    "Open Pipelines — stay on the Screen tab",
    "Click 🎯 Eligibility Scan (top right, beside Submit New Funding)",
    "Wait while it shows ⏳ Scanning… — seconds, no web crawl",
    "Read the banner: “… → 8 eligible for your org (5 newly added …)”",
    "Scroll down: the new opportunities are in this review week",
  ], 0.6, 1.6, 5.4, { gap: 0.95 });
  shot(s, "10-screen-top", 6.4, 1.55, 6.3, "Pipelines → Screen");
  callout(s, "Run it as often as you like", "Calls already in your pipeline are never added twice.",
    0.6, 6.25, 5.4, 0.7, "green");
  s.addNotes("Any team member can run this. It doesn't crawl the web — it screens the shared store of "
    + "raw records against our organisation's eligibility rules. The full Extraction is different: "
    + "it takes 20-40 minutes and only the Super User runs it.");
}
{
  const s = content("Screening & decisions", "Read the Screen tab");
  shot(s, "12-screen-table", 0.6, 1.5, 7.4);
  steps(s, [
    "Pick the Review week (defaults to this week)",
    "Optional: Filters — decision, feasibility, geography, program area",
    "Counters: Total Screened, Proceed, Parked, Declined",
    "Table: score, Auto-rec (system) vs Decision (team), key risks",
  ], 8.4, 1.6, 4.3, { gap: 1.05, size: 14 });
  s.addNotes("This is what the chair puts on screen at the start of the Monday call.");
}
{
  const s = content("Screening & decisions", "How an opportunity is scored");
  s.addText("Nine criteria. Five MUSTs carry 65% of the score; four PREFERs carry 35%.",
    { x: 0.6, y: 1.45, w: 12.1, h: 0.5, fontSize: 18, color: C.text1, margin: 0, isTextBox: true });
  const v = [
    ["Proceed", "90+", "Pursue it", "E7F4EC", C.accent1],
    ["Park", "70–89", "Worth a human look", "FFF6E2", C.accent4],
    ["Decline", "<70", "Or a fatal eligibility gate", "FDECEE", C.accent5],
  ];
  v.forEach(([h, n, b, fill, col], i) => {
    const x = 0.6 + i * 4.1;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y: 2.2, w: 3.8, h: 2.3, rectRadius: 0.12,
      fill: { color: fill }, line: { color: fill }, objectName: `verdict-${h}` });
    s.addText(n, { x: x + 0.3, y: 2.35, w: 3.2, h: 1.0, fontSize: 54, bold: true, color: col, margin: 0, isTextBox: true });
    s.addText(h, { x: x + 0.3, y: 3.4, w: 3.2, h: 0.45, fontSize: 22, bold: true, color: C.text2, margin: 0, isTextBox: true });
    s.addText(b, { x: x + 0.3, y: 3.85, w: 3.2, h: 0.4, fontSize: 14, color: "5B6573", margin: 0, isTextBox: true });
  });
  s.addText([
    { text: "MUSTs: ", options: { bold: true, color: C.text2 } },
    { text: "legal status · strategic fit · implementation capacity · geographic fit · co-financing & compliance", options: { breakLine: true } },
    { text: "PREFERs: ", options: { bold: true, color: C.text2 } },
    { text: "funding quality · donor relationship · competitiveness · bid effort" },
  ], { x: 0.6, y: 4.85, w: 12.1, h: 0.9, fontSize: 15, color: C.text1, margin: 0, isTextBox: true, paraSpaceAfter: 6 });
  callout(s, "People outrank the system",
    "Correct any criterion in Update Decision and the score follows. A human who has read the call knows best.",
    0.6, 5.95, 12.1, 0.8, "green");
  s.addNotes("“Not scored” means the call said nothing — it takes the Park midpoint instead of counting "
    + "against us. A fatal gate is a structural ineligibility that can't be fixed before the deadline.");
}
{
  const s = content("Screening & decisions", "Update a decision");
  tag(s, "KEY TASK", 11.15, 0.6, "green");
  steps(s, [
    "Pipelines → Review: pick the week, then the RFP",
    "Read Key details, Bid Strength and the Eligibility criteria",
    "Click ✏ Update Decision; fix any criterion the system got wrong",
    "Set Decline flags, Key risks, the Decision: Proceed / Park / Decline",
    "Write the rationale (2–3 lines); answer Donor already engaged?",
    "Click 💾 Save changes",
  ], 0.6, 1.6, 5.4, { gap: 0.82 });
  shot(s, "16-update-decision", 6.4, 1.55, 6.3, "Review → Update Decision");
  callout(s, "Proposal lead, next action, deadline?", "Use ✏️ Edit RFP beside Update Decision.",
    0.6, 6.25, 5.4, 0.7, "blue");
  s.addNotes("Every team member can update a decision. Deleting an RFP is admin-only — decline it instead.");
}

// ── 5. Finding more ────────────────────────────────────────────────────────
divider("Finding more", "Finding more", "Search inside RFPIS and the web; submit what the scan missed");
{
  const s = content("Finding more", "Search: inside RFPIS and on the web");
  tag(s, "KEY TASK", 11.15, 0.6, "green");
  shot(s, "20-search", 0.6, 1.5, 7.0);
  s.addText("Inside RFPIS", { x: 8.0, y: 1.5, w: 4.7, h: 0.4, fontSize: 18, bold: true, color: C.text2, margin: 0, isTextBox: true });
  steps(s, [
    "Click 🔍 in the top bar, type 2+ characters, Search",
    "Results: Pages & tabs · Opportunities · Donors",
  ], 8.0, 2.0, 4.7, { gap: 0.75, size: 14 });
  s.addText("On the web", { x: 8.0, y: 3.65, w: 4.7, h: 0.4, fontSize: 18, bold: true, color: C.text2, margin: 0, isTextBox: true });
  steps(s, [
    "Full search page → 🌐 Search the web for “…”",
    "Rate results 👍 😐 👎 to sharpen future searches",
    "Real call? ➕ Track adds and scores it",
  ], 8.0, 4.15, 4.7, { gap: 0.75, size: 14 });
  s.addNotes("Search first before submitting anything — it may already be in RFPIS.");
}
{
  const s = content("Finding more", "Submit an RFP you found elsewhere");
  tag(s, "KEY TASK", 11.15, 0.6, "green");
  steps(s, [
    "Pipelines → Screen → 📝 Submit New Funding",
    "1 · Title*, Donor*, deadline, link (URL), value, Lead applicant*",
    "2 · Nine eligibility questions — “Not sure” is fine",
    "3 · Decline flags*  ·  4 · Bid decision*  ·  5 · Proposal lead*",
    "Click Submit RFP → “Submitted as UID — alignment score X/100”",
  ], 0.6, 1.6, 5.6, { gap: 0.95 });
  shot(s, "21-submit", 6.6, 1.55, 6.1, "📝 Submit New RFP");
  callout(s, "Always paste the link", "It lets RFPIS share the call with other organisations and recheck it.",
    0.6, 6.25, 5.6, 0.7, "amber");
  s.addNotes("For calls forwarded by colleagues or published on a partner's microsite. It goes straight "
    + "into our pipeline, tagged to this review week, and joins the shared pool for everyone else.");
}

// ── 6. Team meetings ───────────────────────────────────────────────────────
divider("Team meetings", "Team meetings", "Where most of us work in RFPIS: notes, actions and follow-ups");
{
  const s = content("Team meetings", "A good Monday-call routine");
  const roles = [
    ["Chair", "Opens Pipelines → Screen for this week"],
    ["Presenter", "Walks through each RFP on the Review tab"],
    ["Team", "Agrees the decision → ✏ Update Decision"],
    ["Note-taker", "➕ Add a note for every agreed action"],
    ["Everyone", "Before closing: Actions → Pending, resolve what's done"],
  ];
  roles.forEach(([r, d], i) => {
    const y = 1.55 + i * 1.0;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y, w: 2.4, h: 0.8, rectRadius: 0.1,
      fill: { color: C.accent1 }, line: { color: C.accent1 }, objectName: `role-${r}` });
    s.addText(r, { x: 0.6, y, w: 2.4, h: 0.8, fontSize: 18, bold: true, color: C.background1,
      align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(d, { x: 3.25, y, w: 4.2, h: 0.8, fontSize: 16, color: C.text1, valign: "middle", margin: 0, isTextBox: true });
  });
  shot(s, "22-meetings", 7.7, 1.55, 5.0, "Actions → Meetings: this week's rota and notes");
  s.addNotes("The rota (note-taker, presenter, chair) is set in Actions → Schedule and shows in the bell.");
}
{
  const s = content("Team meetings", "Capture a meeting note");
  tag(s, "KEY TASK", 11.15, 0.6, "green");
  steps(s, [
    "Actions → Meetings; check the Review week",
    "Click ➕ Add a note",
    "Linked RFP (Proceed only), Issues, Actions / recommendations",
    "Owner and Due Date (defaults to next Monday)",
    "💾 Save note — then Not Resolved → ✓ Resolved when done",
    "Fix it later: ✏️ on the row reopens the note to edit",
  ], 0.6, 1.6, 5.4, { gap: 0.82 });
  shot(s, "23-add-note", 6.4, 1.55, 6.3, "➕ Add a note");
  callout(s, "Anyone can take notes", "Every role can add, edit and resolve meeting notes.",
    0.6, 6.25, 5.4, 0.7, "green");
  s.addNotes("Notes are open to every role. To correct one, click the pencil on its row, change it and "
    + "Save changes. Download the week's notes as CSV for the minutes.");
}
{
  const s = content("Team meetings", "Engagements and pending actions");
  shot(s, "24-engagements", 0.6, 1.5, 5.9, "Engagements — log every donor touchpoint");
  shot(s, "25-pending", 6.8, 1.5, 5.9, "Pending — everything still open");
  s.addText([
    { text: "Engagements: ", options: { bold: true, color: C.text2 } },
    { text: "date, type, donor, internal lead, purpose, outcome → 💾 Save engagement. Target: 2–4 a quarter.", options: { breakLine: true } },
    { text: "Pending: ", options: { bold: true, color: C.text2 } },
    { text: "Filters → your name under Owner; click Not Resolved when an item is done." },
  ], { x: 0.6, y: 5.6, w: 12.1, h: 1.1, fontSize: 15, color: C.text1, margin: 0, isTextBox: true, paraSpaceAfter: 6 });
  s.addNotes("Anyone can log engagements and resolve pending items.");
}

// ── 7. Reports & help ──────────────────────────────────────────────────────
divider("Reports & help", "Reports & help", "Generate a report; where the manual lives");
{
  const s = content("Reports & help", "Generate a report");
  steps(s, [
    "Sidebar → 📊 Report",
    "Choose the Period, Year and View by",
    "Optional: ⚙️ Advanced filter — sections and metrics",
    "Click ▶ Generate report (nothing loads before this)",
    "📄 Export Report → ⬇ Download PDF; 📥 Export Data for Excel",
  ], 0.6, 1.6, 5.4, { gap: 0.95 });
  shot(s, "28-report-generated", 6.4, 1.55, 6.3, "📊 Your Activity Report");
  s.addNotes("The address bar holds a shareable link after Generate report. The first PDF after a "
    + "restart can take a couple of minutes.");
}
{
  const s = content("Reports & help", "Where to get help");
  shot(s, "33-help", 0.6, 1.5, 7.4, "👤 → Help");
  callout(s, "The user manual", "👤 → Help → ⬇ User manual (PDF). Also on the Home page.", 8.4, 1.5, 4.3, 1.2, "green");
  callout(s, "These slides", "👤 → Help → ⬇ Training slides (PPTX).", 8.4, 2.9, 4.3, 1.0, "green");
  callout(s, "Still stuck?", "Ask your administrator — the Help page shows who to contact.", 8.4, 4.1, 4.3, 1.2, "blue");
  s.addNotes("Point everyone at Help. The manual covers every page step by step.");
}
{
  const s = content("Reports & help", "Try it now: 10-minute exercise");
  const tasks = [
    "Open the bell. When is the next auto-scan?",
    "Run the Eligibility Scan. How many were newly added?",
    "Open one RFP on Review. What is its Bid Strength?",
    "Search for a donor you know. Is it in RFPIS?",
    "Open Actions → Pending and filter to your name",
    "Generate this year's report and export the PDF",
  ];
  tasks.forEach((t, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 0.6 + col * 6.15, y = 1.6 + row * 1.6;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 5.95, h: 1.35, rectRadius: 0.12,
      fill: { color: C.background2 }, line: { color: "E3E7EC" }, objectName: `task-${i + 1}` });
    s.addShape(pres.shapes.OVAL, { x: x + 0.25, y: y + 0.4, w: 0.55, h: 0.55,
      fill: { color: C.accent1 }, line: { color: C.accent1 } });
    s.addText(String(i + 1), { x: x + 0.25, y: y + 0.4, w: 0.55, h: 0.55, fontSize: 18, bold: true,
      color: C.background1, align: "center", valign: "middle", margin: 0, isTextBox: true });
    s.addText(t, { x: x + 1.0, y, w: 4.75, h: 1.35, fontSize: 17, color: C.text1, valign: "middle",
      margin: 0, isTextBox: true });
  });
  s.addNotes("Hands-on. Walk the room. Don't save decisions on real RFPs unless the team agreed them.");
}
{
  const s = pres.addSlide({ masterName: "DARK_TITLE", sectionTitle: "Reports & help" });
  s.addText("Thank you", { placeholder: "title" });
  s.addText("Scan on Friday · Screen & submit at the weekend · Decide and take notes on Monday · "
    + "Follow through mid-week.", { placeholder: "body" });
  s.addText("User manual & these slides: 👤 → Help", { x: 0.8, y: 6.4, w: 9, h: 0.4, fontSize: 14,
    color: C.accent6, bold: true, margin: 0, isTextBox: true });
  s.addNotes("Questions. Remind everyone where the manual is.");
}

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await pres.writeFile({ fileName: OUT });
  const applyThemePath = process.env.PPTX_APPLY_THEME;
  if (applyThemePath) {
    const { applyTheme } = require(applyThemePath);
    await applyTheme(OUT, THEME);
  }
  console.log(OUT);
})();
