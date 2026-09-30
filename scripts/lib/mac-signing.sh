#!/usr/bin/env bash
# Code-signing helpers for a local macOS build. Sourced by
# scripts/build-mac-local.sh; the selection functions read their input from
# stdin and arguments only, so scripts/__tests__/macSigning.test.mjs can feed
# them canned `security find-identity` output on any OS.
#
# Why a local build needs a real identity at all: macOS keeps the Screen
# Recording grant (TCC) against the app's designated requirement. For an app
# signed with a certificate that is "team ID + bundle id", which every rebuild
# shares, so the grant survives. An ad hoc app has no team, so its requirement
# is the build's own code hash: every rebuild is a new app to TCC, and a switch
# turned on for the previous build does nothing for this one.

# `security find-identity -v -p codesigning` output on stdin, one
# "SHA1<TAB>NAME" line out per identity, in the order `security` lists them.
parse_signing_identities() {
  awk '
    $1 ~ /^[0-9]+\)$/ && length($2) == 40 && $2 ~ /^[0-9A-Fa-f]+$/ {
      name = $0
      sub(/^[^"]*"/, "", name)
      sub(/"[^"]*$/, "", name)
      print toupper($2) "\t" name
    }
  '
}

# What kind of identity a certificate name is: developer-id, development or
# other. Only the first two are picked automatically.
signing_identity_kind() {
  case "$1" in
    "Developer ID Application:"*) echo "developer-id" ;;
    "Apple Development:"* | "Mac Developer:"*) echo "development" ;;
    "-" | "") echo "adhoc" ;;
    *) echo "other" ;;
  esac
}

# Choose the identity to sign with. Parsed identities ("SHA1<TAB>NAME") on
# stdin; $1 is what was asked for:
#   ""            automatic: the first Developer ID Application, else the
#                 first Apple Development, else ad hoc
#   "-" / adhoc   ad hoc on purpose
#   a SHA-1       that identity (any case)
#   anything else the first identity whose name contains it, as codesign
#                 itself matches names
# Prints "SHA1<TAB>NAME", or "-<TAB>ad hoc". Fails (status 1, nothing printed)
# when an identity was asked for and none matches, so a typo never quietly
# becomes an ad hoc build.
select_signing_identity() {
  local requested="${1:-}"
  local sha name
  local -a shas=() names=()
  while IFS=$'\t' read -r sha name; do
    [[ -n "${sha}" ]] || continue
    shas+=("${sha}")
    names+=("${name}")
  done

  case "${requested}" in
    "-" | adhoc | ad-hoc)
      printf -- '-\tad hoc\n'
      return 0
      ;;
  esac

  local i=0
  if [[ -n "${requested}" ]]; then
    local upper
    upper="$(printf '%s' "${requested}" | tr '[:lower:]' '[:upper:]')"
    for ((i = 0; i < ${#shas[@]}; i++)); do
      if [[ "${shas[$i]}" == "${upper}" || "${names[$i]}" == *"${requested}"* ]]; then
        printf '%s\t%s\n' "${shas[$i]}" "${names[$i]}"
        return 0
      fi
    done
    return 1
  fi

  local kind
  for kind in developer-id development; do
    for ((i = 0; i < ${#shas[@]}; i++)); do
      if [[ "$(signing_identity_kind "${names[$i]}")" == "${kind}" ]]; then
        printf '%s\t%s\n' "${shas[$i]}" "${names[$i]}"
        return 0
      fi
    done
  done
  printf -- '-\tad hoc\n'
}

# The codesign timestamp flag for an identity kind. A secure timestamp is a
# network round trip to Apple and only notarization needs one, so a local
# build asks for it only with a Developer ID identity (the one that could be
# notarized) and builds offline otherwise.
codesign_timestamp_flag() {
  if [[ "$1" == "developer-id" ]]; then
    echo "--timestamp"
  else
    echo "--timestamp=none"
  fi
}

# Sign a built Hippius.app (the helper inside it must already be signed:
# inside-out). Not --deep: that would re-sign the helper with the app's
# entitlements and drop its own audio-input.
#   sign_app_bundle <app> <identity: SHA-1 or -> <kind> <entitlements>
sign_app_bundle() {
  local app="$1" identity="$2" kind="$3" entitlements="$4"
  if [[ "${identity}" == "-" ]]; then
    codesign --force --sign - --entitlements "${entitlements}" "${app}"
  else
    codesign --force --options runtime "$(codesign_timestamp_flag "${kind}")" \
      --sign "${identity}" --entitlements "${entitlements}" "${app}"
  fi
}
