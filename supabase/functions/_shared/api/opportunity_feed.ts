/**
 * The opportunity rail's four cards — a port of core/opportunity_feed.py.
 *
 * This used to run in the browser's Pyodide engine. It is here now because it NEEDS NO
 * SCORING: measured against the live database (2026-11-09), `classify` reads only columns
 * already stored on the row — `alignment_score`, `auto_recommendation`, `decision`, the
 * award value, the deadline, the geographic scope and the posted dates. It ranks stored
 * numbers; it does not compute any. That is what made the rail separable from the
 * Opportunity page's decision aid, which genuinely does have to compute.
 *
 * Every function names the Python symbol it mirrors, and
 * web/scripts/parity/check-scoring.mjs runs this against the live Python per tenant.
 */
import { geographicExclusionReject } from "./geo_gate.ts";
import { detectOpportunityType, OPPORTUNITY_TYPE_EXCLUSIONS } from "./type_detect.ts";

type Json = Record<string, unknown>;

export const STRONG_FIT = 65.0;      // alignment_score at/above this is a strong fit
const TOP_N = 5;
const PROCEED_PARK = new Set(["proceed", "park"]);

const str = (v: unknown) => (v == null ? "" : String(v));

/** core/opportunity_feed._f */
function f(v: unknown): number {
  const n = typeof v === "number" ? v : Number(str(v).trim());
  return Number.isFinite(n) ? n : 0.0;
}

// Geographic-breadth keywords → breadth score (broader scope = more widely open).
const GLOBAL = ["global", "worldwide", "any country", "all countries",
  "all eligible countries"];
const BROAD = ["sub-saharan", "ssa", "lmic", "low- and middle", "low and middle", "africa",
  "asia", "latin america", "developing countries", "multi-country",
  "multiple countries", "regional", "eligible countries", "oda"];

/** core/opportunity_feed._amount_score — log-scaled 0..1 (≈1 at $1B). */
function amountScore(amount: number): number {
  if (amount <= 0) return 0.0;
  return Math.max(0.0, Math.min(1.0, Math.log10(amount + 1) / 9.0));
}

/** core/opportunity_feed._geo_text */
function geoTextOf(scope: unknown): string {
  if (Array.isArray(scope)) return scope.map(str).join(" ").toLowerCase();
  return str(scope).toLowerCase();
}

/** core/opportunity_feed._geo_score */
function geoScore(scope: unknown): number {
  const t = geoTextOf(scope);
  if (!t) return 0.2;
  if (GLOBAL.some((k) => t.includes(k))) return 1.0;
  if (BROAD.some((k) => t.includes(k))) return 0.7;
  if (t.includes(",") || t.includes(" and ")) return 0.5;
  return 0.35;
}

/** core/opportunity_feed._parse_date — strict %Y-%m-%d over the first ten characters,
 * which is what `datetime.strptime` accepts there (anything else is None). */
function parseDate(v: unknown): Date | null {
  if (!v) return null;
  const s = str(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // strptime rejects an out-of-range day ("2026-02-31"); Date would roll it over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/** The server's today as a UTC midnight Date, from an ISO date string. */
export function asToday(today: string): Date {
  return parseDate(today) ?? new Date(Date.UTC(1970, 0, 1));
}

/** core/opportunity_feed._days_until */
function daysUntil(deadline: unknown, today: Date): number | null {
  const d = parseDate(deadline);
  return d ? Math.round((d.getTime() - today.getTime()) / 86400000) : null;
}

/** core/opportunity_feed._urgency_score — 1.0 today → 0.0 at ~120 days out. */
function urgencyScore(days: number | null): number {
  if (days === null) return 0.15;      // unknown deadline → mild
  if (days < 0) return 0.0;            // expired
  return Math.max(0.0, 1.0 - Math.min(days, 120) / 120.0);
}

/** core/opportunity_feed._is_expired */
function isExpired(deadline: unknown, today: Date): boolean {
  const d = parseDate(deadline);
  return d !== null && d.getTime() < today.getTime();
}

/** core/opportunity_feed._recency_key */
const recencyKey = (row: Json) =>
  str(row.date_posted || row.search_date || row.created_at || "");

export type FeedItem = {
  uid: string | null; title: string; funder: string; amount: number; currency: string;
  deadline: string | null; days_until: number | null; geo: string; alignment: number;
  link: string; recommendation: string; _prominence?: number; _score?: number; _why?: string;
};

/** core/opportunity_feed._item */
function item(row: Json, today: Date): FeedItem {
  const amt = f(row.call_award_value);
  const days = daysUntil(row.call_submission_deadline, today);
  return {
    uid: (row.uid as string) ?? null,
    title: str(row.opportunity_title) || "(untitled opportunity)",
    funder: str(row.funding_agency) || "",
    amount: amt,
    currency: str(row.currency) || "USD",
    deadline: row.call_submission_deadline
      ? str(row.call_submission_deadline).slice(0, 10) : null,
    days_until: days,
    geo: geoTextOf(row.call_geographic_scope) || "",
    alignment: f(row.alignment_score),
    link: str(row.opportunity_link) || "",
    recommendation: str(row.decision || row.auto_recommendation || ""),
    _prominence: 0.5 * amountScore(amt) + 0.3 * geoScore(row.call_geographic_scope)
      + 0.2 * urgencyScore(days),
  };
}

/** core/opportunity_feed._is_match */
function isMatch(row: Json): boolean {
  const rec = str(row.auto_recommendation).trim().toLowerCase();
  const dec = str(row.decision).trim().toLowerCase();
  return PROCEED_PARK.has(rec) || PROCEED_PARK.has(dec)
    || f(row.alignment_score) >= STRONG_FIT;
}

/** core/opportunity_feed._row_key — uid, else link, else title, else row identity. */
function rowKey(r: Json, i: number): string {
  return str(r.uid) || str(r.opportunity_link) || str(r.opportunity_title) || `#${i}`;
}

/** core/opportunity_feed._prominence_of */
function prominenceOf(r: Json, today: Date): number {
  const days = daysUntil(r.call_submission_deadline, today);
  return 0.5 * amountScore(f(r.call_award_value))
    + 0.3 * geoScore(r.call_geographic_scope) + 0.2 * urgencyScore(days);
}

/** core/opportunity_feed._geo_ineligible — fail OPEN, so a bug in the gate empties
 * nothing: worst case the cards fall back to fit-agnostic behaviour. */
function geoIneligible(policies: Json | null, row: Json): boolean {
  if (!policies) return false;
  try {
    return !!geographicExclusionReject(row, policies)[0];
  } catch {
    return false;
  }
}

/**
 * Python's `sorted(..., reverse=True)` is STABLE, so equal keys keep their input order.
 * Array.prototype.sort is stable too, but `reverse=True` is not the same as sorting
 * ascending and reversing — it keeps the original order among ties rather than inverting
 * it. Comparing b-to-a on a stable sort is what reproduces that.
 */
type SortKey = number | string;
function sortedDesc<T>(rows: T[], key: (r: T) => SortKey | SortKey[]): T[] {
  const cmp = (a: SortKey | undefined, b: SortKey | undefined) =>
    (a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1);
  return [...rows].sort((ra, rb) => {
    const a = key(ra), b = key(rb);
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const c = cmp(a[i], b[i]);
        if (c) return -c;
      }
      return 0;
    }
    return -cmp(a as SortKey, b as SortKey);
  });
}

export type FeedGroups = {
  top_funding: FeedItem[]; top_matches: FeedItem[]; other: FeedItem[];
};

/**
 * core/opportunity_feed.classify.
 *
 * The three cards are MUTUALLY EXCLUSIVE: every opportunity appears in at most one, at its
 * single best placement. Priority: Top Matches (strong fit, most actionable) → Top Funding
 * (biggest/most-urgent of what is left) → Also Interesting (freshest of the rest). Live
 * deadlines only.
 *
 * `policies`, when given, binds the org's HARD geographic gate. The two fit-agnostic
 * discovery cards exclude calls whose geography hard-excludes the org; Top Matches is NOT
 * geo-filtered, because a human Proceed/Park or a strong alignment shows regardless.
 */
export function classify(rows: Json[], today: Date, policies: Json | null): FeedGroups {
  const all = rows ?? [];
  const live = all.filter((r) => !isExpired(r.call_submission_deadline, today));
  const discover = live.filter((r) => !geoIneligible(policies, r));

  const used = new Set<string>();
  const indexOf = new Map<Json, number>();
  all.forEach((r, i) => indexOf.set(r, i));

  const take = (candidates: Json[], key: (r: Json) => SortKey | SortKey[],
    n = TOP_N): FeedItem[] => {
    const out: FeedItem[] = [];
    for (const r of sortedDesc(candidates, key)) {
      const k = rowKey(r, indexOf.get(r) ?? -1);
      if (used.has(k)) continue;              // already placed in a higher-priority card
      used.add(k);
      out.push(item(r, today));
      if (out.length >= n) break;
    }
    return out;
  };

  // 1. Top Matches — strong fit; the most actionable placement wins the opportunity.
  const top_matches = take(live.filter(isMatch),
    (r) => [f(r.alignment_score), f(r.call_award_value)]);
  // 2. Top Funding — biggest / most-urgent of the GEO-ELIGIBLE remaining rows.
  const top_funding = take(discover, (r) => prominenceOf(r, today));
  // 3. Also interesting — freshest of whatever geo-eligible rows are still unplaced.
  const other = take(discover, recencyKey);

  return { top_funding, top_matches, other };
}

// ---------------------------------------------------------------------------
// FEATURED — the safety net for screening misses
// ---------------------------------------------------------------------------
const FEATURED_N = 5;
const FEATURED_PER_FUNDER = 2;

/** core/opportunity_feed._norm_set */
function normSet(values: unknown): Set<string> {
  if (values == null) return new Set();
  const list = typeof values === "string" ? [values]
    : Array.isArray(values) ? values : [];
  const out = new Set<string>();
  for (const v of list) {
    const s = str(v).trim();
    if (s) out.add(s.toLowerCase());
  }
  return out;
}

/** core/opportunity_feed._overlap — fraction of `a` covered by `b`, substring-tolerant. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0.0;
  let hits = 0;
  for (const x of a) {
    for (const y of b) {
      if (x.includes(y) || y.includes(x)) { hits++; break; }
    }
  }
  return hits / a.size;
}

/** core/opportunity_feed.catalog_item */
export function catalogItem(row: Json, today: Date): FeedItem {
  const amt = f(row.grant_amount);
  const days = daysUntil(row.deadline, today);
  return {
    uid: (row.uid as string) ?? null,
    title: str(row.opportunity_name) || "(untitled opportunity)",
    funder: str(row.funder_name) || "",
    amount: amt,
    currency: str(row.currency) || "USD",
    deadline: row.deadline ? str(row.deadline).slice(0, 10) : null,
    days_until: days,
    geo: geoTextOf(row.call_geographic_scope) || "",
    alignment: 0.0,                  // not screened for this tenant — by design
    link: str(row.opportunity_url) || "",
    recommendation: "",
    _prominence: 0.5 * amountScore(amt) + 0.3 * geoScore(row.call_geographic_scope)
      + 0.2 * urgencyScore(days),
  };
}

export type Prefs = {
  countries?: unknown[]; broad_terms?: unknown[]; themes?: unknown[];
  pursued_areas?: unknown[]; known_funders?: unknown[];
};

/** core/opportunity_feed.featured_score → [score, why]. A featured item must always
 * explain itself, otherwise it reads as noise. */
export function featuredScore(row: Json, prefs: Prefs, today: Date): [number, string] {
  const geo = normSet(row.call_geographic_scope);
  const dom = new Set([...normSet(row.call_domain_areas), ...normSet(row.focus_themes)]);
  const funder = str(row.funder_name).trim().toLowerCase();

  const wantGeo = new Set([...normSet(prefs.countries), ...normSet(prefs.broad_terms)]);
  const wantTheme = new Set([...normSet(prefs.themes), ...normSet(prefs.pursued_areas)]);
  const known = normSet(prefs.known_funders);

  const geoFit = geo.size ? overlap(wantGeo, geo) : 0.35;   // untagged/global → mild credit
  const themeFit = overlap(wantTheme, dom);
  const funderFit = funder && [...known].some((k) => funder.includes(k) || k.includes(funder))
    ? 1.0 : 0.0;
  const sizeFit = amountScore(f(row.grant_amount));
  const urgency = urgencyScore(daysUntil(row.deadline, today));

  const score = 0.34 * geoFit + 0.28 * themeFit + 0.18 * funderFit
    + 0.10 * sizeFit + 0.10 * urgency;

  const why: string[] = [];
  if (themeFit >= 0.5) why.push("matches your programme areas");
  else if (themeFit > 0) why.push("overlaps a programme area");
  if (funderFit) why.push("funder you already work with");
  if (geo.size && geoFit >= 0.5) why.push("in your geography");
  else if (!geo.size) why.push("no geography stated");
  if (urgency >= 0.8) why.push("closing soon");
  return [score, why.join(" · ") || "new in the shared catalog"];
}

/**
 * core/opportunity_feed.featured — rank the SHARED catalogue for this tenant.
 *
 * Excludes expired calls, anything already in the tenant's pipeline (`seen`), and the
 * opportunity types this org can never pursue. The diversity cap keeps one prolific funder
 * from taking every slot, with a backfill pass if that leaves the card short.
 */
export function featured(catalogRows: Json[], prefs: Prefs, seen: Set<string>,
  today: Date, limit = FEATURED_N): FeedItem[] {
  const scored: [number, string, Json][] = [];
  for (const r of catalogRows ?? []) {
    if (isExpired(r.deadline, today)) continue;
    const link = str(r.opportunity_url).trim().toLowerCase().replace(/\/+$/, "");
    if (link && seen.has(link)) continue;             // already in their pipeline
    const otype = str(r.opportunity_type).trim() || detectOpportunityType({
      opportunity_title: r.opportunity_name,
      brief_description: r.brief_description,
      opportunity_link: r.opportunity_url,
      solicitation_type: r.solicitation_type,
      instrument_type: r.instrument_type,
    });
    if (otype && OPPORTUNITY_TYPE_EXCLUSIONS.has(otype)) continue;
    scored.push([...featuredScore(r, prefs, today), r] as [number, string, Json]);
  }

  const out: FeedItem[] = [];
  const perFunder = new Map<string, number>();
  const deferred: [number, string, Json][] = [];
  const build = (sc: number, why: string, r: Json): FeedItem => {
    const it = catalogItem(r, today);
    it._score = Math.round(sc * 1000) / 1000;
    it._why = why;
    return it;
  };

  for (const [sc, why, r] of sortedDesc(scored, (t) => t[0])) {
    const fk = str(r.funder_name).trim().toLowerCase() || `_${str(r.uid)}`;
    if ((perFunder.get(fk) ?? 0) >= FEATURED_PER_FUNDER) {
      deferred.push([sc, why, r]);
      continue;
    }
    perFunder.set(fk, (perFunder.get(fk) ?? 0) + 1);
    out.push(build(sc, why, r));
    if (out.length >= limit) return out;
  }
  for (const [sc, why, r] of deferred) {          // card still short → relax the cap
    if (out.length >= limit) break;
    out.push(build(sc, why, r));
  }
  return out;
}
