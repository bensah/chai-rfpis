import { ExternalLink } from "lucide-react";
import { PAGES, type PageKey } from "../router";

/** A page not yet rebuilt in React: say so, and link to the same page in the Streamlit app. */
export default function ClassicPage({ page, classicUrl }: { page: PageKey; classicUrl: string | null }) {
  const info = PAGES[page];
  const href = classicUrl
    ? classicUrl.replace(/\/+$/, "") + window.location.pathname + window.location.search
    : null;
  return (
    <section className="pt-6">
      <h1 className="text-3xl font-bold text-navy">{info.icon} {info.title}</h1>
      <div className="mt-6 max-w-2xl rounded-xl border border-slate-200 bg-surface p-6">
        <p className="text-slate-700">
          This page has not moved to the new app yet. It works as before in the classic RFPIS app, with the same
          account and the same data.
        </p>
        {href ? (
          <a href={href} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 font-semibold text-white hover:bg-brand-dark">
            Open {info.title} in the classic app <ExternalLink className="h-4 w-4" />
          </a>
        ) : (
          <p className="mt-3 text-sm text-slate-500">The classic app's address is not configured (Settings → app_public_url).</p>
        )}
      </div>
    </section>
  );
}
