// A small history-API router. Paths are the Streamlit app's url_paths (App.py), so a link
// copied from one app opens the same page in the other.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type PageKey =
  | "home" | "pipelines" | "grants" | "actions" | "report" | "donors" | "organization"
  | "submit-new-rfp" | "opportunity" | "profile" | "help" | "search" | "settings"
  | "login" | "activate-account" | "password-reset";

type PageInfo = { title: string; icon: string; rail?: boolean; adminOnly?: boolean; public?: boolean };

/** App.py::_pages, in rail order. `rail` = shown in the sidebar (the CSS-hidden ones are not). */
export const PAGES: Record<PageKey, PageInfo> = {
  home: { title: "Home", icon: "🏠", rail: true },
  pipelines: { title: "Pipelines", icon: "📚", rail: true },
  grants: { title: "Grants", icon: "💼", rail: true },
  actions: { title: "Actions", icon: "🗒️", rail: true },
  report: { title: "Report", icon: "📊", rail: true },
  donors: { title: "Donors", icon: "🗺️", rail: true },
  // Organization and Submit are registered in the rail and not hidden by the header CSS.
  organization: { title: "Tenant", icon: "🏢", rail: true },
  "submit-new-rfp": { title: "Submit", icon: "📝", rail: true },
  opportunity: { title: "Opportunity", icon: "🎯" },
  profile: { title: "Profile", icon: "👤" },
  help: { title: "Help", icon: "❓" },
  search: { title: "Search", icon: "🔍" },
  settings: { title: "Settings", icon: "⚙️", rail: true, adminOnly: true },
  login: { title: "Sign in", icon: "🔐", public: true },
  "activate-account": { title: "Activate", icon: "🔑", public: true },
  "password-reset": { title: "Reset password", icon: "🔓", public: true },
};

export const pageOf = (pathname: string): PageKey | null => {
  const p = pathname.replace(/^\/+|\/+$/g, "");
  if (p === "" || p === "home") return "home";
  return (p in PAGES ? p : null) as PageKey | null;
};

export const hrefOf = (page: PageKey, params: Record<string, string> = {}) => {
  const qs = new URLSearchParams(params).toString();
  return (page === "home" ? "/" : `/${page}`) + (qs ? `?${qs}` : "");
};

// ── Location store ───────────────────────────────────────────────────────────
const EVT = "rfpis:navigate";
const subscribe = (f: () => void) => {
  window.addEventListener("popstate", f);
  window.addEventListener(EVT, f);
  return () => {
    window.removeEventListener("popstate", f);
    window.removeEventListener(EVT, f);
  };
};
const snapshot = () => window.location.pathname + window.location.search;

export function useLocation() {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(loc, window.location.origin);
  return { path: url.pathname, page: pageOf(url.pathname), params: url.searchParams };
}

export function navigate(href: string, { replace = false } = {}) {
  if (replace) history.replaceState(null, "", href);
  else history.pushState(null, "", href);
  window.dispatchEvent(new Event(EVT));
  if (!replace) window.scrollTo(0, 0);
}

/** Change query parameters in place (no new history entry). */
export function setParams(change: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(change)) {
    if (v == null) url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  const next = url.pathname + url.search;
  if (next !== snapshot()) navigate(next, { replace: true });
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

// ── Breadcrumb trail — a port of core/ui_links.py record_visit / nav_trail ───
export type Crumb = { page: PageKey; params: Record<string, string> };
const TRAIL_KEY = "rfpis.trail";
const HISTORY_CAP = 12;

function readTrail(): Crumb[] {
  try {
    return JSON.parse(sessionStorage.getItem(TRAIL_KEY) ?? "[]") as Crumb[];
  } catch {
    return [];
  }
}

function writeTrail(t: Crumb[]) {
  try {
    sessionStorage.setItem(TRAIL_KEY, JSON.stringify(t));
  } catch {
    // storage blocked — no breadcrumbs
  }
}

/** Note the page being shown. A re-render is not a move; Home resets the trail; a page
 * already on the trail is a step back up to it. */
export function recordVisit(page: PageKey, params: URLSearchParams) {
  const p: Record<string, string> = {};
  params.forEach((v, k) => {
    if (k !== "tenant") p[k] = v;
  });
  const entry: Crumb = { page, params: p };
  const hist = readTrail();
  const last = hist[hist.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(entry)) return;
  if (page === "home") return writeTrail([entry]);
  const i = hist.findIndex((e) => e.page === page);
  if (i >= 0) hist.splice(i);
  hist.push(entry);
  writeTrail(hist.slice(-HISTORY_CAP));
}

export function navTrail(): Crumb[] {
  const hist = readTrail();
  if (!hist.length) return [];
  if (hist[0].page !== "home") hist.unshift({ page: "home", params: {} });
  return hist;
}

/** Jump to a crumb: the trail is cut back to it first, so the arrival is not a new step. */
export function goToCrumb(trail: Crumb[], i: number) {
  writeTrail(trail.slice(0, i + 1));
  navigate(hrefOf(trail[i].page, trail[i].params));
}
