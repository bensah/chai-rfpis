/**
 * Site-wide search — `core/site_search.py`, the half that runs in this function.
 *
 * Two result kinds, and the split is the design:
 *
 *   NAV   a STATIC registry of pages, tabs and features, matched on label and keywords.
 *         This is what lets somebody type "blacklist" or "manage users" and arrive, and
 *         it is the half of the search that does not touch the database at all.
 *   DATA  live matches in the organisation's own content — opportunity titles, funders,
 *         briefs and themes, and donor names.
 *
 * THE WEB-DISCOVERY HALF IS NOT HERE. `core/web_search.py` fans one keyword out into
 * several RFP-framed searches across Serper and Tavily and then filters the hits through
 * seven rules (health theme, RFP signal, blacklist, geography, expiry, staleness,
 * language) — 701 lines of Python, holding the provider keys, measured at 21.4 seconds
 * against the live providers for one query. No Edge Function budget survives that and no
 * port of those rules would stay honest, so it runs as a `web_search` job, the way the
 * Report's workbook does. See routes_search.ts.
 *
 * WHERE THE NAV TARGETS POINT. The Python's registry carries Streamlit module paths
 * ("app_pages/pipelines.py"); this one carries React hrefs. The labels and the keywords are
 * verbatim, because they ARE the index — editing them changes what a query finds. The
 * Python's own docstring notes that Streamlit cannot deep-link a tab, so "Pipelines ·
 * Review" lands on the page and the label tells the reader which tab to open. React can do
 * better for the Pipeline, whose stages take `?stage=`, and no better for Settings, whose
 * tabs are component state. Where a deep link exists it is used; where it does not, the
 * label still names the tab.
 */

const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export type NavHit = { label: string; href: string; score: number };

/**
 * (label, keywords, href, adminOnly) — `core/site_search.py::_NAV`, with React hrefs.
 *
 * Kept in the Python's order so that equal scores break the same way: the sort below is
 * stable in both languages, and two entries scoring 40 would otherwise swap between the
 * apps for no reason a reader could see.
 */
const NAV: [string, string, string, boolean][] = [
  ["Home", "dashboard start overview quick", "/", false],
  ["Pipelines", "screen review tracking summary screening triage lifecycle", "/pipelines", false],
  ["Pipelines · Screen", "screening new opportunities triage auto", "/pipelines?stage=screened", false],
  ["Pipelines · Review", "review eligibility criteria badges decision", "/pipelines?stage=reviewed", false],
  ["Pipelines · Track", "track tracking pipeline stage progress proposal", "/pipelines?stage=bidding", false],
  ["Pipelines · Summary", "summary stats overview", "/pipelines", false],
  // The Python sends this to pipelines.py because Funding became a tab there. In this app
  // the owner kept it as its own page (router.tsx says why), so the hit goes to the page.
  ["Grants", "applied funding awarded won reporting deadlines", "/grants", false],
  ["Actions", "meetings engagements pending follow ups todo tasks check-ins", "/actions", false],
  ["Report", "analytics kpi dashboard charts export pdf metrics", "/report", false],
  ["Donors", "donor intelligence contacts catalogue funders multilateral", "/donors", false],
  ["Profile", "my profile change password account email phone", "/profile", false],
  ["Help", "guide how to faq orientation support", "/help", false],
  // Settings tabs are component state in this app, so these all land on the page itself
  // and the label says which tab — exactly what the Streamlit side does for every entry.
  ["Settings · Setup", "settings setup org organization year currency excel sync rates", "/settings", true],
  ["Settings · Manage Users", "users accounts roles add user reset password deactivate invite", "/settings", true],
  ["Settings · User Access", "access matrix permissions overrides roles", "/settings", true],
  ["Settings · Records", "records data rfp backend edit delete export share columns", "/settings", true],
  ["Settings · Sources", "donor sources scan urls catalog feeds", "/settings", true],
  ["Settings · Manual Scan", "manual scan trigger run now history logs", "/settings", true],
  ["Settings · Blacklist", "blacklist blocked domains exclude suppress", "/settings", true],
];

/** The registry, for the parity check to compare label for label against the Python. */
export const navRegistry = (): { label: string; keywords: string; adminOnly: boolean }[] =>
  NAV.map(([label, keywords, , adminOnly]) => ({ label, keywords, adminOnly }));

/**
 * Nav targets matching `query`, best first — `search_nav`.
 *
 * THREE WAYS TO MATCH, and they are ranked rather than merged:
 *
 *   100 - index   the query appears in the LABEL. Earlier is better, so a prefix match on
 *                 a tab name beats the same word buried in a longer label.
 *   40            the query appears inside one keyword token. `q in tok`, not `tok == q`,
 *                 so "scan" finds "scanning".
 *   20            every WORD of the query appears somewhere in the label plus keywords —
 *                 the multi-word fallback, which is how "manage users" matches at all.
 *
 * Scores do not add: the first branch that fires wins, exactly as the Python's if/elif
 * chain does. A query matching the label is never also given the keyword score.
 */
export function searchNav(query: unknown, isAdmin: boolean): NavHit[] {
  const q = s(query).trim().toLowerCase();
  if (!q) return [];
  const out: NavHit[] = [];
  for (const [label, keywords, href, adminOnly] of NAV) {
    if (adminOnly && !isAdmin) continue;
    const ll = label.toLowerCase();
    let score = 0;
    if (ll.includes(q)) score = 100 - ll.indexOf(q);
    else if (keywords.split(/\s+/).some((tok) => tok.includes(q))) score = 40;
    else if (q.split(/\s+/).every((w) => (`${ll} ${keywords}`).includes(w))) score = 20;
    if (score) out.push({ label, href, score });
  }
  // Python's `list.sort(key=…, reverse=True)` is stable, so equal scores keep registry
  // order. `Array.prototype.sort` is stable too (ES2019), so this is the same answer.
  return out.sort((a, b) => b.score - a.score);
}

/**
 * `_sanitize` — strip the delimiters PostgREST's `or_` filter parses.
 *
 * A typed comma or bracket would otherwise end the filter early and change which columns
 * are searched. Replaced with spaces rather than removed, because the value is wrapped in
 * `%…%` either way and a space is a wildcard once it is.
 */
export const sanitize = (query: unknown): string =>
  s(query).replace(/,/g, " ").replace(/\(/g, " ").replace(/\)/g, " ").trim();

/** Under two characters searches nothing — the Python's own floor, in both data calls. */
export const TOO_SHORT = 2;

export type OppHit = {
  title: string; funder: string; deadline: string; decision: string; source: string;
  uid: string;
};
export type DonorHit = { name: string };

/**
 * Opportunity matches across title, funder, brief and focus theme.
 *
 * DE-DUPLICATED ON (title, funder), lower-cased, keeping the first — which is what makes
 * the same call found by two scans appear once. It is not `core/deduplicator.py`: that is
 * a fuzzy match used for KPIs, and this is an exact one used for a results list. Being
 * stricter here is deliberate; a search that hid a near-match would hide a row somebody is
 * looking for.
 */
export async function searchOpportunities(
  db: { get: (t: string, q: string) => Promise<Record<string, unknown>[]> },
  query: unknown, limit = 30,
): Promise<OppHit[]> {
  const qf = sanitize(query);
  if (qf.length < TOO_SHORT) return [];
  // One `or=(…)` over the four columns, URL-encoded whole — the commas inside it are the
  // filter's own separators, which is exactly why `sanitize` took the user's out first.
  const or = encodeURIComponent(
    ["opportunity_title", "funding_agency", "brief_description", "focus_theme"]
      .map((c) => `${c}.ilike.%${qf}%`).join(","));
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await db.get("rfp_submissions",
      `select=uid,opportunity_title,funding_agency,call_submission_deadline,decision,source`
      + `&or=(${or})&limit=${limit}`);
  } catch {
    // The Python swallows this too. A search box that 500s because one column is missing
    // is worse than one that returns the other two groups.
    rows = [];
  }
  const out: OppHit[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const title = s(r.opportunity_title).trim();
    const funder = s(r.funding_agency).trim();
    const key = `${title.toLowerCase()}\u0000${funder.toLowerCase()}`;
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title, funder,
      deadline: s(r.call_submission_deadline).slice(0, 10),
      decision: s(r.decision).trim(),
      source: s(r.source).trim(),
      // NOT in the Python's result, and the difference is the point: Streamlit cannot
      // deep-link a row, so its hit navigates to the Pipelines page and leaves the reader
      // to find the call. This app has /opportunity?uid=, so the hit opens the call.
      uid: s(r.uid).trim(),
    });
  }
  return out;
}

/** Donor matches by name, de-duplicated case-insensitively — `search_donors`. */
export async function searchDonors(
  db: { get: (t: string, q: string) => Promise<Record<string, unknown>[]> },
  query: unknown, limit = 30,
): Promise<DonorHit[]> {
  const qf = sanitize(query);
  if (qf.length < TOO_SHORT) return [];
  let rows: Record<string, unknown>[] = [];
  try {
    rows = await db.get("donor_sources",
      `select=donor_name&donor_name=ilike.${encodeURIComponent(`%${qf}%`)}&limit=${limit}`);
  } catch {
    rows = [];
  }
  const out: DonorHit[] = [];
  const seen = new Set<string>();
  for (const d of rows) {
    const name = s(d.donor_name).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name });
  }
  return out;
}
