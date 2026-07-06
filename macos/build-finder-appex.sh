#!/usr/bin/env bash
# Build the Hippius Finder Sync extension as a UNIVERSAL (arm64 + x86_64) .appex.
#
# A release Hippius.app is `--target universal-apple-darwin`, so the embedded
# extension must be universal too — a host-arch-only .appex would fail to load
# on the other architecture (e.g. an Intel Mac running an arm64-only extension).
# The local build/load playbook builds host-arch only, which is fine for a dev
# smoke test but wrong for a shipped release; this script is the release variant.
#
# It does NOT sign — signing + embedding is macos/embed-finder-extension.sh,
# which must run AFTER the host app exists so the whole bundle can be re-sealed
# inside-out. Output: an unsigned universal .appex whose path is printed on the
# last stdout line so a caller can capture it.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
proj_dir="${script_dir}/HippiusFinder"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "ERROR: xcodegen not found. Install with 'brew install xcodegen'." >&2
  exit 1
fi

cd "${proj_dir}"

# Regenerate the .xcodeproj from project.yml (it is gitignored) so the build is
# reproducible from a clean checkout. Progress goes to stderr so the ONLY thing
# on stdout is the final artifact path a caller captures.
xcodegen generate >&2

# ONLY_ACTIVE_ARCH=NO + explicit ARCHS forces a fat binary regardless of the
# runner's native slice; CODE_SIGNING_ALLOWED=NO because embed-finder-extension.sh
# owns signing with the real Developer ID identity and per-bundle entitlements.
xcodebuild \
  -project HippiusFinder.xcodeproj \
  -scheme HippiusFinder \
  -configuration Release \
  -derivedDataPath build \
  ARCHS="arm64 x86_64" \
  ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  build >&2

appex="${proj_dir}/build/Build/Products/Release/HippiusFinder.appex"
if [[ ! -d "${appex}" ]]; then
  echo "ERROR: build did not produce ${appex}" >&2
  exit 1
fi

# Fail loudly if the binary is not actually universal — a silently thin .appex
# would ship a release that is broken on half of macs, which is exactly the
# failure this script exists to prevent.
binary="${appex}/Contents/MacOS/HippiusFinder"
arches="$(lipo -archs "${binary}" 2>/dev/null || true)"
if [[ "${arches}" != *arm64* || "${arches}" != *x86_64* ]]; then
  echo "ERROR: ${binary} is not universal (arches: '${arches}'); expected arm64 + x86_64." >&2
  exit 1
fi
echo "universal appex built (${arches})" >&2

# Last stdout line = the artifact path, for the caller to capture.
echo "${appex}"
