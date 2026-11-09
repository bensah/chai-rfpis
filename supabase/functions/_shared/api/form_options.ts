/**
 * What the RFP editor's dropdowns offer — `core/dropdowns.py::load` for the browser.
 *
 * One route rather than a constant in the client, because two of these lists are NOT
 * repo data. `core/dropdowns.load` overlays `team_members` and `currencies` from
 * `app_settings` on top of the YAML, and the roster in particular is tenant-scoped and
 * deliberately absent from the repo: `core/settings.get_team_members` says real names are
 * "never committed to the public repo; they're configured per-deployment". A client-side
 * copy would either leak one deployment's staff into source or offer the YAML's
 * "Team Member 1..N" placeholders, which is how a free-text box got the same person
 * recorded under four spellings and split every per-person figure on the Report.
 *
 * The REST of the vocabularies are generated into `form_vocab.ts` from the Python that
 * owns them (scripts/gen_form_vocab.py), for the reason geo_tables.ts gives: a controlled
 * vocabulary hand-copied into TypeScript drifts, and a dropdown offering a value the
 * Python does not recognise writes a row nothing downstream can read.
 *
 * So this module's only real work is the overlay, in the same order `load()` applies it.
 */
import { loadCurrencies } from "./money.ts";
import { loadNameConfig } from "./report_names.ts";
import { gzipped, json } from "./http.ts";
import type { Db } from "./db.ts";
import type { Ctx } from "./session.ts";
import {
  CRITERION_ANSWERS, CRITERION_DEFAULTS, DROPDOWNS, GEO_OPTIONS, INSTRUMENT_TYPES,
  OPPORTUNITY_TYPES, PROGRAM_AREAS, SOLICITATION_TYPES,
} from "./form_vocab.ts";

export type FormOptions = {
  dropdowns: Record<string, string[]>;
  programAreas: string[];
  geoOptions: string[];
  criterionAnswers: Record<string, string[]>;
  criterionDefaults: Record<string, Record<string, string>>;
  opportunityTypes: string[];
  solicitationTypes: string[];
  instrumentTypes: string[];
  teamMembers: string[];
  currencies: string[];
};

export function createFormOptions(db: Db) {
  /**
   * Every list the editor needs, in one response.
   *
   * Cached for a minute at the browser. These change when an admin edits the roster or
   * the currency table, not between keystrokes, and the editor asks for them each time it
   * opens — a minute keeps a session of edits off the database without making a roster
   * change wait for a reload.
   */
  async function options(req: Request, ctx: Ctx): Promise<Response> {
    // `db.scopeTid` resolves view-as; the all-zero id is the single-tenant sentinel, which
    // `_scoped_store` treats as "no tenant" so the GLOBAL app_settings row answers. Same
    // test routes_report.ts makes for the same call.
    const tid = db.scopeTid(ctx.scope);
    const [names, currencies] = await Promise.all([
      loadNameConfig(db, tid.startsWith("00000000-") ? null : tid),
      loadCurrencies(db),
    ]);

    const body: FormOptions = {
      dropdowns: DROPDOWNS,
      programAreas: PROGRAM_AREAS,
      geoOptions: GEO_OPTIONS,
      criterionAnswers: CRITERION_ANSWERS,
      criterionDefaults: CRITERION_DEFAULTS,
      opportunityTypes: OPPORTUNITY_TYPES,
      solicitationTypes: SOLICITATION_TYPES,
      instrumentTypes: INSTRUMENT_TYPES,
      // `loadNameConfig` already appends "Other" the way core/dropdowns.py does, so the
      // form's "Other → specify" path stays a roster entry.
      teamMembers: names.roster,
      currencies: currencies.map((c) => c.code),
    };
    return gzipped(req, json(body, 200, { "Cache-Control": "private, max-age=60" }));
  }

  return { options };
}
