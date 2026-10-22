"""Chromium's system libraries, fetched without apt (core/chromium_libs.py).

The deployed PDF export failed with "missing the system library libglib-2.0.so.0": the
libraries used to come from packages.txt, and that file had to be disabled because its apt
step took the whole app down when a repository in the host image went stale (#271). These
tests pin the pieces that replace it — dependency resolution against what the host already
has, unpacking a .deb without dpkg, and refusing archive paths that escape the target. No
test here touches the network.

Run:  python -m unittest tests.test_chromium_libs
"""
import io
import json
import os
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from core import chromium_libs as cl      # noqa: E402


def _stanza(name, depends="", provides="", pre=""):
    st = {"Package": name, "Filename": f"pool/main/{name}.deb"}
    if depends:
        st["Depends"] = depends
    if pre:
        st["Pre-Depends"] = pre
    if provides:
        st["Provides"] = provides
    return st


def _deb(files: dict[str, bytes], links: dict[str, str] | None = None) -> bytes:
    """A minimal .deb: ar archive holding debian-binary, control.tar.xz, data.tar.xz."""
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w:xz") as tar:
        for path, content in files.items():
            info = tarfile.TarInfo(path)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        for path, target in (links or {}).items():
            info = tarfile.TarInfo(path)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            tar.addfile(info)

    def member(name: str, payload: bytes) -> bytes:
        header = (name.ljust(16) + "0".ljust(12) + "0".ljust(6) + "0".ljust(6)
                  + "100644".ljust(8) + str(len(payload)).ljust(10) + "`\n")
        return header.encode("ascii") + payload + (b"\n" if len(payload) % 2 else b"")

    return (b"!<arch>\n" + member("debian-binary", b"2.0\n")
            + member("control.tar.xz", b"") + member("data.tar.xz", data.getvalue()))


class ParseTests(unittest.TestCase):
    def test_dependency_groups_drop_versions_and_arch_qualifiers(self):
        self.assertEqual(cl._dep_groups("libc6 (>= 2.38), libffi8 | libffi7:any, foo [amd64]"),
                         [["libc6"], ["libffi8", "libffi7"], ["foo"]])

    def test_stanzas_keep_continuation_lines(self):
        text = "Package: a\nDescription: x\n more\n\nPackage: b\nDepends: a\n"
        got = list(cl._parse_stanzas(text))
        self.assertEqual([s["Package"] for s in got], ["a", "b"])
        self.assertEqual(got[1]["Depends"], "a")


class ResolveTests(unittest.TestCase):
    INDEX = {
        "libglib2.0-0t64": _stanza("libglib2.0-0t64", "libc6 (>= 2.38), libffi8, libpcre2-8-0"),
        "libnss3": _stanza("libnss3", "libnspr4, libsqlite3-0"),
        "libnspr4": _stanza("libnspr4", "libc6"),
        "libsqlite3-0": _stanza("libsqlite3-0", "libc6"),
        "libffi8": _stanza("libffi8", "libc6"),
        "libpcre2-8-0": _stanza("libpcre2-8-0", "libc6"),
        "libc6": _stanza("libc6"),
        "fontconfig-config": _stanza("fontconfig-config", "fonts-dejavu-core | fonts-liberation"),
        "fonts-liberation": _stanza("fonts-liberation"),
        "fonts-dejavu-core": _stanza("fonts-dejavu-core"),
        "libgcc-s1": _stanza("libgcc-s1", provides="libgcc1"),
        "libuses-virtual": _stanza("libuses-virtual", "libgcc1"),
    }

    def _names(self, todo):
        return sorted(st["Package"] for st in todo)

    def test_only_what_the_host_lacks_is_fetched(self):
        have = {"libc6", "libffi8", "libpcre2-8-0"}
        todo, unknown = cl._resolve(["libglib2.0-0t64", "libnss3"], self.INDEX, have)
        self.assertEqual(self._names(todo),
                         ["libglib2.0-0t64", "libnspr4", "libnss3", "libsqlite3-0"])
        self.assertEqual(unknown, [])

    def test_an_alternative_already_chosen_satisfies_the_group(self):
        todo, _ = cl._resolve(["fonts-liberation", "fontconfig-config"], self.INDEX, {"libc6"})
        self.assertEqual(self._names(todo), ["fontconfig-config", "fonts-liberation"])

    def test_virtual_packages_resolve_through_provides(self):
        todo, _ = cl._resolve(["libuses-virtual"], self.INDEX, {"libc6"})
        self.assertEqual(self._names(todo), ["libgcc-s1", "libuses-virtual"])

    def test_a_t64_name_falls_back_to_the_older_spelling(self):
        index = {"libcups2": _stanza("libcups2")}
        todo, unknown = cl._resolve(["libcups2t64"], index, set())
        self.assertEqual(self._names(todo), ["libcups2"])
        self.assertEqual(unknown, [])

    def test_unknown_names_are_reported_not_fatal(self):
        todo, unknown = cl._resolve(["no-such-package"], self.INDEX, set())
        self.assertEqual(todo, [])
        self.assertEqual(unknown, ["no-such-package"])

    def test_a_runaway_closure_is_refused(self):
        index = {f"p{i}": _stanza(f"p{i}", f"p{i + 1}") for i in range(cl._MAX_PACKAGES + 5)}
        with self.assertRaises(RuntimeError):
            cl._resolve(["p0"], index, set())


class UnpackTests(unittest.TestCase):
    def test_a_deb_is_unpacked_with_its_symlinks(self):
        blob = _deb({"./usr/lib/x86_64-linux-gnu/libglib-2.0.so.0.8400.0": b"ELF"},
                    {"./usr/lib/x86_64-linux-gnu/libglib-2.0.so.0": "libglib-2.0.so.0.8400.0"})
        with tempfile.TemporaryDirectory() as dest:
            cl._unpack_deb(blob, dest)
            lib_dir = os.path.join(dest, "usr", "lib", "x86_64-linux-gnu")
            self.assertTrue(os.path.isfile(os.path.join(lib_dir, "libglib-2.0.so.0.8400.0")))
            if os.name == "posix":
                with open(os.path.join(lib_dir, "libglib-2.0.so.0"), "rb") as fh:
                    self.assertEqual(fh.read(), b"ELF")

    def test_paths_that_escape_the_target_are_skipped(self):
        blob = _deb({"../../evil": b"x", "./ok": b"y"}, {"./abs-link": "/etc/passwd",
                                                         "./up-link": "../../etc/passwd"})
        with tempfile.TemporaryDirectory() as outer:
            dest = os.path.join(outer, "d")
            os.makedirs(dest)
            cl._unpack_deb(blob, dest)
            self.assertTrue(os.path.isfile(os.path.join(dest, "ok")))
            self.assertFalse(os.path.exists(os.path.join(outer, "..", "evil")))
            self.assertFalse(os.path.lexists(os.path.join(dest, "abs-link")))
            self.assertFalse(os.path.lexists(os.path.join(dest, "up-link")))

    def test_a_non_deb_is_rejected(self):
        with tempfile.TemporaryDirectory() as dest:
            with self.assertRaises(ValueError):
                cl._unpack_deb(b"<html>mirror error</html>", dest)


class OverlayTests(unittest.TestCase):
    def test_nothing_installed_means_no_overlay(self):
        with tempfile.TemporaryDirectory() as root, \
             mock.patch.object(cl, "_root_dir", return_value=root):
            self.assertEqual(cl.env_overlay(), {})

    @unittest.skipUnless(os.name == "posix", "LD_LIBRARY_PATH is a Linux concern")
    def test_installed_libraries_are_prepended_to_the_loader_path(self):
        with tempfile.TemporaryDirectory() as root:
            lib = os.path.join(root, "usr", "lib", "x86_64-linux-gnu")
            os.makedirs(lib)
            conf = os.path.join(root, "fonts.conf")
            open(conf, "w").close()
            with open(os.path.join(root, cl._MARKER), "w") as fh:
                json.dump({"lib_dirs": [lib], "fonts_conf": conf}, fh)
            with mock.patch.object(cl, "_root_dir", return_value=root), \
                 mock.patch.dict(os.environ, {"LD_LIBRARY_PATH": "/existing"}):
                env = cl.env_overlay()
        self.assertEqual(env["LD_LIBRARY_PATH"], lib + os.pathsep + "/existing")
        self.assertEqual(env["FONTCONFIG_FILE"], conf)


class InstallGuardTests(unittest.TestCase):
    def test_a_non_debian_host_is_declined_without_network(self):
        with mock.patch.object(cl.os.path, "exists", return_value=False), \
             mock.patch.object(cl, "_fetch", side_effect=AssertionError("no network")):
            ok, msg = cl.install()
        self.assertFalse(ok)
        self.assertIn("not Debian", msg)

    def test_a_mirror_failure_is_reported_not_raised(self):
        with mock.patch.object(cl.os.path, "exists", return_value=True), \
             mock.patch.object(cl, "_os_release",
                               return_value={"ID": "debian", "VERSION_CODENAME": "trixie"}), \
             mock.patch.object(cl, "_arch", return_value="amd64"), \
             mock.patch.object(cl, "_installed", return_value=set()), \
             mock.patch.object(cl, "_fetch", side_effect=OSError("unreachable")):
            ok, msg = cl.install()
        self.assertFalse(ok)
        self.assertIn("unreachable", msg)


if __name__ == "__main__":
    unittest.main()
