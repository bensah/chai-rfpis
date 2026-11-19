/**
 * The form controls every screen that writes an opportunity is built from.
 *
 * THEY LIVED INSIDE RfpEditor.tsx until Submit New Notice arrived. Both screens write the
 * same `rfp_submissions` columns from the same controlled vocabularies, and the Streamlit
 * app has already shown what happens when the two forms are built separately: Lead
 * applicant was on the Grants page and nowhere else, so an opportunity could be captured
 * and only later acquire the field that says who is actually applying. Sharing the controls
 * does not by itself keep the two forms in step, but it removes the easiest way for them
 * to drift — a dropdown on one screen and a free-text box on the other.
 *
 * `Choice` and `Multi` carry a rule the editor needed and the submit form inherits: a value
 * already on the row that is no longer in the vocabulary STAYS selectable. Nothing is
 * silently rewritten just because somebody opened a form on it.
 */
import { useMemo, useState, type ReactNode } from "react";
import MultiSelect from "../components/MultiSelect";
import { Select, field, fieldClass } from "../ui";

export function Row({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  const c = cols === 4 ? "sm:grid-cols-4" : cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return <div className={`grid grid-cols-1 gap-x-4 ${c}`}>{children}</div>;
}

export function Lbl({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 text-sm font-medium text-ink-700" title={hint}>{children}</div>
  );
}

export function Text({ label, value, onChange, hint, tip, area, required }: {
  label: string; value: string; onChange: (v: string) => void;
  hint?: string; tip?: string; area?: boolean; required?: boolean;
}) {
  return (
    <div className="mb-4">
      <Lbl hint={tip ?? hint}>{label}{required && <span className="text-bad-600"> *</span>}</Lbl>
      {area
        ? <textarea className={`${fieldClass} min-h-24`} value={value}
            onChange={(e) => onChange(e.target.value)} />
        : <input className={fieldClass} value={value}
            onChange={(e) => onChange(e.target.value)} />}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Num({ label, value, onChange, step = "1", hint }: {
  label: string; value: string; onChange: (v: string) => void; step?: string; hint?: string;
}) {
  return (
    <div className="mb-4">
      <Lbl hint={hint}>{label}</Lbl>
      <input type="number" min="0" step={step} className={fieldClass} value={value}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function DateBox({ label, value, onChange, hint }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string;
}) {
  return (
    <div className="mb-4">
      <Lbl hint={hint}>{label}</Lbl>
      <input type="date" className={fieldClass} value={value}
        onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

 /**
 * `hint` is SHOWN under the control and also offered as its tooltip; `tip` is the tooltip
 * alone. The difference is about layout, not importance: in a four-up row one long
 * explanation turns a tidy line of selects into a ragged block, and the Streamlit original
 * put all of this behind `help=` — a hover — in the first place.
 */

/**
 * A controlled vocabulary, with one rule worth stating: a value already on the row that is
 * NOT in the list stays selectable. `_opt` and `_type_select` both do this, and it is not
 * politeness — a row carrying a value an older vocabulary allowed would otherwise be
 * silently rewritten to something else the moment anyone opened the editor on it.
 */
export function Choice({
  label, value, onChange, options, hint, tip, blank = "—", required, format,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; hint?: string; tip?: string; blank?: string; required?: boolean;
  /**
   * What to SHOW for a stored value — Streamlit's `format_func`.
   *
   * Some vocabularies store a code and show a sentence: `org_legal_type` holds
   * "higher_ed" and the editor reads "Higher Education". Without this an admin picks
   * identifiers out of a list, which is both uglier and harder to get right — "tribal"
   * and "for_profit" are not self-explaining. The VALUE is unaffected; only the text is.
   */
  format?: (v: string) => string;
}) {
  const opts = useMemo(() => {
    const list = [...new Set(options)];
    return value && !list.includes(value) ? [...list, value] : list;
  }, [options, value]);
  return (
    <div className="mb-4">
      <Lbl hint={tip ?? hint}>{label}{required && <span className="text-bad-600"> *</span>}</Lbl>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{blank}</option>
        {opts.map((o) => <option key={o} value={o}>{format ? format(o) : o}</option>)}
      </Select>
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

export function Multi({ label, value, onChange, options, hint, allowNew = false }: {
  label: string; value: string[]; onChange: (v: string[]) => void;
  options: string[]; hint?: string;
  /**
   * Let the user type a name the list does not hold — `MultiSelect`'s own `allowNew`.
   *
   * OFF by default, and the default protects SCORING: a typed value stored against a
   * controlled vocabulary matches nothing, and the criterion reads as unanswered.
   *
   * PEOPLE ARE NOT A CONTROLLED VOCABULARY, which is why the Team tab turns it on. A
   * proposal lead from another CHAI team is a real answer that the tenant's own member
   * list has never heard of, and refusing it does not keep the data clean — it just
   * means the field is left blank or filled with the wrong person.
   */
  allowNew?: boolean;
}) {
  // Same rule as Choice: stored values the vocabulary has since dropped stay selected.
  const opts = useMemo(
    () => [...new Set([...options, ...value])], [options, value]);
  return (
    <div className="mb-4">
      <MultiSelect label={label} options={opts} value={value} onChange={onChange} help={hint}
        allowNew={allowNew} />
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * A single choice that also accepts a name the list does not hold.
 *
 * `Choice` is a native `<select>`, which cannot take a typed value at all, so a field
 * whose list is a STARTING POINT rather than a closed set needs this instead: the list,
 * plus "Someone else…", which reveals a text box. A stored value that is not in the list
 * preselects that box with the text already in it, so re-opening the editor shows what is
 * stored rather than silently resetting to blank.
 */
export function ChoiceOrNew({
  label, value, onChange, options, hint, tip, blank = "—", addLabel = "Someone else…",
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: string[]; hint?: string; tip?: string; blank?: string; addLabel?: string;
}) {
  const list = useMemo(() => [...new Set(options)], [options]);
  const known = !!value && list.includes(value);
  const [typing, setTyping] = useState(!!value && !known);
  return (
    <div className="mb-4">
      <Lbl hint={tip ?? hint}>{label}</Lbl>
      <Select
        value={typing ? ADD : value}
        onChange={(e) => {
          if (e.target.value === ADD) { setTyping(true); onChange(""); return; }
          setTyping(false);
          onChange(e.target.value);
        }}
      >
        <option value="">{blank}</option>
        {list.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value={ADD}>{addLabel}</option>
      </Select>
      {typing && (
        <input
          autoFocus value={value} onChange={(e) => onChange(e.target.value)}
          placeholder="Type the person's name"
          aria-label={`${label} — type a name`}
          className={field("mt-2")}
        />
      )}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/** Sentinel for the "type one" row. Not a storable value — it never reaches `onChange`. */
const ADD = "__add_new__";
