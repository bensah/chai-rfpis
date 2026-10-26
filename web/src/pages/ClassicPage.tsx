import { ArrowUpRight, Construction } from "lucide-react";
import { PAGES, type PageKey } from "../router";
import { NAV_ICON } from "../shell/navIcons";
import { Card, LinkButton, PageHeader } from "../ui";

/** A page not yet rebuilt in React: say so, and link to the same page in the Streamlit app. */
export default function ClassicPage({ page, classicUrl }: { page: PageKey; classicUrl: string | null }) {
  const info = PAGES[page];
  const Icon = NAV_ICON[page];
  const href = classicUrl
    ? classicUrl.replace(/\/+$/, "") + window.location.pathname + window.location.search
    : null;
  return (
    <section>
      <PageHeader
        title={<span className="flex items-center gap-2.5"><Icon className="h-6 w-6 text-accent-600" strokeWidth={1.9} /> {info.title}</span>}
      />
      <Card className="max-w-2xl p-7">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Construction className="h-5 w-5" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-brand-700">Not in the new app yet</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">
          {info.title} still works exactly as before in the classic RFPIS app, with the same account and the same
          data. It moves here in a later phase of the rebuild.
        </p>
        {href ? (
          <LinkButton href={href} variant="primary" className="mt-5" icon={<ArrowUpRight className="h-4 w-4" />}>
            Open {info.title} in the classic app
          </LinkButton>
        ) : (
          <p className="mt-4 text-sm text-ink-500">
            The classic app's address is not configured (Settings → app_public_url).
          </p>
        )}
      </Card>
    </section>
  );
}
