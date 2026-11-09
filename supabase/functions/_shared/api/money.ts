/**
 * Money, as the Streamlit app counts it: `core/dropdowns.py::usd_rate`,
 * `core/pipeline.py::usd_value`, and `core/records.py`'s request-currency and
 * submission-weight rules, ported together because the Outcome stage needs all four and
 * getting any one of them alone would produce a number that looks right.
 *
 * WHY THIS IS SERVER-SIDE AT ALL. `routes_pipelines.ts` says money conversion stays in the
 * browser, which holds the FX rates from `/scoring/snapshot`, and that a second rate source
 * here would drift from it. That still holds — and this is not a second source. `ratesFor`
 * below is the SAME function the snapshot calls; it is called one step earlier, so the
 * conversion happens where the rate is fetched instead of a round trip away. The Outcome
 * stage must not reach for `/scoring/snapshot` to add up its own totals: that is the Pyodide
 * seam the migration is retiring, and a win/loss total that stops working when the scoring
 * worker does would be a strange thing to have built.
 */
import { q, type Db } from "./db.ts";
import { normaliseCurrency, type Rate } from "./fx.ts";

export type Currency = {
  code: string; label: string; aliases: string[]; usdRate: number;
};

/**
 * `config/dropdowns.yaml`'s `currencies`, copied for the same reason `STAGES` and
 * `DECISIONS` are: this module also runs as a Deno Edge Function with no filesystem to read
 * the YAML from.
 *
 * THE DEFAULT, NOT THE TABLE. `core/dropdowns.py::load` replaces this list wholesale with
 * `app_settings.currencies_json` when a deployment has one — `data = {**data, "currencies":
 * overrides}`, a replacement rather than a merge — so the rates a deployment actually
 * converts at are configured in Admin → Settings and need not resemble these at all. This
 * one has six entries where the YAML has five: an admin added SEK, which no copy of the
 * file would ever have mentioned.
 *
 * Which is the whole reason `loadCurrencies` exists. Hard-coding the YAML here would have
 * been a table that silently disagreed with the Streamlit app for one currency and for any
 * rate anybody ever edits.
 */
export const DEFAULT_CURRENCIES: Currency[] = [
  { code: "USD", label: "USD", aliases: ["USD $", "US$", "$"], usdRate: 1.0 },
  { code: "GBP", label: "GBP", aliases: ["GBP £", "£"], usdRate: 1.33 },
  { code: "EUR", label: "EUR", aliases: ["Euro", "Euro €", "€"], usdRate: 1.16 },
  { code: "XAF", label: "FCFA", aliases: ["FCFA", "F CFA"], usdRate: 0.00166 },
  { code: "CAD", label: "CAD", aliases: ["CAD $", "Can$", "C$"], usdRate: 0.73 },
];

/** One entry of `currencies_json`, which is the YAML's own shape round-tripped through
 *  Admin → Settings. `symbol` is carried in the stored JSON and unused here. */
function toCurrency(v: unknown): Currency | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const code = String(o.code ?? "").trim();
  if (!code) return null;
  const rate = Number(o.usd_rate);
  return {
    code,
    label: String(o.label ?? code).trim() || code,
    aliases: Array.isArray(o.aliases)
      ? o.aliases.map((a) => String(a ?? "").trim()).filter(Boolean) : [],
    usdRate: Number.isFinite(rate) ? rate : 1.0,
  };
}

/**
 * The deployment's currency table: `app_settings.currencies_json` if it has one, else the
 * YAML defaults above.
 *
 * GLOBAL, not tenant-scoped, and that is the Python's routing rather than a simplification:
 * `currencies_json` is not in `core/settings.py::_TENANT_SCOPED_KEYS` (which holds only
 * `schedule_json`, `scan_policies` and `team_members_json`), so `_scoped_store` returns
 * None for it and the shared `app_settings` row answers for every tenant. Reading
 * `tenant_settings` here would find nothing and quietly fall back to the YAML.
 *
 * Never throws. A missing or malformed setting leaves the defaults in place, which is what
 * `load()`'s bare `except Exception: pass` does.
 */
export async function loadCurrencies(db: Db): Promise<Currency[]> {
  try {
    const rows = await db.service.get(
      "app_settings", `select=value&key=eq.${q("currencies_json")}&limit=1`);
    const raw = rows[0]?.value;
    if (!raw) return DEFAULT_CURRENCIES;
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return DEFAULT_CURRENCIES;
    const out = parsed.map(toCurrency).filter((c): c is Currency => c !== null);
    // A list that parses to nothing usable is a broken setting, not an instruction to
    // convert everything at 1.0.
    return out.length ? out : DEFAULT_CURRENCIES;
  } catch {
    return DEFAULT_CURRENCIES;
  }
}

/** `core/dropdowns.py::usd_rate`'s static half: code, then label, then aliases, then the
 *  first token. Returns null when the table has never heard of the value, which the caller
 *  reads as "no conversion" exactly as the Python's trailing `return 1.0` does. */
export function staticRate(currency: string, table: Currency[] = DEFAULT_CURRENCIES): number | null {
  const cur = currency.trim();
  if (!cur) return null;
  for (const e of table) if (e.code === cur) return e.usdRate;
  for (const e of table) if (e.label === cur) return e.usdRate;
  for (const e of table) if (e.aliases.includes(cur)) return e.usdRate;
  const first = cur.split(/\s+/)[0];
  for (const e of table) if (e.code === first) return e.usdRate;
  return null;
}

/**
 * USD per 1 unit of `currency`, given rates already fetched by `ratesFor`.
 *
 * `core/dropdowns.py::usd_rate`'s resolution order, and the order is the point: LIVE rate
 * first — so a currency missing from the static table (DKK, CHF, NGN) converts correctly
 * instead of silently defaulting to 1.0, which is the "$nan / treated as USD" bug that
 * function's docstring names — then the static table, then 1.0.
 *
 * The live lookup is keyed on the FIRST TOKEN, upper-cased, which is what the Python does
 * (`cur.split()[0].upper()`). It matters here: a third of this table's currency cells carry
 * a symbol — "GBP £", "Euro €", "CAD $" — and without the split none of them would reach a
 * live rate at all.
 */
export function usdRate(
  currency: unknown, rates: Record<string, Rate>, table: Currency[] = DEFAULT_CURRENCIES,
): number {
  const cur = String(currency ?? "").trim();
  if (!cur || cur.toUpperCase() === "USD") return 1.0;
  const key = normaliseCurrency(cur);
  const live = key ? rates[key]?.[0] : null;
  if (live) return live;
  return staticRate(cur, table) ?? 1.0;
}

/** `core/pipeline.py::usd_value` — 0 for anything that is not a number, which is how a NaN
 *  amount (the Excel import's empty cell) stops being counted rather than poisoning a sum. */
export function usdValue(
  amount: unknown, currency: unknown, rates: Record<string, Rate>,
  table: Currency[] = DEFAULT_CURRENCIES,
): number {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(n)) return 0;
  return n * usdRate(currency, rates, table);
}

/**
 * `core/records.py::requested_currency` — the currency the REQUEST was made in.
 *
 * `amount_requested` is what WE asked the funder for; `currency` is the unit the CALL was
 * advertised in. They are not the same thing, and conflating them is a named bug: a Canadian
 * call advertised in CAD against a budget submitted in USD rendered a USD 715,400 request as
 * "$509,530 USD" on the Grants page. The editor captures the submission currency once as
 * `currency_secured` — labelled simply "Currency", governing both the requested and the
 * secured amount — and `currency` is only the fallback for rows saved before that field
 * existed.
 *
 * Live, this is load-bearing right now: the one CAD call among the answered applications was
 * requested in USD, and reading the call's currency would understate it by 28%.
 */
export function requestedCurrency(row: {
  currency_secured?: unknown; currency?: unknown;
}): string {
  const cur = String(row.currency_secured ?? "").trim();
  return cur || String(row.currency ?? "").trim();
}

/**
 * `core/records.py::submission_weight` — how many donor-side applications this row is.
 *
 * NOT 1. A row submitted to a funder twice is TWO applications, and counting rows
 * under-reports every total, every bucket and the win rate. One live Not-Approved row
 * carries `submissions = 2`, so counting rows would show 4 losses where the Streamlit
 * Applied Funding page shows 5.
 *
 * ONLY `progress_status = Completed` opens the gate, and that is the owner's rule rather
 * than an oversight. `core/records.py` carries the incident: Total Submitted read 12 against
 * an applied-funding list of 13 because two rows had a donor decision of "Under Review" over
 * a `progress_status` still saying "Not Started" — stale from an edit. A donor decision
 * alone once resurrected counts migration 089 had deliberately reset, so the decision does
 * NOT open the gate; the data is what has to be kept honest instead. `ledgerGap` below is
 * how this stage makes that visible rather than waiting for somebody to notice two numbers
 * disagreeing on a dashboard.
 *
 * A Completed row counts at least once, which is also the floor migration 089 enforces.
 */
export function submissionWeight(row: RowLike): number {
  if (String(row.progress_status ?? "").trim().toLowerCase() !== "completed") return 0;
  const n = Number(row.submissions);
  return Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1;
}

/**
 * Rows the funder has answered that the submission ledger counts as zero applications,
 * because their `progress_status` never reached Completed.
 *
 * Reported, never repaired. Writing `progress_status = Completed` here because a decision
 * implies one is exactly the resurrection migration 089 undid. So the stage says which rows
 * disagree with themselves and lets a person decide — the same shape as the Bidding stage's
 * awaiting-submission panel, and for the same reason.
 */
export function ledgerGap<T extends RowLike>(rows: T[]): T[] {
  return rows.filter((r) => submissionWeight(r) === 0);
}

/**
 * A stored row, as these rules read one: the columns they actually look at, plus an index
 * signature that makes the type OPEN.
 *
 * The index signature is not decoration. `{ progress_status?: unknown }` is what TypeScript
 * calls a WEAK TYPE — every property optional — and it rejects any argument that shares no
 * DECLARED property with it. A plain `Record<string, unknown>` slips through, so this was
 * invisible while the callers passed raw rows; the moment one passed a row with derived
 * fields spread onto it the call stopped compiling, with "has no properties in common". An
 * index signature on the source does not rescue it. Opening the target does.
 */
type RowLike = { progress_status?: unknown; submissions?: unknown; [k: string]: unknown };
