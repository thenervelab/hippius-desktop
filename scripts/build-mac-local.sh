#!/usr/bin/env bash
# Build Hippius Desktop on this Mac with everything a CI release has except
# Apple's notarization: the app, the screen-recording helper inside it
# (Contents/MacOS/HippiusCapture), a fresh signature, and a DMG on the Desktop.
#
#   pnpm build:mac-local [--channel staging|beta|production] [--universal]
#                        [--no-dmg] [--dry-run]
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
#   --no-dmg          stop after the signed .app
#   --dry-run         run the checks and print the steps without building
#
# Signing: with APPLE_SIGNING_IDENTITY set to a real identity the helper and
# app are signed with it; otherwise ad hoc. Either way the result is NOT
# notarized, so it is for local testing only.
set -euo pipefail

channel="staging"
make_dmg=1
universal=0
dry_run=0

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

while (($#)); do
  case "$1" in
    --channel)
      [[ $# -ge 2 ]] || { echo "ERROR: --channel needs a value" >&2; exit 2; }
      channel="$2"
      shift 2
      ;;
    --channel=*) channel="${1#--channel=}"; shift ;;
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

identity="${APPLE_SIGNING_IDENTITY:-}"
if [[ -n "${identity}" && "${identity}" != "-" ]]; then
  sign_label="${identity}"
else
  identity="-"
  sign_label="ad hoc"
fi

echo "==> Hippius ${version}, channel ${channel}, ${arch_label}, signed ${sign_label}"
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
# Signs it with its own entitlements (audio-input) and checks them.
run env APPLE_SIGNING_IDENTITY="${identity}" macos/embed-capture-helper.sh "${app}" "${helper}"

# ---- 4. Re-sign the app ----------------------------------------------------

echo "==> 4/5 Re-signing the app"
# Adding a file to Contents/MacOS broke the app's seal. Not --deep: that would
# re-sign the helper with the app's entitlements and drop its own.
if [[ "${identity}" == "-" ]]; then
  run codesign --force --sign - --entitlements src-tauri/entitlements.plist "${app}"
else
  run codesign --force --options runtime --sign "${identity}" --entitlements src-tauri/entitlements.plist "${app}"
fi
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

cat <<EOF

Done: ${installer}

Install and first launch
  1. Quit any running Hippius (menu bar icon, then Quit).
  2. $( ((make_dmg)) && echo "Open the DMG and drag Hippius onto Applications (Replace)." || echo "Copy Hippius.app into /Applications (Replace).")
  3. The first time, right-click Hippius in Applications and choose Open. It is
     signed on this Mac, not notarized by Apple, so a double-click is refused.
  4. If Capture says Screen Recording is not allowed although it is switched on
     in System Settings (a rebuilt app has a new signature), run
       tccutil reset ScreenCapture hippius.com
     then allow it again when asked, and relaunch Hippius.
EOF
