#!/usr/bin/env bash
# Embed the Hippius Finder Sync extension into a built Hippius.app and sign
# inside-out. Injecting the .appex invalidates the app's signature, so the app
# MUST be re-signed LAST (extension first, app last) or `codesign --deep
# --verify` fails. The extension's sandbox exceptions are restricted
# entitlements, which macOS honours only for a properly signed binary — so
# APPLE_SIGNING_IDENTITY must be a real Developer ID Application identity even
# for local testing, not ad-hoc ("-").
set -euo pipefail

APP_PATH="${1:?usage: embed-finder-extension.sh <Hippius.app> <HippiusFinder.appex>}"
APPEX_SRC="${2:?usage: embed-finder-extension.sh <Hippius.app> <HippiusFinder.appex>}"
IDENTITY="${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY to a Developer ID Application identity}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_entitlements="${script_dir}/../src-tauri/entitlements.plist"
ext_entitlements="${script_dir}/FinderSync.entitlements"

plugins_dir="${APP_PATH}/Contents/PlugIns"
mkdir -p "${plugins_dir}"
rm -rf "${plugins_dir}/HippiusFinder.appex"
cp -R "${APPEX_SRC}" "${plugins_dir}/HippiusFinder.appex"

# 1) Sign the extension FIRST (hardened runtime + secure timestamp + its own
#    sandboxed entitlements).
codesign --force --options runtime --timestamp \
  --entitlements "${ext_entitlements}" \
  --sign "${IDENTITY}" \
  "${plugins_dir}/HippiusFinder.appex"

# 2) Re-sign the whole app LAST so the freshly added PlugIns dir is re-sealed.
codesign --force --options runtime --timestamp \
  --entitlements "${app_entitlements}" \
  --sign "${IDENTITY}" \
  "${APP_PATH}"

# 3) Verify the nested signature and that the sandbox exceptions survived
#    signing. Without them the extension loads but can never open the bridge
#    socket, so every right-click silently falls back to "Open Hippius to
#    share" — a failure with no error anywhere.
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
# `:-` dumps the raw entitlements plist to stdout; a plain `-` prints the
# abbreviated human-readable form instead. Match on `hippius/finder` rather than
# the full socket path: the SBPL rules are regexes, so the signed blob carries
# the escaped `\.hippius/finder\.sock`, which no literal path match can find.
ext_signed="$(codesign -d --entitlements :- "${plugins_dir}/HippiusFinder.appex" 2>/dev/null | tr -d '\000')"
if [[ "${ext_signed}" != *"hippius/finder"* ]]; then
  echo "ERROR: socket sandbox exception missing from the signed extension" >&2
  exit 1
fi
# The app group is what raised a TCC prompt on every launch; it must not return
# through a stray edit to either entitlements file.
if [[ "${ext_signed}" == *"application-groups"* ]]; then
  echo "ERROR: the extension claims an App Group again; see macos/FinderSync.entitlements" >&2
  exit 1
fi

echo "embed + sign OK"
