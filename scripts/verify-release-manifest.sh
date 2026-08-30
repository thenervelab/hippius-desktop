#!/usr/bin/env bash
# Assert that a release's latest.json describes the artifacts the release
# actually carries, before anyone is offered an update from it.
#
# WHY THIS EXISTS. A wrong manifest is indistinguishable from a right one at
# every layer that could complain: it is valid JSON, its signature verifies, and
# the update it points at installs. v0.5.0's manifest pointed macOS at
# tauri-action's pre-finalize artifact — no Finder extension, never notarized —
# and no job failed. The mistake was reachable only by reading the manifest
# against the asset list, which is what this does.
#
# The `-app` keys are the ones that matter and the easy ones to miss:
# tauri-plugin-updater resolves `[{os}-{arch}-{installer}, {os}-{arch}]` IN THAT
# ORDER (updater.rs::get_urls), and a macOS .app — what a DMG install reports
# too — maps to installer `app`. So darwin-<arch>-app is read FIRST and a
# correction written only to the bare key never reaches a user.
#
# Usage: verify-release-manifest.sh <tag> <expected-version>
# Requires: gh (authenticated via GH_TOKEN), jq. Env: REPO=<owner/name>.
set -euo pipefail

TAG="${1:?usage: verify-release-manifest.sh <tag> <expected-version>}"
EXPECTED_VERSION="${2:?usage: verify-release-manifest.sh <tag> <expected-version>}"
: "${REPO:?set REPO=<owner/name>}"

MAC_TARBALL="Hippius.app.tar.gz"

# tauri-action's own `--bundles app` output, uploaded before the finalize step
# embeds the Finder extension. It is a different FILENAME from the finalized
# tarball, so the finalize step's `--clobber` never replaces it — it has to be
# deleted, and this asserts that it was. Left in place it is the most plausible
# wrong click on the release page: it sits next to Hippius_universal.dmg and
# reads as its sibling.
STALE_TARBALL="Hippius_universal.app.tar.gz"

problems=0
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

fail() {
  echo "::error title=Release manifest verification::$1" >&2
  problems=$((problems + 1))
}

ok() {
  echo "  ok: $1"
}

echo "Verifying the manifest on ${REPO} ${TAG} (expecting version ${EXPECTED_VERSION})"

assets="${work}/assets.txt"
gh release view "${TAG}" --repo "${REPO}" --json assets --jq '.assets[].name' >"${assets}"

echo "== release assets"
for stale in "${STALE_TARBALL}" "${STALE_TARBALL}.sig"; do
  if grep -qxF "${stale}" "${assets}"; then
    fail "${stale} is still attached; it has no Finder extension and was never notarized or \
stapled, and a human browsing the release cannot tell it from the real download"
  fi
done

for required in "${MAC_TARBALL}" "${MAC_TARBALL}.sig" latest.json; do
  if ! grep -qxF "${required}" "${assets}"; then
    fail "${required} is missing from the release"
  fi
done

if ! grep -q '\.dmg$' "${assets}"; then
  fail "the release carries no .dmg — there is nothing for a manual macOS install"
fi
if ((problems == 0)); then
  ok "asset list is complete and carries no pre-finalize artifact"
fi

# Everything below reads the manifest, so a missing one is fatal rather than
# another finding.
if ! gh release download "${TAG}" --repo "${REPO}" --pattern latest.json --dir "${work}"; then
  fail "no latest.json on ${TAG}; nothing can be verified"
  echo "FAILED: ${problems} problem(s)." >&2
  exit 1
fi
manifest="${work}/latest.json"

echo "== manifest"
manifest_version="$(jq -r '.version // ""' "${manifest}")"
if [[ "${manifest_version}" != "${EXPECTED_VERSION}" ]]; then
  fail "latest.json says version ${manifest_version}, the release is ${EXPECTED_VERSION} — \
builds compare these strings to decide whether an update exists"
else
  ok "manifest version is ${EXPECTED_VERSION}"
fi

# Every URL the manifest hands out must name an asset this release actually has.
# Covers Windows and Linux too: a renamed bundle would otherwise 404 mid-update.
while read -r url; do
  [[ -z "${url}" ]] && continue
  name="${url##*/}"
  if ! grep -qxF "${name}" "${assets}"; then
    fail "the manifest points at ${name}, which is not an asset on ${TAG} — that update 404s"
  fi
done < <(jq -r '.platforms | to_entries[] | .value.url' "${manifest}")

# The bare linux-x86_64 key is what an AppImage (and the fallback) reads.
# plugin-updater cannot apply a .deb as the current user. Keep
# linux-x86_64-deb for apt; the bare key must be an updater payload
# (AppImage) or absent. A .deb there is how in-app Install failed with
# Permission denied (os error 13).
linux_bare="$(jq -r '.platforms["linux-x86_64"].url // empty' "${manifest}")"
if [[ "${linux_bare}" == *.deb ]]; then
  fail "linux-x86_64 points at a .deb (${linux_bare##*/}); plugin-updater cannot \
apply a .deb as the current user. Keep linux-x86_64-deb for apt; the bare key \
must be an AppImage (or absent)"
else
  ok "linux-x86_64 is not a .deb"
fi

expected_url="https://github.com/${REPO}/releases/download/${TAG}/${MAC_TARBALL}"

# The signature to compare every macOS platform key against. Its absence is
# already a finding above, so the only case left here is "the asset is on the
# release but would not download" — which must be a failure too, not a quiet
# skip: an empty `expected_sig` disables the comparison below, and a verifier
# that silently stops checking is the failure mode this whole script exists to
# prevent.
expected_sig=""
if grep -qxF "${MAC_TARBALL}.sig" "${assets}"; then
  if gh release download "${TAG}" --repo "${REPO}" --pattern "${MAC_TARBALL}.sig" \
    --dir "${work}" >/dev/null 2>&1 && [[ -s "${work}/${MAC_TARBALL}.sig" ]]; then
    expected_sig="$(cat "${work}/${MAC_TARBALL}.sig")"
  else
    fail "${MAC_TARBALL}.sig is attached to ${TAG} but could not be downloaded, so the \
manifest's signature could not be compared against the one shipped beside the tarball"
  fi
fi

echo "== macOS platform keys"
for arch in aarch64 x86_64; do
  # The bare key is the fallback; the `-app` key is the one macOS reads first.
  # Both must be present and identical, or the two paths serve different builds.
  for key in "darwin-${arch}" "darwin-${arch}-app"; do
    entry="$(jq -r --arg k "${key}" '.platforms[$k] // empty' "${manifest}")"
    if [[ -z "${entry}" ]]; then
      fail "latest.json has no ${key} entry; macOS on that arch is offered no update"
      continue
    fi

    url="$(jq -r --arg k "${key}" '.platforms[$k].url' "${manifest}")"
    if [[ "${url}" != "${expected_url}" ]]; then
      fail "${key} points at ${url##*/}, not the finalized ${MAC_TARBALL}"
    else
      ok "${key} -> ${MAC_TARBALL}"
    fi

    sig="$(jq -r --arg k "${key}" '.platforms[$k].signature // ""' "${manifest}")"
    if [[ -z "${sig}" ]]; then
      fail "${key} carries no signature; the updater rejects an unsigned payload"
    elif [[ -n "${expected_sig}" && "${sig}" != "${expected_sig}" ]]; then
      fail "${key}'s signature is not the one attached as ${MAC_TARBALL}.sig — \
it was signed over different bytes than the asset it names"
    fi
  done
done

if ((problems > 0)); then
  echo
  echo "FAILED: ${problems} problem(s). This release must not be published." >&2
  exit 1
fi

echo
echo "Manifest verified against the release's own assets."
