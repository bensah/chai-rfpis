/**
 * Settings → Setup — the routes. `app_pages/admin.py` → `views/org_setup.py`.
 *
 * WHO MAY: admin and above, which is the gate on the whole Settings page in Streamlit
 * ("the nav already omits this page for non-admins, but gate here too in case someone
 * deep-links to it"). Enforced per route rather than once, because an Edge Function has
 * no nav to omit anything from.
 *
 * THREE SAVES, NOT ONE. See org_setup.ts — the Streamlit page has three buttons writing
 * three places, and folding them together would let a half-filled Bid Fitness tab
 * overwrite a complete identity while the Streamlit app, still live on the same rows,
 * kept writing them separately.
 *
 * WHAT IS NOT HERE, and is a gap rather than an omission:
 *
 *   * THE LOGO. `settings.set_org_logo` stores the file as base64 under `org_logo_b64`
 *     on the same identity blob. Uploading is a multipart body and a size decision, and
 *     the Streamlit uploader also warns above 5 MB and stores anyway; the READ carries
 *     the stored logo through so an organisation sees its own mark, and the editor says
 *     where to change it. Until that lands, the identity save is careful to preserve the
 *     key — `mergedIdentity` is built on the raw blob for exactly that reason.
 *   * SCAN PREFERENCES — policies, criteria terms, search terms, currency rates. Its own
 *     store (`core/policies.py`) and its own tab; `policies.ts` already reads them.
 *
 * THE VERIFY-AFTER-WRITE IS NOT BELT AND BRACES. The characteristic failure on these two
 * columns is not an exception: an RLS or wrong-key write returns success and changes
 * nothing. The Python re-reads and names the fields that did not land, pointing at the
 * Deployment diagnostics; so does this, with the same four fields and the same reason for
 * it being only those four.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";
import { coerceOverlay, loadOrg } from "./org.ts";
import { loadNameConfig } from "./report_names.ts";
import {
  base64Bytes, cleanPortalUrl, cleanTeam, derivedIdentity, identityFields, logoProblem,
  LOGO_MAX_BYTES, LOGO_MIME_TYPES, mergedIdentity, notPersisted, profileFields,
  renameImplied, renameOutcome, seedPartners, setOrgFields, strippedBase64, stripDerived,
  teamNames, VERIFIED_FIELDS, withLogo,
} from "./org_setup.ts";
import {
  AREA_TAXONOMY, BOARD_OPTIONS, CATEGORY_FULL, COFINANCING_LEVELS, DONOR_PORTAL_SEED,
  ENTITY_TYPE_LABELS, ENTITY_TYPES, LEGAL_TYPE_LABELS, LEGAL_TYPES, ORG_STAGES,
  PARTNER_STATUS, PARTNER_TYPES, PROPOSAL_LANGUAGES, ROUTE_OPTIONS,
} from "./org_vocab.ts";
import { COUNTRIES } from "./form_vocab.ts";

type Row = Record<string, unknown>;

const BLOCKED = () => json({ error: "Settings is for administrators." }, 403);

/** The write did not land, said the way the Python says it. */
const NOT_PERSISTED = (fields: string[]) => json({
  error: "Saved without an error, but these fields did NOT persist in the database: "
    + fields.join(", ")
    + ". The tenant write was likely blocked — check Settings → Accounts → Deployment "
    + "and confirm SUPABASE_KEY reads as the service-role key.",
  problems: fields,
}, 500);

export function createOrgSetupRoutes(db: Db) {
  /** The tenant these tabs write to — null when no tenant resolved (the all-zero scope). */
  const target = (ctx: Ctx): string | null => {
    const tid = db.scopeTid(ctx.scope);
    return /^0{8}-/.test(tid) ? null : tid;
  };

  /** The RAW identity blob, which is what a partial save merges onto. */
  async function storedIdentity(tenantId: string): Promise<Row> {
    const rows = await db.service.get(
      "tenants", `select=org_identity&id=eq.${q(tenantId)}&limit=1`).catch(() => [] as Row[]);
    return coerceOverlay(rows[0]?.org_identity) ?? {};
  }

  /**
   * `GET /settings/setup` — everything the four tabs render from.
   *
   * The vocabularies come down WITH the values rather than being imported by the browser,
   * for the split the generated tables already keep: these are repo constants, and the
   * donor names and portal hosts beside them are live rows. A page that imported one and
   * fetched the other would have two places to look when an option went missing.
   */
  async function read(_req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const tid = target(ctx);
    const [org, donors] = await Promise.all([
      loadOrg(db, tid),
      // The donor vocabulary both relationship pickers draw on, and the portal hosts.
      // Failure is not fatal: an admin who cannot reach donor_intel can still edit every
      // other field, and the pickers accept a typed value anyway.
      db.as(ctx.scope).getAll("donor_intel", "select=donor,donor_website", "donor")
        .catch(() => [] as Row[]),
    ]);

    const donorNames = [...new Set(
      donors.map((d) => str(d.donor).trim()).filter(Boolean))].sort();
    const portals = [...new Set([
      ...DONOR_PORTAL_SEED,
      // Cleaned by the SAME rule the seed was, ported rather than approximated: a second
      // normalisation that disagreed anywhere would list one portal twice, and ticking
      // the wrong one records a registration against a host no donor matches.
      ...donors.map((d) => cleanPortalUrl(d.donor_website)),
    ].filter((p) => p && p.includes(".")))].sort();

    return json({
      identity: org.identity,
      profile: org.profile,
      logo: org.logo,
      // The partner table AS THE EDITOR SEEDS IT: structured rows plus a one-time merge
      // of the legacy flat lists. It is not cosmetic — the save writes `partners` FROM
      // this table, so a legacy name that never reached the screen is gone the first
      // time anybody presses save.
      partners: seedPartners(org.profile),
      team: await teamRoster(tid),
      options: {
        legalTypes: LEGAL_TYPES,
        entityTypes: ENTITY_TYPES,
        stages: ORG_STAGES,
        cofinancing: COFINANCING_LEVELS,
        boards: BOARD_OPTIONS,
        routes: ROUTE_OPTIONS,
        languages: PROPOSAL_LANGUAGES,
        partnerTypes: PARTNER_TYPES,
        partnerStatus: PARTNER_STATUS,
        countries: COUNTRIES,
        // The two code-to-sentence tables. `org_legal_type` stores "higher_ed" and the
        // Streamlit editor shows "Higher Education" through `format_func`; without them
        // an admin picks identifiers out of a list, and "tribal" or "for_profit" do not
        // explain themselves.
        legalTypeLabels: LEGAL_TYPE_LABELS,
        entityTypeLabels: ENTITY_TYPE_LABELS,
        // [category, canonical keys] for the two rating matrices. THE KEYS TRAVEL WHOLE
        // and are never composed in the browser: a stored area is "IDs - Malaria & NTDs"
        // and that exact string is what program_area_classifier matches an organisation's
        // areas against a call's and a donor's. A key rebuilt from the category name
        // would look right and match nothing, costing MUST-2 and competitiveness at once.
        areaTaxonomy: AREA_TAXONOMY,
        // The prefix expanded, so the page can show "Malaria & NTDs · Infectious
        // Diseases" without knowing how a key is put together.
        categoryNames: CATEGORY_FULL,
        donors: donorNames,
        portals,
      },
      verifiedFields: [...VERIFIED_FIELDS],
      logo_limits: { maxBytes: LOGO_MAX_BYTES, types: Object.keys(LOGO_MIME_TYPES) },
    });
  }

  /** `PUT /settings/setup/identity` — the Profile tab's save. */
  async function putIdentity(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const tid = target(ctx);
    if (!tid) return json({ error: "No organization is resolved for this session." }, 409);

    const fields = identityFields((await body(req)) as Row);
    const written = await writeIdentity(tid, fields);
    if (written.error) return written.error;

    // VERIFY. The read goes back through loadOrg so it sees exactly what the page will:
    // tenants.name as org_name, placeholders substituted for blanks.
    const after = await loadOrg(db, tid);
    const bad = notPersisted(fields, after.identity);
    if (bad.length) return NOT_PERSISTED(bad);
    return json({ identity: after.identity, warnings: written.warnings });
  }

  /**
   * `PUT /settings/setup/profile` — the Bid Fitness tab's save.
   *
   * It writes BOTH columns, as the Python does: the profile blob, then three
   * competitiveness keys onto the identity. They are separate writes and the profile goes
   * first, so a failure on the second leaves the scoring profile saved rather than the
   * other way round.
   */
  async function putProfile(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const tid = target(ctx);
    if (!tid) return json({ error: "No organization is resolved for this session." }, 409);

    const form = (await body(req)) as Row;
    const profile = stripDerived(profileFields(form));
    const res = await db.service.update("tenants", `id=eq.${q(tid)}`, { org_profile: profile })
      .catch((e: unknown) => { throw e; });
    if (!Array.isArray(res) || !res.length) {
      return json({
        error: `tenants.org_profile update for ${tid} affected 0 rows — the write did not `
          + "persist (check RLS, and that SUPABASE_KEY is the service-role key).",
      }, 500);
    }

    const derived = derivedIdentity(profile.org_entity_type, form.hqCountry);
    const written = await writeIdentity(tid, derived);
    if (written.error) return written.error;

    // The Python's own verification: the profile is re-read and the legal type compared.
    const after = await loadOrg(db, tid);
    if (str(after.profile.org_legal_type) !== str(profile.org_legal_type)) {
      return json({
        error: "Saved without an error, but the profile did NOT persist in the database. "
          + "The tenant write was likely blocked — confirm migration 072 is applied and "
          + "SUPABASE_KEY is the service-role key.",
      }, 500);
    }
    return json({
      profile: after.profile, identity: after.identity,
      partners: seedPartners(after.profile), warnings: written.warnings,
    });
  }

  /** `PUT /settings/setup/team` — the roster. */
  async function putTeam(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const p = (await body(req)) as Row;
    // Either shape: the textarea's text, or an already-split list. `cleanTeam` is the
    // writer's own rule and applies to both — it is what keeps "Other" out of a roster
    // the dropdowns append "Other" to.
    const names = cleanTeam(Array.isArray(p.names) ? p.names : teamNames(p.text));
    await writeSetting(ctx, target(ctx), "team_members_json", JSON.stringify(names));
    return json({ team: names });
  }

  // ── shared ─────────────────────────────────────────────────────────────────

  /**
   * One partial identity write, with the rename it implies.
   *
   * The rename is reported as a WARNING rather than an error, which is the Python's own
   * choice and not a softening of it: `OrgRenameError` is raised after the identity
   * fields have already been stored, and the editor says "Every other field on this form
   * was saved." Returning 500 here would send an admin back to re-enter fields that are
   * already in the database.
   */
  async function writeIdentity(tid: string, fields: Record<string, string>): Promise<{
    error: Response | null; warnings: { code: string; detail: string }[];
  }> {
    const warnings: { code: string; detail: string }[] = [];
    const ident = mergedIdentity(await storedIdentity(tid), fields);
    const res = await db.service.update("tenants", `id=eq.${q(tid)}`, { org_identity: ident })
      .catch(() => null);
    if (!Array.isArray(res) || !res.length) {
      return {
        error: json({
          error: `tenants.org_identity update for ${tid} affected 0 rows — the write did `
            + "not persist (check RLS, and that SUPABASE_KEY is the service-role key).",
        }, 500),
        warnings,
      };
    }
    const name = renameImplied(setOrgFields(fields));
    if (name) {
      try {
        const r = await db.service.update("tenants", `id=eq.${q(tid)}`, { name });
        if (!Array.isArray(r) || !r.length) throw new Error("affected 0 rows");
      } catch (e) {
        const { message } = renameOutcome(name, e instanceof Error ? e.message : String(e));
        warnings.push({ code: "rename_failed", detail: message });
      }
    }
    return { error: null, warnings };
  }

  /**
   * The roster, read through `report_names.loadNameConfig` rather than a second query.
   *
   * That function already makes `_scoped_store`'s decision — tenant_settings when a
   * tenant resolves, the global app_settings row otherwise — and it is the same read the
   * opportunity forms use for the Proposal lead dropdown. Two readers of one key would be
   * two places to get that decision wrong, and getting it wrong in a view-as means
   * editing the super_user's own roster while the page says otherwise.
   *
   * "Other" is dropped again on the way out: loadNameConfig APPENDS it for the forms, and
   * it is not a person. `cleanTeam` is the same filter the save applies.
   */
  async function teamRoster(tid: string | null): Promise<string[]> {
    const names = await loadNameConfig(db, tid).catch(() => ({ roster: [] as string[] }));
    return cleanTeam(names.roster ?? []);
  }

  /**
   * `settings.set_setting`'s own routing, which is NOT one table.
   *
   * A tenant-scoped key with a tenant resolved goes to `tenant_settings`, keyed on
   * (tenant_id, key); everything else goes to the global `app_settings`, keyed on key
   * alone. Both are UPSERTS — `insert` would fail on the unique constraint the second
   * time anybody saved, which is every save after the first.
   *
   * The Python's fallback from tenant_settings to app_settings is deliberately NOT
   * copied: it fires only when the table itself is absent (pre-075), and this deployment
   * is long past that. Copying it would mean a transient error silently writing one
   * tenant's roster into the row every tenant reads.
   */
  async function writeSetting(ctx: Ctx, tid: string | null, key: string, value: string) {
    const updatedBy = str(ctx.user.email);
    if (tid) {
      await db.service.upsert("tenant_settings",
        { tenant_id: tid, key, value, updated_by: updatedBy }, "tenant_id,key");
      return;
    }
    await db.service.upsert("app_settings", { key, value, updated_by: updatedBy }, "key");
  }

  /**
   * `PUT /settings/setup/logo` — set or clear the organisation's mark.
   *
   * BASE64 IN JSON, not multipart. The image is STORED as base64 on the identity blob
   * either way, so a multipart upload would decode bytes only to re-encode them, and the
   * JSON body is the same shape every other save on this page uses.
   *
   * It writes through `withLogo` onto the RAW stored blob, for the reason `mergedIdentity`
   * exists: the branding and the eligibility flags live in that same column, and writing a
   * merged-with-defaults identity back would reset them. Clearing writes empty strings
   * rather than deleting the keys, so an old `org_logo_url` cannot resurrect itself.
   */
  async function putLogo(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const tid = target(ctx);
    if (!tid) return json({ error: "No organization is resolved for this session." }, 409);

    const p = (await body(req)) as Row;
    const clearing = p.clear === true;
    let b64 = "", mime = "";

    if (!clearing) {
      b64 = strippedBase64(p.data);
      mime = str(p.mime).trim().toLowerCase();
      // Size first, from the string's own length: an oversized upload is refused without
      // decoding anything, in a function billed by CPU time.
      const problem = logoProblem(mime, base64Bytes(b64));
      if (problem) return json({ error: problem }, 400);
    }

    const ident = withLogo(await storedIdentity(tid), b64, mime);
    const res = await db.service.update("tenants", `id=eq.${q(tid)}`, { org_identity: ident })
      .catch(() => null);
    if (!Array.isArray(res) || !res.length) {
      return json({
        error: `tenants.org_identity update for ${tid} affected 0 rows — the logo was not `
          + "saved (check RLS, and that SUPABASE_KEY is the service-role key).",
      }, 500);
    }
    const after = await loadOrg(db, tid);
    return json({
      logo: after.logo,
      detail: clearing
        ? "Logo removed. The header falls back to the organisation name."
        : "Logo saved. It appears in the page header and on exported reports.",
    });
  }

  return { read, putIdentity, putProfile, putTeam, putLogo };
}

