/**
 * The Report's data export — `views/report.py`'s "📥 Export Data" button.
 *
 * Six sheets of the rows the page's figures are computed from: a Summary of the top-line
 * KPIs, then Scan logs, RFPs, Meeting logs, Engagement logs and Applied Funding. It is the
 * audit trail behind the charts, which is why it ships rows rather than the numbers.
 *
 * IT CANNOT RUN IN THE EDGE FUNCTION, and the reason is worth stating rather than
 * discovering: the workbook is written with `openpyxl`, the frames go through
 * `core.records.clean_df`, and the whole thing runs well past a 2s CPU budget on a tenant
 * with a few thousand scan rows. So it is a `web_jobs` job (migration 099) run by
 * `scripts/run_web_job.py`, exactly as the re-score is — this file is the half that decides
 * WHAT to export and under what name, and the runner is the half that builds it.
 *
 * THE ONLY THING THE BROWSER CHOOSES IS THE PERIOD. The tenant, whether the shared
 * discovery crawl is included, and the filename are all settled here from the session,
 * because `POST /jobs` will start any kind it is given with any params: a client that could
 * name its own tenant could export somebody else's rows, and a gate that lives only on the
 * convenient path is not a gate.
 */
import { periodSlug, type Selection } from "./report_period.ts";

/**
 * `views/report.py::_slug` — a filename-safe token.
 *
 * Letters, digits and dashes survive; every run of anything else becomes one dash, and the
 * result is trimmed of leading and trailing dashes BOTH before and after the length cut, so
 * a truncation that lands on a dash does not leave one dangling.
 */
export function slugToken(text: unknown, limit = 28): string {
  const out = String(text ?? "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, limit).replace(/^-+|-+$/g, "") || "org";
}

/**
 * `_export_filename` — `RFPIS_<period>_report_<org>_<report-id>_<year>.<ext>`.
 *
 * Every part is in the name for a reason the old name taught: it used to be the same
 * string for every tenant and every period, so two downloads collided in the browser's
 * folder and a file on disk could not be traced back to the report that made it. The
 * report id is the `?r=` snapshot, or `unsaved` when the report was never generated under
 * a link.
 */
export function exportFilename(sel: Selection, orgShort: string, rid: string | null, ext: string): string {
  const parts = [
    "RFPIS", periodSlug(sel), "report",
    slugToken(orgShort), slugToken(rid || "unsaved", 20), String(sel.year),
  ];
  return `${parts.filter((p) => p).join("_")}.${ext}`;
}

/** What the runner is told to build. Everything but `bounds` and `view` is the session's. */
export type ExportParams = {
  tenant_id: string | null;
  /** ISO day, inclusive. Null under All time — the runner then filters nothing by date. */
  start: string | null;
  end: string | null;
  /** For the Summary sheet's "Period" row, said the way the page says it. */
  period: string;
  period_label: string;
  view: string;
  filename: string;
  /**
   * Whether the scan log goes in UNFILTERED.
   *
   * `_load_scan_logs` filters scan_logs to the tenant for an ordinary member and applies no
   * filter at all for a super_user or a deployment with no tenants. Measured on live data:
   * the unfiltered set is not merely "plus the shared discovery crawl" — on 2026-11-15 it
   * was 3,273 rows wider than one tenant's, of which 3,207 were the untenanted crawl and 66
   * belonged to OTHER TENANTS. That is correct for a super_user, who can already see every
   * tenant, and it is why this field is not called `include_shared_scans`: a name that
   * promised only the crawl would make the other 66 look like a bug the next time somebody
   * counted.
   *
   * Decided here from the session, never read from the request: it is the difference
   * between exporting one organisation's runs and exporting everybody's.
   */
  unfiltered_scans: boolean;
  by: string;
};
