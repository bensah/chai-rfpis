"""The single fake `streamlit` shared by every test module that needs one.

Several test modules must put a stub `streamlit` in sys.modules BEFORE they import app
modules that do `import streamlit as st` at module top (auth.tenant_context,
db.supabase_client, core.app_header, core.excel_sync). Each module used to build its OWN
stub and assign it, which broke in two ways once the whole suite ran in one process:

  * An app module binds `st` at ITS first import and is then cached for the rest of the
    run, so it kept a reference to whichever stub happened to be installed at that moment.
    A later module's setUp cleared a DIFFERENT object, so one module's session_state
    leaked into another's assertions (a tenant id from test_session_identity_isolation
    turning up inside test_workbook_isolation, and so on).
  * The stubs carried only session_state, so importing anything decorated with
    `@st.cache_data` (core.web_search) raised AttributeError and took the whole of
    test_search_discovery with it.

`install()` fixes both by being idempotent on sys.modules: the first caller builds the
stub, every later caller gets that SAME object back. Clearing its session_state therefore
clears the dict the app code is really reading, whatever the import order was.

That last promise only held while NO test module imported an app module before the first
`install()`. `tests/test_cron_multitenant.py` did exactly that (`from core import
scan_pipeline`, `import auth.tenant_context`), and it sorts before every module that
installs the stub, so under the full suite `auth.tenant_context.st` was bound to the REAL
Streamlit for the rest of the process. Bare Streamlit's session_state is a no-op that logs
"Session state does not function when running a script without `streamlit run`" and
silently drops every write, so test_session_identity_isolation and test_workbook_isolation
wrote their fixtures into the stub and the code under test read an entirely different,
permanently empty mapping. Sixteen tests failed in bulk and passed alone.

`_rebind_app_modules()` closes that hole: installing the stub also repoints the
module-level `st` of every ALREADY-IMPORTED project module at it. The order-independence
above is then a property of this fixture rather than of a convention each new test module
has to remember.

Restoring the real Streamlit instead is not an option here: `sc` and `tc` resolve
`streamlit` lazily in places, so putting the real module back mid-run breaks these tests.
A test that genuinely needs the real Streamlit must reinstall it around its own runs; see
tests/test_criteria_editor_widget.py.
"""
from __future__ import annotations

import os
import sys
import types

_MARKER = "_is_shared_test_fake"

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_HERE)


class QueryParams(dict):
    """Enough of st.query_params for the tests: get / set / del / membership."""


def _noop(*_a, **_kw):
    return None


class _CacheDecorator:
    """Stands in for st.cache_data / st.cache_resource.

    Caching is a no-op here: the decorated function is returned unchanged, so tests never
    see a result memoised from an earlier test. Supports both spellings the app uses —
    bare `@st.cache_data` and parameterised `@st.cache_data(ttl=900, show_spinner=False)` —
    and the `st.cache_data.clear()` call sites in app_pages/admin.py.
    """

    def __call__(self, *args, **kwargs):
        if len(args) == 1 and not kwargs and callable(args[0]):
            fn = args[0]                      # bare @st.cache_data
            fn.clear = _noop
            return fn

        def wrap(fn):                         # @st.cache_data(ttl=...)
            fn.clear = _noop
            return fn

        return wrap

    def clear(self, *_a, **_kw):
        return None


def _is_project_module(mod: types.ModuleType) -> bool:
    """True for a module that lives in this repo but outside tests/."""
    path = getattr(mod, "__file__", None)
    if not path:
        return False
    try:
        path = os.path.abspath(path)
    except (TypeError, ValueError):
        return False
    return path.startswith(_PROJECT_ROOT + os.sep) and not path.startswith(_HERE + os.sep)


def _rebind_app_modules(fake: types.ModuleType) -> list[str]:
    """Point already-imported app modules' module-level `st` at `fake`.

    An app module that did `import streamlit as st` before the stub existed holds the real
    module forever — `sys.modules` is only consulted at import. Repointing the name is the
    same thing a later import would have done, and it is what makes `install()` order-
    independent. Modules that resolve `streamlit` lazily (core.excel_sync, parts of
    db.supabase_client) have no `st` global and need nothing here.

    Returns the module names that were repointed, for diagnosis.
    """
    rebound = []
    for name, mod in list(sys.modules.items()):
        if not isinstance(mod, types.ModuleType) or mod is fake:
            continue
        bound = getattr(mod, "st", None)
        if not isinstance(bound, types.ModuleType) or bound.__name__ != "streamlit":
            continue
        if bound is fake or not _is_project_module(mod):
            continue
        mod.st = fake
        rebound.append(name)
    return rebound


def install() -> types.ModuleType:
    """Install (or return) the one shared fake `streamlit`.

    Call this at module level, before importing any app module. Returns the stub so the
    caller can read/clear `session_state` and hang extra attributes on it. An app module
    that was imported earlier (and so bound the real Streamlit) is repointed at the stub.
    """
    existing = sys.modules.get("streamlit")
    if isinstance(existing, types.ModuleType) and getattr(existing, _MARKER, False):
        _rebind_app_modules(existing)
        return existing

    fake = types.ModuleType("streamlit")
    setattr(fake, _MARKER, True)
    fake.session_state = {}
    fake.secrets = {}
    fake.query_params = QueryParams()
    fake.cache_data = _CacheDecorator()
    fake.cache_resource = _CacheDecorator()
    for _name in ("warning", "markdown", "error", "info", "success", "caption", "write"):
        setattr(fake, _name, _noop)
    sys.modules["streamlit"] = fake
    _rebind_app_modules(fake)
    return fake
