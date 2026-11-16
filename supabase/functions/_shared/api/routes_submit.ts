/**
 * Submit New Notice — the route. `app_pages/submit_rfp.py` + `views/submit_form.py`.
 *
 * WHO MAY SUBMIT: any signed-in member. The Streamlit page says so in as many words —
 * "Open to ANY logged-in user (no admin gate)" — and it is the point of the page: capture
 * is the job of whoever found the call, and a gate here would send them to email instead.
 *
 * WHAT HAPPENS AFTER THE INSERT, and why it is not all done here:
 *
 *   * The seen-ledger tombstone. `core/seen_ledger.column_map()` PROBES the live rfp_seen
 *     table to learn whether it carries the modern or the legacy column spelling. Guessing
 *     that from TypeScript writes no tombstone while reporting success, which is the exact
 *     failure the ledger exists to end — the same reasoning `record_decision` gives.
 *   * The share to the global pool. `extracted_store.upsert_extracted` mints the pool's uid
 *     from the URL with `make_uid`, and a second implementation of that hash would key the
 *     same call two ways, so one tenant's manual capture would sit in the pool twice.
 *
 * Both are best-effort in the Python — wrapped in bare `except: pass`, never blocking the
 * insert — and both are a job here for the same reason. KNOWN GAP: the live deployment
 * holds no RFPIS_GH_DISPATCH_TOKEN, so that job is queued and never dispatched, and until
 * it is set a React submission gets no tombstone and shares nothing. The row itself, and
 * its score, land either way.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import { weekLabel } from "./actions.ts";
import type { Ctx } from "./session.ts";
import {
  buildRow, clampOffset, generateUid, localDay, needsSubmissionCheck, pickUid, poolRecord,
  validate, type SubmitPayload,
} from "./submit.ts";

type Enqueue = (
  kind: string, params: Record<string, unknown>, ctx: Ctx,
) => Promise<{ id: string; dispatched: boolean } | null>;

export function createSubmitRoutes(db: Db, enqueue: Enqueue | null = null) {
  /** `POST /submit` — capture one opportunity. */
  async function submit(req: Request, ctx: Ctx): Promise<Response> {
    const p = (await body(req)) as SubmitPayload;

    // VALIDATION FIRST, and nothing is written until it passes.
    const errors = validate(p);
    // `problems`, not a shape of this route's own: `api.ts::call` lifts that key onto the
    // ApiError every page already renders. The Python shows the same list in one block
    // ("Please fix the following:"), so all of them come back at once rather than one per
    // round trip.
    if (errors.length) return json({ error: "Please fix the following:", problems: errors }, 400);

    const now = new Date();
    const offset = clampOffset(p.offsetMinutes);
    const submitter = str(ctx.user.name).trim() || str(ctx.user.email).trim() || "XX";
    const base = generateUid(submitter, now, offset);

    // Every uid already minted this minute-stamp's DAY, in one read, so `pickUid` can bump
    // the minute without a query per attempt. `like` with a trailing * is a prefix match;
    // the stamp is fixed-width, so the prefix cannot reach into another day.
    const prefix = base.slice(0, base.lastIndexOf("-") + 1);
    const seen = await db.as(ctx.scope)
      .get("rfp_submissions", `select=uid&uid=like.${q(prefix)}*&limit=200`)
      .catch(() => [] as Record<string, unknown>[]);
    const uid = pickUid(base, new Set(seen.map((r) => str(r.uid))));

    let row: Record<string, unknown>;
    try {
      row = buildRow(p, {
        uid,
        submitter,
        email: str(ctx.user.email),
        nowIso: now.toISOString(),
        // `review_week_label()` with no argument — the week containing the submitter's own
        // today, not the upcoming one. A row records the week it was found in.
        reviewWeek: weekLabel(localDay(now, offset)),
        // The submitter's own calendar day, same source the uid and the review week use.
        today: localDay(now, offset),
      });
    } catch (e) {
      // The only throws in `buildRow` are the date-shaped ones, and they are the client
      // sending something a date input cannot produce.
      return json({ error: e instanceof Error ? e.message : "Bad value." }, 400);
    }

    const [saved] = await db.as(ctx.scope).insert("rfp_submissions", row);
    if (!saved) return json({ error: "The submission was not saved." }, 500);

    // Two jobs, not one, and deliberately: a re-score is idempotent arithmetic that may run
    // again any time, while the tombstone and the pool share are writes that should happen
    // once. Folding them together would mean a failed re-score re-running the share.
    const warnings: { code: string; detail: string }[] = [];
    if (enqueue) {
      const queued = await Promise.all([
        enqueue("rescore", { tenant_id: str(saved.tenant_id), uid }, ctx),
        enqueue("submit_followup", {
          tenant_id: str(saved.tenant_id), uid, pool: poolRecord(row),
        }, ctx),
      ]);
      // Said plainly rather than swallowed. The row is saved and the score on screen is
      // real; what is behind is the canonical re-score and the scan's tombstone, and a
      // submitter who is never told will not know to wonder why the call came back.
      if (!queued[0]?.dispatched) {
        warnings.push({
          code: "rescore_not_queued",
          detail: "Saved and scored, but the canonical re-score could not be started, so "
            + "the score shown is the form's own and may move when it runs.",
        });
      }
      if (!queued[1]?.dispatched) {
        warnings.push({
          code: "followup_not_queued",
          detail: "Saved, but the scan's record of this call could not be started. The "
            + "weekly scan may find it again and list it as new.",
        });
      }
    }

    return json({
      uid,
      alignmentScore: row.alignment_score,
      autoRecommendation: row.auto_recommendation,
      needsSubmissionCheck: needsSubmissionCheck(
        row.call_submission_deadline as string | null, localDay(now, offset),
      ),
      warnings,
    }, 201);
  }

  return { submit };
}
