/**
 * My Organization — `app_pages/organization.py`, the read-only entity view.
 *
 * IT IS READ-ONLY AND THAT IS THE PAGE'S OWN DESIGN, not a limit of this port. The
 * Streamlit page says so in its docstring: "Everyone can view; editing is admin /
 * super-user only. The full edit form lives in Settings → Setup". The editor is
 * `views/org_setup.py`, 1,120 lines over four tabs, and it belongs to the Settings port.
 * What this page does is show a tenant what the matching engine actually believes about
 * them, and say how much of it is still missing.
 *
 * "ENTITY", NOT "ORGANIZATION", in the page's own words — a tenant may be a single
 * individual rather than an organisation (migration 078), so the wording avoids org-only
 * language where it can.
 *
 * TWO BLOBS ON ONE ROW. `tenants.org_identity` carries the branding and the eligibility
 * flags; `tenants.org_profile` carries the fit profile the scoring engine reads. Neither
 * is self-describing:
 *
 *   * identity is merged onto `ORG_DEFAULTS`, and the display NAME is `tenants.name`
 *     rather than the blob's own `org_name` — the editor's "Organization name" field IS
 *     the tenant rename, so the canonical column wins.
 *   * profile is merged onto `DEFAULT_PROFILE` after legacy keys are renamed. Skip the
 *     rename and a field that IS set reads as empty, the completeness bar drops, and the
 *     page says "not yet screening-ready" with nothing on screen explaining why.
 *
 * Both tables are generated from the Python that owns them — see org_vocab.ts.
 *
 * WHAT IS NOT PORTED, and why it is a gap rather than an omission:
 *   * `org_user_declared_areas`. `get_profile` fills it from `core.user_program_areas`,
 *     the program areas a tenant's own users named on their accounts. It is DERIVED on
 *     every read, never persisted, and it feeds MUST-2. This page does not show it, so
 *     it is not read here; anything that scores from this payload would be missing it.
 *   * the logo. `settings.get_org_logo` reads `org_logo_b64` and the page renders it.
 *     Carried through as a data URL below rather than left out, because an organisation
 *     looking at its own record and not seeing its own mark reads as the wrong record.
 */
import { q, type Db } from "./db.ts";
import {
  CATEGORY_FULL, DEFAULT_PROFILE, ENTITY_TYPE_LABELS, LEGAL_TYPE_LABELS, ORG_DEFAULTS,
  RATING_WORD, RENAMED_KEYS,
} from "./org_vocab.ts";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

// ── The two merges ───────────────────────────────────────────────────────────

/** `core/org_profile._migrate_keys` — legacy key to current, only when the new one is absent. */
export function migrateKeys(overlay: Row): Row {
  const out: Row = { ...overlay };
  for (const [old, next] of Object.entries(RENAMED_KEYS)) {
    if (old in out && !(next in out)) {
      out[next] = out[old];
      delete out[old];
    }
  }
  return out;
}

/** `core/org_profile._deep_merge` — overlay wins, and a LIST replaces wholesale. */
export function deepMerge(base: Row, overlay: Row): Row {
  const out: Row = structuredClone(base);
  for (const [k, v] of Object.entries(overlay)) {
    const cur = out[k];
    const bothPlainObjects =
      v !== null && typeof v === "object" && !Array.isArray(v)
      && cur !== null && typeof cur === "object" && !Array.isArray(cur);
    out[k] = bothPlainObjects ? deepMerge(cur as Row, v as Row) : v;
  }
  return out;
}

/**
 * A stored overlay, however it was stored. `_coerce_overlay` accepts a dict OR a JSON
 * string, because the single-tenant path keeps the blob in a text column and the
 * multi-tenant one in jsonb; anything else is no overlay at all.
 */
export function coerceOverlay(v: unknown): Row | null {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Row;
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Row : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** `core/org_profile.get_profile`'s merge, without the database. */
export const mergeProfile = (overlay: unknown): Row => {
  const o = coerceOverlay(overlay);
  return o ? deepMerge(DEFAULT_PROFILE as Row, migrateKeys(o)) : structuredClone(DEFAULT_PROFILE as Row);
};

/**
 * `core/settings.get_org`'s merge. The display name is `tenants.name`, NOT the blob's
 * `org_name` — the editor's "Organization name" field renames the tenant, so the column
 * is the canonical answer and the blob's copy can be stale.
 */
export function mergeIdentity(tenantName: unknown, identity: unknown): Record<string, string> {
  const ident = coerceOverlay(identity) ?? {};
  const out: Record<string, string> = {};
  for (const [key, fallback] of Object.entries(ORG_DEFAULTS)) {
    const v = ident[key];
    out[key] = v === null || v === undefined || v === "" ? fallback : s(v);
  }
  out.org_name = s(tenantName) || s(ident.org_name) || ORG_DEFAULTS.org_name;
  return out;
}

// ── Labels ───────────────────────────────────────────────────────────────────

/** `legal_type_label` — unknown codes are title-cased, empty is an em dash. */
export function legalTypeLabel(code: unknown): string {
  const t = s(code).trim();
  if (!t) return "—";
  return LEGAL_TYPE_LABELS[t]
    ?? t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** `entity_type_label` — empty is "(not specified)", which IS a listed label. */
export function entityTypeLabel(code: unknown): string {
  const t = s(code).trim();
  return ENTITY_TYPE_LABELS[t]
    ?? t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Completeness ─────────────────────────────────────────────────────────────

/**
 * `core/profile_completeness._filled` — and the one rule worth stating: ZERO COUNTS AS
 * UNSET. An organisation never has a $0 budget or a $0 largest grant, so a stored zero is
 * somebody skipping the field, and counting it as filled would show a complete profile
 * the matching engine cannot use.
 */
export function filled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.length > 0;
  if (typeof v === "object") return Object.keys(v as Row).length > 0;
  if (typeof v === "number") return v !== 0;
  return Boolean(v);
}

/**
 * The weighted checks, in `core/profile_completeness.completeness`'s order.
 *
 * GEOGRAPHY AND PROGRAM AREAS WEIGH MOST because they are the load-bearing gate and fit
 * signals — everything else fills in the picture. The order is the Python's, because the
 * page prints the first six missing labels and a different order is a different sentence.
 */
const CHECKS: [string, (org: Row, prof: Row) => unknown, number][] = [
  ["countries of operation", (_o, p) => p.org_operating_countries, 3],
  ["countries of registration", (_o, p) => p.org_registered_countries, 2],
  ["domains / areas of expertise", (_o, p) => p.org_domain_expertise, 3],
  ["strategic priority areas", (_o, p) => p.org_priority_areas, 2],
  ["legal type", (_o, p) => p.org_legal_type, 1],
  ["founding year", (_o, p) => p.org_founding_year, 1],
  ["primary country", (o) => o.org_country, 1],
  ["HQ country", (o, p) => o.org_hq_country || p.org_hq_country, 1],
  ["annual budget", (_o, p) => p.org_annual_budget, 1],
  ["largest grant managed", (_o, p) => p.org_largest_grant, 1],
  ["co-financing capacity", (_o, p) => p.org_cofinancing_capacity, 1],
  ["organization stage", (_o, p) => p.org_stage, 1],
  ["funding target band", (_o, p) => p.org_max_target, 1],
  ["funders won from", (_o, p) => p.org_funder_history, 1],
  ["donor registrations", (_o, p) => p.org_donor_registrations, 1],
  ["proposal languages", (_o, p) => p.proposal_languages, 1],
];

export function completeness(org: Row, prof: Row): { pct: number; missing: string[] } {
  const o = org ?? {};
  const p = prof ?? {};
  let total = 0;
  let got = 0;
  const missing: string[] = [];
  for (const [label, read, weight] of CHECKS) {
    total += weight;
    if (filled(read(o, p))) got += weight;
    else missing.push(label);
  }
  return { pct: got / (total || 1), missing };
}

/** `rag_band` — the product rule of 2026-08-01: red at or below 50%, green at or above 80%. */
export const ragBand = (pct: number): "red" | "amber" | "green" =>
  pct >= 0.80 ? "green" : pct > 0.50 ? "amber" : "red";

/**
 * `readiness_gap` — what is STILL missing before screening can run: at least one country
 * of operation AND at least one program area. An empty list means ready.
 *
 * It names ONLY what is missing, which is the whole point of it being a list rather than
 * a boolean: telling somebody to add a country of operation they have already set is how
 * a nudge becomes noise.
 */
export function readinessGap(prof: Row): string[] {
  const p = prof ?? {};
  const gap: string[] = [];
  if (!filled(p.org_operating_countries)) gap.push("at least one country of operation");
  if (!filled(p.org_domain_expertise) && !filled(p.org_priority_areas)) {
    gap.push("at least one program area");
  }
  return gap;
}

// ── Program-area ratings ─────────────────────────────────────────────────────

/**
 * `_split_key` — a rated area is stored as "PREFIX - Sub-area"; a key with no separator
 * is all sub-area and no category, which is what the Python returns for one too.
 */
const splitKey = (key: unknown): [string, string] => {
  const k = s(key);
  const at = k.indexOf(" - ");
  return at === -1 ? ["", k.trim()] : [k.slice(0, at).trim(), k.slice(at + 3).trim()];
};

/** `subarea_label` — "HSS - Health Financing" to "Health Financing". */
export const subareaLabel = (key: unknown): string => splitKey(key)[1];

/** `category_full` — "HSS - Health Financing" to "Health System Strengthening". An
 *  unrecognised prefix falls back to itself, and a key with no prefix to the key. */
export const categoryFull = (key: unknown): string => {
  const [pre] = splitKey(key);
  return CATEGORY_FULL[pre] ?? (pre || s(key));
};

export type RatingRow = { key: string; label: string; category: string; value: number; word: string };

/**
 * `rating_bars_html`'s DATA, with the HTML left to the page.
 *
 * Sorted by value descending and then by key, which is the Python's
 * `key=lambda kv: (-kv[1], kv[0])` — a total order, so the two apps list the same areas in
 * the same sequence rather than agreeing only on the set.
 */
export function ratingRows(ratings: unknown): RatingRow[] {
  if (!ratings || typeof ratings !== "object" || Array.isArray(ratings)) return [];
  const out: RatingRow[] = [];
  for (const [k, raw] of Object.entries(ratings as Row)) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({
      key: k, label: subareaLabel(k), category: categoryFull(k), value,
      word: RATING_WORD[String(value)] ?? "",
    });
  }
  return out.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

/** Areas that are SELECTED but carry no grade — shown as plain chips beside the bars. */
export const ungraded = (selection: unknown, ratings: unknown): string[] => {
  const rated = ratings && typeof ratings === "object" && !Array.isArray(ratings)
    ? new Set(Object.keys(ratings as Row)) : new Set<string>();
  return Array.isArray(selection)
    ? selection.map(s).filter((a) => a && !rated.has(a)) : [];
};

// ── The read ─────────────────────────────────────────────────────────────────

export type OrgPayload = {
  identity: Record<string, string>;
  profile: Row;
  logo: string | null;
  completeness: { pct: number; missing: string[]; band: string; gap: string[]; hasGeo: boolean };
  team: string[];
  canEdit: boolean;
};

/**
 * One tenant's identity and profile, from the one row that holds both.
 *
 * `tenants.name` comes back alongside the blobs because the display name is the column
 * rather than the blob — see `mergeIdentity`. A tenant id that resolves to nothing (the
 * single-tenant sentinel) gets the defaults, which is what `get_org` does when the legacy
 * path is not allowed: a placeholder, never another organisation's name.
 */
export async function loadOrg(db: Db, tenantId: string | null): Promise<{
  identity: Record<string, string>; profile: Row; logo: string | null;
}> {
  if (!tenantId) {
    return {
      identity: mergeIdentity("", {}),
      profile: mergeProfile(null),
      logo: null,
    };
  }
  const rows = await db.service.get(
    "tenants", `select=name,org_identity,org_profile&id=eq.${q(tenantId)}&limit=1`)
    .catch(() => [] as Row[]);
  const row = rows[0] ?? {};
  const identity = mergeIdentity(row.name, row.org_identity);
  // The logo lives in the identity blob as base64 under its own key, not as a column.
  const ident = coerceOverlay(row.org_identity) ?? {};
  const b64 = s(ident.org_logo_b64).trim();
  return {
    identity,
    profile: mergeProfile(row.org_profile),
    // Prefixed here rather than in the page: whether it is a data URL or an http one is a
    // fact about how it was stored, and the page should only have to put it in a src.
    logo: b64 ? (b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`)
      : (s(identity.org_logo_url).trim() || null),
  };
}
