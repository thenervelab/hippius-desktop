#!/usr/bin/env bash
# Copy HippiusCapture into a built Hippius.app's Contents/MacOS/ and re-sign
# if an identity is available. Run after `tauri build` (or from the finalize
# pipeline) so the helper is next to the main binary for current_exe() lookup.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${script_dir}/HippiusCapture/.build/release/HippiusCapture"

if [[ ! -f "${helper}" ]]; then
  "${script_dir}/build-capture-helper.sh" >/dev/null
fi

app_path="${1:-}"
if [[ -z "${app_path}" ]]; then
  echo "usage: $0 /path/to/Hippius.app" >&2
  exit 1
fi
dest="${app_path}/Contents/MacOS/HippiusCapture"
cp -f "${helper}" "${dest}"
chmod +x "${dest}"
echo "embedded ${dest}" >&2

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "${identity}" && "${identity}" != "-" ]]; then
  codesign --force --options runtime --sign "${identity}" "${dest}" >&2
  echo "signed HippiusCapture with ${identity}" >&2
fi
