"""Chromium's system libraries, installed WITHOUT apt — into a directory this process owns.

WHY THIS EXISTS. Headless Chromium links against ~20 shared libraries (glib, nss, atk, cups,
X11 …) that a slim container does not ship. On Streamlit Community Cloud the documented way to
get them is `packages.txt`, which the host feeds to `apt-get` before every deploy. That route
is closed to us: the host image carries a stale `bullseye-security` source, and once that
repository's Release file expired `apt-get update` failed and Streamlit aborted the WHOLE
deploy — the app went offline to fix a PDF button (#271). Bullseye's security support has
since ended, so the file will not come back to life. `packages.txt` stays disabled, and PDF
export kept failing with "missing the system library libglib-2.0.so.0".

So the libraries are fetched the way apt would, minus the root and minus the system:

  1. read which packages the host already has (`/var/lib/dpkg/status`, world-readable);
  2. read the host release's package index from deb.debian.org (the same mirror apt uses,
     the same release the host runs — so every library matches the host's libc);
  3. resolve the dependency closure of the packages Chromium needs, skipping everything the
     host already has;
  4. download those .debs and unpack them — in Python, no dpkg — into a private directory;
  5. hand that directory to the browser as `LD_LIBRARY_PATH` (and a fontconfig file, so the
     PDF has fonts to set type in).

Nothing outside that directory is touched, so a failure here can only leave PDF export where
it was. It runs once per container, only when a launch has actually failed for a missing
library, and the result is remembered on disk for the next process.
"""
from __future__ import annotations

import io
import json
import logging
import lzma
import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

log = logging.getLogger(__name__)

MIRROR = "https://deb.debian.org/debian"

# What Chromium needs, by Debian package name — the list `packages.txt` used to carry, which is
# kept in the repository (as packages.txt.disabled) and read from there so there is one list.
# The fallback copy is only for a deploy that somehow lacks the file.
_FALLBACK_PACKAGES = (
    "fonts-liberation", "libasound2t64", "libatk-bridge2.0-0t64", "libatk1.0-0t64",
    "libatspi2.0-0t64", "libcairo2", "libcups2t64", "libdbus-1-3", "libdrm2", "libgbm1",
    "libglib2.0-0t64", "libnspr4", "libnss3", "libpango-1.0-0", "libx11-6", "libxcb1",
    "libxcomposite1", "libxdamage1", "libxext6", "libxfixes3", "libxkbcommon0",
    "libxrandr2",
)

# A dependency closure that grows past this is resolving something other than libraries
# (a desktop, a toolchain) — stop rather than download half of Debian into /tmp.
_MAX_PACKAGES = 150
_HTTP_TIMEOUT = 120
_MARKER = ".rfpis-chromium-libs.json"


def _root_dir() -> str:
    """Where the unpacked libraries live: beside the Playwright browsers when that is
    writable (same lifetime as the browser they serve), otherwise the temp directory."""
    explicit = os.environ.get("RFPIS_CHROMIUM_LIBS_DIR")
    if explicit:
        return explicit
    try:
        from core import playwright_setup
        base = playwright_setup.browsers_path()
        if base and base != "0":
            parent = os.path.dirname(base.rstrip("/\\")) or base
            candidate = os.path.join(parent, "rfpis-chromium-libs")
            os.makedirs(candidate, exist_ok=True)
            if os.access(candidate, os.W_OK):
                return candidate
    except Exception:
        pass
    return os.path.join(tempfile.gettempdir(), "rfpis-chromium-libs")


def _wanted_packages() -> list[str]:
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in ("packages.txt", "packages.txt.disabled"):
        try:
            with open(os.path.join(repo, name), encoding="utf-8") as fh:
                names = [ln.strip() for ln in fh
                         if ln.strip() and not ln.strip().startswith("#")]
            if names:
                return names
        except Exception:
            continue
    return list(_FALLBACK_PACKAGES)


def _os_release() -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open("/etc/os-release", encoding="utf-8") as fh:
            for line in fh:
                if "=" in line:
                    key, _, value = line.partition("=")
                    out[key.strip()] = value.strip().strip('"')
    except Exception:
        pass
    return out


def _arch() -> str | None:
    try:
        out = subprocess.run(["dpkg", "--print-architecture"], capture_output=True,
                             text=True, timeout=10)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())


def _triplet(arch: str) -> str:
    return {"amd64": "x86_64-linux-gnu", "arm64": "aarch64-linux-gnu"}.get(arch, "")


def _parse_stanzas(text: str):
    """Debian control-file paragraphs (`Packages`, `dpkg/status`) as dicts."""
    for para in text.split("\n\n"):
        fields: dict[str, str] = {}
        key = None
        for line in para.splitlines():
            if not line:
                continue
            if line[0] in " \t" and key:
                fields[key] += "\n" + line.strip()
                continue
            key, _, value = line.partition(":")
            key = key.strip()
            fields[key] = value.strip()
        if fields.get("Package"):
            yield fields


def _dep_groups(field: str) -> list[list[str]]:
    """`a (>= 1), b | c:any` -> [["a"], ["b", "c"]]. Versions are not compared: the index is
    the host's own release, so whatever it carries is what the host's libraries expect."""
    groups = []
    for group in field.split(","):
        alts = []
        for alt in group.split("|"):
            name = re.sub(r"\(.*?\)|\[.*?\]|<.*?>", "", alt).strip().split(":")[0]
            if name:
                alts.append(name)
        if alts:
            groups.append(alts)
    return groups


def _installed() -> set[str]:
    """Package names (and the names they Provide) the host already has."""
    have: set[str] = set()
    try:
        with open("/var/lib/dpkg/status", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except Exception:
        return have
    for st in _parse_stanzas(text):
        if "installed" not in st.get("Status", "").split():
            continue
        have.add(st["Package"])
        for group in _dep_groups(st.get("Provides", "")):
            have.update(group)
    return have


def _fetch(url: str) -> bytes:
    """HTTPS GET. `requests` carries its own CA bundle (certifi), so this does not depend on
    the host's certificate store being complete; urllib is the fallback if it is missing."""
    headers = {"User-Agent": "rfpis-chromium-libs/1"}
    try:
        import requests
    except ImportError:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT) as resp:
            return resp.read()
    resp = requests.get(url, headers=headers, timeout=_HTTP_TIMEOUT)
    resp.raise_for_status()
    return resp.content


def _index(codename: str, arch: str) -> dict[str, dict[str, str]]:
    """The release's `main` package index, newest-wins across the point-release suites."""
    packages: dict[str, dict[str, str]] = {}
    for suite in (codename, f"{codename}-updates"):
        url = f"{MIRROR}/dists/{suite}/main/binary-{arch}/Packages.xz"
        try:
            text = lzma.decompress(_fetch(url)).decode("utf-8", errors="replace")
        except Exception as exc:
            if suite == codename:
                raise RuntimeError(f"could not read the {codename} package index ({exc})")
            continue                      # -updates is optional
        for st in _parse_stanzas(text):
            packages[st["Package"]] = st
    return packages


def _resolve(wanted: list[str], index: dict, have: set[str]) -> tuple[list[dict], list[str]]:
    """Dependency closure of `wanted`, minus what the host has. Returns (to_fetch, unknown)."""
    provides: dict[str, str] = {}
    for name, st in index.items():
        for group in _dep_groups(st.get("Provides", "")):
            for virtual in group:
                provides.setdefault(virtual, name)

    def real(name: str) -> str | None:
        if name in index:
            return name
        if name in provides:
            return provides[name]
        # Debian 13 renamed several libraries with a `t64` suffix; an older release still
        # carries the plain name. Try the other spelling before giving up.
        alt = name[:-3] if name.endswith("t64") else None
        return alt if alt and alt in index else None

    chosen: dict[str, dict] = {}
    unknown: list[str] = []
    queue: list[list[str]] = [[n] for n in wanted]
    while queue:
        group = queue.pop(0)
        if any(alt in have or alt in chosen for alt in group):
            continue
        pick = None
        for alt in group:
            name = real(alt)
            if name and (name in have or name in chosen):
                pick = ""
                break
            if name and pick is None:
                pick = name
        if pick == "":
            continue
        if pick is None:
            unknown.append(" | ".join(group))
            continue
        st = index[pick]
        chosen[pick] = st
        if len(chosen) > _MAX_PACKAGES:
            raise RuntimeError("the dependency closure grew past "
                               f"{_MAX_PACKAGES} packages; refusing to continue")
        for key in ("Pre-Depends", "Depends"):
            queue.extend(_dep_groups(st.get(key, "")))
    return list(chosen.values()), unknown


def _ar_members(blob: bytes):
    """Members of a Unix `ar` archive (the outer shell of a .deb)."""
    if not blob.startswith(b"!<arch>\n"):
        raise ValueError("not a .deb (missing ar magic)")
    pos = 8
    while pos + 60 <= len(blob):
        header = blob[pos:pos + 60]
        name = header[:16].decode("ascii", errors="replace").strip().rstrip("/")
        size = int(header[48:58].decode("ascii").strip())
        start = pos + 60
        yield name, blob[start:start + size]
        pos = start + size + (size % 2)


def _safe_members(tar: tarfile.TarFile, dest: str):
    """Regular files, dirs and symlinks that stay inside `dest`; anything else is skipped."""
    dest = os.path.realpath(dest)
    for m in tar.getmembers():
        if not (m.isfile() or m.isdir() or m.issym()):
            continue
        target = os.path.realpath(os.path.join(dest, m.name))
        if not (target == dest or target.startswith(dest + os.sep)):
            continue
        if m.issym():
            if os.path.isabs(m.linkname):
                continue
            link_to = os.path.realpath(os.path.join(os.path.dirname(target), m.linkname))
            if not link_to.startswith(dest + os.sep):
                continue
        yield m


def _unpack_deb(blob: bytes, dest: str) -> None:
    for name, data in _ar_members(blob):
        if not name.startswith("data.tar"):
            continue
        if name.endswith(".zst"):
            # Python cannot read zstd before 3.14; dpkg-deb can, and every Debian host has it.
            with tempfile.NamedTemporaryFile(suffix=".deb", delete=False) as fh:
                fh.write(blob)
            try:
                subprocess.run(["dpkg-deb", "-x", fh.name, dest], check=True,
                               capture_output=True, timeout=120)
            finally:
                os.unlink(fh.name)
            return
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
            members = list(_safe_members(tar, dest))
            try:
                tar.extractall(dest, members=members, filter="fully_trusted")
            except TypeError:                 # Python without extraction filters
                tar.extractall(dest, members=members)
        return
    raise ValueError("no data.tar member in .deb")


def _lib_dirs(root: str, arch: str) -> list[str]:
    trip = _triplet(arch)
    dirs = [os.path.join(root, "usr", "lib", trip), os.path.join(root, "lib", trip),
            os.path.join(root, "usr", "lib"), os.path.join(root, "lib")]
    return [d for d in dirs if os.path.isdir(d)]


def _write_fonts_conf(root: str) -> str:
    """A fontconfig file that sees the fonts we unpacked AND the system's own.

    libfontconfig only reads its compiled-in /etc/fonts/fonts.conf; on a slim host that file
    may not exist, and Chromium then has no font to set the report in. The system config is
    included when present (it brings its own aliases); otherwise the unpacked
    fontconfig-config's rules are, so `sans-serif` still resolves to a real face."""
    conf_dir = os.path.join(root, "etc", "fonts")
    os.makedirs(conf_dir, exist_ok=True)
    path = os.path.join(conf_dir, "rfpis-fonts.conf")
    rules = ('<include ignore_missing="yes">/etc/fonts/fonts.conf</include>'
             if os.path.exists("/etc/fonts/fonts.conf")
             else f'<include ignore_missing="yes">{conf_dir}/conf.d</include>')
    # The generic families named outright. Without them a host with no fontconfig rules
    # matched `sans-serif` to whichever face it found first — Liberation Mono — and the whole
    # report came out typewritten. The first rule is fontconfig's own 49-sansserif.conf: a
    # request naming no generic family (Chromium's `system-ui` default) falls back to
    # sans-serif rather than to the first font on disk.
    aliases = (
        '  <match target="pattern">'
        + "".join(f'<test qual="all" name="family" compare="not_eq"><string>{g}</string></test>'
                  for g in ("sans-serif", "serif", "monospace"))
        + '<edit name="family" mode="append_last"><string>sans-serif</string></edit>'
        "</match>\n")
    aliases += "".join(
        f"  <alias><family>{generic}</family><prefer>"
        + "".join(f"<family>{face}</family>" for face in faces)
        + "</prefer></alias>\n"
        for generic, faces in (
            ("sans-serif", ("Liberation Sans", "DejaVu Sans")),
            ("system-ui", ("Liberation Sans", "DejaVu Sans")),
            ("serif", ("Liberation Serif", "DejaVu Serif")),
            ("monospace", ("Liberation Mono", "DejaVu Sans Mono"))))
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(
            '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
            "<fontconfig>\n"
            f"  <dir>{root}/usr/share/fonts</dir>\n"
            "  <dir>/usr/share/fonts</dir>\n"
            f"  <cachedir>{root}/fontconfig-cache</cachedir>\n"
            f"  {rules}\n"
            f"{aliases}"
            "</fontconfig>\n")
    return path


def _read_marker(root: str) -> dict | None:
    try:
        with open(os.path.join(root, _MARKER), encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("lib_dirs") and all(os.path.isdir(d) for d in data["lib_dirs"]):
            return data
    except Exception:
        pass
    return None


def env_overlay() -> dict[str, str]:
    """Environment additions that point a child process at the unpacked libraries, or {}
    when nothing has been installed. Cheap — reads one small file."""
    if not os.name == "posix":
        return {}
    data = _read_marker(_root_dir())
    if not data:
        return {}
    existing = os.environ.get("LD_LIBRARY_PATH", "")
    overlay = {"LD_LIBRARY_PATH": os.pathsep.join(
        list(data["lib_dirs"]) + ([existing] if existing else []))}
    if data.get("fonts_conf") and os.path.exists(data["fonts_conf"]):
        overlay["FONTCONFIG_FILE"] = data["fonts_conf"]
    return overlay


def install() -> tuple[bool, str]:
    """Fetch and unpack whatever Chromium needs that the host lacks. `(ok, message)`.

    Never raises. Only meaningful on a Debian-family Linux host; anywhere else it says so."""
    if not os.path.exists("/var/lib/dpkg/status"):
        return False, "this host is not Debian-based, so its libraries can't be fetched here"
    release = _os_release()
    codename = release.get("VERSION_CODENAME")
    if release.get("ID") != "debian" or not codename:
        return False, (f"this host runs {release.get('PRETTY_NAME') or 'an unknown OS'}; the "
                       f"library fetch only knows Debian's mirror")
    arch = _arch()
    if not arch or not _triplet(arch):
        return False, f"unsupported architecture {arch or platform.machine()}"
    root = _root_dir()
    try:
        have = _installed()
        index = _index(codename, arch)
        todo, unknown = _resolve(_wanted_packages(), index, have)
        staging = root + ".partial"
        shutil.rmtree(staging, ignore_errors=True)
        os.makedirs(staging, exist_ok=True)
        for st in todo:
            blob = _fetch(f"{MIRROR}/{st['Filename']}")
            _unpack_deb(blob, staging)
        # Swap in atomically-enough: a half-unpacked tree is never what the marker points at.
        shutil.rmtree(root, ignore_errors=True)
        os.replace(staging, root)
        lib_dirs = _lib_dirs(root, arch)
        fonts_conf = _write_fonts_conf(root)
        with open(os.path.join(root, _MARKER), "w", encoding="utf-8") as fh:
            json.dump({"codename": codename, "arch": arch, "lib_dirs": lib_dirs,
                       "fonts_conf": fonts_conf,
                       "packages": sorted(st["Package"] for st in todo),
                       "unresolved": unknown}, fh, indent=1)
    except Exception as exc:
        log.warning("chromium_libs: install failed: %s", exc)
        return False, f"fetching Chromium's libraries from {MIRROR} failed ({exc})"
    msg = (f"unpacked {len(todo)} Debian {codename} package(s) for Chromium into {root}"
           + (f"; not in the index: {', '.join(unknown)}" if unknown else ""))
    log.info("chromium_libs: %s", msg)
    return True, msg


def status() -> dict[str, object]:
    """For the deployment diagnostics: what, if anything, has been unpacked."""
    root = _root_dir()
    data = _read_marker(root) or {}
    return {"dir": root, "installed": bool(data), "packages": len(data.get("packages") or []),
            "unresolved": data.get("unresolved") or []}
