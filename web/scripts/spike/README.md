# Does the Python scoring engine run in the browser?

The trial behind the scoring decision in [`docs/FRONTEND_MIGRATION.md`](../../../docs/FRONTEND_MIGRATION.md).

Screen, Review, Records, the rail and the Opportunity decision aid all recompute a live score
rather than trusting the stored one, through about 6,500 lines of Python
(`core/auto_scorer.py`, `core/criteria_derive.py`, `core/matching.py`, …). Porting that to
TypeScript would take weeks and drift on every change. The alternative is to run the repo's
own Python in the browser under Pyodide, so the code that scores in React **is** the code that
scores in Streamlit.

This measures whether that is fast enough and, more importantly, whether it gives the same
answers.

## Running it

```bash
# 1. a fixture from live data: the snapshot, some rows, and Python's own scores for them
python web/scripts/spike/make_fixture.py <tenant_id> 60

# 2. the Python the browser needs (all of core/ and config/, plus the two stand-ins)
node web/scripts/spike/build_bundle.mjs

# 3. serve it and open http://localhost:5191
python -m http.server 5191 --directory web/scripts/spike
```

`fixture/` is gitignored: it is a copy of repo code and live tenant rows.

## What it showed (2026-10-25, 60 rows, one tenant)

- **Identical to Python on every row and every field.**
- Engine boot ~3 s warm (~26 s on a first visit, then browser-cached), first score ~4 s,
  then 8–16 ms per row.
- The browser carries 107 files / 2.0 MB of unchanged `core/` and `config/`.

## The two stand-ins

`browser_stubs/` replaces exactly two modules, both pure data access:

- `db/supabase_client.py` — serves the snapshot through the same `table().select().eq()`
  interface the scoring code already calls, so no scoring module changes.
- `auth/tenant_context.py` — answers the few tenant questions the path asks; the real one
  reads Streamlit session state and mints JWTs, neither of which exists here.

## The currency trap

`core/fx.py` converts non-USD amounts with a rate fetched over the network. There is no
`httpx` in the browser, so that call fails and the code **silently** falls back to the static
table in `config/dropdowns.yaml` — EUR 1.16 against the live 1.1203. Scores still matched on
these 60 rows, because the bands are coarse, but a 3.5% swing can cross a boundary.

So the snapshot carries the rates the server used and `seed_fx()` puts them into `core.fx`'s
cache before anything is scored. The trial prints which source each currency resolved to, so
a regression here is visible rather than silent. XAF legitimately stays on the static table:
the rate API does not serve it, and Python falls back there too.
