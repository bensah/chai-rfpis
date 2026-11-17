/**
 * Add several users at once — a table you can paste a spreadsheet into.
 *
 * VALIDATED AS A BATCH. Every problem across every row comes back before anything is
 * created, so a batch with one typo creates nobody. The Python says why: "a half-created
 * team, with the admin left to work out which rows went through, is harder to fix than a
 * list of typos."
 *
 * PASTE IS THE POINT. Nobody types twelve colleagues into a web form. A paste of tab- or
 * comma-separated rows — the shape a spreadsheet selection puts on the clipboard — fills
 * the table in the Streamlit column order: email, full name, role, department. Rows past
 * the end of the table are APPENDED rather than dropped: silently losing the tail of a
 * paste is the worst failure available here, because nobody would know which colleagues
 * went missing.
 *
 * Both this and the single-user form go through the SAME creation path, so a bulk-added
 * account is indistinguishable from one added alone — same invite link, same email, same
 * tenant membership.
 */
import { useState } from "react";
import { Plus, Trash2, UserPlus } from "lucide-react";
import {
  inviteUsers, type AdminUsers, type BulkQueued, type BulkRow,
} from "../api";
import { Badge, Button, Notice, Select, fieldClass } from "../ui";
import { Dialog, Field } from "./dialog";

export default function BulkInvite({ data, roles, onClose, onDone, onBack }: {
  data: AdminUsers; roles: string[];
  onClose: () => void; onDone: () => void; onBack: () => void;
}) {
  const blank = (): BulkRow =>
    ({ email: "", name: "", role: roles[0], department: "", areas: [] });
  const [rows, setRows] = useState<BulkRow[]>(() => [blank(), blank(), blank()]);
  const [tenantMode, setTenantMode] = useState("own");
  const [newTenantName, setNewTenantName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [done, setDone] = useState<BulkQueued | null>(null);

  const edit = (i: number, patch: Partial<BulkRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const used = rows.filter((r) => r.email || r.name || r.department || r.areas.length);

  /** A spreadsheet paste, spread across rows and columns from the cell it started in. */
  const paste = (startRow: number, startCol: number, text: string) => {
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
    // A single cell with no tab is an ordinary paste: let the input handle it.
    if (lines.length <= 1 && !text.includes("\t")) return false;
    const cols: (keyof BulkRow)[] = ["email", "name", "role", "department"];
    const next = [...rows];
    lines.forEach((line, li) => {
      const cells = line.includes("\t") ? line.split("\t") : line.split(",");
      const target = startRow + li;
      while (next.length <= target) next.push(blank());
      const patch: Partial<BulkRow> = {};
      cells.forEach((cell, ci) => {
        const col = cols[startCol + ci];
        if (col && col !== "areas") patch[col] = cell.trim() as never;
      });
      next[target] = { ...next[target], ...patch };
    });
    setRows(next);
    return true;
  };

  if (done) {
    return (
      <Dialog title="Adding the team" onClose={onClose}>
        <Notice tone="good">{done.detail}</Notice>
        <ul className="mt-3 space-y-1 text-sm text-ink-700">
          {done.queued.map((q) => (
            <li key={q.email} className="flex items-center gap-2">
              <Badge tone={q.job_id ? "accent" : "bad"}>
                {q.job_id ? (q.dispatched ? "queued" : "waiting for a runner") : "not queued"}
              </Badge>
              {q.email}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-500">
          Each person gets their own activation link. They appear in the list behind this
          dialog as they are created.
        </p>
        <div className="mt-5">
          <Button variant="primary" onClick={() => { onDone(); onClose(); }}>Done</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Add several users" onClose={onClose}>
      <div className="mb-4 flex flex-wrap gap-1">
        <button
          type="button" aria-pressed="false" onClick={onBack}
          className="rounded-lg px-3.5 py-1.5 text-sm text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
        >
          One user
        </button>
        <button
          type="button" aria-pressed="true"
          className="rounded-lg bg-brand-50 px-3.5 py-1.5 text-sm font-semibold text-brand-700"
        >
          Several users
        </button>
      </div>

      <Notice tone="brand" className="mb-4">
        One row per person. <strong>Paste straight from a spreadsheet</strong> — columns
        in this order: email, full name, role, department. Empty rows are ignored, and
        everybody gets their own activation link.
      </Notice>

      <div className="overflow-x-auto rounded-lg border border-ink-200">
        <table className="w-full text-sm">
          <thead className="bg-ink-50 text-left text-xs font-semibold text-ink-600 uppercase">
            <tr>
              <th className="px-2 py-2">Email</th>
              <th className="px-2 py-2">Full name</th>
              <th className="px-2 py-2">Role</th>
              <th className="px-2 py-2">Department</th>
              <th className="w-8 px-2 py-2"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-2 py-1.5">
                  <input
                    className={fieldClass} value={r.email} aria-label={`Email ${i + 1}`}
                    onChange={(e) => edit(i, { email: e.target.value })}
                    onPaste={(e) => {
                      if (paste(i, 0, e.clipboardData.getData("text"))) e.preventDefault();
                    }}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={fieldClass} value={r.name} aria-label={`Name ${i + 1}`}
                    onChange={(e) => edit(i, { name: e.target.value })}
                    onPaste={(e) => {
                      if (paste(i, 1, e.clipboardData.getData("text"))) e.preventDefault();
                    }}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    value={r.role} aria-label={`Role ${i + 1}`}
                    onChange={(e) => edit(i, { role: e.target.value })}
                  >
                    {/* A pasted role the actor cannot assign stays selectable, so the
                        server's refusal names it rather than the table silently
                        rewriting it to something they did not choose. */}
                    {[...new Set([...roles, r.role].filter(Boolean))].map((x) =>
                      <option key={x} value={x}>{x}</option>)}
                  </Select>
                </td>
                <td className="px-2 py-1.5">
                  <input
                    className={fieldClass} value={r.department}
                    aria-label={`Department ${i + 1}`}
                    onChange={(e) => edit(i, { department: e.target.value })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <button
                    type="button" aria-label={`Remove row ${i + 1}`}
                    className="rounded p-1 text-ink-400 transition-colors hover:bg-bad-50 hover:text-bad-700"
                    onClick={() => setRows(rows.length > 1
                      ? rows.filter((_, j) => j !== i) : [blank()])}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button className="mt-2" icon={<Plus className="h-4 w-4" />}
        onClick={() => setRows([...rows, blank()])}>
        Add a row
      </Button>

      {data.canChooseTenant && (
        <div className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-4">
          <div className="mb-2 text-sm font-medium text-ink-800">Which organisation?</div>
          <Select value={tenantMode} aria-label="Organisation"
            onChange={(e) => setTenantMode(e.target.value)}>
            <option value="own">My own organisation</option>
            <option value="new">A new one, named below</option>
          </Select>
          {tenantMode === "new" && (
            <div className="mt-3">
              <Field
                label="New organisation name" value={newTenantName}
                onChange={setNewTenantName}
                hint="Everybody in this table joins it — an existing organisation of the same name is reused."
              />
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <Notice tone="bad" className="mt-4">
          <strong>Nothing was created.</strong> Fix these and try again:
          <ul className="mt-1.5 list-disc pl-5 text-sm">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </Notice>
      )}
      {failed && problems.length === 0 && (
        <Notice tone="bad" className="mt-4">{failed}</Notice>
      )}

      <div className="mt-5 flex gap-2">
        <Button
          variant="primary" busy={busy} disabled={!used.length}
          icon={<UserPlus className="h-4 w-4" />}
          onClick={async () => {
            setBusy(true); setProblems([]); setFailed(null);
            try {
              setDone(await inviteUsers(rows, { tenantMode, newTenantName }));
            } catch (e) {
              const err = e as { message?: string; problems?: string[] };
              setProblems(err.problems ?? []);
              setFailed(err.message ?? "Could not add the team.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Create {used.length || ""} account{used.length === 1 ? "" : "s"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}
