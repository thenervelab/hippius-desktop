#!/usr/bin/env bash
# Prove a built engine does on this machine what the app asks of it
# (src-tauri/src/video_engine/plan.rs), on the committed test clips:
#
#   - everywhere: an H.264 + AC-3 MKV is remuxed into an MP4 without
#     touching the picture;
#   - macOS and Windows: the OS encoders work (the app's order: Media
#     Foundation hardware, then software, on Windows) and a WMV converts to
#     H.264 + AAC in MPEG-TS;
#   - Linux: there is no encoder at all, so a WMV is not converted.
#
#   smoke-test.sh <engine binary>
set -euo pipefail

engine="${1:?usage: smoke-test.sh <engine>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures="${script_dir}/../../src-tauri/tests/fixtures/video"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

"${engine}" -hide_banner -version | head -1

probe() { "${engine}" -hide_banner -nostdin -i "$1" 2>&1 || true; }

# Remux: the picture is copied, the AC-3 left out (the app re-encodes it
# where the OS has an AAC encoder; that is the runtime test's job).
"${engine}" -hide_banner -nostdin -loglevel error -i "${fixtures}/clip_h264_ac3.mkv" \
  -map 0:0 -c:v copy -an -f mp4 "${work}/remux.mp4"
info="$(probe "${work}/remux.mp4")"
grep -q "Video: h264" <<<"${info}" || { echo "${info}"; echo "::error::the remuxed MP4 has no H.264 video"; exit 1; }
echo "remux: ok"

case "$(uname -s)" in
  Darwin) video=("h264_videotoolbox -allow_sw 1 -bf 0"); audio="aac_at" ;;
  Linux) video=(); audio="" ;;
  *) video=("h264_mf -hw_encoding 1 -bf 0" "h264_mf -bf 0"); audio="aac_mf" ;;
esac

if ((${#video[@]} == 0)); then
  encoders="$("${engine}" -hide_banner -encoders 2>/dev/null | awk 'p && NF >= 2 {print $2} /^ *-+$/ {p=1}')"
  if grep -qvxE 'wrapped_avframe|pcm_s16le' <<<"${encoders}"; then
    echo "::error::the Linux engine carries an encoder: ${encoders}"
    exit 1
  fi
  echo "no encoder on Linux: WMV and other conversions show the download fallback"
  echo "smoke test passed"
  exit 0
fi

picked=""
for candidate in "${video[@]}"; do
  read -r -a enc <<<"${candidate}"
  if "${engine}" -hide_banner -nostdin -loglevel error -f lavfi -i testsrc2=size=320x240:rate=25 -t 0.2 \
    -c:v "${enc[@]}" -b:v 500k -f null - 2>"${work}/enc.log"; then
    picked="${candidate}"
    break
  fi
  echo "encoder unavailable: ${candidate} ($(tail -1 "${work}/enc.log"))"
done
if [[ -z "${picked}" ]]; then
  echo "::error::no OS H.264 encoder works with this engine on this runner"
  exit 1
fi
echo "video encoder: ${picked}, audio encoder: ${audio}"

"${engine}" -hide_banner -nostdin -loglevel error -stream_loop -1 -i "${fixtures}/clip.wmv" -t 6 -c copy -f asf "${work}/in.wmv"
read -r -a enc <<<"${picked}"
start=$(date +%s)
"${engine}" -hide_banner -nostdin -loglevel error -i "${work}/in.wmv" \
  -vf "scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,bwdif=deint=interlaced,format=yuv420p" \
  -c:v "${enc[@]}" -b:v 1500k -force_key_frames 'expr:gte(t,n_forced*4)' \
  -c:a "${audio}" -b:a 160k -ac 2 -ar 48000 -f mpegts "${work}/out.ts"
echo "converted 6 s in $(($(date +%s) - start)) s"

info="$(probe "${work}/out.ts")"
grep -q "Video: h264" <<<"${info}" || { echo "${info}"; echo "::error::output has no H.264 video"; exit 1; }
grep -q "Audio: aac" <<<"${info}" || { echo "${info}"; echo "::error::output has no AAC audio"; exit 1; }
echo "smoke test passed"
