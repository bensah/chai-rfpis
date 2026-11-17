/**
 * Settings → Setup → Scan Preferences — the routes. `views/org_setup.py`'s fourth tab.
 *
 * THREE STORES, THREE SAVES, because that is where the data lives:
 *
 *   policies        `scan_policies`, TENANT-scoped. What the scan admits.
 *   search terms    `search_pivots_custom`, GLOBAL. What a broad web search fans out to.
 *   currencies      `currencies_json`, GLOBAL. The rates every amount converts at.
 *
 * THE SCOPING IS NOT A CHOICE MADE HERE, it is `core/settings._TENANT_SCOPED_KEYS`, which
 * holds exactly `schedule_json`, `scan_policies` and `team_members_json`. The other two
 * are deliberately shared: one deployment, one exchange-rate table. Writing them per
 * tenant would leave every tenant but the first converting at the YAML defaults, which is
 * the sort of difference nobody notices until two organisations disagree about the size
 * of the same award.
 *
 * THE EFFECTIVE POLICY IS NOT THE STORED POLICY. `core/policies.get_policies` merges the
 * saved overlay onto a base and then SEEDS an empty geography or theme scope from the
 * tenant's own profile — so what the editor shows is partly derived. The page is given
 * both, and told which is which, because saving the effective policy turns a seed into an
 * explicit choice and an admin should be able to see that happening.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";
import { loadOrg } from "./org.ts";
import { getPolicies } from "./policies.ts";
import { CRITERIA } from "./scorer.ts";
import { CRITERION_LABELS } from "./org_vocab.ts";
import { COUNTRIES, GEO_OPTIONS } from "./form_vocab.ts";
import { currencyRows, policyPayload, searchTerms, seedGeo } from "./scan_prefs.ts";

type Row = Record<string, unknown>;

const POLICIES_KEY = "scan_policies";
const PIVOTS_KEY = "search_pivots_custom";
const CURRENCIES_KEY = "currencies_json";

export function createScanPrefRoutes(db: Db) {
  const BLOCKED = () => json({ error: "Scan preferences are for administrators." }, 403);

  const tenantOf = (ctx: Ctx): string | null => {
    const tid = db.scopeTid(ctx.scope);
    return /^0{8}-/.test(tid) ? null : tid;
  };

  /** One setting's raw value, from the store `_scoped_store` would have chosen. */
  async function readSetting(tid: string | null, key: string, scoped: boolean): Promise<string> {
    const rows = scoped && tid
      ? await db.service.get("tenant_settings",
        `select=value&tenant_id=eq.${q(tid)}&key=eq.${q(key)}&limit=1`).catch(() => [] as Row[])
      : await db.service.get("app_settings",
        `select=value&key=eq.${q(key)}&limit=1`).catch(() => [] as Row[]);
    return str(rows[0]?.value);
  }

  async function writeSetting(
    ctx: Ctx, tid: string | null, key: string, value: string, scoped: boolean,
  ): Promise<void> {
    const updatedBy = str(ctx.user?.email);
    if (scoped && tid) {
      await db.service.upsert("tenant_settings",
        { tenant_id: tid, key, value, updated_by: updatedBy }, "tenant_id,key");
      return;
    }
    await db.service.upsert("app_settings", { key, value, updated_by: updatedBy }, "key");
  }

  /** `GET /settings/scan-prefs` — the effective policy, the raw one, and the two lists. */
  async function read(_req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const tid = tenantOf(ctx);

    const [rawPolicy, rawPivots, rawCurrencies, org] = await Promise.all([
      readSetting(tid, POLICIES_KEY, true),
      readSetting(tid, PIVOTS_KEY, false),
      readSetting(tid, CURRENCIES_KEY, false),
      loadOrg(db, tid),
    ]);

    // The stored document, parsed. The page edits THIS — not the effective policy — so an
    // empty geography stays visibly empty rather than appearing as a choice the admin
    // never made. The effective view travels alongside so the page can say what the scan
    // is doing today.
    let stored: Row = {};
    try {
      const parsed = rawPolicy ? JSON.parse(rawPolicy) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
    } catch {
      // An unparseable policy is no policy, which is what the Python's except branch
      // decides too. Reported, because a silent reset of the scan's rules is the sort of
      // thing somebody should hear about.
      stored = {};
    }
    const effective = getPolicies(rawPolicy || null, org.profile);

    let currencies: unknown[] = [];
    try {
      const parsed = rawCurrencies ? JSON.parse(rawCurrencies) : [];
      if (Array.isArray(parsed)) currencies = parsed;
    } catch { currencies = []; }

    let pivots: string[] = [];
    try {
      const parsed = rawPivots ? JSON.parse(rawPivots) : [];
      if (Array.isArray(parsed)) pivots = parsed.map((x) => str(x)).filter(Boolean);
    } catch { pivots = []; }

    return json({
      stored,
      // What the scan actually gates on right now, seeding included.
      effective,
      // True when the gate the scan uses is NOT what the document says — i.e. the scope
      // was seeded from the profile. The page says so, because saving makes it explicit.
      seeded: {
        countries: !((stored.countries as Row | undefined)?.eligible as unknown[])?.length
          && effective.countries.eligible.length > 0,
        themes: !((stored.themes as Row | undefined)?.required_any as unknown[])?.length
          && effective.themes.required_any.length > 0,
      },
      searchTerms: pivots,
      currencies,
      options: {
        countries: COUNTRIES,
        geoOptions: GEO_OPTIONS,
        criteria: [...CRITERIA],
        criterionLabels: CRITERION_LABELS,
      },
      policyParseError: !!rawPolicy && !Object.keys(stored).length,
      // GLOBAL, and the page says so beside the two controls it applies to.
      globalKeys: ["searchTerms", "currencies"],
    });
  }

  /**
   * `PUT /settings/scan-prefs/policies` — the whole policy document.
   *
   * The geo seed runs on the way IN, as the Python does, and the response says whether it
   * fired: "Never PERSIST a geo-empty policy for a tenant that HAS a geography in its
   * profile — a saved blank scope would otherwise read as 'see everything'."
   */
  async function putPolicies(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const tid = tenantOf(ctx);
    const form = (await body(req)) as Row;

    const built = policyPayload(form);
    const org = await loadOrg(db, tid);
    const policy = seedGeo(built, org.profile);
    const seeded = policy !== built;

    await writeSetting(ctx, tid, POLICIES_KEY, JSON.stringify(policy, null, 2), true);
    return json({
      policy,
      seeded,
      detail: seeded
        ? "Saved. You left the geography empty, so it was filled from this organisation's "
          + "registered and operating countries — a blank scope would have read as "
          + "“see everything” and turned the hard gate off."
        : "Saved. The next scan will use these rules.",
    });
  }

  /** `PUT /settings/scan-prefs/search-terms` — the custom web-search pivots. */
  async function putSearchTerms(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const p = (await body(req)) as Row;
    const terms = searchTerms(p.terms);
    await writeSetting(ctx, null, PIVOTS_KEY, JSON.stringify(terms), false);
    return json({
      terms,
      detail: `Saved ${terms.length} custom search term${terms.length === 1 ? "" : "s"} — `
        + "applied to the next broad web search, for every organisation on this "
        + "deployment.",
    });
  }

  /** `PUT /settings/scan-prefs/currencies` — the exchange-rate table. */
  async function putCurrencies(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const p = (await body(req)) as Row;
    const { rows, dropped } = currencyRows(p.rows);
    if (!rows.length) {
      // Refused rather than stored: an empty override list REPLACES the YAML wholesale,
      // so it would leave the deployment with no currency table at all and every
      // non-USD amount converting at 1.0.
      return json({
        error: "That would leave no currencies at all. The stored table replaces the "
          + "shipped defaults wholesale, so an empty one converts every amount at 1.0.",
      }, 400);
    }
    await writeSetting(ctx, null, CURRENCIES_KEY, JSON.stringify(rows), false);
    return json({
      rows,
      dropped,
      detail: `Saved ${rows.length} currenc${rows.length === 1 ? "y" : "ies"}`
        + (dropped
          ? `. ${dropped} row${dropped === 1 ? " was" : "s were"} dropped for a missing `
            + "code or a rate that was not a positive number."
          : ". These rates apply to every organisation on this deployment."),
    });
  }

  return { read, putPolicies, putSearchTerms, putCurrencies };
}
