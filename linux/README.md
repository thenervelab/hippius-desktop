# Linux file-manager "Share with Hippius" integration

Right-click a file or folder in your Linux file manager → **Share with Hippius**.
This mirrors the macOS Finder Sync feature, using the same backend: each action
invokes the **main Hippius binary** in its `--finder-share <path>` CLI mode (no
separate helper binary — the one-binary requirement), which forwards the clicked
path to the running app over the bridge Unix socket. See
[`docs/plans/2026-07-08-cross-platform-finder-share-design.md`](../docs/plans/2026-07-08-cross-platform-finder-share-design.md).

## What's here

| File | File manager | Installed to (per-user) |
|---|---|---|
| `nautilus/Share with Hippius` | GNOME Files (Nautilus) | `~/.local/share/nautilus/scripts/` (executable) |
| `caja/Share with Hippius` | MATE (Caja) | `~/.config/caja/scripts/` (executable) |
| `servicemenus/hippius-share.desktop` | KDE (Dolphin) | `~/.local/share/kio/servicemenus/` (executable) |
| `nemo/hippius-share.nemo_action` | Cinnamon (Nemo) | `~/.local/share/nemo/actions/` |
| `thunar/uca-snippet.xml` | XFCE (Thunar) | merged into `~/.config/Thunar/uca.xml` |

There is **no cross-desktop standard** for file-manager context menus, so each
desktop needs its own small declarative file. All of them shell out to the same
`Hippius --finder-share` command. Nautilus/Caja use **scripts** rather than a
`nautilus-python` extension because Nautilus 43+/GTK4 broke the python extension
ABI while standalone scripts are unaffected.

## Installing

- **`.deb` / rpm (primary):** the package postinst drops these into the system
  dirs (`/usr/share/nautilus/scripts`, `/usr/share/kio/servicemenus`,
  `/usr/share/nemo/actions`, …) and installs the `Hippius` binary on `PATH`.
- **AppImage / manual:** run [`install-shell-integration.sh`](install-shell-integration.sh),
  which copies the files into your per-user config dirs (and idempotently merges
  the Thunar action). Re-runnable; safe to run again after an update.

After install, restart the file manager (or log out/in) if the item doesn't
appear immediately. Dolphin re-reads service menus on change; Nautilus/Caja pick
up new scripts on the next window.

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
