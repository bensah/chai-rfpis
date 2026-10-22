# packages.txt is intentionally disabled → renamed to `packages.txt.disabled`

**Why:** Streamlit Community Cloud runs `apt-get` whenever a `packages.txt` is present.
On 2026-09-08 the upstream Debian mirror's `bullseye-security` **release file expired**
(`E: Release file … is expired (invalid since 15h…)`), so `apt-get update` returned a
non-zero exit and Streamlit aborted the whole deploy — "Oh no. Error running app."
The host image lists that bullseye repository alongside its own (trixie) ones, and
bullseye's security support has since ended, so **do not re-enable this file**: the apt
step is likely to fail the same way and take the whole app offline again.

**How PDF export gets Chromium's libraries instead:** `core/chromium_libs.py`. When the
first PDF export finds Chromium cannot start for a missing system library, it reads the
host's own Debian release index from deb.debian.org, resolves what Chromium needs that the
host lacks, downloads those `.deb`s and unpacks them (in Python, no root, no apt) into a
private directory, then launches Chromium with `LD_LIBRARY_PATH` pointing there. The first
export on a fresh container takes a minute or two; later ones reuse the unpacked files.

`packages.txt.disabled` is still the list of packages that fetch starts from — edit it
there if Chromium ever needs a new library.
