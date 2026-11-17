"""Emit supabase/functions/_shared/api/records_vocab.ts from the Python that owns it.

Settings → Records → Data is ONE renderer over several tables, and what distinguishes
them is a dict: `_DATA_SPECS` in `app_pages/admin.py`. Each entry names the table, the
column it orders by, which columns the grid shows and what to call them, which are dates,
which the free-text search covers, which offer a dropdown filter, and the fields the edit
dialog builds — with each field's TYPE, which decides whether it renders as a date, a
one-line box or a textarea.

WHY IT IS GENERATED RATHER THAN RETYPED, which is the same argument gen_form_vocab makes:

  * `date_cols` decides which columns are parsed as dates for the range filter. Miss one
    and the filter silently matches nothing, because a string never falls inside a date
    range.
  * `search_cols` decides what a search actually looks at. A column missing here is a
    column the user can see on screen and cannot find by typing — the worst kind of
    search bug, because nothing is wrong with the result, only with its absence.
  * `edit_fields` decides which columns a save WRITES. One missing is a field an admin
    edits on the Streamlit page and cannot edit here; one spelled wrong is a column that
    does not exist, and the save fails on the first use.
  * `order_col` is read with `desc=True`. A wrong one reorders the whole grid, which
    looks like data loss on a long table.

The dict lives inside admin.py, a Streamlit page that runs widgets at import time, so it
is lifted from the syntax tree rather than imported. That is the same trick the parity
harnesses use on view files.

    python scripts/gen_records_vocab.py        # rewrites the .ts in place

`tests/test_records_vocab_is_current.py` re-lifts and compares, so a spec changed in
admin.py fails a test rather than quietly leaving the React page a table behind.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

ADMIN = ROOT / "app_pages" / "admin.py"
OUT = ROOT / "supabase/functions/_shared/api/records_vocab.ts"


def js(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def data_specs() -> dict:
    """`_DATA_SPECS` out of app_pages/admin.py, as a plain dict.

    It is an annotated assignment (`_DATA_SPECS: dict[str, dict] = {...}`), so the walk
    looks for AnnAssign as well as Assign — an earlier version of this that only checked
    Assign found nothing and emitted an empty table, which is exactly the silent failure
    this file exists to prevent, so the lookup raises instead when it finds nothing.
    """
    tree = ast.parse(ADMIN.read_text(encoding="utf-8"))
    for n in ast.walk(tree):
        target = None
        if isinstance(n, ast.AnnAssign):
            target = n.target
        elif isinstance(n, ast.Assign) and len(n.targets) == 1:
            target = n.targets[0]
        if isinstance(target, ast.Name) and target.id == "_DATA_SPECS" and n.value:
            return ast.literal_eval(n.value)
    raise SystemExit(
        "_DATA_SPECS is no longer a literal in app_pages/admin.py — the Records tab was "
        "restructured, so this table would ship specs nothing renders.")


def lifted_list(name: str) -> list:
    """A module-level string constant from admin.py (the two special table names)."""
    tree = ast.parse(ADMIN.read_text(encoding="utf-8"))
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name) and t.id == name:
                    return ast.literal_eval(n.value)
    raise SystemExit(f"{name} is no longer assigned in app_pages/admin.py")


def main() -> None:
    specs = data_specs()
    # Normalised to the shape the TypeScript reads, with every optional key present. A
    # missing key in TS is `undefined`, and `undefined.includes(...)` throws inside a
    # render — so the absence is resolved HERE, once, rather than guarded at every use.
    norm = {
        name: {
            "table": spec["table"],
            "orderCol": spec["order_col"],
            "tableCols": list(spec.get("table_cols", [])),
            "colLabels": dict(spec.get("col_labels", {})),
            "dateCols": list(spec.get("date_cols", [])),
            "searchCols": list(spec.get("search_cols", [])),
            "advancedFilters": list(spec.get("advanced_filters", [])),
            "editFields": [list(f) for f in spec.get("edit_fields", [])],
            "caption": spec.get("caption", ""),
        }
        for name, spec in specs.items()
    }
    body = f'''/**
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
export type RecordSpec = {{
  table: string;
  orderCol: string;
  tableCols: string[];
  colLabels: Record<string, string>;
  dateCols: string[];
  searchCols: string[];
  advancedFilters: string[];
  editFields: [string, string, string][];
  caption: string;
}};

/**
 * The auxiliary tables, keyed by the name the picker shows.
 *
 * Every optional key is present with an empty default: a missing key is `undefined` in
 * TypeScript, and `undefined.includes(...)` throws inside a render. The absence is
 * resolved once, in the generator, rather than guarded at every use.
 */
export const RECORD_SPECS: Record<string, RecordSpec> = {js(norm)};

/** The two entries that are NOT auxiliary tables — each has its own branch. */
export const SCREENED_LABEL = {js(lifted_list("_SCREENED"))};
export const EXTRACTED_LABEL = {js(lifted_list("_EXTRACTED"))};

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
export const RECORD_OPTIONS: string[] = {js(
    [lifted_list("_SCREENED"), lifted_list("_EXTRACTED"), *specs.keys()])};

/**
 * The columns the Extracted Solicitations grid shows, in order.
 *
 * That branch has no spec dict — it is a read-only view of the global raw store — so its
 * column list is lifted from the branch itself.
 */
export const EXTRACTED_COLUMNS: string[] = {js(lifted_list("_show_cols"))};
'''
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}: {len(norm)} table specs, "
          f"{sum(len(v['editFields']) for v in norm.values())} edit fields, "
          f"{len(lifted_list('_show_cols'))} extracted columns")


if __name__ == "__main__":
    main()
