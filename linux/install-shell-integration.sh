#!/usr/bin/env bash
# Install the Hippius "Share with Hippius" file-manager integration into the
# current user's config dirs. Used for AppImage (first-run) and manual installs;
# the .deb/rpm drop the same files into system dirs from their postinst instead.
#
# Idempotent: safe to re-run. Covers Nautilus (GNOME), Caja (MATE), Dolphin
# (KDE), Nemo (Cinnamon), and Thunar (XFCE, merged into its single uca.xml).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

install_exec() { # src dst_dir
	mkdir -p "$2"
	install -m 0755 "$1" "$2/"
}
install_file() { # src dst_dir
	mkdir -p "$2"
	install -m 0644 "$1" "$2/"
}

# GNOME Files / MATE Caja: executable scripts (menu label = filename).
install_exec "$here/nautilus/Share with Hippius" "$data_home/nautilus/scripts"
install_exec "$here/caja/Share with Hippius" "$config_home/caja/scripts"

# KDE Dolphin ServiceMenu: must be executable to be authorized (KF >= 5.85 path).
install_exec "$here/servicemenus/hippius-share.desktop" "$data_home/kio/servicemenus"

# Cinnamon Nemo action.
install_file "$here/nemo/hippius-share.nemo_action" "$data_home/nemo/actions"

# XFCE Thunar: merge the <action> into the single uca.xml (never clobber the
# user's other actions). Skip if our unique-id is already present.
thunar_uca="$config_home/Thunar/uca.xml"
if [ -f "$thunar_uca" ] && grep -q "hippius-share-1" "$thunar_uca"; then
	echo "Thunar: Hippius action already present, skipping."
elif command -v xmlstarlet >/dev/null 2>&1 && [ -f "$thunar_uca" ]; then
	# Insert our <action> before the closing </actions>.
	snippet="$(sed -e '/^<!--/,/-->/d' "$here/thunar/uca-snippet.xml")"
	tmp="$(mktemp)"
	awk -v snip="$snippet" '/<\/actions>/{print snip} {print}' "$thunar_uca" >"$tmp"
	mv "$tmp" "$thunar_uca"
	echo "Thunar: merged Hippius action into $thunar_uca"
else
	mkdir -p "$(dirname "$thunar_uca")"
	if [ ! -f "$thunar_uca" ]; then
		# Fresh file: wrap our action in an <actions> root.
		{
			echo '<?xml version="1.0" encoding="UTF-8"?>'
			echo '<actions>'
			sed -e '/^<!--/,/-->/d' "$here/thunar/uca-snippet.xml"
			echo '</actions>'
		} >"$thunar_uca"
		echo "Thunar: created $thunar_uca with the Hippius action"
	else
		echo "Thunar: uca.xml exists and xmlstarlet is unavailable; add the action from"
		echo "        $here/thunar/uca-snippet.xml manually, or via Thunar > Edit > Configure custom actions."
	fi
fi

echo "Done. Restart the file manager (or log out/in) if the menu item does not appear immediately."
