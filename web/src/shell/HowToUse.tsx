/**
 * "How to use this app" — the weekly rhythm and the roles.
 *
 * Lifted out of HomePage so the left sidebar can open it as an overlay from anywhere
 * (owner, 2026-11-09). It used to be a <details> block at the bottom of the Dashboard,
 * which meant it was only reachable from the one page you need it least on: by the time
 * somebody is lost in Track or Actions, going Home to read how Track works has already
 * cost them the thing they were doing.
 *
 * Content only. The overlay, its dismissal and its persistence live in Layout, because
 * where a thing is shown is the shell's business and what it says is this file's.
 */
export default function HowToUse() {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink-600">
      <p className="font-semibold text-ink-800">Weekly rhythm</p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          <strong>Friday morning</strong> — the automated scan pulls new opportunities from
          the donor sources into the shared store, the bell shows <strong>Scan
          completed</strong>, and everyone is emailed any new Proceed / Park calls. Open{" "}
          <strong>Funding Pipeline → Screen</strong> and click <strong>Eligibility
          Scan</strong> to screen against your organisation.
        </li>
        <li>
          <strong>Friday → Sunday</strong> — anyone who finds a call outside the scan
          submits it via <strong>Submit New Notice</strong>. It is scored and tagged to the
          review week it was found in.
        </li>
        <li>
          <strong>Monday</strong> — the team call. Walk through <strong>Review</strong>,
          which opens on the week just gone, and record each outcome with <strong>Update
          Decision</strong>. Capture notes and agreed actions in <strong>Meeting
          Actions</strong>, linked to the call.
        </li>
        <li>
          <strong>Mid-week</strong> — proposal teams work the <strong>Track</strong> tab:
          stage, progress, next action, deadlines. Log donor calls under <strong>Meeting
          Actions → Engagements</strong> and close finished items in{" "}
          <strong>Pending</strong>.
        </li>
      </ol>
      <p className="font-semibold text-ink-800">Roles</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Admin</strong> — everything, plus users, scan preferences and records
          (<strong>Settings</strong>).
        </li>
        <li>
          <strong>Reviewer / Contributor</strong> — screening, decisions, call edits,
          submissions, meeting notes and engagements; no delete, no Settings.
        </li>
      </ul>
    </div>
  );
}
