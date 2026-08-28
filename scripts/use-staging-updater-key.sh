#!/usr/bin/env bash
#
# Swap the updater public key in src-tauri/tauri.conf.json for the STAGING one.
#
# Why this exists, rather than a staging pubkey committed on the staging branch:
# the two release lanes now live in one repository. A pubkey that differs per
# branch is a merge hazard with a silent, delayed failure mode — a staging->main
# merge that carried the staging key would ship a production release whose
# updater signature check fails against every installed copy, and nothing would
# report it until users simply stopped receiving updates. So the tree carries the
# PRODUCTION key on every branch, and the staging lane patches its own key in
# here, at build time, where it cannot escape into another branch.
#
# Reads STAGING_PUBKEY from the environment (the TAURI_UPDATER_PUBKEY_STAGING
# secret). Fails closed: an unset secret expands to the empty string, and writing
# an empty pubkey would produce a build that accepts unverifiable updates.

set -euo pipefail

CONFIG="src-tauri/tauri.conf.json"

if [[ -z "${STAGING_PUBKEY:-}" ]]; then
  echo "::error title=Missing staging updater key::TAURI_UPDATER_PUBKEY_STAGING is not set. Refusing to build a staging release that would carry the production updater key."
  exit 1
fi

if [[ ! -f "$CONFIG" ]]; then
  echo "::error title=Config not found::$CONFIG is missing; run this from the repository root."
  exit 1
fi

# Write via a sibling temp file rather than $RUNNER_TEMP: this script also runs
# on the Windows runner under Git Bash, where $RUNNER_TEMP is a backslash path.
jq --arg k "$STAGING_PUBKEY" '.plugins.updater.pubkey = $k' "$CONFIG" >"$CONFIG.tmp"
mv "$CONFIG.tmp" "$CONFIG"

# Print the key's minisign comment line (its identity), never the key itself, so
# a build log shows WHICH key was used without publishing it.
echo "Updater pubkey set for the staging channel:"
printf '%s' "$STAGING_PUBKEY" | base64 --decode | head -1
