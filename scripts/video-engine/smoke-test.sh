#!/usr/bin/env bash
# Prove a built engine converts a WMV on this machine, the way the app runs it:
# the same encoder candidates in the same order (src-tauri/src/video_engine/
# plan.rs, Encoder::candidates), then a WMV to H.264 + AAC in MPEG-TS, read
# back. Exits non-zero when no encoder works or the output does not decode.
#
#   smoke-test.sh <engine binary>
set -euo pipefail

engine="${1:?usage: smoke-test.sh <engine>}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

case "$(uname -s)" in
  Darwin) candidates=("h264_videotoolbox -allow_sw 1 -bf 0") ;;
  Linux) candidates=("libopenh264") ;;
  *) candidates=("h264_mf -hw_encoding 1 -bf 0" "h264_mf -bf 0" "libopenh264") ;;
esac

"${engine}" -hide_banner -version | head -1
"${engine}" -hide_banner -nostdin -loglevel error -y \
  -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 6 \
  -c:v wmv2 -b:v 800k -c:a wmav2 -b:a 96k "${work}/in.wmv"

picked=""
for candidate in "${candidates[@]}"; do
  read -r -a enc <<<"${candidate}"
  if "${engine}" -hide_banner -nostdin -loglevel error -f lavfi -i testsrc2=size=320x240:rate=25 -t 0.2 \
    -c:v "${enc[@]}" -b:v 500k -f null - 2>"${work}/enc.log"; then
    picked="${candidate}"
    break
  fi
  echo "encoder unavailable: ${candidate} ($(tail -1 "${work}/enc.log"))"
done
if [[ -z "${picked}" ]]; then
  echo "::error::no H.264 encoder works with this engine on this runner"
  exit 1
fi
echo "encoder: ${picked}"

read -r -a enc <<<"${picked}"
start=$(date +%s)
"${engine}" -hide_banner -nostdin -loglevel error -i "${work}/in.wmv" \
  -vf "scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1,bwdif=deint=interlaced,format=yuv420p" \
  -c:v "${enc[@]}" -b:v 1500k -force_key_frames 'expr:gte(t,n_forced*4)' \
  -c:a aac -b:a 128k -ac 2 -f mpegts "${work}/out.ts"
echo "converted 6 s in $(( $(date +%s) - start )) s"

info="$("${engine}" -hide_banner -nostdin -i "${work}/out.ts" 2>&1 || true)"
grep -q "Video: h264" <<<"${info}" || { echo "${info}"; echo "::error::output has no H.264 video"; exit 1; }
grep -q "Audio: aac" <<<"${info}" || { echo "${info}"; echo "::error::output has no AAC audio"; exit 1; }
"${engine}" -hide_banner -nostdin -loglevel error -i "${work}/out.ts" -f null -
echo "smoke test passed"
