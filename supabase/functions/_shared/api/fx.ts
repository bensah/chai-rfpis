/**
 * Exchange rates for the browser's scoring engine.
 *
 * `core/fx.py` converts non-USD award amounts with a live rate from open.er-api.com. The
 * browser cannot make that call (no httpx under Pyodide) and would silently fall back to the
 * static table in config/dropdowns.yaml — EUR 1.16 against a live 1.1203, enough to move an
 * amount into a different scoring band. So the server fetches the rates and sends them with
 * the snapshot.
 *
 * Normalisation and the cache lifetimes mirror core/fx.py exactly, because the browser looks
 * these up by the key that module computes.
 */

const ERAPI = "https://open.er-api.com/v6/latest/";
const RATE_TTL_MS = 6 * 3600 * 1000;    // core/fx.py::_RATE_TTL
const FAIL_TTL_MS = 15 * 60 * 1000;     // core/fx.py::_FAIL_TTL
const TIMEOUT_MS = 4000;                // core/fx.py::_HTTP_TIMEOUT

/** core/fx.py::_ALIAS */
const ALIAS: Record<string, string> = {
  EURO: "EUR", EUROS: "EUR", POUND: "GBP", POUNDS: "GBP", STERLING: "GBP",
  DOLLAR: "USD", DOLLARS: "USD", US: "USD", USDOLLAR: "USD", FCFA: "XAF",
  CFA: "XAF", RAND: "ZAR", NAIRA: "NGN", SHILLING: "KES", KRONE: "DKK", KRONER: "DKK",
};

export type Rate = [number | null, string | null];

// Per function instance, like the module-level cache in Python.
const cache = new Map<string, { at: number; rate: Rate }>();

/**
 * The key core/fx.py would look the rate up under, or null when it would not even try.
 *
 * THE FIRST-TOKEN SPLIT IS NOT A TIDY-UP. `core/dropdowns.py::usd_rate` calls the live
 * lookup with `cur.split()[0].upper()`, and this did not, so every currency cell carrying a
 * symbol — "GBP £", "Euro €", "CAD $" — failed the ISO test here, returned null, and fell
 * back to the static table while the Python used the live rate. That is 13 live rows, and
 * the two tables disagree: static GBP 1.33 against a live 1.340956, static EUR 1.16 against
 * 1.119485, static CAD 0.73 against 0.715262 — up to about 3.6%, which `fx.ts`'s own header
 * says is "enough to move an amount into a different scoring band".
 *
 * The alias lookup runs twice on purpose: once on the whole string, so a multi-word name
 * the table knows ("F CFA") still resolves, and once on the first token for the rest.
 */
export function normaliseCurrency(raw: unknown): string | null {
  const whole = String(raw ?? "").trim().toUpperCase();
  let cur = ALIAS[whole] ?? whole;
  if (!/^[A-Z]{3}$/.test(cur)) {
    const first = cur.split(/\s+/)[0] ?? "";
    cur = ALIAS[first] ?? first;
  }
  if (!cur || cur === "USD") return null;          // USD needs no rate
  if (!/^[A-Z]{3}$/.test(cur)) return null;        // not an ISO code — never worth a call
  return cur;
}

async function fetchRate(cur: string): Promise<Rate> {
  try {
    const r = await fetch(ERAPI + cur, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) return [null, null];
    const j = await r.json() as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
    if (j.result !== "success") return [null, null];
    const usd = j.rates?.USD;
    if (!usd) return [null, null];
    return [usd, (j.time_last_update_utc ?? "").slice(0, 16) || new Date().toISOString().slice(0, 10)];
  } catch {
    return [null, null];
  }
}

/** Rates for every currency in `values`, keyed as core/fx.py keys its cache. Never throws:
 * a currency that cannot be resolved is simply absent, and the browser falls back exactly
 * as Python does. */
export async function ratesFor(values: unknown[]): Promise<Record<string, Rate>> {
  const wanted = new Set<string>();
  for (const v of values) {
    const c = normaliseCurrency(v);
    if (c) wanted.add(c);
  }
  const now = Date.now();
  const out: Record<string, Rate> = {};
  const missing: string[] = [];
  for (const cur of wanted) {
    const hit = cache.get(cur);
    const ttl = hit && hit.rate[0] !== null ? RATE_TTL_MS : FAIL_TTL_MS;
    if (hit && now - hit.at < ttl) out[cur] = hit.rate;
    else missing.push(cur);
  }
  const fetched = await Promise.all(missing.map(async (cur) => [cur, await fetchRate(cur)] as const));
  for (const [cur, rate] of fetched) {
    cache.set(cur, { at: now, rate });
    out[cur] = rate;
  }
  return out;
}
