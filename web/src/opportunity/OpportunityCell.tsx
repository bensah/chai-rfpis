/**
 * The opportunity's name, wherever it appears in a table — and the two things you can do
 * from it.
 *
 * ONE COMPONENT for all five Pipeline stages, because they had drifted into three
 * behaviours for the same cell: Screened and Review made the title a link to the
 * opportunity page, while Bidding, Submitted and Outcome made it a button that opened an
 * inline panel instead. Same text, same styling, same cursor; a different thing happened
 * depending on which stage you were looking at, and on three of the five there was no way
 * to reach the full record at all.
 *
 * So the rules are fixed here rather than repeated five times:
 *
 *   * the TITLE always opens the opportunity in this app — never the funder's site;
 *   * the ↗ icon always opens the funder's own call, in a new tab, and is the only thing
 *     that leaves the app;
 *   * the ✎ opens the one editor (src/opportunity/RfpEditor.tsx) on this row;
 *   * the chevron, where a stage has an inline panel, is what expands it. That used to be
 *     the title's job, which is why the title could not be a link.
 */
import { ChevronDown, ChevronRight, ExternalLink, Pencil } from "lucide-react";
import { hrefOf, Link } from "../router";

export type OpportunityCellProps = {
  uid: string;
  title: string | null | undefined;
  /** `opportunity_link` — the funder's own page for this call. */
  link?: string | null;
  /** Open the editor on this row. Omitted on a surface that does not edit. */
  onEdit?: (uid: string) => void;
  /** Expand this stage's inline panel. Omitted where the stage has none. */
  onToggle?: () => void;
  expanded?: boolean;
  /** Anything the stage shows beside the name — Outcome's "×2", say. */
  children?: React.ReactNode;
};

export default function OpportunityCell({
  uid, title, link, onEdit, onToggle, expanded = false, children,
}: OpportunityCellProps) {
  return (
    <div className="flex items-start gap-1.5">
      {onToggle && (
        <button
          onClick={onToggle} aria-expanded={expanded}
          aria-label={expanded ? "Hide this row's detail" : "Show this row's detail"}
          className="mt-0.5 inline-flex shrink-0 text-ink-400 transition-colors hover:text-brand-700"
        >
          {expanded
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />}
        </button>
      )}
      <div className="min-w-0">
        <Link
          to={hrefOf("opportunity", { uid })}
          title="Open the full record in RFPIS"
          className="font-medium text-brand-700 hover:text-accent-700 hover:underline"
        >
          {title || uid}
        </Link>
        {children}
        {link && (
          <a
            href={link} target="_blank" rel="noreferrer"
            className="ml-1.5 inline-flex text-ink-400 hover:text-accent-700"
            aria-label="Open the call on the funder's own site"
            title="Open the call on the funder's own site"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
        {onEdit && (
          <button
            onClick={() => onEdit(uid)}
            className="ml-1.5 inline-flex align-text-bottom text-ink-400 hover:text-accent-700"
            aria-label="Edit this opportunity"
            title="Edit this opportunity"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
