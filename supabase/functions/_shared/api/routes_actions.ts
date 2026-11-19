/**
 * Meeting Actions — the routes. One read, four writes.
 *
 * WHO MAY WRITE: any signed-in member. That is the Streamlit gate too —
 * `role in ("super_user", "admin", "reviewer", "collaborator")`, which is everyone the app
 * issues a session to — and it is deliberate rather than lax: the note-taker rota rotates
 * through every member, Contributors included, so the person who has to write Monday's
 * notes is whoever is on the rota that week. Narrowing it here would lock the rota's own
 * people out of the job it gives them.
 *
 * The one thing NOT open is the schedule, which is the rota itself; changing who chairs a
 * call is an administrative act, not note-taking.
 */
import { q, type Db } from "./db.ts";
import { body, json, str } from "./http.ts";
import {
  buildActions, ENGAGEMENT_FIELDS, loadSchedule, NOTE_FIELDS, weekBounds, type RotaEntry,
} from "./actions.ts";
import { isAdmin, type PermUser } from "./permissions.ts";
import type { Ctx } from "./session.ts";

const today = () => new Date().toISOString().slice(0, 10);

/** A day, or null. A blank clears the column; anything unparseable is refused, not dropped. */
function dayOrNull(v: unknown, field: string): string | null {
  const t = str(v).trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.slice(0, 10))) throw new Error(`${field} must be a date`);
  return t.slice(0, 10);
}

export function createActionRoutes(db: Db) {
  const tid = (ctx: Ctx) => {
    const t = db.scopeTid(ctx.scope);
    return /^0{8}-/.test(t) ? null : t;
  };

  /** `GET /actions?week=YYYY-MM-DD` — everything all four tabs need. */
  async function read(req: Request, ctx: Ctx): Promise<Response> {
    const p = new URL(req.url).searchParams;
    const asked = str(p.get("week")).trim();
    const week = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today();
    const [notes, engagements, schedule] = await Promise.all([
      db.as(ctx.scope).getAll("meeting_logs", `select=${NOTE_FIELDS}`, "id"),
      db.as(ctx.scope).getAll("engagement_logs", `select=${ENGAGEMENT_FIELDS}`, "id"),
      loadSchedule(db, tid(ctx)),
    ]);
    return json({
      ...buildActions({ notes, engagements, schedule, week, today: today() }),
      canEditSchedule: isAdmin(ctx.user as PermUser),
    });
  }

  /**
   * `POST /actions/notes` — a note on a week's call.
   *
   * `meeting_date` is snapped to that week's MONDAY. The Streamlit form takes a week and
   * writes its Monday; a client posting an arbitrary day would create a week nothing else
   * on the page can find, because every other read groups by Monday.
   */
  async function createNote(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const actions = str(b.actions).trim();
    if (!actions) return json({ error: "An action is required." }, 400);
    const when = dayOrNull(b.meetingDate, "meetingDate") ?? today();
    const [row] = await db.as(ctx.scope).insert("meeting_logs", {
      meeting_date: weekBounds(when).monday,
      rfp_uid: str(b.rfpUid).trim() || null,
      donor_title: str(b.donorTitle).trim() || null,
      remarks: str(b.remarks).trim(),
      actions,
      owner: str(b.owner).trim() || null,
      deadline: dayOrNull(b.deadline, "deadline"),
      is_resolved: b.resolved === true,
    });
    return json({ id: str(row?.id) }, 201);
  }

  /**
   * `PATCH /actions/notes/:id` — edit one, or just tick it resolved.
   *
   * SPARSE: only the keys present are written. The resolve toggle on the Pending tab sends
   * `{resolved}` alone, and a full write would blank every field the toggle never saw.
   */
  async function patchNote(req: Request, ctx: Ctx, id: string): Promise<Response> {
    const b = await body(req);
    const patch: Record<string, unknown> = {};
    if ("remarks" in b) patch.remarks = str(b.remarks).trim();
    if ("actions" in b) {
      const a = str(b.actions).trim();
      if (!a) return json({ error: "An action is required." }, 400);
      patch.actions = a;
    }
    if ("owner" in b) patch.owner = str(b.owner).trim() || null;
    if ("rfpUid" in b) patch.rfp_uid = str(b.rfpUid).trim() || null;
    if ("donorTitle" in b) patch.donor_title = str(b.donorTitle).trim() || null;
    if ("deadline" in b) patch.deadline = dayOrNull(b.deadline, "deadline");
    if ("resolved" in b) patch.is_resolved = b.resolved === true;
    if (!Object.keys(patch).length) return json({ error: "Nothing to change." }, 400);
    const rows = await db.as(ctx.scope).update("meeting_logs", `id=eq.${q(id)}`, patch);
    // A tenant-scoped update that matches nothing is a note in another tenant, or one
    // already deleted. Both are "not yours to change" and neither deserves a 500.
    if (!rows.length) return json({ error: "That note no longer exists." }, 404);
    return json({ ok: true });
  }

  /** `POST /actions/engagements` — a donor touchpoint. */
  async function createEngagement(req: Request, ctx: Ctx): Promise<Response> {
    const b = await body(req);
    const donor = str(b.donor).trim();
    if (!donor) return json({ error: "A donor is required." }, 400);
    const [row] = await db.as(ctx.scope).insert("engagement_logs", {
      engagement_date: dayOrNull(b.date, "date") ?? today(),
      donor,
      engagement_type: str(b.type).trim() || null,
      format: str(b.format).trim() || null,
      internal_lead: str(b.internalLead).trim() || null,
      donor_contacts: str(b.donorContacts).trim() || null,
      purpose: str(b.purpose).trim() || null,
      outcome: str(b.outcome).trim() || null,
      linked_rfp_uid: str(b.rfpUid).trim() || null,
      // Explicitly false, never left NULL. NULL is the pre-migration-014 state and
      // `engagementOpen` reads it through the outcome instead — writing one today would
      // make a brand-new engagement's openness depend on whether somebody typed an
      // outcome into it, which is not what the tick box means.
      is_resolved: b.resolved === true,
    });
    return json({ id: str(row?.id) }, 201);
  }

  /** `PATCH /actions/engagements/:id` — same sparse rule as notes. */
  async function patchEngagement(req: Request, ctx: Ctx, id: string): Promise<Response> {
    const b = await body(req);
    const patch: Record<string, unknown> = {};
    const map: Record<string, string> = {
      donor: "donor", type: "engagement_type", format: "format",
      internalLead: "internal_lead", donorContacts: "donor_contacts",
      purpose: "purpose", outcome: "outcome", rfpUid: "linked_rfp_uid",
    };
    for (const [from, to] of Object.entries(map)) {
      if (from in b) patch[to] = str(b[from]).trim() || null;
    }
    if ("date" in b) patch.engagement_date = dayOrNull(b.date, "date");
    if ("resolved" in b) patch.is_resolved = b.resolved === true;
    if (!Object.keys(patch).length) return json({ error: "Nothing to change." }, 400);
    const rows = await db.as(ctx.scope).update("engagement_logs", `id=eq.${q(id)}`, patch);
    if (!rows.length) return json({ error: "That engagement no longer exists." }, 404);
    return json({ ok: true });
  }

  /**
   * `PUT /actions/schedule` — replace the rota.
   *
   * A WHOLE-LIST WRITE, because the store is one JSON blob and `core/schedule.py` has
   * always replaced it wholesale. The consequence to know: two admins editing the rota at
   * once is last-write-wins, exactly as the report snapshots are. The list is a handful of
   * rows that change a few times a year, so the race is theoretical in a way the snapshot
   * one is not.
   *
   * Admin only. Everyone writes notes; who chairs the call is not note-taking.
   */
  async function putSchedule(req: Request, ctx: Ctx): Promise<Response> {
    if (!isAdmin(ctx.user as PermUser)) {
      return json({ error: "Only an administrator can change the rota." }, 403);
    }
    const tenant = tid(ctx);
    if (!tenant) return json({ error: "No tenant to hold a rota." }, 400);
    const b = await body(req);
    const raw = Array.isArray(b.schedule) ? b.schedule : [];
    // `_clean`'s rules, applied on the way IN as well as on the way out: a valid date, the
    // first entry per date, sorted. Cleaning only on read would store duplicates that the
    // next writer then silently dropped.
    const seen = new Set<string>();
    const items: RotaEntry[] = [];
    for (const r of raw as Record<string, unknown>[]) {
      const d = str(r?.date).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen.has(d)) continue;
      seen.add(d);
      items.push({
        date: d, cid: str(r.cid).trim(),
        noteTaker: str(r.noteTaker).trim(),
        presenter: str(r.presenter).trim(),
        chair: str(r.chair).trim(),
      });
    }
    items.sort((a, b2) => a.date.localeCompare(b2.date));
    await db.service.upsert("tenant_settings", {
      tenant_id: tenant, key: "schedule_json",
      // Stored in the PYTHON's key spelling, because core/schedule.py still reads this row
      // and the Streamlit page is still live. A camelCase blob here would empty the rota
      // in the app people are using today.
      value: JSON.stringify(items.map((i) => ({
        date: i.date, cid: i.cid, note_taker: i.noteTaker,
        presenter: i.presenter, chair: i.chair,
      }))),
      updated_by: str(ctx.user.email),
    }, "tenant_id,key");
    return json({ ok: true, count: items.length });
  }

  return { read, createNote, patchNote, createEngagement, patchEngagement, putSchedule };
}
