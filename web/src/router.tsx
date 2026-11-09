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
 * WHERE THE TITLES CAME FROM. The owner set these on 2026-11-09, naming both apps in one
 * instruction ("change this for both platforms"), so these ARE theirs and the Streamlit
 * rail carries the same words.
 *
 * The history is worth keeping, because this comment was wrong once in each direction.
 * The owner first renamed the pages in the STREAMLIT app only, and an earlier version here
 * claimed those titles as theirs for this app too — a cross-app inference presented as an
 * instruction. They corrected it ("I only gave a prompt with a focus on the chai-rfpis
 * page not the new react page"), so the claim was withdrawn, and then they issued the
 * names for both. Same destination, different authority, and the difference is the whole
 * point: a title changed here under the redesign's naming latitude may be changed again by
 * the next author, and one the owner set may not.
 *
 * `grants` is the exception and is NOT the Streamlit title. See its own note below.
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
  home: { title: "Dashboard", icon: "🏠", rail: true },
  pipelines: { title: "Funding Pipeline", icon: "📚", rail: true },
  // A RAIL ITEM, AND THE OWNER SETTLED THAT ON 2026-11-09 — said to this session directly,
  // not relayed: "keep Funding as its own page in the React not in the RFPIS". The two
  // apps differ here on purpose. On the Streamlit side Funding stopped being a page and
  // became the "Outcomes" tab of Funding Pipeline; here it stays its own page.
  //
  // ITS TITLE IS ALSO THE EXCEPTION. Every other name below matches the Streamlit rail
  // word for word; this one is "Proposals submitted" where that app says "Outcomes", and
  // the owner named the difference when they set them: "do not change for streamlit as it
  // is now moved to pipeline screen as a tab". A tab inside the Pipeline can be called
  // Outcomes because the stages around it supply the context; a standalone rail item has
  // to say what it holds.
  //
  // The reason it is not simply folded into the Pipeline's Outcome stage: that stage covers
  // only what a funder has ANSWERED, while this page also holds the pending applications,
  // the per-funder breakdown and the reporting tab. Making it a tab today would drop those
  // three rather than move them. Revisit when the Outcome stage can carry them — until
  // then this is a decision, not an oversight. /grants resolves either way.
  grants: { title: "Proposals submitted", icon: "💼", rail: true },
  actions: { title: "Meeting Actions", icon: "🗒️", rail: true },
  report: { title: "Funding Report", icon: "📊", rail: true },
  donors: { title: "Donor Intelligence", icon: "🗺️", rail: true },
  organization: { title: "My Organization", icon: "🏢", rail: true },
  // The slug stays `submit-new-rfp`. The page is named for what it takes in now, but a
  // bookmark or an emailed link still has to resolve.
  "submit-new-rfp": { title: "Submit new notice", icon: "📝", rail: true },
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
