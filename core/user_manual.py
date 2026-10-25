"""The user manual (PDF) and training deck (PPTX) as in-app downloads.

Both files are built from `docs/user-manual/` (see its README) and shipped in
`assets/help/`, so they are served straight from the repo — no storage bucket, no
static-file serving. Offered on Help and on Home; a missing file is skipped rather
than raising, so a checkout without the binaries still renders both pages.
"""
from __future__ import annotations

from pathlib import Path

import streamlit as st

_HELP_DIR = Path(__file__).resolve().parent.parent / "assets" / "help"

# (label, file name, mime, one-line description)
DOWNLOADS = [
    ("⬇ User manual (PDF)", "RFPIS_User_Manual.pdf", "application/pdf",
     "Step-by-step guide to every page, from sign-in to reports."),
    ("⬇ Training slides (PPTX)", "RFPIS_Training_Deck.pptx",
     "application/vnd.openxmlformats-officedocument.presentationml.presentation",
     "The team training session: screening, decisions, search, meetings."),
]


@st.cache_data(show_spinner=False)
def _read_cached(name: str, mtime: float) -> bytes:
    # `mtime` is part of the cache key: a rebuilt file is re-read without a restart.
    return (_HELP_DIR / name).read_bytes()


def _read(name: str) -> bytes | None:
    p = _HELP_DIR / name
    return _read_cached(name, p.stat().st_mtime) if p.is_file() else None


def render_manual_downloads(key_prefix: str, *, captions: bool = True) -> bool:
    """Draw one download button per available file, side by side. Returns False when
    neither file is present, so the caller can drop its surrounding heading."""
    files = [(lbl, name, mime, desc, _read(name)) for lbl, name, mime, desc in DOWNLOADS]
    files = [f for f in files if f[4]]
    if not files:
        return False
    cols = st.columns(len(files))
    for col, (lbl, name, mime, desc, data) in zip(cols, files):
        with col:
            st.download_button(lbl, data=data, file_name=name, mime=mime,
                               key=f"{key_prefix}_{name}", width="stretch")
            if captions:
                st.caption(desc)
    return True
