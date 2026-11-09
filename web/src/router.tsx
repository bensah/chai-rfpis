// A small history-API router. Paths are the Streamlit app's url_paths (App.py), so a link
// copied from one app opens the same page in the other.
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

export type PageKey =
  | "home" | "pipelines" | "grants" | "actions" | "report" | "donors" | "organization"
  | "submit-new-rfp" | "opportunity" | "profile" | "help" | "search" | "settings"
  | "login" | "activate-account" | "password-reset";

type PageInfo = { title: string; icon: string; rail?: boolean; adminOnly?: boolean; public?: boolean };

/**
 * App.py::_pages, in rail order. `rail` = shown in the sidebar.
 *
 * The URL paths are the Streamlit app's `url_path`s and must stay as they are until
 * cut-over, so a link copied from one app opens the same page in the other. Keep the keys
 * when a title changes: they ARE the slugs, and bookmarks and emailed links resolve
 * through them.
 *
 * THE TITLES ARE THE OWNER'S, as of 2026-11-09, renamed on the Streamlit side first and
 * carried across verbatim rather than re-derived. One page under two names across two apps
 * reads as two products, which is what "Pipelines"/"Pipeline" and "Grants"/"Applied
 * funding" used to do.
 *
 * ONLY `rail: true` PUTS A PAGE IN THE SIDEBAR. The seven below without it — opportunity,
 * profile, help, search and the three public auth pages — exist so their URLs resolve: an
 * emailed activation link, a feed item's /opportunity deep link, the top-right menu. The
 * Streamlit app registers the same set and then HIDES them with CSS, which failed in the
 * COLLAPSED rail, where the icons are still painted: the owner saw a column of unexplained
 * glyphs. Rendering from this flag cannot fail that way — a page without it never reaches
 * the DOM, collapsed or not. Do not reintroduce a hide.
 */
export const PAGES: Record<PageKey, PageInfo> = {
  home: { title: "Home", icon: "🏠", rail: true },
  pipelines: { title: "Funding Pipeline", icon: "📚", rail: true },
  // STILL A RAIL ITEM HERE, where on the Streamlit side it no longer is — there it became
  // the "Outcomes" tab of Funding Pipeline. The React Pipeline does have an Outcome stage,
  // but that covers only what a funder has ANSWERED, while this page also holds the
  // pending applications, the per-funder breakdown and the reporting tab. Folding it in
  // would drop function rather than move it, so it is the owner's call. /grants resolves
  // either way.
  grants: { title: "Funding", icon: "💼", rail: true },
  actions: { title: "Meeting Actions", icon: "🗒️", rail: true },
  report: { title: "Fundraising Report", icon: "📊", rail: true },
  donors: { title: "Donor Intelligence", icon: "🗺️", rail: true },
  organization: { title: "My Organization", icon: "🏢", rail: true },
  "submit-new-rfp": { title: "Submit New RFP", icon: "📝", rail: true },
  opportunity: { title: "Opportunity", icon: "🎯" },
  profile: { title: "Profile", icon: "👤" },
  help: { title: "Help", icon: "❓" },
  search: { title: "Search", icon: "🔍" },
  // Deliberately in the rail: admins get Settings as a first-class item, not a hidden one.
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
