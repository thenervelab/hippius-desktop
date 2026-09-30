#!/usr/bin/env bash
# Build Hippius Desktop on this Mac with everything a CI release has except
# Apple's notarization: the app, the screen-recording helper inside it
# (Contents/MacOS/HippiusCapture), a fresh signature, and a DMG on the Desktop.
#
#   pnpm build:mac-local [--channel staging|beta|production] [--universal]
#                        [--identity <sha1|name|->] [--no-dmg] [--dry-run]
#
# Why not plain `pnpm tauri:build`: Tauri knows nothing about the helper (it is
# deliberately not an externalBin, see .claude/rules/macos-packaging.md), and a
# release build looks for it only beside its own binary. Without this script
# the app builds fine and simply has no recording, camera or microphone.
#
# Options:
#   --channel <name>  compile-time release channel (default: staging, the lane
#                     that shows staging-gated features such as Capture)
#   --universal       build arm64 + x86_64 (needs both rustup targets and
#                     Xcode); by default the app and helper are built for this
#                     Mac's own architecture, which works on Intel and Apple
#                     silicon alike
#   --identity <id>   sign with this identity: a SHA-1 or (part of) a name
#                     from `security find-identity -v -p codesigning`, or
#                     "-" for ad hoc. Overrides APPLE_SIGNING_IDENTITY.
#   --no-dmg          stop after the signed .app
#   --dry-run         run the checks and print the steps without building
#
# Signing: --identity, else APPLE_SIGNING_IDENTITY, else the first
# "Developer ID Application" identity in the keychain, else the first
# "Apple Development" one, else ad hoc. A real identity keeps the Screen
# Recording grant across rebuilds; ad hoc loses it on every build (see
# scripts/lib/mac-signing.sh). The result is NOT notarized either way, so it
# is for local testing only.
set -euo pipefail

channel="staging"
make_dmg=1
universal=0
dry_run=0
requested_identity="${APPLE_SIGNING_IDENTITY:-}"

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --channel)
      [[ $# -ge 2 ]] || { echo "ERROR: --channel needs a value" >&2; exit 2; }
      channel="$2"
      shift 2
      ;;
    --channel=*) channel="${1#--channel=}"; shift ;;
    --identity)
      [[ $# -ge 2 ]] || { echo "ERROR: --identity needs a value" >&2; exit 2; }
      requested_identity="$2"
      shift 2
      ;;
    --identity=*) requested_identity="${1#--identity=}"; shift ;;
    --no-dmg) make_dmg=0; shift ;;
    --universal) universal=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "ERROR: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "${channel}" in
  staging | beta | production) ;;
  *) echo "ERROR: --channel must be staging, beta or production (got '${channel}')" >&2; exit 2 ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: build-mac-local.sh builds the macOS app and only runs on a Mac." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${repo_root}"
# shellcheck source=scripts/lib/mac-signing.sh
source "${repo_root}/scripts/lib/mac-signing.sh"

# Print a step in a dry run, run it otherwise.
run() {
  if ((dry_run)); then
    printf '    [dry run] %s\n' "$*"
  else
    "$@"
  fi
}

# ---- Preflight -------------------------------------------------------------

# `next build` writes the same .next/out the dev server serves from, so a
# running `pnpm tauri:dev` breaks mid-session (and this build can pick up its
# half-written output).
dev_running=""
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  dev_running="something is listening on port 3000 (the Next.js dev server)"
elif pgrep -f 'tauri(:| )dev' >/dev/null 2>&1; then
  dev_running="'tauri dev' is running"
fi
if [[ -n "${dev_running}" ]]; then
  echo "ERROR: ${dev_running}. Stop 'pnpm tauri:dev' (Ctrl+C) first: this build would overwrite the files it serves." >&2
  exit 1
fi

# The cargo target dir is what fills up. Tauri runs cargo from src-tauri, so a
# relative CARGO_TARGET_DIR is relative to there.
target_root="${CARGO_TARGET_DIR:-${repo_root}/src-tauri/target}"
[[ "${target_root}" == /* ]] || target_root="${repo_root}/src-tauri/${target_root}"
df_dir="${target_root}"
[[ -d "${df_dir}" ]] || df_dir="${repo_root}"
free_gb="$(df -Pk "${df_dir}" | awk 'NR==2 { printf "%d", $4 / 1048576 }')"
echo "==> Free disk: ${free_gb} GB (volume of ${df_dir})"
if ((free_gb < 18)); then
  echo "ERROR: less than 18 GB free. A release build needs about 15 to 20 GB; free some space first." >&2
  exit 1
fi

if [[ ! -f src-tauri/.env ]]; then
  echo "WARN: src-tauri/.env is missing; 'pnpm setup:env' writes it. Without INDEXER_API_KEY storage figures read as zero." >&2
fi

version="$(node -p "require('./src-tauri/tauri.conf.json').version")"
host_arch="$(uname -m)" # arm64 or x86_64
if ((universal)); then
  bundle_dir="${target_root}/universal-apple-darwin/release/bundle/macos"
  tauri_target=(--target universal-apple-darwin)
  helper_flag=(--universal)
  arch_label="universal"
else
  bundle_dir="${target_root}/release/bundle/macos"
  tauri_target=()
  helper_flag=()
  arch_label="${host_arch}"
fi
app="${bundle_dir}/Hippius.app"
dmg="${HOME}/Desktop/Hippius-${version}-local.dmg"

# Picked before anything is built, so a mistyped --identity fails at once.
identities="$(security find-identity -v -p codesigning 2>/dev/null | parse_signing_identities || true)"
if ! selected="$(printf '%s\n' "${identities}" | select_signing_identity "${requested_identity}")"; then
  echo "ERROR: no valid code-signing identity matches '${requested_identity}'. These are available:" >&2
  if [[ -n "${identities}" ]]; then
    printf '%s\n' "${identities}" | sed 's/^/         /' >&2
  else
    echo "         (none)" >&2
  fi
  exit 2
fi
identity="${selected%%$'\t'*}"
sign_label="${selected#*$'\t'}"
if [[ "${identity}" == "-" ]]; then
  identity_kind="adhoc"
else
  identity_kind="$(signing_identity_kind "${sign_label}")"
  sign_label="${sign_label} (${identity})"
fi

echo "==> Hippius ${version}, channel ${channel}, ${arch_label}"
echo "==> Signing identity: ${sign_label}"
if [[ "${identity}" == "-" ]]; then
  if [[ -z "${requested_identity}" ]]; then
    echo "WARN: no Developer ID Application or Apple Development identity in the keychain," >&2
  else
    echo "WARN: ad hoc signing was asked for (--identity - or APPLE_SIGNING_IDENTITY=-)," >&2
  fi
  cat >&2 <<'EOF'
      so this build is signed ad hoc. macOS ties an ad hoc app's Screen
      Recording permission to that one build, so you must grant it again after
      EVERY rebuild:
        1. Quit Hippius.
        2. System Settings > Privacy & Security > Screen & System Audio
           Recording (Screen Recording before macOS 14): select Hippius and
           remove it with the minus button.
        3. Run: tccutil reset ScreenCapture hippius.com
        4. Open Hippius, start a capture, press Allow, switch Hippius on,
           then relaunch Hippius.
      Xcode (Settings > Accounts > Manage Certificates) creates a free Apple
      Development identity, which this script then picks up automatically.
EOF
fi
if git rev-parse --git-dir >/dev/null 2>&1; then
  echo "    $(git branch --show-current 2>/dev/null) @ $(git log --oneline -1)"
fi

# ---- 1. The helper ---------------------------------------------------------

echo "==> 1/5 Building the screen-recording helper (${arch_label})"
if ((dry_run)); then
  helper="<built helper>"
  run macos/build-capture-helper.sh ${helper_flag[@]+"${helper_flag[@]}"}
else
  # First, so a Swift error fails in seconds rather than after the app build.
  helper="$(macos/build-capture-helper.sh ${helper_flag[@]+"${helper_flag[@]}"})"
  echo "    ${helper} ($(lipo -archs "${helper}"))"
fi

# ---- 2. The app ------------------------------------------------------------

echo "==> 2/5 Building the app. This takes a while."
# A stale bundle from an earlier build must not pass for this one.
run rm -rf "${app}"
run node scripts/dev-env.mjs --soft
# `tauri build` runs `pnpm build` (next build) itself. Only the .app: the DMG
# is made below, once the helper is in. No updater artifacts: they need the
# release signing key and a local build has no use for them.
run env HIPPIUS_RELEASE_CHANNEL="${channel}" pnpm tauri build ${tauri_target[@]+"${tauri_target[@]}"} --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}'
if ((!dry_run)) && [[ ! -d "${app}" ]]; then
  echo "ERROR: tauri build did not produce ${app}" >&2
  exit 1
fi

# ---- 3. Embed the helper ---------------------------------------------------

echo "==> 3/5 Putting the helper inside the app"
# Signs it with its own entitlements (audio-input) and checks them. No
# secure timestamp unless the identity could be notarized: it needs the
# network and nothing local checks it.
if [[ "${identity_kind}" == "developer-id" ]]; then
  helper_timestamp=""
else
  helper_timestamp="none"
fi
run env APPLE_SIGNING_IDENTITY="${identity}" HIPPIUS_CODESIGN_TIMESTAMP="${helper_timestamp}" \
  macos/embed-capture-helper.sh "${app}" "${helper}"

# ---- 4. Re-sign the app ----------------------------------------------------

echo "==> 4/5 Re-signing the app"
# Adding a file to Contents/MacOS broke the app's seal. Not --deep: that would
# re-sign the helper with the app's entitlements and drop its own.
run sign_app_bundle "${app}" "${identity}" "${identity_kind}" src-tauri/entitlements.plist
run codesign --verify --deep --strict "${app}"

if ((!dry_run)); then
  embedded="${app}/Contents/MacOS/HippiusCapture"
  if [[ ! -x "${embedded}" ]]; then
    echo "ERROR: ${embedded} is missing after the embed" >&2
    exit 1
  fi
  # A helper without the app's architecture would leave Record disabled on
  # this Mac with no other sign of trouble.
  main_exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${app}/Contents/Info.plist")"
  app_archs="$(lipo -archs "${app}/Contents/MacOS/${main_exe}")"
  helper_archs="$(lipo -archs "${embedded}")"
  for arch in ${app_archs}; do
    if [[ " ${helper_archs} " != *" ${arch} "* ]]; then
      echo "ERROR: the app is '${app_archs}' but the helper is '${helper_archs}'" >&2
      exit 1
    fi
  done
  echo "    signature OK; helper embedded (${helper_archs})"
fi

# ---- 5. The DMG ------------------------------------------------------------

if ((make_dmg)); then
  echo "==> 5/5 Making the DMG"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/hippius-dmg.XXXXXX")"
  trap 'rm -rf "${stage}"' EXIT
  # ditto keeps the signatures and extended attributes intact; the
  # Applications link gives the usual drag-to-install window.
  run ditto "${app}" "${stage}/Hippius.app"
  run ln -s /Applications "${stage}/Applications"
  run hdiutil create -volname Hippius -srcfolder "${stage}" -ov -format UDZO "${dmg}"
  installer="${dmg}"
  echo "    ${dmg}"
else
  echo "==> 5/5 Skipping the DMG (--no-dmg)"
  installer="${app}"
  echo "    ${app}"
fi

((dry_run)) && { echo "Dry run: nothing was built."; exit 0; }

if [[ "${identity}" == "-" ]]; then
  grant_note="     Ad hoc: Screen Recording must be granted again after every rebuild. If
     Capture says it is not allowed although it is switched on, remove Hippius
     from Privacy & Security > Screen & System Audio Recording with the minus
     button, run
       tccutil reset ScreenCapture hippius.com
     then press Allow in Hippius again, switch it on and relaunch."
else
  grant_note="     Screen Recording granted to an earlier build signed this way carries
     over. The first time after an ad hoc build, remove the old Hippius
     entries from Privacy & Security > Screen & System Audio Recording with
     the minus button and run
       tccutil reset ScreenCapture hippius.com
     then press Allow in Hippius, switch it on and relaunch."
fi

cat <<EOF

Done: ${installer}

Install and first launch
  1. Quit any running Hippius (menu bar icon, then Quit).
  2. $( ((make_dmg)) && echo "Open the DMG and drag Hippius onto Applications (Replace)." || echo "Copy Hippius.app into /Applications (Replace).")
  3. If macOS refuses to open it the first time, right-click Hippius in
     Applications and choose Open. It is signed on this Mac, not notarized.
  4. Signed with: ${sign_label}
${grant_note}
EOF
