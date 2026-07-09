"""Nautilus (GNOME Files) extension: a top-level "Share with Hippius" menu item.

This is the GNOME analog of the macOS `.appex` / Windows COM DLL — an OS-loaded
file-manager extension (not a separate binary we run) that forwards the selected
path to the already-running app via the ONE main binary's `--finder-share` CLI
mode. The `.deb` ships it system-wide at
`/usr/share/nautilus-python/extensions/`, so every GNOME user gets a real
TOP-LEVEL menu item with no per-user setup — unlike the `~/.local/.../scripts/`
fallback, which only the installing user gets and which Nautilus buries under a
"Scripts" submenu.

Requires the `python3-nautilus` runtime (declared as a `.deb` Depends). After
install, restart Files (`nautilus -q`) or log out/in once so Nautilus loads it.
"""
import os
import subprocess

import gi

# Nautilus 43+ (GTK4, e.g. Ubuntu 23.10+) exposes the 4.0 typelib; older
# releases (GTK3, e.g. Ubuntu 22.04) expose 3.0. Require the newest available so
# one file works on both.
try:
    gi.require_version("Nautilus", "4.0")
except ValueError:
    gi.require_version("Nautilus", "3.0")

from gi.repository import GObject, Nautilus  # noqa: E402  (must follow require_version)

# The `.deb` installs the main binary here; fall back to the PATH name for other
# layouts. Same executable, second mode — no separate helper (the one-binary rule).
_BINARY = "/usr/bin/Hippius" if os.path.exists("/usr/bin/Hippius") else "Hippius"


class HippiusShareExtension(GObject.GObject, Nautilus.MenuProvider):
    """Adds a single top-level "Share with Hippius" item to the file menu."""

    def _on_activate(self, _menu_item, files):
        # One share per selected path, mirroring the other file managers'
        # per-file invocation. Popen (not run) so the menu returns immediately;
        # the CLI mode writes SHARE:<path> to the bridge socket and exits.
        for file_info in files:
            path = file_info.get_location().get_path()
            if path:
                subprocess.Popen([_BINARY, "--finder-share", path])

    def get_file_items(self, *args):
        # nautilus-python 4.0 dropped the leading `window` arg
        # (get_file_items(self, files)); 3.0 keeps it
        # (get_file_items(self, window, files)). `files` is always the last arg.
        files = args[-1]
        if not files:
            return []
        item = Nautilus.MenuItem(
            name="HippiusShareExtension::share",
            label="Share with Hippius",
            tip="Create a Hippius share link for the selection",
        )
        item.connect("activate", self._on_activate, files)
        return [item]
