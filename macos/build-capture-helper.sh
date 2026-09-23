#!/usr/bin/env bash
# Build the HippiusCapture ScreenCaptureKit helper and stage it for Tauri.
#
# Dev: places a host-arch binary at
#   macos/HippiusCapture/.build/release/HippiusCapture
# and copies it next to the most recent cargo target so `tauri:dev` finds it.
#
# Release: also writes the Tauri externalBin name under
#   src-tauri/binaries/HippiusCapture-<triple>
# so `tauri build` embeds it in Contents/MacOS/.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg_dir="${script_dir}/HippiusCapture"
repo_root="$(cd "${script_dir}/.." && pwd)"
bin_dir="${repo_root}/src-tauri/binaries"

cd "${pkg_dir}"
swift build -c release >&2

built="${pkg_dir}/.build/release/HippiusCapture"
if [[ ! -f "${built}" ]]; then
  echo "ERROR: swift build did not produce ${built}" >&2
  exit 1
fi

arch="$(uname -m)"
case "${arch}" in
  arm64) triple="aarch64-apple-darwin" ;;
  x86_64) triple="x86_64-apple-darwin" ;;
  *) echo "ERROR: unsupported arch ${arch}" >&2; exit 1 ;;
esac

mkdir -p "${bin_dir}"
staged="${bin_dir}/HippiusCapture-${triple}"
cp -f "${built}" "${staged}"
chmod +x "${staged}"
echo "staged ${staged}" >&2

# Best-effort: copy next to debug/release cargo targets so current_exe()'s
# sibling lookup works during `pnpm tauri:dev` without a full bundle.
for target in debug release; do
  dest_dir="${repo_root}/src-tauri/target/${target}"
  if [[ -d "${dest_dir}" ]]; then
    cp -f "${built}" "${dest_dir}/HippiusCapture"
    chmod +x "${dest_dir}/HippiusCapture"
    echo "copied helper → ${dest_dir}/HippiusCapture" >&2
  fi
done

echo "${built}"
