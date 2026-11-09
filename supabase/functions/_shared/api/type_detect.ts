/**
 * What pursuing an opportunity actually IS — a port of core/type_detect.py, limited to the
 * part the rail's Featured card needs.
 *
 * Featured excludes the opportunity types this org can never pursue (procurement,
 * consultancy, training, loan): featuring a tender the gate correctly rejected would just
 * reintroduce the noise the gate exists to remove. The catalogue row usually carries
 * `opportunity_type` already, and this is the fallback for when it does not.
 *
 * Only the DECISION is hand-ported. The vocabularies — ~80 enriched rules plus the host
 * and label lists — are generated from the Python (scripts/gen_geo_tables.py →
 * type_tables.ts), so a keyword cannot drift by a typo.
 */
import {
  SOLICITATION_RULES, INSTRUMENT_RULES, SOLICITATION_GROUPS, PROCUREMENT_HOSTS,
  GRANT_PORTAL_HOSTS, PROCUREMENT_LABELS, CONSULTANCY_LABELS, PORTAL_NOISE,
  OPPORTUNITY_TYPE_EXCLUSION_NAMES,
} from "./type_tables.ts";

type Json = Record<string, unknown>;

const str = (v: unknown) => (v == null ? "" : String(v));

/** core/type_detect.OPPORTUNITY_TYPE_EXCLUSIONS, as the membership test the callers make. */
export const OPPORTUNITY_TYPE_EXCLUSIONS = new Set(OPPORTUNITY_TYPE_EXCLUSION_NAMES);

const GROUP_FUNDING = new Set(SOLICITATION_GROUPS[0] ?? []);
const GROUP_EOI = new Set(SOLICITATION_GROUPS[1] ?? []);
const GROUP_TENDER = new Set(SOLICITATION_GROUPS[2] ?? []);

/** core/type_detect._denoise — neutralise portal names whose own wording reads as a type. */
function denoise(blob: string): string {
  let out = (blob ?? "").toLowerCase();
  for (const [bad, good] of PORTAL_NOISE) {
    if (out.includes(bad)) out = out.split(bad).join(good);
  }
  return out;
}

/** core/type_detect._match — first rule whose needle appears wins. The leading space is
 * the Python's, so the " acronym" rules also match at the start of the string. */
function match(blob: string, rules: [string, string][]): string | null {
  const hay = " " + (blob ?? "").toLowerCase();
  for (const [kw, val] of rules) if (hay.includes(kw)) return val;
  return null;
}

/** core/type_detect.detect_solicitation — title + description + link. */
export function detectSolicitation(c: Json): string | null {
  const blob = `${str(c.opportunity_title)} ${str(c.brief_description)} ` +
    `${str(c.opportunity_link)}`;
  return match(denoise(blob), SOLICITATION_RULES);
}

/** core/type_detect.detect_instrument — the donor's funding-instrument field first. */
export function detectInstrument(c: Json): string | null {
  const fi = c._funding_instrument || c.funding_window || c.funding_type || "";
  const blob = `${str(fi)} ${str(c.opportunity_title)} ${str(c.opportunity_link)}`;
  return match(denoise(blob), INSTRUMENT_RULES);
}

/**
 * core/type_detect.detect_opportunity_type. Signals, strongest first:
 *   1. HOST — ungm.org and friends only ever carry procurement notices, which is
 *      language-independent and so catches the Spanish tender no English label matched.
 *   2. TITLE/BODY LABELS.
 *   3. The already-detected solicitation family and instrument.
 * Returns null when nothing is recognisable, so the caller decides how to fail.
 */
export function detectOpportunityType(c: Json): string | null {
  const blob = [str(c.opportunity_title) || str(c.opportunity_name),
    str(c.brief_description)].join(" ").toLowerCase();
  // Either field name: screened rows call it opportunity_link, catalogue rows
  // opportunity_url. Reading only one silently blanks the strongest signal we have.
  const link = (str(c.opportunity_link) || str(c.opportunity_url)).toLowerCase();

  if (PROCUREMENT_HOSTS.some((h) => link.includes(h))) return "Procurement";
  if (PROCUREMENT_LABELS.some((l) => blob.includes(l))) return "Procurement";
  if (CONSULTANCY_LABELS.some((l) => blob.includes(l))) return "Consultancy";

  const sol = str(c.solicitation_type) || detectSolicitation(c);
  const inst = str(c.instrument_type) || detectInstrument(c);
  const onGrantPortal = GRANT_PORTAL_HOSTS.some((h) => link.includes(h));

  if (sol && GROUP_TENDER.has(sol) && !onGrantPortal) return "Procurement";
  if (onGrantPortal) return "Grant/funding call";   // a funding portal's calls ARE funding
  if (inst === "Loan") return "Loan";
  if (inst === "Prize/Award" || sol === "Challenge") return "Prize/Challenge";
  if (inst === "Grant" || inst === "Cooperative Agreement" || inst === "Seed fund"
    || (sol && GROUP_FUNDING.has(sol))) return "Grant/funding call";
  // EOI/LOI/CfCN — a funding call unless the consultancy labels above already caught it.
  if (sol && GROUP_EOI.has(sol)) return "Grant/funding call";
  return null;
}
