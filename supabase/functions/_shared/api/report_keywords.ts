/**
 * The two vocabulary-driven derivations Report needs: the curated keyword extractor
 * (`core/keyword_cloud.py`) and the programme-area frequency behind the focus-area cloud
 * (`views/report.py::_programme_area_freq`).
 *
 * Only the ALGORITHMS are here. Both word lists live in the generated `report_vocab.ts`,
 * written from the Python modules that own them — a hand-typed second copy of an 80-stem
 * vocabulary is a copy that falls behind, and the symptom is a topic quietly missing from
 * one half of the application.
 */
import { AREA_SUBS, KEYWORD_STEMS } from "./report_vocab.ts";

// ── Curated keyword extraction (core/keyword_cloud.py) ───────────────────────

/** Inverse map, built once: surface form → display label. */
const WORD_TO_STEM: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [stem, forms] of Object.entries(KEYWORD_STEMS)) {
    for (const w of forms) m[w.toLowerCase()] = stem;
  }
  return m;
})();

// Runs of letters, plus hyphens and slashes so "covid-19" and "HIV/AIDS" survive to the
// splitting step. Deliberately ASCII-only, matching the Python's [A-Za-z][A-Za-z0-9\-/]*.
const TOKEN_RE = /[A-Za-z][A-Za-z0-9\-/]*/g;

/**
 * Lowercased word tokens. Hyphenated and slashed forms split ("covid-19" → covid;
 * "HIV/AIDS" → hiv, aids). Digit-only pieces are dropped.
 *
 * Python's `str.isdigit()` is true for superscripts and other Unicode digits that a plain
 * /^\d+$/ misses — but the token pattern above is ASCII-only, so nothing non-ASCII can reach
 * this test and the simple form is exact here. (`permissions.ts` has the same hazard where
 * the input is NOT constrained, and handles it with an explicit class.)
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const tok of String(text).match(TOKEN_RE) ?? []) {
    for (const piece of tok.split(/[-/]/)) {
      const p = piece.toLowerCase().trim();
      if (p && !/^[0-9]+$/.test(p)) out.push(p);
    }
  }
  return out;
}

/**
 * `{display label: count}` across an iterable of texts — token OCCURRENCES, not documents.
 * A text saying "AI" twice counts twice here; the success table deliberately uses presence
 * instead, and does its own de-duplication per row.
 */
export function extractKeywordFrequencies(
  texts: Iterable<string>, minCount = 1,
): Record<string, number> {
  const counter: Record<string, number> = {};
  for (const text of texts) {
    if (!text) continue;
    for (const tok of tokenize(String(text))) {
      const stem = WORD_TO_STEM[tok];
      if (stem !== undefined) counter[stem] = (counter[stem] ?? 0) + 1;
    }
  }
  if (minCount > 1) {
    for (const [k, v] of Object.entries(counter)) if (v < minCount) delete counter[k];
  }
  return counter;
}

/** The distinct display labels a text carries — presence, which is what conversion needs. */
export function keywordStems(text: string): Set<string> {
  return new Set(Object.keys(extractKeywordFrequencies([text])));
}

// ── Programme areas (views/report.py::_programme_area_freq) ──────────────────

/**
 * Values that mean "we could not tell". Drawing one in a focus-area cloud presents an
 * absence of information as a focus.
 */
const AREA_NON_VALUES = new Set([
  "n/a", "na", "none", "other", "unspecified", "unspecified program areas",
  "unspecified programme areas", "not specified", "tbd",
]);

/**
 * Snap a stored area onto the taxonomy's own spelling where it unambiguously matches.
 *
 * The pipeline stores "Digital Health" and "Digital Health (+AI)" for one sub-area, so the
 * cloud drew it twice at half weight each. Exact match first, then a PREFIX match accepted
 * only when exactly one sub-area matches — an ambiguous prefix is left alone rather than
 * guessed at, and an area the taxonomy has never heard of keeps its own name.
 */
export function canonicalArea(label: string): string {
  const low = label.toLowerCase();
  for (const s of AREA_SUBS) if (s.toLowerCase() === low) return s;
  const hits = AREA_SUBS.filter((s) => s.toLowerCase().startsWith(low));
  return hits.length === 1 ? hits[0] : label;
}

/**
 * `{programme area: number of calls}` from the `call_domain_areas` a row actually carries —
 * not from titles and briefs, and not from the scan vocabulary. Those describe what was
 * looked for; this describes what the team decided to pursue.
 *
 * The stored values carry an internal grouping prefix, inconsistently: the same area appears
 * as "Cross-cutting - Digital Health (+AI)", with two spaces, and as "Cross-cutting Expert
 * Areas - Digital Health". Left alone they draw as three areas at one call each instead of
 * one area at three.
 *
 * A column value may be a Postgres array, a JSON array in a string, or a comma-separated
 * string; all three are in the live data.
 */
export function programmeAreaFreq(rows: Iterable<{ call_domain_areas?: unknown }>): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const row of rows) {
    const raw = row.call_domain_areas;
    let items: unknown[];
    if (typeof raw === "string") {
      const txt = raw.trim();
      if (txt.startsWith("[")) {
        try {
          const parsed = JSON.parse(txt);
          items = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          items = [txt];
        }
      } else {
        items = txt ? txt.split(",") : [];
      }
    } else if (Array.isArray(raw)) {
      items = raw;
    } else {
      items = raw ? [raw] : [];
    }

    const seenThisRow = new Set<string>();
    for (const item of items) {
      // `str(item or "")`: Python's falsy check, not a null check — a 0 or a False in the
      // column becomes "", not "0"/"false".
      let label = String(item ? item : "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      // "<Category> - <Sub-area>" → "<Sub-area>", split on the LAST separator so an area
      // whose own name contains a dash survives.
      const cut = label.lastIndexOf(" - ");
      if (cut !== -1) label = label.slice(cut + 3).trim();
      if (!label || AREA_NON_VALUES.has(label.toLowerCase())) continue;
      label = canonicalArea(label);
      if (!label) continue;
      // One call counts once for an area even if it lists it twice.
      if (seenThisRow.has(label.toLowerCase())) continue;
      seenThisRow.add(label.toLowerCase());
      freq[label] = (freq[label] ?? 0) + 1;
    }
  }
  return freq;
}
