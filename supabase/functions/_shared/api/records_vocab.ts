/**
 * Settings → Records → Data — the per-table specs. GENERATED — do not edit.
 *
 *     python scripts/gen_records_vocab.py
 *
 * Source of truth: `_DATA_SPECS` in app_pages/admin.py. See that script for why these
 * are generated: `date_cols` decides what the range filter can match, `search_cols` what
 * a search can find, and `edit_fields` which columns a save writes — each of which fails
 * silently rather than loudly when it falls behind.
 */

/** One table's spec. `editFields` is [column, kind, label]; kind is date | text | area. */
export type RecordSpec = {
  table: string;
  orderCol: string;
  tableCols: string[];
  colLabels: Record<string, string>;
  dateCols: string[];
  searchCols: string[];
  advancedFilters: string[];
  editFields: [string, string, string][];
  caption: string;
};

/**
 * The auxiliary tables, keyed by the name the picker shows.
 *
 * Every optional key is present with an empty default: a missing key is `undefined` in
 * TypeScript, and `undefined.includes(...)` throws inside a render. The absence is
 * resolved once, in the generator, rather than guarded at every use.
 */
export const RECORD_SPECS: Record<string, RecordSpec> = {"Applied Funding": {"advancedFilters": ["owner", "status", "report_type", "source"], "caption": "Keyed on `funding_id`. Re-sync OVERWRITES matching rows from Excel.", "colLabels": {"award_date": "Awarded", "donor_title": "Donor", "end_date": "Ends", "funding_id": "Grant ID", "owner": "Owner", "report_due_date": "Report due", "report_type": "Report", "source": "Source", "status": "Status"}, "dateCols": ["award_date", "end_date", "report_due_date", "submitted_date"], "editFields": [["funding_id", "text", "Grant ID *"], ["donor_title", "text", "Donor"], ["form_id_link", "text", "Linked RFP form ID"], ["award_date", "date", "Award date"], ["end_date", "date", "End date"], ["report_type", "text", "Report type"], ["report_due_date", "date", "Report due date"], ["submitted_date", "date", "Submitted date"], ["status", "text", "Status"], ["owner", "text", "Owner"], ["remarks", "area", "Remarks"]], "orderCol": "report_due_date", "searchCols": ["funding_id", "donor_title", "owner", "remarks"], "table": "applied_funding", "tableCols": ["funding_id", "donor_title", "award_date", "end_date", "status", "owner", "report_type", "report_due_date", "source"]}, "Engagement Logs": {"advancedFilters": ["internal_lead", "engagement_type", "source"], "caption": "All fields Excel-managed; edits here are overwritten by next sync if the same row exists in Excel.", "colLabels": {"donor": "Donor", "engagement_date": "Date", "engagement_type": "Type", "format": "Format", "internal_lead": "Internal lead", "linked_rfp_uid": "Linked RFP", "purpose": "Purpose", "source": "Source"}, "dateCols": ["engagement_date"], "editFields": [["engagement_date", "date", "Engagement date *"], ["donor", "text", "Donor"], ["engagement_type", "text", "Engagement type"], ["format", "text", "Format"], ["internal_lead", "text", "Internal lead"], ["donor_contacts", "area", "Donor contacts"], ["purpose", "area", "Purpose"], ["outcome", "area", "Outcome"], ["linked_rfp_uid", "text", "Linked RFP UID"]], "orderCol": "engagement_date", "searchCols": ["donor", "purpose", "outcome", "internal_lead"], "table": "engagement_logs", "tableCols": ["engagement_date", "donor", "engagement_type", "format", "internal_lead", "purpose", "linked_rfp_uid", "source"]}, "Meeting Logs": {"advancedFilters": ["owner", "is_resolved", "source"], "caption": "**Excel-managed:** date, donor, issues, actions, owner, deadline. **App-managed (preserved on sync):** Status, Linked RFP.", "colLabels": {"actions": "Actions", "deadline": "Due", "donor_title": "Donor", "is_resolved": "Status", "meeting_date": "Meeting date", "owner": "Owner", "remarks": "Issues", "rfp_uid": "Linked RFP", "source": "Source"}, "dateCols": ["meeting_date", "deadline"], "editFields": [["meeting_date", "date", "Meeting date *"], ["donor_title", "text", "Donor title"], ["remarks", "area", "Issues / Remarks"], ["actions", "area", "Actions / Recommendations"], ["owner", "text", "Owner"], ["deadline", "date", "Due date"], ["is_resolved", "bool", "Status: Resolved?"], ["rfp_uid", "text", "Linked RFP UID"]], "orderCol": "meeting_date", "searchCols": ["donor_title", "remarks", "actions", "owner"], "table": "meeting_logs", "tableCols": ["meeting_date", "donor_title", "owner", "deadline", "is_resolved", "rfp_uid", "remarks", "actions", "source"]}, "Narrative Logs": {"advancedFilters": ["owner", "status"], "caption": "All fields Excel-managed.", "colLabels": {"date_used": "Date used", "narrative_title": "Title", "owner": "Owner", "status": "Status", "used_in": "Used in", "used_with": "Used with", "version_date": "Version"}, "dateCols": ["version_date", "date_used"], "editFields": [["version_date", "date", "Version date *"], ["narrative_title", "text", "Title"], ["used_in", "text", "Used in"], ["used_with", "text", "Used with"], ["date_used", "date", "Date used"], ["status", "text", "Status"], ["link_location", "text", "Link / location"], ["owner", "text", "Owner"]], "orderCol": "version_date", "searchCols": ["narrative_title", "used_in", "used_with", "owner"], "table": "narrative_logs", "tableCols": ["version_date", "narrative_title", "used_in", "used_with", "date_used", "status", "owner"]}};

/** The two entries that are NOT auxiliary tables — each has its own branch. */
export const SCREENED_LABEL = "Screened Solicitations";
export const EXTRACTED_LABEL = "Extracted Solicitations";

/**
 * The picker's order, as admin.py composes it: the two special entries first.
 *
 * Order is part of the answer here — `_DATA_OPTIONS[0]` is what the page opens on, and
 * opening on a different table than the Streamlit page does would make two apps disagree
 * about what "Records" means at a glance.
 *
 * Spelled out rather than derived from `Object.keys(RECORD_SPECS)`: that object is
 * emitted with sorted keys so its diffs stay readable, which would put the picker in
 * alphabetical order instead of admin.py's own.
 */
export const RECORD_OPTIONS: string[] = ["Screened Solicitations", "Extracted Solicitations", "Meeting Logs", "Engagement Logs", "Applied Funding", "Narrative Logs"];

/**
 * The columns the Extracted Solicitations grid shows, in order.
 *
 * That branch has no spec dict — it is a read-only view of the global raw store — so its
 * column list is lifted from the branch itself.
 */
export const EXTRACTED_COLUMNS: string[] = ["opportunity_name", "funder_name", "funding_status", "deadline", "deadline_confidence", "grant_amount", "currency", "call_geographic_scope", "solicitation_type", "funding_window", "source", "opportunity_url"];
