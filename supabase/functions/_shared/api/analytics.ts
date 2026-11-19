/**
 * Settings → Analytics — the cross-tenant platform rollups. `core/analytics.py`.
 *
 * SUPER_USER ONLY, and read-only. Every figure crosses tenant boundaries, so every query
 * runs on the service role; the gate is on the route and is the whole of the access
 * control here.
 *
 * TWO COUNTING RULES CARRY THE WHOLE FILE, and both are the kind that read as
 * implementation detail until they are wrong:
 *
 *   1. A SYSTEM RUN IS ONE WITH NO TENANT. `scan_logs` holds both the Friday extract-only
 *      crawl (tenant_id null) and every tenant's own screening run (tenant_id set).
 *      Counting them together would report one deployment's discovery totals as the sum
 *      of every tenant re-screening the same store, which grows with tenants rather than
 *      with what was found.
 *   2. `scan_logs` IS ONE ROW PER SOURCE PER RUN. The number of runs is therefore the
 *      number of distinct scan_date MINUTES, not the number of rows — the Python's own
 *      approximation, carried over rather than improved on, because an improvement here
 *      would make the two apps report different run counts for the same history.
 *
 * COUNTS SELECT "*", NOT "id". Some shared tables have no `id` column at all —
 * `extracted_solicitations` is keyed on `uid` — and counting a column that is not there
 * silently returns zero. The Python has the same comment for the same reason.
 */
import { q, type Db } from "./db.ts";

type Row = Record<string, unknown>;
const s = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
};

/**
 * `core/scan_pipeline.MATCH_RUN_LABEL` — the `source` a screening run writes.
 *
 * It is how a tenant's screening run is told apart from a crawl row in the same table,
 * so it is compared exactly. check-analytics asserts it against the Python; a drift here
 * would report every tenant as never having screened.
 */
export const MATCH_RUN_LABEL = "\u{1F3AF} Find my matches";

/** Exact row count, service role, 0 on any error — `_count`. */
async function count(db: Db, table: string, filter = ""): Promise<number> {
  try {
    const r = await db.service.count(table, filter);
    return n(r);
  } catch {
    return 0;
  }
}

/**
 * `system_discovery_stats` — deployment-wide discovery totals.
 *
 * PAGINATED AND FILTERED SERVER-SIDE. PostgREST caps a response at 1000 rows, so an
 * unpaginated read silently under-counts the moment scan_logs passes that — which the
 * Python learnt the hard way and records in its own comment. `getAll` pages; the
 * tenant_id filter keeps every tenant's rows off the wire rather than fetching them to
 * throw away.
 */
export async function systemDiscoveryStats(db: Db): Promise<{
  runs: number; found: number; rejected: number; catalog: number; last_run: string | null;
}> {
  let rows: Row[] = [];
  try {
    rows = await db.service.getAll(
      "scan_logs",
      "select=scan_date,rfps_found,rfps_new,rfps_rejected,tenant_id,triggered_by"
      + "&tenant_id=is.null",
      "scan_date");
  } catch {
    rows = [];
  }
  let found = 0, rejected = 0;
  const runs = new Set<string>();
  let lastRun: string | null = null;
  for (const r of rows) {
    // Belt and braces, as the Python keeps: the filter is server-side, and this is the
    // second check that a tenant row never lands in a system total.
    if (r.tenant_id) continue;
    found += n(r.rfps_found);
    rejected += n(r.rfps_rejected);
    const d = s(r.scan_date).slice(0, 16);
    if (d) runs.add(d);
    // The NEWEST, which `getAll` does not guarantee the order of — it pages ascending to
    // walk the table. The Python reads row 0 of a descending query; taking the maximum
    // is the same answer without depending on the order rows arrive in.
    if (r.scan_date && (lastRun === null || s(r.scan_date) > lastRun)) {
      lastRun = s(r.scan_date);
    }
  }
  return {
    runs: runs.size,
    found,
    rejected,
    catalog: await count(db, "extracted_solicitations"),
    last_run: lastRun,
  };
}

/** `tenant_activity` — the per-tenant rollup. */
export async function tenantActivity(db: Db): Promise<Row[]> {
  let tenants: Row[] = [];
  try {
    tenants = await db.service.get(
      "tenants", "select=id,name,status,is_platform,created_at&order=name.asc");
  } catch {
    // The Python's own fallback: `is_platform` arrived in a later migration, and a
    // deployment without it must still get a rollup rather than an empty table.
    try {
      tenants = await db.service.get(
        "tenants", "select=id,name,status,created_at&order=name.asc");
    } catch {
      return [];
    }
  }
  const mems = await db.service.getAll(
    "tenant_memberships", "select=tenant_id,status", "tenant_id").catch(() => [] as Row[]);
  const active = new Map<string, number>();
  const pending = new Map<string, number>();
  for (const m of mems) {
    const tid = s(m.tenant_id);
    const bucket = s(m.status) === "active" ? active : s(m.status) === "pending" ? pending : null;
    if (bucket) bucket.set(tid, (bucket.get(tid) ?? 0) + 1);
  }

  // Per tenant: the submission count and the last screening run. The Python calls this an
  // N+1 and accepts it for a small number of tenants; the two reads are issued together
  // per tenant and the tenants in parallel, which is the same number of queries arriving
  // at once instead of in a line.
  return await Promise.all(tenants.map(async (t) => {
    const tid = s(t.id);
    const [rfps, screens] = await Promise.all([
      count(db, "rfp_submissions", `tenant_id=eq.${q(tid)}`),
      db.service.get("scan_logs",
        `select=scan_date&tenant_id=eq.${q(tid)}&source=eq.${q(MATCH_RUN_LABEL)}`
        + "&order=scan_date.desc&limit=1").catch(() => [] as Row[]),
    ]);
    return {
      id: tid,
      name: t.name ?? null,
      status: s(t.status) || "active",
      is_platform: !!t.is_platform,
      members: active.get(tid) ?? 0,
      pending: pending.get(tid) ?? 0,
      rfps,
      last_screen: screens[0]?.scan_date ?? null,
      created: s(t.created_at).slice(0, 10),
    };
  }));
}

/** `user_stats` — the app-wide user rollup. */
export async function userStats(db: Db): Promise<{
  total: number; active: number; inactive: number; by_role: Record<string, number>;
}> {
  const users = await db.service.getAll("users", "select=role,is_active", "role")
    .catch(() => [] as Row[]);
  const byRole: Record<string, number> = {};
  let active = 0;
  for (const u of users) {
    // "unknown" for a missing role, not "" — the rollup is printed as a label, and an
    // empty one reads as a rendering fault rather than as a user with no role set.
    const role = s(u.role) || "unknown";
    byRole[role] = (byRole[role] ?? 0) + 1;
    if (u.is_active) active += 1;
  }
  return { total: users.length, active, inactive: users.length - active, by_role: byRole };
}
