/**
 * Tenant resolution — a port of auth/tenant_context.py. Every query here runs on the
 * service role, as the Python does: membership resolution is an identity operation that
 * must see the true rows before any tenant context exists.
 */
import { q, type Db } from "./db.ts";
import type { Json } from "./jwt.ts";

export type Membership = {
  tenant_id: string; name: string | null; slug: string | null; role: string | null;
  is_platform: boolean; is_developer: boolean;
};

export function createTenants(db: Db) {
  async function activeMemberships(userId: string): Promise<Membership[]> {
    // Every variant embeds `status`: it is the only guard that drops blacklisted/pending
    // tenants (RLS gates on tenant_id alone). Later variants degrade the newer columns.
    const selects = [
      "tenant_id,role,tenants(name,slug,is_platform,is_developer,status)",
      "tenant_id,role,tenants(name,slug,is_platform,status)",
      "tenant_id,role,tenants(name,slug,status)",
    ];
    for (const sel of selects) {
      let rows: Json[];
      try {
        rows = await db.service.get("tenant_memberships",
          `select=${q(sel)}&user_id=eq.${q(userId)}&status=eq.active`);
      } catch {
        continue;
      }
      const out: Membership[] = [];
      for (const r of rows) {
        const t = (r.tenants && typeof r.tenants === "object" ? r.tenants : {}) as Json;
        // Suspend is intentionally NOT enforced (tenant_context.active_memberships).
        if (t.status === "blacklisted" || t.status === "pending") continue;
        out.push({
          tenant_id: String(r.tenant_id), name: (t.name as string) ?? null,
          slug: (t.slug as string) ?? null, role: (r.role as string) ?? null,
          is_platform: Boolean(t.is_platform), is_developer: Boolean(t.is_developer),
        });
      }
      return out;
    }
    return [];
  }

  async function platformHome(): Promise<Membership | null> {
    for (const [col, val] of [["is_platform", "true"], ["slug", "rfpis"]]) {
      try {
        const rows = await db.service.get("tenants", `select=id,name,slug&${col}=eq.${val}&limit=1`);
        if (rows.length) {
          const t = rows[0];
          return { tenant_id: String(t.id), name: (t.name as string) ?? null,
            slug: (t.slug as string) ?? null, role: "super_user", is_platform: true, is_developer: false };
        }
      } catch {
        // column may not exist — try the next lookup
      }
    }
    return null;
  }

  const byName = (a: Membership, b: Membership) =>
    (a.name ?? "").toLowerCase().localeCompare((b.name ?? "").toLowerCase());

  /** tenant_context._default_membership, followed by set_active_tenant's membership gate:
   * a choice the user does not actively hold leaves the session tenant-LESS. */
  async function defaultMembership(user: Json, mems: Membership[]): Promise<Membership | null> {
    if (!mems.length) return null;
    if (mems.length === 1) return mems[0];
    if (String(user.role ?? "").toLowerCase() === "super_user") {
      const preds: ((m: Membership) => boolean)[] = [
        (m) => m.is_platform,
        (m) => (m.slug ?? "").trim().toLowerCase() === "rfpis",
        (m) => (m.name ?? "").trim().toLowerCase().startsWith("rfpis"),
      ];
      for (const p of preds) {
        const home = mems.find(p);
        if (home) return home;
      }
      const direct = await platformHome();
      if (direct) return mems.find((m) => m.tenant_id === direct.tenant_id) ?? null;
      return [...mems].sort(byName)[0];
    }
    const last = user.last_tenant_id ? String(user.last_tenant_id) : null;
    if (last) {
      const m = mems.find((x) => x.tenant_id === last);
      if (m) return m;
    }
    return [...mems].sort(byName)[0];
  }

  let devCache: { at: number; ids: string[] } = { at: 0, ids: [] };
  /** tenant_context.developer_tenant_ids (60 s cache; falls back to is_platform pre-079). */
  async function developerTenantIds(): Promise<string[]> {
    if (Date.now() - devCache.at < 60_000) return devCache.ids;
    let ids: string[] | null = null;
    try {
      ids = (await db.service.get("tenants", "select=id&is_developer=eq.true")).map((r) => String(r.id));
    } catch {
      try {
        ids = (await db.service.get("tenants", "select=id&is_platform=eq.true")).map((r) => String(r.id));
      } catch {
        ids = null;
      }
    }
    devCache = { at: Date.now(), ids: ids ?? devCache.ids };
    return devCache.ids;
  }

  /** tenant_context.resolve_tenant_by_key — slug, then id. */
  async function resolveTenantByKey(key: string): Promise<{ id: string; name: string | null; slug: string | null } | null> {
    if (!key) return null;
    for (const col of ["slug", "id"]) {
      try {
        const rows = await db.service.get("tenants", `select=id,name,slug&${col}=eq.${q(key)}&limit=1`);
        if (rows.length) {
          return { id: String(rows[0].id), name: (rows[0].name as string) ?? null,
            slug: (rows[0].slug as string) ?? null };
        }
      } catch {
        // an id lookup with a non-uuid key errors — try the next column
      }
    }
    return null;
  }

  return { activeMemberships, defaultMembership, developerTenantIds, resolveTenantByKey };
}

export type Tenants = ReturnType<typeof createTenants>;
