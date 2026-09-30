#!/usr/bin/env bash
# Put HippiusCapture into a built Hippius.app as Contents/MacOS/HippiusCapture
# and sign it: hardened runtime, secure timestamp, its own entitlements
# (macos/CaptureHelper.entitlements). A release build of the app looks for
# the helper only there; without it no recording is offered.
#
# Usage: embed-capture-helper.sh <Hippius.app> [helper-binary]
#   helper-binary defaults to a fresh universal build.
#
# Adding a file to Contents/MacOS breaks the app's seal, so the APP must be
# re-signed afterwards, inside-out: finalize-macos-release.sh runs this
# before embed-finder-extension.sh, which signs the app last. With
# APPLE_SIGNING_IDENTITY unset or "-" the helper is signed ad hoc (local
# testing only; such an app cannot be notarized).
set -euo pipefail

APP_PATH="${1:?usage: embed-capture-helper.sh <Hippius.app> [helper-binary]}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entitlements="${script_dir}/CaptureHelper.entitlements"

helper="${2:-}"
if [[ -z "${helper}" ]]; then
  helper="$("${script_dir}/build-capture-helper.sh" --universal)"
fi
if [[ ! -f "${helper}" ]]; then
  echo "ERROR: no helper binary at ${helper}" >&2
  exit 1
fi

dest="${APP_PATH}/Contents/MacOS/HippiusCapture"
cp -f "${helper}" "${dest}"
chmod +x "${dest}"
echo "embedded ${dest}" >&2

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "${identity}" && "${identity}" != "-" ]]; then
  # Notarization rejects an executable without a secure timestamp or without
  # the hardened runtime.
  codesign --force --options runtime --timestamp \
    --entitlements "${entitlements}" \
    --identifier "hippius.com.HippiusCapture" \
    --sign "${identity}" \
    "${dest}"
  echo "signed HippiusCapture with ${identity}" >&2
else
  codesign --force --options runtime \
    --entitlements "${entitlements}" \
    --identifier "hippius.com.HippiusCapture" \
    --sign - \
    "${dest}"
  echo "WARN: APPLE_SIGNING_IDENTITY unset; HippiusCapture signed ad hoc" >&2
fi

# The entitlement is the silent one: a helper signed without it records a
# silent microphone track in every signed build.
signed="$(codesign -d --entitlements :- "${dest}" 2>/dev/null | tr -d '\000')"
if [[ "${signed}" != *"com.apple.security.device.audio-input"* ]]; then
  echo "ERROR: the signed helper lacks com.apple.security.device.audio-input" >&2
  exit 1
fi
codesign --verify --strict --verbose=2 "${dest}"
echo "helper embed + sign OK" >&2
