#!/usr/bin/env bash
# Turn a Tauri-built (extension-less) Hippius.app into a shippable, notarized
# release that CONTAINS the Finder Sync extension.
#
# WHY THIS EXISTS (and why Tauri can't do it alone): Tauri v2 re-signs every
# nested bundle it detects using the app's single `entitlements.plist`. A Finder
# extension MUST be sandboxed (`app-sandbox=true`) with its own App-Group
# entitlement — signing it with the non-sandboxed app entitlements produces an
# extension macOS refuses to load. So the extension can't be present while Tauri
# signs; it is embedded + inside-out re-signed AFTER Tauri finishes, which
# invalidates Tauri's signature/notarization/DMG. This script therefore re-owns
# the tail of the pipeline: embed → re-sign → notarize → DMG → updater artifact.
#
# Order is load-bearing (inside-out, then seal): the extension is signed first
# and the outer app last (embed-finder-extension.sh), then notarization staples
# the sealed app, then the DMG and updater tarball are built FROM the stapled app.
#
# Usage: finalize-macos-release.sh <Hippius.app> <output-dir>
# Required env:
#   APPLE_SIGNING_IDENTITY            Developer ID Application identity
#   APPLE_API_KEY / _ISSUER / _PATH   App Store Connect key for notarytool
#   TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]  minisign key for the updater .sig
set -euo pipefail

APP_PATH="${1:?usage: finalize-macos-release.sh <Hippius.app> <output-dir>}"
OUT_DIR="${2:?usage: finalize-macos-release.sh <Hippius.app> <output-dir>}"
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
: "${APPLE_API_KEY:?set APPLE_API_KEY (App Store Connect key id)}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"
: "${APPLE_API_KEY_PATH:?set APPLE_API_KEY_PATH (path to the .p8)}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${OUT_DIR}"

notarize() {
  # Submit an artifact (.zip / .dmg) and block until Apple returns a verdict;
  # --wait makes a rejected build fail the job instead of shipping un-notarized.
  local artifact="$1"
  xcrun notarytool submit "${artifact}" \
    --key "${APPLE_API_KEY_PATH}" \
    --key-id "${APPLE_API_KEY}" \
    --issuer "${APPLE_API_ISSUER}" \
    --wait
}

echo "==> [1/5] Build the universal Finder extension"
APPEX="$("${script_dir}/build-finder-appex.sh")"

echo "==> [2/5] Embed + inside-out re-sign into ${APP_PATH}"
"${script_dir}/embed-finder-extension.sh" "${APP_PATH}" "${APPEX}"

echo "==> [3/5] Notarize + staple the app"
# notarytool takes an archive, not a bare .app; a ditto zip preserves the
# signature and symlinks. The staple is applied to the .app itself so Gatekeeper
# accepts it once copied out of the DMG.
app_zip="${OUT_DIR}/Hippius-notarize.zip"
/usr/bin/ditto -c -k --keepParent "${APP_PATH}" "${app_zip}"
notarize "${app_zip}"
xcrun stapler staple "${APP_PATH}"
rm -f "${app_zip}"

echo "==> [4/5] Regenerate + sign the updater tarball from the stapled app"
# The updater serves a gzipped .app; it MUST be rebuilt from the embedded app or
# auto-updates would strip the extension. The .sig is a minisign signature the
# updater verifies against the pubkey in tauri.conf.json.
app_dir="$(dirname "${APP_PATH}")"
app_name="$(basename "${APP_PATH}")"
tarball="${OUT_DIR}/Hippius.app.tar.gz"
tar -C "${app_dir}" -czf "${tarball}" "${app_name}"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  # `tauri signer sign` writes <tarball>.sig next to the input.
  pnpm tauri signer sign \
    --private-key "${TAURI_SIGNING_PRIVATE_KEY}" \
    ${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:+--password "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD}"} \
    "${tarball}"
else
  echo "WARN: TAURI_SIGNING_PRIVATE_KEY unset — updater .sig NOT produced." >&2
fi

echo "==> [5/5] Build, sign, notarize + staple the DMG"
# create-dmg gives the standard drag-to-Applications layout users expect.
dmg="${OUT_DIR}/Hippius_universal.dmg"
rm -f "${dmg}"
create-dmg \
  --volname "Hippius" \
  --app-drop-link 480 170 \
  --icon "${app_name}" 140 170 \
  --window-size 640 360 \
  "${dmg}" \
  "${APP_PATH}"
codesign --force --timestamp --sign "${APPLE_SIGNING_IDENTITY}" "${dmg}"
notarize "${dmg}"
xcrun stapler staple "${dmg}"

echo "==> DONE. Artifacts in ${OUT_DIR}:"
ls -1 "${OUT_DIR}"
