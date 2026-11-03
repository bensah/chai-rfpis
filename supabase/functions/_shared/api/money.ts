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
import { normaliseCurrency, type Rate } from "./fx.ts";

/**
 * `config/dropdowns.yaml`'s `currencies`, copied for the same reason `STAGES` and
 * `DECISIONS` are: this module also runs as a Deno Edge Function with no filesystem to read
 * the YAML from. The test "the currency table matches config/dropdowns.yaml" keeps the copy
 * honest — including the rates, because a stale one here is a wrong total rather than a
 * failure anybody would see.
 *
 * These are the FALLBACK. `usd_rate` tries the live rate first and only lands here when the
 * network does not answer, which matters: the static GBP is 1.33 against a live 1.340956 and
 * the static EUR 1.16 against 1.119485, so the two disagree by up to about 3.6%.
 */
export const CURRENCIES: {
  code: string; label: string; aliases: string[]; usdRate: number;
}[] = [
  { code: "USD", label: "USD", aliases: ["USD $", "US$", "$"], usdRate: 1.0 },
  { code: "GBP", label: "GBP", aliases: ["GBP £", "£"], usdRate: 1.33 },
  { code: "EUR", label: "EUR", aliases: ["Euro", "Euro €", "€"], usdRate: 1.16 },
  { code: "XAF", label: "FCFA", aliases: ["FCFA", "F CFA"], usdRate: 0.00166 },
  { code: "CAD", label: "CAD", aliases: ["CAD $", "Can$", "C$"], usdRate: 0.73 },
  { code: "SEK", label: "SEK", aliases: ["SEK kr"], usdRate: 0.11 },
];

/** `core/dropdowns.py::usd_rate`'s static half: code, then label, then aliases, then the
 *  first token. Returns null when the table has never heard of the value, which the caller
 *  reads as "no conversion" exactly as the Python's trailing `return 1.0` does. */
export function staticRate(currency: string): number | null {
  const cur = currency.trim();
  if (!cur) return null;
  for (const e of CURRENCIES) if (e.code === cur) return e.usdRate;
  for (const e of CURRENCIES) if (e.label === cur) return e.usdRate;
  for (const e of CURRENCIES) if (e.aliases.includes(cur)) return e.usdRate;
  const first = cur.split(/\s+/)[0];
  for (const e of CURRENCIES) if (e.code === first) return e.usdRate;
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
export function usdRate(currency: unknown, rates: Record<string, Rate>): number {
  const cur = String(currency ?? "").trim();
  if (!cur || cur.toUpperCase() === "USD") return 1.0;
  const key = normaliseCurrency(cur);
  const live = key ? rates[key]?.[0] : null;
  if (live) return live;
  return staticRate(cur) ?? 1.0;
}

/** `core/pipeline.py::usd_value` — 0 for anything that is not a number, which is how a NaN
 *  amount (the Excel import's empty cell) stops being counted rather than poisoning a sum. */
export function usdValue(
  amount: unknown, currency: unknown, rates: Record<string, Rate>,
): number {
  const n = Number(amount);
  if (amount === null || amount === undefined || amount === "" || !Number.isFinite(n)) return 0;
  return n * usdRate(currency, rates);
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
export function submissionWeight(row: {
  progress_status?: unknown; submissions?: unknown;
}): number {
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
export function ledgerGap<T extends { progress_status?: unknown }>(rows: T[]): T[] {
  return rows.filter((r) => submissionWeight(r) === 0);
}
