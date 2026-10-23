// Program-area taxonomy + geography vocabularies, generated from the Python modules by
// scripts/export_web_vocab.py (core.program_area_classifier, core.geographies).
import vocab from "../generated/vocab.json";

const PA_KEYS = vocab.programAreas.keys as unknown as Record<string, [string, string]>;

export const PA_CATEGORIES: string[] = vocab.programAreas.categories;
export const GEO_OPTIONS: string[] = vocab.geo.options;

const KEYS_BY_CATEGORY = new Map<string, string[]>();
const KEYS_BY_SUBLABEL = new Map<string, string[]>();
for (const [k, [cat, sub]] of Object.entries(PA_KEYS)) {
  KEYS_BY_CATEGORY.set(cat, [...(KEYS_BY_CATEGORY.get(cat) ?? []), k]);
  KEYS_BY_SUBLABEL.set(sub, [...(KEYS_BY_SUBLABEL.get(sub) ?? []), k]);
}

function splitKey(key: string): [string, string] {
  const i = (key ?? "").indexOf(" - ");
  return i >= 0 ? [key.slice(0, i).trim(), key.slice(i + 3).trim()] : ["", (key ?? "").trim()];
}

/** 'Cross-cutting - Assistive Technology' -> 'Assistive Technology'. */
export function subareaLabel(key: string): string {
  return splitKey(key)[1];
}

/** 'HSS - Health Financing' -> 'Health System Strengthening'. */
export function categoryFull(key: string): string {
  if (PA_KEYS[key]) return PA_KEYS[key][0];
  const [pre] = splitKey(key);
  return pre || key;
}

/** Category names / canonical keys / bare sub-labels -> the set of canonical keys. */
export function expandProgramAreas(selections: string[]): Set<string> {
  const out = new Set<string>();
  for (const sel of selections) {
    const s = String(sel).trim();
    if (PA_KEYS[s]) out.add(s);
    else if (KEYS_BY_CATEGORY.has(s)) KEYS_BY_CATEGORY.get(s)!.forEach((k) => out.add(k));
    else if (KEYS_BY_SUBLABEL.has(s)) KEYS_BY_SUBLABEL.get(s)!.forEach((k) => out.add(k));
  }
  return out;
}

const REGION_MEMBERS = vocab.geo.regionMembers as Record<string, string[]>;

/** Region / tier / country labels -> lowercased labels plus every member country. */
export function expandGeo(selection: string[]): Set<string> {
  const out = new Set<string>();
  for (const item of selection) {
    const s = String(item).trim();
    if (!s) continue;
    out.add(s.toLowerCase());
    for (const c of REGION_MEMBERS[s.toLowerCase()] ?? []) out.add(c);
  }
  return out;
}

export const RATING_WORD = ["None", "Very low", "Low", "Medium", "High", "Very high"];
