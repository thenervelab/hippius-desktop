#!/usr/bin/env bash
# Build + embed + register the Finder Sync extension from source so the full
# right-click sharing feature is testable locally — including under
# `pnpm tauri:dev`.
#
# WHY A SCRIPT (and why `pnpm tauri:dev` can't do this alone): `tauri dev` runs
# the raw debug binary (`target/debug/Hippius`), NOT a `.app` bundle. A macOS
# Finder extension can only be hosted by a signed `.app` with the `.appex` in
# `Contents/PlugIns/`, registered with `pluginkit`. So this script produces a
# bundled debug `.app`, embeds + signs the extension, and registers it ONCE.
#
# After that, the extension is a standalone process Finder loads; it talks to
# whichever Hippius process is bound to `~/.hippius/finder.sock`. The app binds
# that socket on every launch and creates the directory itself
# (finder_bridge::socket::FinderBridge::start), so a subsequent `pnpm tauri:dev`
# binary binds it too — hot-reload dev then drives the SAME registered
# extension. Re-run this script only after editing the Swift extension
# (macos/HippiusFinder/*.swift); Rust/frontend changes just need
# `pnpm tauri:dev`.
#
# The extension's sandbox exceptions are restricted entitlements, honoured only
# for a properly signed binary, so a Developer ID Application identity is
# required even locally. Set APPLE_SIGNING_IDENTITY, or this script auto-detects
# the first one in your keychain.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "The Finder extension is macOS-only; nothing to do on $(uname)." >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"

# Resolve a Developer ID Application identity: explicit env wins, else the first
# one in the login keychain.
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  APPLE_SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null |
    sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -n1)"
fi
if [[ -z "${APPLE_SIGNING_IDENTITY}" ]]; then
  cat >&2 <<'EOHELP'
ERROR: no 'Developer ID Application' code-signing identity found in your keychain.

The Finder extension is sandboxed and reaches the app only through the socket
exceptions in macos/FinderSync.entitlements. Those are restricted entitlements,
which macOS honours only for a properly signed binary — ad-hoc ("-") signing cannot
carry them. (Everything EXCEPT the Finder feature still runs fine under a plain
`pnpm tauri:dev` with no cert.)

Fix with ONE of:
  • Import the shared Hippius "Developer ID Application" cert (the same .p12 CI uses
    as the APPLE_CERTIFICATE secret) into your login keychain, then re-run:
        security import Hippius-DeveloperID.p12 \
          -k ~/Library/Keychains/login.keychain-db -P '<p12-password>' -T /usr/bin/codesign
  • Or, if you already have a Team-V28B5X732P identity under a different name, point at it:
        APPLE_SIGNING_IDENTITY="Developer ID Application: … (V28B5X732P)" pnpm finder:dev

List what you currently have:  security find-identity -v -p codesigning
EOHELP
  exit 1
fi
export APPLE_SIGNING_IDENTITY
echo "Signing identity: ${APPLE_SIGNING_IDENTITY}"

echo "==> [1/4] Build the Finder extension (.appex)"
appex="$(macos/build-finder-appex.sh)"

echo "==> [2/4] Build the debug app bundle"
app="${repo_root}/src-tauri/target/debug/bundle/macos/Hippius.app"
# The bundle is signed with the identity above so the sandbox exceptions survive. The
# trailing "TAURI_SIGNING_PRIVATE_KEY" updater error is HARMLESS — the .app is
# built + signed before it fires — so success is judged by the .app existing,
# not by tauri's exit code.
set +e
pnpm tauri build --debug --bundles app
set -e
if [[ ! -d "${app}" ]]; then
  echo "ERROR: tauri build did not produce ${app}" >&2
  exit 1
fi

echo "==> [3/4] Embed + inside-out sign the extension into the app"
macos/embed-finder-extension.sh "${app}" "${appex}"

echo "==> [4/4] Register + enable the extension, reload Finder"
pluginkit -a "${app}/Contents/PlugIns/HippiusFinder.appex"
pluginkit -e use -i hippius.com.FinderSync
killall Finder 2>/dev/null || true

echo
echo "Registered:"
pluginkit -m -i hippius.com.FinderSync || true
cat <<'EONEXT'

Done. The Finder extension is registered and enabled.

Test the full feature from source:
  • pnpm tauri:dev        # hot-reload dev; the extension connects to its socket
    …or run the bundled build directly for stdout logs:
      src-tauri/target/debug/bundle/macos/Hippius.app/Contents/MacOS/Hippius

Then right-click a file/folder in Finder → "Share with Hippius (public/private)".
Re-run this script only after editing macos/HippiusFinder/*.swift.
EONEXT
