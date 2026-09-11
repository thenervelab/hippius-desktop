#!/usr/bin/env bash
#
# Write src-tauri/.env from a secret piped on stdin.
#
# Every release workflow bundles this file as a Tauri resource (`tauri.conf.json`) and the app
# loads it at runtime (main.rs), so it has to exist even when it sets nothing — bundling a
# missing resource fails the build.
#
# Everything it can carry is optional: `HIPPIUS_INDEXER_URL` and `HIPPIUS_CONSOLE_BASE_URL`,
# which the staging workflow uses to point a build at the staging console. So this writes the
# file and stops.
#
# It used to refuse to continue unless the result carried an INDEXER_API_KEY, because a build
# without one rendered zeros on every indexer-backed screen instead of an error, and shipped
# looking healthy. The indexer now authenticates the logged-in user, so no shared key is
# bundled and there is nothing left here that a build can silently omit.
#
# Usage: printf '%s' "$SECRET" | scripts/write-tauri-env.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/src-tauri/.env"

mkdir -p "$(dirname "${env_file}")"
cat >"${env_file}"
# Best-effort: Windows runners have no POSIX mode bits to set.
chmod 600 "${env_file}" 2>/dev/null || true

# Byte count only — never the contents.
echo "src-tauri/.env written ($(wc -c <"${env_file}" | tr -d ' ') bytes)."
