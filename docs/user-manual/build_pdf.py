"""Render manual.html to the downloadable PDF in assets/help/.

    python docs/user-manual/build_pdf.py

Uses the same Playwright Chromium the app's report export uses. A screenshot that
is missing from img/ is printed as a labelled placeholder instead of a broken image,
so the PDF can be built before every capture exists.
"""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "assets" / "help" / "RFPIS_User_Manual.pdf"

_PLACEHOLDERS = """() => {
  document.querySelectorAll('figure.shot img').forEach(img => {
    if (img.complete && img.naturalWidth) return;
    const d = document.createElement('div');
    d.className = 'placeholder';
    d.innerHTML = '<b>Screenshot: ' + (img.alt || 'screen') + '</b><span>' +
                  img.getAttribute('src') + '</span>';
    img.replaceWith(d);
  });
}"""

_FOOTER = ("<div style='width:100%;font:8px Arial,sans-serif;color:#8a94a3;"
           "padding:0 13mm;display:flex;justify-content:space-between'>"
           "<span>RFPIS User Manual</span>"
           "<span><span class='pageNumber'></span> / <span class='totalPages'></span></span></div>")


def build(out: Path = OUT) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto((HERE / "manual.html").as_uri(), wait_until="networkidle")
        page.evaluate("document.fonts.ready")
        page.evaluate(_PLACEHOLDERS)
        page.emulate_media(media="print")
        page.pdf(path=str(out), format="A4", print_background=True,
                 display_header_footer=True, header_template="<span></span>",
                 footer_template=_FOOTER,
                 margin={"top": "14mm", "bottom": "16mm", "left": "13mm", "right": "13mm"})
        browser.close()
    return out


if __name__ == "__main__":
    print(build())
