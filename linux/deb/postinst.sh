#!/bin/sh
# Debian post-install for Hippius: make the shell-integration files executable.
#
# tauri's deb `files` install with 0644, but a Dolphin ServiceMenu must be
# executable to be authorized, and the per-user installer script needs +x. The
# system-wide Dolphin + Nemo entries work immediately; GNOME/XFCE/MATE users run
# /usr/share/hippius/shell-integration/install-shell-integration.sh once (their
# action files are per-user, not system-wide).
set -eu

chmod 0755 /usr/share/kio/servicemenus/hippius-share.desktop 2>/dev/null || true
chmod 0755 /usr/share/hippius/shell-integration/install-shell-integration.sh 2>/dev/null || true
chmod 0755 "/usr/share/hippius/shell-integration/nautilus/Share with Hippius" 2>/dev/null || true
chmod 0755 "/usr/share/hippius/shell-integration/caja/Share with Hippius" 2>/dev/null || true

exit 0
