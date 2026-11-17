// The donor vocabulary the WRITE dialogs need, from the generated table.
//
// Separate from model.ts only so a dialog does not pull the whole display/filter/export
// module in with it. Same source either way: web/src/generated/donor_vocab.json, emitted
// by scripts/gen_donor_vocab.py from core/donor_fields.py. Nothing here is hand-typed —
// a hand-typed category list is how the Add form starts offering a value the Python then
// folds into something else.
import V from "../generated/donor_vocab.json";

/** The six canonical categories, in the order the Add form offers them. */
export const CATEGORIES: string[] = V.categories;

/** The fixed enums, each with "" first as the unset option. */
export const CHOICE: Record<string, string[]> = V.choice;

/** A requirement's four states. Blank is "unanswered", NOT "not sure". */
export const TRISTATE_OPTS: string[] = V.tristateOpts;
export const TRISTATE_TO_VAL: Record<string, string | null> = V.tristateToVal;
export const VAL_TO_TRISTATE: Record<string, string> = V.valToTristate;

/** Free-text-to-finite-choice vocabularies for the full edit form. */
export const FUNDING_MECHANISMS: string[] = V.fundingMechanisms;
export const ROUTE_STATUSES: string[] = V.routeStatuses;
export const LOCAL_ORG_ELIGIBLE: string[] = V.localOrgEligible;
export const FUNDING_CYCLES: string[] = V.fundingCycles;
export const APPLICATION_PROCESSES: string[] = V.applicationProcesses;
export const REPORTING_REQUIREMENTS: string[] = V.reportingRequirements;
export const PARTNER_TYPE_OPTIONS: string[] = V.partnerTypeOptions;
export const OTHER: string = V.other;

/** Columns of the donor_contacts table (focal persons), in form order. */
export const CONTACT_COLS: string[] = V.contactCols;
