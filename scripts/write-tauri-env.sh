#!/usr/bin/env bash
#
# Write src-tauri/.env from a secret piped on stdin, keeping only the variables the app
# actually reads.
#
# Every release workflow bundles this file as a Tauri resource (`tauri.conf.json`) and the app
# loads it at runtime (main.rs), so it has to exist even when it sets nothing — bundling a
# missing resource fails the build. It also means **every line that survives this script ships
# inside the installer** and can be read back out of it with nothing more than `unzip`.
#
# So this is an allowlist, not a passthrough. `TAURI_ENV_FILE` is a whole file maintained by
# hand, and it still carries `INDEXER_API_KEY` — which the app stopped reading when the indexer
# moved to per-user auth (audit M-9 / SC2), but which is still a live operator credential for
# the entire indexer, `DELETE /cache/*` included. Copying the secret verbatim would keep
# shipping that in every DMG and MSI for as long as nobody remembers to edit the secret, which
# is the whole failure M-9 describes. Filtering here makes it impossible to forget, and covers
# the next credential somebody adds to that secret by accident too.
#
# This inverts an earlier check that required INDEXER_API_KEY to be PRESENT: back when the app
# needed it, a build without one rendered zeros on every indexer-backed screen instead of an
# error and shipped looking healthy. Same file, opposite direction, for the same reason — what
# ends up in the bundle should not depend on anybody remembering.
#
# Usage: printf '%s' "$SECRET" | scripts/write-tauri-env.sh

set -euo pipefail

# The only variables src-tauri reads from this file. Both are optional; the staging lane sets
# HIPPIUS_CONSOLE_BASE_URL to point share links at the staging console.
ALLOWED_KEYS=(
  HIPPIUS_INDEXER_URL
  HIPPIUS_CONSOLE_BASE_URL
)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/src-tauri/.env"

mkdir -p "$(dirname "${env_file}")"

secret="$(cat)"
kept=()
dropped=()

while IFS= read -r line || [[ -n "${line}" ]]; do
  # Strip a trailing CR so a CRLF-authored secret does not yield keys with an invisible
  # character appended — which would silently fail to match the allowlist and be dropped.
  line="${line%$'\r'}"

  # Comments and blanks carry nothing the app reads. The file's purpose is documented in the
  # committed .env.example instead.
  [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue

  key="${line%%=*}"
  key="${key#"${key%%[![:space:]]*}"}" # ltrim
  key="${key%"${key##*[![:space:]]}"}" # rtrim

  allowed=no
  for candidate in "${ALLOWED_KEYS[@]}"; do
    if [[ "${key}" == "${candidate}" ]]; then
      allowed=yes
      break
    fi
  done

  if [[ "${allowed}" == yes ]]; then
    kept+=("${line}")
  else
    dropped+=("${key}")
  fi
done <<<"${secret}"

# `${arr[@]+"${arr[@]}"}` because `set -u` treats an empty array as unset on bash 3.2, which
# is what macOS runners still ship — and an empty result is the normal case here.
printf '%s\n' ${kept[@]+"${kept[@]}"} >"${env_file}"
# Best-effort: Windows runners have no POSIX mode bits to set.
chmod 600 "${env_file}" 2>/dev/null || true

# Key NAMES only — never values, and never a length, which is itself a hint about a secret.
if [[ ${#dropped[@]} -gt 0 ]]; then
  echo "::notice::Dropped ${#dropped[@]} variable(s) the app does not read, so they are not bundled: ${dropped[*]}"
fi
echo "src-tauri/.env written with ${#kept[@]} allowlisted variable(s)."
