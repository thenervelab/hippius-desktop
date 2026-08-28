#!/usr/bin/env bash
# Attach a SHA256SUMS asset and put a Downloads table at the top of the release
# body, so a human landing on the release page can tell which file to take.
#
# WHY THIS EXISTS. A release carries a dozen assets and only three of them are
# things a person should download; the rest are auto-update payloads and their
# signatures. Nothing on the page says which is which, and the names do not help
# — `Hippius_universal.app.tar.gz` read as the sibling of `Hippius_universal.dmg`
# for long enough to ship an extension-less build to anyone who guessed wrong.
# Naming the real downloads is the cheap half of not repeating that.
#
# Checksums come from the GitHub API's own per-asset digest, so nothing is
# downloaded to produce them.
#
# Usage: publish-release-downloads.sh <tag>
# Requires: gh (authenticated via GH_TOKEN), jq. Env: REPO=<owner/name>.
set -euo pipefail

TAG="${1:?usage: publish-release-downloads.sh <tag>}"
: "${REPO:?set REPO=<owner/name>}"

CHECKSUM_ASSET="SHA256SUMS"

# Replaced wholesale on every run, so re-running the job (or a later edit of the
# release notes) never stacks two tables.
MARKER_START="<!-- hippius:downloads:start -->"
MARKER_END="<!-- hippius:downloads:end -->"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

release="${work}/release.json"
gh api "repos/${REPO}/releases/tags/${TAG}" >"${release}"

# ---------------------------------------------------------------------------
# SHA256SUMS, in the format `sha256sum -c` reads.
# ---------------------------------------------------------------------------
missing="$(jq -r --arg self "${CHECKSUM_ASSET}" '
  [.assets[] | select(.name != $self) | select((.digest // "") == "")] | length
' "${release}")"

if [[ "${missing}" != "0" ]]; then
  echo "::warning title=No checksums published::${missing} asset(s) on ${TAG} have no digest in \
the API, so a SHA256SUMS listing only the rest would imply a coverage it does not have."
else
  jq -r --arg self "${CHECKSUM_ASSET}" '
    .assets[] | select(.name != $self)
    | "\(.digest | sub("^sha256:"; ""))  \(.name)"
  ' "${release}" | sort -k2 >"${work}/${CHECKSUM_ASSET}"

  gh release upload "${TAG}" --repo "${REPO}" "${work}/${CHECKSUM_ASSET}" --clobber
  echo "Attached ${CHECKSUM_ASSET} ($(wc -l <"${work}/${CHECKSUM_ASSET}" | tr -d ' ') entries)."
fi

# ---------------------------------------------------------------------------
# The Downloads table. One row per platform, naming the installer — never the
# updater payload.
# ---------------------------------------------------------------------------
asset_matching() {
  # First asset whose name matches the pattern, or empty. `--arg` rather than a
  # glob so a name containing regex characters cannot change the match.
  jq -r --arg pattern "$1" '
    [.assets[].name | select(test($pattern))] | first // ""
  ' "${release}"
}

table="${work}/table.md"
{
  echo "${MARKER_START}"
  echo "### Downloads"
  echo
  echo "| Platform | File |"
  echo "| --- | --- |"
} >"${table}"

rows=0
add_row() {
  local label="$1" name="$2"
  if [[ -z "${name}" ]]; then
    return 0
  fi
  echo "| ${label} | [\`${name}\`](https://github.com/${REPO}/releases/download/${TAG}/${name}) |" \
    >>"${table}"
  rows=$((rows + 1))
}

# `--arg` passes the pattern raw, so these are the regexes jq sees verbatim.
add_row "macOS" "$(asset_matching '\.dmg$')"
add_row "Windows" "$(asset_matching '-setup\.exe$')"
add_row "Linux (Debian/Ubuntu)" "$(asset_matching '\.deb$')"

if ((rows == 0)); then
  echo "::warning title=No installers found::${TAG} carries no .dmg, -setup.exe or .deb, so no \
Downloads table was written."
  exit 0
fi

{
  echo
  echo "The remaining assets are auto-update payloads and their signatures — the app fetches those"
  echo "itself. Do not install from them; they are not the same file as the installer above."
  if [[ "${missing}" == "0" ]]; then
    echo "Checksums for every asset are in \`${CHECKSUM_ASSET}\`."
  fi
  echo "${MARKER_END}"
  echo
} >>"${table}"

# Prepend, preserving whatever release notes are already there. A previous run's
# table is cut out first so the marker pair stays unique.
body="${work}/body.md"
jq -r '.body // ""' "${release}" >"${body}"

cleaned="${work}/cleaned.md"
awk -v start="${MARKER_START}" -v end="${MARKER_END}" '
  $0 == start { skipping = 1; next }
  $0 == end   { skipping = 0; next }
  !skipping   { print }
' "${body}" >"${cleaned}"

cat "${table}" "${cleaned}" >"${work}/new-body.md"
gh release edit "${TAG}" --repo "${REPO}" --notes-file "${work}/new-body.md"
echo "Downloads table written to the ${TAG} release notes (${rows} platform(s))."
