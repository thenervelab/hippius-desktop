#!/usr/bin/env bash
# Embed the Hippius Finder Sync extension into a built Hippius.app and sign
# inside-out. Injecting the .appex invalidates the app's signature, so the app
# MUST be re-signed LAST (extension first, app last) or `codesign --deep
# --verify` fails. App Groups need a real Team ID — ad-hoc ("-") signing will
# not grant the shared container, so APPLE_SIGNING_IDENTITY must be a real
# Developer ID Application identity even for local testing.
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

# 3) Verify the nested signature and that the App Group survived signing.
codesign --verify --deep --strict --verbose=2 "${APP_PATH}"
if ! codesign -d --entitlements - "${plugins_dir}/HippiusFinder.appex" 2>/dev/null | grep -q "com.hippius.shared"; then
  echo "ERROR: App Group entitlement missing from the signed extension" >&2
  exit 1
fi

echo "embed + sign OK"
