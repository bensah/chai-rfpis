// What the `?tenant=` param does — web/src/shell/viewAsUrl.ts.
//
// THE BUG THIS PINS, reported by the owner on his first use of view-as (2026-11-18):
// "I'm viewing the tenant CHAI Cameroon as superuser, however, clicking Return to my
// account refuses to do so in the react."
//
// It did not refuse. The server was right all along — `routes_auth.viewAs` with an empty
// key reissues the session with `view: null`. What went wrong was entirely in the browser:
// the `?tenant=` param SELECTS the view, "Return to my account" cleared only the SESSION,
// and so on the very next render the param named a tenant matching neither the (now empty)
// view nor the super's own — which is precisely the condition for entering a view-as. The
// return was undone within the same tick, every time, which looks exactly like a dead
// button. `Layout`'s `.catch(() => undefined)` ensured a real failure looked the same.
//
// Streamlit never had this: its handler deletes the param in the same callback
// (core/app_header.py:1200). React cannot — the session update and the param change are
// separate renders and the effect runs between them — so the intent has to survive the
// round trip. That is the `leaving` flag, and these are its cases.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { viewAsUrlAction } = await import(
  pathToFileURL(path.join(here, "../src/shell/viewAsUrl.ts")).href);

/** A super_user whose own tenant is `rfpis`, currently viewing `chai-cameroon`. */
const VIEWING = {
  role: "super_user",
  key: "chai-cameroon",
  viewSlug: "chai-cameroon", viewId: "t-cam",
  tenantSlug: "rfpis", tenantId: "t-rfpis",
  leaving: false,
};

test("the reported bug: a return is not undone by the stale param", () => {
  // The exact state one tick after viewAs(null) resolves: the session has let go of the
  // view, the URL has not. WITHOUT the leaving flag this is {do:"enter"} and the reader
  // is thrown straight back into chai-cameroon.
  const afterReturn = {
    ...VIEWING, viewSlug: null, viewId: null, key: "chai-cameroon", leaving: true,
  };
  assert.deepEqual(viewAsUrlAction(afterReturn), { do: "clear" });

  // And this is what it did before the fix, which is why the button looked dead.
  assert.deepEqual(
    viewAsUrlAction({ ...afterReturn, leaving: false }),
    { do: "enter", key: "chai-cameroon" },
    "without `leaving` the stale param re-enters the view — the original defect");
});

test("the return settles once the session and the URL agree", () => {
  assert.deepEqual(
    viewAsUrlAction({ ...VIEWING, viewSlug: null, viewId: null, key: null, leaving: true }),
    { do: "settled" });
});

test("leaving keeps clearing while the session still holds the view", () => {
  // The other order: the param went first and the session has not caught up. Clearing
  // again is harmless; stamping would write the viewed slug back and restart the loop.
  assert.deepEqual(viewAsUrlAction({ ...VIEWING, key: null, leaving: true }),
    { do: "clear" });
});

test("once settled, the URL is stamped with the user's own tenant", () => {
  assert.deepEqual(
    viewAsUrlAction({ ...VIEWING, viewSlug: null, viewId: null, key: null, leaving: false }),
    { do: "stamp", slug: "rfpis" });
});

test("a fresh key enters the view-as", () => {
  assert.deepEqual(viewAsUrlAction({ ...VIEWING, viewSlug: null, viewId: null }),
    { do: "enter", key: "chai-cameroon" });
});

test("a raw tenant id works as well as a slug", () => {
  assert.deepEqual(viewAsUrlAction({ ...VIEWING, viewSlug: null, viewId: null, key: "t-cam" }),
    { do: "enter", key: "t-cam" });
});

test("the key that is already being viewed is a stamp, not a re-entry", () => {
  // Otherwise every render would post /session/view again. Both spellings count.
  assert.deepEqual(viewAsUrlAction(VIEWING), { do: "stamp", slug: "chai-cameroon" });
  assert.deepEqual(viewAsUrlAction({ ...VIEWING, key: "t-cam" }),
    { do: "stamp", slug: "chai-cameroon" });
});

test("the super's OWN tenant in the URL never starts a view-as", () => {
  // Entering a view-as of your own tenant is what the server turns back into null
  // (routes_auth.viewAs: `t.id === ctx.session.tenant?.id ? null : ...`). Asking for it is
  // a pointless round trip that ends where it started.
  for (const key of ["rfpis", "t-rfpis"]) {
    assert.deepEqual(viewAsUrlAction({ ...VIEWING, viewSlug: null, viewId: null, key }),
      { do: "stamp", slug: "rfpis" }, key);
  }
});

test("a non-super_user cannot select a tenant through the URL", () => {
  // app_header._apply_tenant_url: for everyone else the param only DESCRIBES. An incoming
  // value is ignored and overwritten with what they are actually allowed to see.
  for (const role of ["admin", "user", null, undefined]) {
    assert.deepEqual(
      viewAsUrlAction({ ...VIEWING, role, viewSlug: null, viewId: null, key: "chai-cameroon" }),
      { do: "stamp", slug: "rfpis" }, String(role));
  }
});

test("no key and no view stamps the user's own tenant", () => {
  assert.deepEqual(
    viewAsUrlAction({ ...VIEWING, key: null, viewSlug: null, viewId: null }),
    { do: "stamp", slug: "rfpis" });
});

test("a user with no tenant at all stamps nothing", () => {
  assert.deepEqual(
    viewAsUrlAction({
      role: "user", key: null, viewSlug: null, viewId: null,
      tenantSlug: null, tenantId: null, leaving: false,
    }),
    { do: "stamp", slug: null });
});

test("an empty-string key is not a request to enter anything", () => {
  // `params.get` can hand back "" for `?tenant=`, and resolving "" server-side is a 404.
  assert.deepEqual(viewAsUrlAction({ ...VIEWING, viewSlug: null, viewId: null, key: "" }),
    { do: "stamp", slug: "rfpis" });
});

test("entering from Settings > Tenants is the same path as a pasted URL", () => {
  // The tenant name in Settings > Tenants links to hrefOf("home", {tenant: slug}), so it
  // arrives here as an ordinary key rather than through a second mechanism that could
  // drift from this one. This asserts the two are indistinguishable.
  const fromSettings = viewAsUrlAction({
    ...VIEWING, viewSlug: null, viewId: null, key: "chai-mali",
  });
  const fromAddressBar = viewAsUrlAction({
    ...VIEWING, viewSlug: null, viewId: null, key: "chai-mali",
  });
  assert.deepEqual(fromSettings, { do: "enter", key: "chai-mali" });
  assert.deepEqual(fromSettings, fromAddressBar);
});

test("switching straight from one tenant to another enters the new one", () => {
  // Settings > Tenants is reachable while already viewing-as, so this is a real path:
  // viewing chai-cameroon, click chai-mali.
  assert.deepEqual(viewAsUrlAction({ ...VIEWING, key: "chai-mali" }),
    { do: "enter", key: "chai-mali" });
});
