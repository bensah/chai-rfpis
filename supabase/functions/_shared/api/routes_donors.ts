/**
 * Writing to the donor catalogue — queued, never applied here.
 *
 * NOTHING IN THIS FILE WRITES TO donor_intel, and that is the whole design. The rules a
 * donor save has to apply live in `core/donor_write.py`, where app_pages/donors.py also
 * calls them: a payload-cleaning rule where `or None` collapses False and 0 as well as
 * "", an intersection with the LIVE columns that names what it drops, a human-verified
 * provenance tag that stops auto-enrichment overwriting a reviewer's answers, and an
 * upsert that verifies a row came back because PostgREST answers 200 with an empty list
 * when RLS refuses it.
 *
 * Re-implementing those four in TypeScript would put a second set of rules about shared,
 * cross-tenant data where the first one cannot see it — the same argument
 * `routes_platform.ts` makes about the suggestion queue and `run_web_job.py` makes about
 * the approval path, and the same failure: a quietly wrong donor record rather than an
 * error. So every route here queues a `donor_action` job and says so plainly.
 *
 * THE PERMISSION SPLIT IS NOT CHECKED HERE EITHER. Donor Intelligence has two audiences
 * by design — a developer-tenant Super User edits the row, everyone else proposes a
 * change for review — and both arrive as the same job kind. `_donor_action` reads the
 * actor from the users table and enforces the split against the same record the
 * Streamlit page checks, so the answer cannot differ between the two apps. What this
 * file does enforce is the shape of a request, because a malformed one should be a 400
 * now rather than a job that fails in a runner five minutes later.
 */
import { body, json, str } from "./http.ts";
import type { Db } from "./db.ts";
import type { Ctx } from "./session.ts";

type Row = Record<string, unknown>;
type Enqueue = (
  kind: string, params: Row, ctx: Ctx,
) => Promise<{ id: string; dispatched: boolean } | null>;

/** Said the same way everywhere: queued is not done, and not dispatched is not queued. */
function queuedReply(
  queued: { id: string; dispatched: boolean } | null, done: string,
): Response {
  if (!queued) return json({ error: "Could not queue the change." }, 500);
  return json({
    job_id: queued.id,
    dispatched: queued.dispatched,
    // A row that is queued but undispatched is a DIFFERENT state from both "done" and
    // "failed", and it is the one this product fails at worst: nothing errors, the job
    // simply sits at "queued" for ever. So it is named rather than smoothed over.
    detail: queued.dispatched
      ? done
      : "Queued, but no runner could be reached — nothing has been changed yet.",
  });
}

export function createDonorWriteRoutes(_db: Db, enqueue: Enqueue | null) {
  /** `POST /donors` — create a donor, or propose one. */
  async function create(req: Request, ctx: Ctx): Promise<Response> {
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);
    const b = (await body(req).catch(() => ({}))) as Row;
    const name = str(b.name).trim();
    if (!name) return json({ error: "A donor name is required." }, 400);
    const suggest = b.suggest === true;
    const queued = await enqueue("donor_action", {
      action: suggest ? "suggest_add" : "add",
      name,
      edited: (b.edited && typeof b.edited === "object") ? b.edited : {},
      rationale: str(b.rationale).trim() || null,
      by: str(ctx.user.email),
    }, ctx);
    return queuedReply(queued, suggest
      ? "Queued. A developer Super User will review adding this donor."
      : "Queued. The runner holds the rules about the shared catalogue.");
  }

  /** `PATCH /donors/:key` — save an edit, or propose one. */
  async function update(req: Request, ctx: Ctx, key: string): Promise<Response> {
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);
    const b = (await body(req).catch(() => ({}))) as Row;
    const edited = (b.edited && typeof b.edited === "object") ? b.edited as Row : null;
    // An empty edit is refused rather than queued: a job that does nothing still reports
    // "Saved", and a user who watched it succeed would believe their change landed.
    if (!edited || Object.keys(edited).length === 0) {
      return json({ error: "Nothing to save — no fields were changed." }, 400);
    }
    const queued = await enqueue("donor_action", {
      action: b.suggest === true ? "suggest" : "save",
      canonical_key: key,
      edited,
      // Only sent when the request carries them. An ABSENT contacts list and an EMPTY one
      // are different instructions — the runner REPLACES this donor's contacts with what
      // it is given, so passing [] for "the form did not show contacts" would delete
      // every focal person the donor has.
      ...(Array.isArray(b.contacts) ? { contacts: b.contacts } : {}),
      rationale: str(b.rationale).trim() || null,
      by: str(ctx.user.email),
    }, ctx);
    return queuedReply(queued, b.suggest === true
      ? "Queued. A developer Super User will review the proposed changes."
      : "Queued. The runner applies the same rules as the classic app.");
  }

  /** `DELETE /donors/:key`, and `POST /donors/delete` for a selection. */
  async function remove(req: Request, ctx: Ctx, key: string | null): Promise<Response> {
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);
    let keys: string[] = key ? [key] : [];
    if (!key) {
      const b = (await body(req).catch(() => ({}))) as Row;
      keys = Array.isArray(b.keys)
        ? b.keys.map((k) => str(k).trim()).filter(Boolean)
        : [];
    }
    if (!keys.length) return json({ error: "No donors selected." }, 400);
    const queued = await enqueue("donor_action", {
      action: "delete", keys, by: str(ctx.user.email),
    }, ctx);
    return queuedReply(queued,
      `Queued. ${keys.length} donor(s) will be removed from the shared catalogue.`);
  }

  /**
   * `POST /donors/pdf` — render one or more donor profiles as a branded A4 PDF.
   *
   * THE ONE ROUTE HERE THAT QUEUES A READ. Everything else in this file queues a write
   * and says so; this queues `donor_pdf`, which selects, renders with reportlab and
   * uploads one file. It is in this file because it is the same resource and the same
   * seam, not because it changes anything.
   *
   * It does not go through `donor_action`, deliberately. That kind's first act is to
   * decide whether the actor may edit the shared catalogue, and a reader asking for a
   * printout of what is already on their screen should never be asked that question —
   * answering it "no" is the behaviour a reader would be stuck with.
   *
   * The reply is the queued job, not the file. The caller polls the job and follows the
   * signed URL in its result, exactly as the Report export does.
   */
  async function pdf(req: Request, ctx: Ctx): Promise<Response> {
    if (!enqueue) return json({ error: "Background jobs are not configured." }, 503);
    const b = (await body(req).catch(() => ({}))) as Row;
    const keys = Array.isArray(b.keys)
      ? b.keys.map((k) => str(k).trim()).filter(Boolean)
      : [];
    if (!keys.length) return json({ error: "No donors selected." }, 400);
    // A bound, because each donor is a page or more of reportlab flowables and the
    // runner has six minutes. Refusing 200 donors now is a better answer than a job
    // that is killed half-way and leaves nothing to download.
    if (keys.length > 50) {
      return json({
        error: `${keys.length} donors is more than one PDF can hold. `
          + "Select up to 50, or use the CSV export for the whole table.",
      }, 400);
    }
    const queued = await enqueue("donor_pdf", {
      keys,
      by: str(ctx.user.email),
      // Named here rather than in the runner so the UI can show the filename while the
      // job is still running, which is most of the wait.
      filename: str(b.filename).trim() || undefined,
      contacts: b.contacts !== false,
    }, ctx);
    return queuedReply(queued,
      keys.length === 1 ? "Queued. The PDF will be ready shortly."
        : `Queued. A PDF of ${keys.length} donors will be ready shortly.`);
  }

  return { create, update, remove, pdf };
}
