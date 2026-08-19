# Linux file-manager "Share with Hippius" integration

Right-click a file or folder in your Linux file manager → **Share with Hippius**.
This mirrors the macOS Finder Sync feature, using the same backend: each action
invokes the **main Hippius binary** in its `--finder-share <path>` CLI mode (no
separate helper binary — the one-binary requirement), which forwards the clicked
path to the running app over the bridge Unix socket. See
[`docs/plans/2026-07-08-cross-platform-finder-share-design.md`](../docs/plans/2026-07-08-cross-platform-finder-share-design.md).

## What's here

| File | File manager | How the `.deb` installs it |
|---|---|---|
| `nautilus-python/hippius-share.py` | GNOME Files (Nautilus) | **system-wide** `/usr/share/nautilus-python/extensions/` — a real top-level item, all users |
| `servicemenus/hippius-share.desktop` | KDE (Dolphin) | **system-wide** `/usr/share/kio/servicemenus/` |
| `nemo/hippius-share.nemo_action` | Cinnamon (Nemo) | **system-wide** `/usr/share/nemo/actions/` |
| `nautilus/Share with Hippius` | GNOME Files (Nautilus) — fallback | per-user `~/.local/share/nautilus/scripts/` via the manual installer |
| `caja/Share with Hippius` | MATE (Caja) | per-user `~/.config/caja/scripts/` via the manual installer |
| `thunar/uca-snippet.xml` | XFCE (Thunar) | merged into `~/.config/Thunar/uca.xml` via the manual installer |

There is **no cross-desktop standard** for file-manager context menus, so each
desktop needs its own small declarative file. All of them run the same
`Hippius --finder-share` command.

**GNOME (Ubuntu's default) uses a `nautilus-python` extension**, not a script:
it is installed system-wide by the `.deb`, gives a real **top-level** "Share with
Hippius" item (a script would appear only under the "Scripts" submenu and only
for the installing user), and works on both Nautilus 3.x/GTK3 (Ubuntu 22.04) and
4.x/GTK4 (Ubuntu 23.10+) via a version-agnostic `get_file_items`. It needs the
`python3-nautilus` runtime, declared as a `.deb` `depends`. The per-user
`nautilus/…` script stays as a fallback (AppImage, or hosts without
`python3-nautilus`).

## Installing

- **`.deb` (primary):** the package installs the GNOME extension + the Dolphin
  and Nemo entries into the system dirs, pulls in `python3-nautilus`, and puts
  the `Hippius` binary on `PATH` — **no per-user step for GNOME/KDE/Cinnamon**.
  MATE/XFCE users run the manual installer below.
- **AppImage / manual / MATE / XFCE:** run
  [`install-shell-integration.sh`](install-shell-integration.sh), which copies
  the per-user files into your config dirs (and idempotently merges the Thunar
  action). Re-runnable; safe to run again after an update.

After install, **restart the file manager** (`nautilus -q`, or log out/in) so it
loads the new extension/menu. Dolphin re-reads service menus on change.

## Flatpak / Snap: not supported

A **Flatpak** (or Snap) build **cannot** install a host file-manager extension —
the sandbox has no export point for the host's Nautilus/Dolphin/etc., and the
file managers run on the host outside the sandbox. This is a long-standing
platform limitation that also affects the Nextcloud and Dropbox Flatpaks. Users
who need the right-click integration should install the **native `.deb`/rpm**;
the rest of the app still works under Flatpak.

## Requirements

- The `Hippius` binary must be on `PATH` (the `.deb`/rpm handles this). For a
  non-standard install, edit the `Exec=`/command lines to an absolute path.
- The app does not need to be running when you click: the CLI mode launches it
  and retries for ~10s, so the click still lands.
