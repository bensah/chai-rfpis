/**
 * Settings → Records → Data. `app_pages/admin.py`, the `_DATA_SPECS` branch.
 *
 * ONE ROUTE OVER SEVERAL TABLES, and the table is named by the CLIENT — which is exactly
 * the shape that becomes an arbitrary-read primitive if the name is trusted. It is not:
 * a request names a SPEC KEY ("Meeting Logs"), the spec says which table that is, and a
 * key that is not in the generated specs is refused. There is no path by which a string
 * from a request reaches PostgREST as a table name.
 *
 * The same applies to columns. Sort, filter and the save payload are all intersected
 * with the spec's own column lists, so a client cannot order by a column it invented or
 * write one the editor never offered.
 *
 * WHAT EACH BRANCH IS:
 *
 *   Screened Solicitations   NOT here. It is the opportunity line-list, which React
 *                            already renders as its own page from the same rows. A
 *                            second grid over it would be a second definition of what
 *                            "an opportunity" is, and the first one to drift would be
 *                            whichever nobody was looking at. The page links across.
 *   Extracted Solicitations  the GLOBAL raw store, every geography, before eligibility
 *                            screening. Read-only by design — a scan populates it — and
 *                            nothing else in React shows it at all.
 *   the four aux tables      meeting_logs, engagement_logs, applied_funding,
 *                            narrative_logs: read, edit, delete.
 *
 * WHY EDITING THEM HERE IS NOT DUPLICATION of the Meetings and Applications pages: those
 * pages write the rows a user OWNS, through forms shaped to the task. This is the
 * administrator's view of the table itself — every row, including ones Excel sync wrote,
 * with the columns that sync manages. The Streamlit page keeps them separate for the
 * same reason, and its caption on each table says which columns a re-sync overwrites.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";
import {
  EXTRACTED_COLUMNS, EXTRACTED_LABEL, RECORD_OPTIONS, RECORD_SPECS, SCREENED_LABEL,
  type RecordSpec,
} from "./records_vocab.ts";

type Row = Record<string, unknown>;

/** How many rows one table load pulls. The Streamlit page uses the same ceiling. */
const ROW_LIMIT = 2000;

export function createRecordRoutes(db: Db) {
  const BLOCKED = () => json({ error: "Records is for administrators." }, 403);

  /**
   * The spec a request named, or null.
   *
   * THE ONLY WAY A TABLE NAME IS CHOSEN. The client sends a label; this returns the spec
   * or nothing. A missing entry is a 400, never a fallback to some default table — a
   * fallback would answer a request for a table that does not exist with somebody
   * else's rows.
   */
  const specFor = (label: string): RecordSpec | null =>
    (Object.hasOwn(RECORD_SPECS, label) ? RECORD_SPECS[label] : null);

  /** `GET /settings/records?table=…` — one table's rows, plus what the page renders. */
  async function read(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const label = str(new URL(req.url).searchParams.get("table")) || RECORD_OPTIONS[0];

    if (label === SCREENED_LABEL) {
      // Answered rather than 404'd, so the page can say where the list lives instead of
      // looking broken. One list, one definition — the same argument the Archive tab makes.
      return json({
        table: label, kind: "screened", rows: [], total: 0, options: RECORD_OPTIONS,
        note: "The screened line-list is the Opportunities page — same rows, one list. "
          + "A second grid here would be a second definition of what an opportunity is.",
      });
    }

    if (label === EXTRACTED_LABEL) {
      // The GLOBAL store: not tenant-scoped, because it is not any tenant's. Read as the
      // session so the table's own policy decides, and read-only — there is no write
      // route to this table at all, by design.
      const rows = await db.as(ctx.scope).getAll(
        "extracted_solicitations", `select=${EXTRACTED_COLUMNS.join(",")}`, "opportunity_name")
        .catch(() => [] as Row[]);
      return json({
        table: label, kind: "extracted", rows, total: rows.length,
        options: RECORD_OPTIONS,
        columns: EXTRACTED_COLUMNS,
        note: "Every opportunity a scan captured, across all geographies, BEFORE "
          + "eligibility screening. Read-only: a scan populates it, and rows your "
          + "pipeline rejects on geography still appear here.",
      });
    }

    const spec = specFor(label);
    if (!spec) return json({ error: `No such table: ${label}` }, 400);

    const rows = await db.as(ctx.scope).getAll(
      spec.table, "select=*", spec.orderCol).catch(() => [] as Row[]);
    // Newest first, as `order(order_col, desc=True)` does. Sorted here rather than in the
    // query because `getAll` pages by its order column ascending to walk the table, so
    // asking it for descending would page incorrectly.
    rows.sort((a, b) => str(b[spec.orderCol]).localeCompare(str(a[spec.orderCol])));
    return json({
      table: label, kind: "aux", spec, options: RECORD_OPTIONS,
      rows: rows.slice(0, ROW_LIMIT), total: rows.length,
      truncated: rows.length > ROW_LIMIT,
    });
  }

  /** `PATCH /settings/records` — one row, only the columns the spec's editor offers. */
  async function update(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const p = (await body(req)) as Row;
    const spec = specFor(str(p.table));
    if (!spec) return json({ error: `No such table: ${str(p.table)}` }, 400);
    const id = str(p.id);
    if (!id) return json({ error: "Which row?" }, 400);

    // ONLY the editor's own fields. A column outside `editFields` is not a column this
    // surface edits, whatever a client sends — including `id`, `tenant_id` and anything
    // Excel sync owns that the dialog deliberately does not show.
    const allowed = new Map(spec.editFields.map(([col, kind]) => [col, kind]));
    const patch: Row = {};
    for (const [col, kind] of allowed) {
      if (!(col in (p.values as Row ?? {}))) continue;
      const v = (p.values as Row)[col];
      patch[col] = kind === "bool" ? !!v : (str(v).trim() || null);
    }
    if (!Object.keys(patch).length) return json({ error: "Nothing to change." }, 400);

    const saved = await db.as(ctx.scope).update(spec.table, `id=eq.${q(id)}`, patch);
    if (!Array.isArray(saved) || !saved.length) {
      // Zero rows is the tenant-scoping answer, not a missing row: the update is scoped,
      // so another tenant's row simply does not match. Saying "not found" is both true
      // and the only thing that should be said about it.
      return json({ error: "That row was not found in this organization's records." }, 404);
    }
    return json({ saved: saved[0] });
  }

  /** `DELETE /settings/records?table=…&id=…` — one row. */
  async function remove(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) return BLOCKED();
    const url = new URL(req.url);
    const spec = specFor(str(url.searchParams.get("table")));
    if (!spec) return json({ error: "No such table." }, 400);
    const id = str(url.searchParams.get("id"));
    if (!id) return json({ error: "Which row?" }, 400);
    const gone = await db.as(ctx.scope).delete(spec.table, `id=eq.${q(id)}`);
    if (!Array.isArray(gone) || !gone.length) {
      return json({ error: "That row was not found in this organization's records." }, 404);
    }
    return json({ deleted: id });
  }

  return { read, update, remove };
}
