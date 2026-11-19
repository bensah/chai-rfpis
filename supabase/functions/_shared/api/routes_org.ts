/**
 * My Organization — the route. `app_pages/organization.py`.
 *
 * ONE READ, NO WRITES. The page is a read-only view of what the matching engine believes
 * about a tenant; the editor is Settings → Setup (`views/org_setup.py`), which this port
 * has not reached. `canEdit` travels so the page can say which it is — "View only —
 * editing is restricted to app owners" is the Streamlit wording and it is the honest one.
 *
 * WHICH TENANT. `db.scopeTid` already resolves a super_user's view-as, which is exactly
 * what the Streamlit page does by hand through `su_view_tenant` — and its comment is worth
 * repeating here because the trap is the same: the ACCOUNT role decides, never the
 * effective one. `is_super_user()` answers False for the duration of a view-as, so gating
 * on it would drop the target and swing the page back to the super's own entity the moment
 * they opened somebody else's. `scopeTid` reads `viewTenantId` first for that reason, so
 * this route simply asks it.
 */
import { json } from "./http.ts";
import {
  completeness, entityTypeLabel, filled, legalTypeLabel, loadOrg, ragBand, ratingRows,
  readinessGap, subareaLabel, ungraded,
} from "./org.ts";
import { loadNameConfig } from "./report_names.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Db } from "./db.ts";
import type { Ctx } from "./session.ts";

export function createOrgRoutes(db: Db) {
  /** `GET /organization` — identity, profile, completeness and the roster. */
  async function read(_req: Request, ctx: Ctx): Promise<Response> {
    const tid = db.scopeTid(ctx.scope);
    const tenantId = /^0{8}-/.test(tid) ? null : tid;
    const [org, names] = await Promise.all([
      loadOrg(db, tenantId),
      // The roster, scoped to the entity being SHOWN. The Streamlit page passes the
      // view-as tenant for the same reason: a super_user's own roster listed under
      // another organisation's details is a believable, wrong answer.
      loadNameConfig(db, tenantId).catch(() => ({ roster: [] as string[] })),
    ]);

    const { pct, missing } = completeness(org.identity, org.profile);
    const p = org.profile;
    return json({
      identity: org.identity,
      profile: p,
      logo: org.logo,
      // RESOLVED HERE, NOT IN THE PAGE. The labels come from tables generated out of the
      // Python (org_vocab.ts) and the rating order is `rating_bars_html`'s own
      // `(-value, key)` — a total order, so both apps list the same areas in the same
      // sequence rather than agreeing only on the set. A browser copy of either would be
      // a second implementation of something the Python owns.
      labels: {
        legalType: legalTypeLabel(p.org_legal_type),
        entityType: entityTypeLabel(p.org_entity_type),
      },
      ratings: {
        domain: ratingRows(p.org_domain_ratings),
        priority: ratingRows(p.org_priority_ratings),
        // Selected but ungraded: shown as plain chips beside the bars, labelled the same
        // way a graded one is so the two lists read as one vocabulary.
        domainUngraded: ungraded(p.org_domain_expertise, p.org_domain_ratings).map(subareaLabel),
        priorityUngraded: ungraded(p.org_priority_areas, p.org_priority_ratings).map(subareaLabel),
      },
      completeness: {
        pct,
        missing,
        band: ragBand(pct),
        gap: readinessGap(p),
        // Either geography field counts here, where `readinessGap` wants the operating
        // one specifically. The page asks a different question with it — "is there any
        // geography at all" decides whether to warn or merely nudge.
        hasGeo: filled(p.org_registered_countries) || filled(p.org_operating_countries),
      },
      // `loadNameConfig` appends "Other" the way core/dropdowns.py does, for the forms.
      // It is not a person and must not be listed as one.
      team: (names.roster ?? []).filter((n) => n && n !== "Other"),
      canEdit: isAdmin(ctx.user as PermUser),
    });
  }

  return { read };
}
