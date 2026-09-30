#!/usr/bin/env bash
# Build the HippiusCapture ScreenCaptureKit helper.
#
#   build-capture-helper.sh              host-arch build for development
#   build-capture-helper.sh --universal  arm64 + x86_64 release build (CI)
#
# Prints the built binary's path on stdout (logs go to stderr), so a caller
# can do HELPER="$(macos/build-capture-helper.sh --universal)".
#
# Dev: a debug `pnpm tauri:dev` finds the product under
# macos/HippiusCapture/.build/ on its own (recording/macos.rs). It is also
# copied beside the cargo target's binaries, which is where a shipped app
# keeps it (Contents/MacOS).
#
# Release: the app does NOT get the helper from Tauri. finalize-macos-release.sh
# builds it universal, embeds and signs it with its own entitlements
# (embed-capture-helper.sh), then re-signs the app. A release build of the app
# looks for the helper only beside its own binary, so an app without it
# offers no recording at all.
set -euo pipefail

universal=0
case "${1:-}" in
  --universal) universal=1 ;;
  "") ;;
  *) echo "usage: $0 [--universal]" >&2; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_dir="${script_dir}/HippiusCapture"
repo_root="$(cd "${script_dir}/.." && pwd)"

cd "${pkg_dir}"
arch_flags=()
if ((universal)); then
  arch_flags=(--arch arm64 --arch x86_64)
fi
swift build -c release ${arch_flags[@]+"${arch_flags[@]}"} >&2
# Asked, not assumed: a multi-arch build lands under .build/apple/ or
# .build/out/ depending on the SwiftPM version.
bin_dir="$(swift build -c release ${arch_flags[@]+"${arch_flags[@]}"} --show-bin-path)"
built="${bin_dir}/HippiusCapture"

if [[ ! -f "${built}" ]]; then
  echo "ERROR: swift build did not produce ${built}" >&2
  exit 1
fi

if ((universal)); then
  # A thin helper in a universal app records on half the fleet and silently
  # offers nothing on the other half.
  arches="$(lipo -archs "${built}")"
  if [[ "${arches}" != *arm64* || "${arches}" != *x86_64* ]]; then
    echo "ERROR: ${built} is '${arches}', not universal" >&2
    exit 1
  fi
  echo "built universal helper (${arches})" >&2
else
  # Best effort: beside the cargo target's binaries, where a shipped app
  # keeps it. Honours a shared CARGO_TARGET_DIR.
  target_root="${CARGO_TARGET_DIR:-${repo_root}/src-tauri/target}"
  for profile in debug release; do
    dest_dir="${target_root}/${profile}"
    if [[ -d "${dest_dir}" ]]; then
      cp -f "${built}" "${dest_dir}/HippiusCapture"
      chmod +x "${dest_dir}/HippiusCapture"
      echo "copied helper to ${dest_dir}/HippiusCapture" >&2
    fi
  done
fi

echo "${built}"
