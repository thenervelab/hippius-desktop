#!/usr/bin/env bash
#
# Write src-tauri/.env from a secret piped on stdin, then refuse to continue if
# it carries no indexer key.
#
# Every release workflow bundles this file as a Tauri resource and the app loads
# it at runtime (main.rs). Without INDEXER_API_KEY every indexer-backed screen —
# the home page's Available Credits and Storage Usage cards, the storage total,
# the billing charts — renders a confident zero rather than an error, so a build
# with a missing key looks healthy and ships silently broken. Failing the build
# is the only place that mistake is cheap to catch.
#
# Usage: printf '%s' "$SECRET" | scripts/write-tauri-env.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/src-tauri/.env"

mkdir -p "$(dirname "${env_file}")"
cat >"${env_file}"
# Best-effort: Windows runners have no POSIX mode bits to set.
chmod 600 "${env_file}" 2>/dev/null || true

key="$(sed -n 's/^INDEXER_API_KEY=//p' "${env_file}" | head -1)"
if [[ -z "${key}" ]]; then
  echo "::error::src-tauri/.env has no INDEXER_API_KEY. Indexer-backed screens would render zeros instead of failing, so this build is not shippable. Check the TAURI_ENV_FILE repository secret."
  exit 1
fi

# Length only — never the value.
echo "src-tauri/.env written; INDEXER_API_KEY present (${#key} chars)."
