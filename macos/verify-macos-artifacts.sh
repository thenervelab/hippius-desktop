#!/usr/bin/env bash
# Open the finalized macOS artifacts and assert they are what the release claims
# to ship: Finder extension embedded, notarized, stapled, and signed with the key
# installed builds verify against.
#
# WHY THIS EXISTS. Every failure below is SILENT at build time.
# finalize-macos-release.sh reports success whether or not the extension made it
# in; a manifest pointing at an extension-less tarball is valid JSON carrying a
# valid signature; an update built that way installs cleanly and Gatekeeper never
# speaks up because the DMG beside it is fine. v0.5.0 shipped exactly that and it
# surfaced as "Share with Hippius disappeared", days later, from a user. The only
# way to know is to open the artifact — so the release lanes open it, here,
# before anything is published.
#
# Note what is NOT sufficient: `codesign --verify --deep --strict` PASSES on the
# extension-less build. It was validly signed, just never notarized or stapled
# and missing a bundle nobody signed. The load-bearing checks are the appex
# presence, `stapler validate` and `spctl --assess`.
#
# Usage: verify-macos-artifacts.sh <dir> <expected-version>
#   <dir> holds Hippius.app.tar.gz, Hippius.app.tar.gz.sig and one .dmg
#
# Requires minisign (brew install minisign) and a repo checkout, so the committed
# updater pubkey can be read out of src-tauri/tauri.conf.json.
set -euo pipefail

DIR="${1:?usage: verify-macos-artifacts.sh <dir> <expected-version>}"
EXPECTED_VERSION="${2:?usage: verify-macos-artifacts.sh <dir> <expected-version>}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

# The App Group the extension must carry, from the same file the build reads.
# Hardcoding it here would let the two drift into an extension macOS refuses to
# load while this script still reported success.
# shellcheck source=macos/group.env
source "${script_dir}/group.env"

TARBALL="${DIR}/Hippius.app.tar.gz"
SIGNATURE="${TARBALL}.sig"

# The pre-finalize `--bundles app` artifact. tauri-action uploads it under this
# name before the extension is embedded; it must never reach a release, and it
# must never be what this script was pointed at.
STALE_TARBALL="${DIR}/Hippius_universal.app.tar.gz"

problems=0
work="$(mktemp -d)"
mount_point="${work}/mnt"

cleanup() {
  # Detaching a DMG that was never attached is not an error worth reporting.
  if [[ -d "${mount_point}" ]]; then
    hdiutil detach "${mount_point}" -quiet 2>/dev/null || true
  fi
  rm -rf "${work}"
}
trap cleanup EXIT

# A GitHub Actions error annotation so the failure is readable from the run
# summary, not only from a scrolled log.
fail() {
  echo "::error title=macOS release verification::$1" >&2
  problems=$((problems + 1))
}

ok() {
  echo "  ok: $1"
}

# ---------------------------------------------------------------------------
# The checks that apply to any .app, wherever it came from — the updater's
# tarball and the DMG's copy must both pass, because users get one of each and
# the two are built by different steps.
# ---------------------------------------------------------------------------
check_app_bundle() {
  local app="$1" label="$2"
  local appex="${app}/Contents/PlugIns/HippiusFinder.appex"

  if [[ ! -d "${appex}" ]]; then
    fail "${label}: no HippiusFinder.appex in Contents/PlugIns — this build has NO Finder extension"
    return
  fi
  ok "${label}: Finder extension embedded"

  local arches
  arches="$(lipo -archs "${appex}/Contents/MacOS/HippiusFinder" 2>/dev/null || echo "")"
  if [[ "${arches}" != *x86_64* || "${arches}" != *arm64* ]]; then
    fail "${label}: the extension is '${arches}', not universal — it cannot load on the other arch"
  else
    ok "${label}: extension is universal (${arches})"
  fi

  # Signed with the app's non-sandboxed entitlements the extension loads on no
  # Mac at all, which is the failure Tauri's own nested re-signing would cause.
  local entitlements
  entitlements="$(codesign -d --entitlements :- "${appex}" 2>/dev/null | tr -d '\000')"
  if [[ "${entitlements}" != *"com.apple.security.app-sandbox"* ]]; then
    fail "${label}: the extension is not sandboxed; macOS will refuse to load it"
  elif [[ "${entitlements}" != *"${HIPPIUS_APP_GROUP}"* ]]; then
    fail "${label}: the extension lacks App Group ${HIPPIUS_APP_GROUP}; it cannot reach the app"
  else
    ok "${label}: extension entitlements carry the sandbox + ${HIPPIUS_APP_GROUP}"
  fi

  if ! xcrun stapler validate "${app}" >/dev/null 2>&1; then
    fail "${label}: no notarization ticket stapled — first launch needs a network round trip, \
and fails outright offline"
  else
    ok "${label}: notarization ticket stapled"
  fi

  # The check that would have caught v0.5.0. `spctl` answers the question
  # Gatekeeper will ask on the user's Mac, and answers it offline thanks to the
  # staple above.
  local assessment
  assessment="$(spctl --assess -vv --type exec "${app}" 2>&1 || true)"
  if [[ "${assessment}" != *"accepted"* || "${assessment}" != *"Notarized Developer ID"* ]]; then
    fail "${label}: Gatekeeper rejects this build: ${assessment//$'\n'/ }"
  else
    ok "${label}: Gatekeeper accepts it as a Notarized Developer ID build"
  fi

  local version
  version="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "${app}/Contents/Info.plist" 2>/dev/null || echo "")"
  if [[ "${version}" != "${EXPECTED_VERSION}" ]]; then
    fail "${label}: reports version '${version}', release is ${EXPECTED_VERSION} — \
the artifact came from a different build than the tag"
  else
    ok "${label}: reports version ${version}"
  fi
}

# ---------------------------------------------------------------------------
# The updater payload.
# ---------------------------------------------------------------------------
check_updater_tarball() {
  echo "== updater tarball"

  if [[ ! -s "${TARBALL}" ]]; then
    fail "no Hippius.app.tar.gz in ${DIR} — macOS would have no update payload"
    return
  fi
  if [[ -e "${STALE_TARBALL}" ]]; then
    fail "Hippius_universal.app.tar.gz is present; that is tauri-action's pre-finalize build, \
which carries no Finder extension and was never notarized"
  fi

  tar -xzf "${TARBALL}" -C "${work}"
  check_app_bundle "${work}/Hippius.app" "tarball"
}

# The updater refuses a payload it cannot verify against the pubkey COMPILED
# INTO the installed build, and reports that refusal as "no update available".
# Verifying against the committed pubkey here is the only point at which a
# signing-key mismatch is still recoverable: once a build ships with the wrong
# key, no later release can reach it.
check_updater_signature() {
  echo "== updater signature"

  if [[ ! -s "${SIGNATURE}" ]]; then
    fail "no Hippius.app.tar.gz.sig — latest.json would offer an update nothing can verify"
    return
  fi
  if ! command -v minisign >/dev/null 2>&1; then
    fail "minisign not installed; cannot verify the updater signature (brew install minisign)"
    return
  fi

  local pubkey="${work}/updater.pub" sig="${work}/updater.minisig"
  jq -r '.plugins.updater.pubkey' "${repo_root}/src-tauri/tauri.conf.json" |
    base64 --decode >"${pubkey}"
  base64 --decode <"${SIGNATURE}" >"${sig}"

  if ! minisign -V -p "${pubkey}" -x "${sig}" -m "${TARBALL}" >/dev/null 2>&1; then
    fail "the updater signature does not verify against the pubkey in tauri.conf.json — \
every installed build would reject this update as unsigned"
  else
    ok "signature verifies against the committed updater pubkey"
  fi
}

# ---------------------------------------------------------------------------
# What a manual download gets. Built by a separate step from the tarball, so it
# is verified separately rather than assumed to match.
# ---------------------------------------------------------------------------
check_dmg() {
  echo "== DMG"

  local dmg
  dmg="$(find "${DIR}" -maxdepth 1 -name '*.dmg' | head -1)"
  if [[ -z "${dmg}" ]]; then
    fail "no .dmg in ${DIR} — there is nothing for a manual install"
    return
  fi

  if ! xcrun stapler validate "${dmg}" >/dev/null 2>&1; then
    fail "DMG: no notarization ticket stapled to the disk image itself"
  else
    ok "DMG: notarization ticket stapled"
  fi

  # An explicit mountpoint, not /Volumes: a stale mount of the same volume name
  # sends the checks to /Volumes/Hippius 1 while they read /Volumes/Hippius.
  mkdir -p "${mount_point}"
  if ! hdiutil attach "${dmg}" -nobrowse -readonly -mountpoint "${mount_point}" >/dev/null; then
    fail "DMG: cannot be mounted"
    return
  fi

  check_app_bundle "${mount_point}/Hippius.app" "DMG"
  hdiutil detach "${mount_point}" -quiet
}

echo "Verifying macOS release artifacts in ${DIR} (expecting version ${EXPECTED_VERSION})"
check_updater_tarball
check_updater_signature
check_dmg

if ((problems > 0)); then
  echo
  echo "FAILED: ${problems} problem(s). This build must not be published." >&2
  exit 1
fi

echo
echo "All macOS release artifacts verified."
