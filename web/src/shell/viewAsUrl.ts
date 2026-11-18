/**
 * What the `?tenant=` param should do on this render — as a pure function.
 *
 * WHY THIS IS NOT JUST AN `if` INSIDE App's EFFECT. It was, and it shipped a bug the
 * owner hit on his first use of the feature (2026-11-18): "clicking Return to my account
 * refuses to do so".
 *
 * It did not refuse. `routes_auth.viewAs` with an empty key correctly returned a session
 * with `view: null`. But the URL still said `?tenant=chai-cameroon`, and the param is the
 * SELECTOR — so on the very next render the effect saw a key matching neither the (now
 * empty) view nor the super's own tenant, and re-entered the view-as. Return worked and
 * was undone within the same tick, which from the outside is indistinguishable from a
 * dead button. `Layout`'s `.catch(() => undefined)` made sure a genuine failure looked
 * identical too.
 *
 * The rule has four cases and three of them are only reachable mid-flight, which is
 * exactly the kind of thing that is never tested while it lives inside a `useEffect`
 * alongside `viewAs()` and `setParams()`. So the decision is here, where
 * `web/scripts/view-as.test.mjs` can enumerate it, and the effect does as it is told.
 * Re-injecting the defect (dropping the `leaving` branch) fails 3 of its 14 tests.
 *
 * Streamlit has no equivalent because its handler deletes the param in the same callback
 * (`core/app_header.py:1200`). React cannot: the session update and the param change are
 * separate renders, and the effect runs in between. Hence `leaving`.
 */

export type ViewAsInputs = {
  /** `users.role` — only a super_user may select a tenant through the URL. */
  role: string | null | undefined;
  /** The `?tenant=` value, already trimmed to null when absent. */
  key: string | null;
  /** The tenant currently being viewed-as, if any. */
  viewSlug?: string | null;
  viewId?: string | null;
  /** The signed-in user's OWN tenant. */
  tenantSlug?: string | null;
  tenantId?: string | null;
  /** True between "Return to my account" being clicked and the session agreeing. */
  leaving: boolean;
};

export type ViewAsAction =
  /** Ask the server to view this tenant. */
  | { do: "enter"; key: string }
  /** Rewrite the param to the tenant actually being shown (null removes it). */
  | { do: "stamp"; slug: string | null }
  /** Mid-return: take the stale key out of the URL and change nothing else. */
  | { do: "clear" }
  /** The return has completed — the caller may lower its `leaving` flag. */
  | { do: "settled" };

/** core/app_header._apply_tenant_url, plus the leaving case Streamlit does not need. */
export function viewAsUrlAction(i: ViewAsInputs): ViewAsAction {
  // LEAVING WINS OVER EVERYTHING. While a return is in flight the URL is stale by
  // definition, and acting on it is the bug. The flag is lowered only once BOTH halves
  // agree: the session has no view, and the param is gone.
  if (i.leaving) {
    if (!i.viewId && !i.viewSlug && !i.key) return { do: "settled" };
    return { do: "clear" };
  }

  // A key that names something we are already showing is not a request to switch — it is
  // the stamp from a previous render coming back round. All four comparisons are needed:
  // the param may carry a slug or a raw id, and may name either the viewed tenant or the
  // user's own.
  const names = (v: string | null | undefined) => !!v && v === i.key;
  if (i.role === "super_user" && i.key
    && !names(i.viewSlug) && !names(i.viewId)
    && !names(i.tenantSlug) && !names(i.tenantId)) {
    return { do: "enter", key: i.key };
  }

  // Otherwise the URL only DESCRIBES what is being shown — for a non-super_user an
  // incoming value is ignored entirely, which is why this is the same branch for both.
  return { do: "stamp", slug: i.viewSlug ?? i.tenantSlug ?? null };
}
