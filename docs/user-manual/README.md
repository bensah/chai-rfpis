# RFPIS user manual and training deck

Sources for the two files the app offers as downloads on **Help** and **Home**
(`core/user_manual.py`):

| Output | Built from | Command |
|---|---|---|
| `assets/help/RFPIS_User_Manual.pdf` | `manual.html` + `manual.css` + `img/` | `python docs/user-manual/build_pdf.py` |
| `assets/help/RFPIS_Training_Deck.pptx` | `build_deck.js` + `img/` | `node docs/user-manual/build_deck.js` (needs `pptxgenjs@3.12.0` on `NODE_PATH`) |

`manual.html` also reads well on its own in a browser.

Both are tenant-agnostic: the example organisation is **"RFPIS APP"** and the example
address is **user@example.com**. Screenshots in `img/` were taken from a live tenant at
1440×900 (device scale 1.25) and saved as JPEG; personal emails and phone numbers were
masked before capture. Retake a screenshot whenever its page changes, then rebuild both
outputs.
