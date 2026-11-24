#!/usr/bin/env bash
# Encode a folder of frames from render-frames.mjs into a looping GIF.
#   encode.sh <frames-dir> <out.gif> [fps] [colors]
# Two passes: build one palette for the whole clip, then map every frame to it
# with light dithering. Only changed pixels are stored per frame (diff_mode),
# which keeps these mostly static isometric scenes small.
set -euo pipefail
in="$1"; out="$2"; fps="${3:-30}"; colors="${4:-96}"
pal="$(mktemp -t signin-palette).png"
ffmpeg -v error -y -framerate "$fps" -i "$in/f_%04d.png" \
  -vf "palettegen=max_colors=${colors}:stats_mode=diff" "$pal"
ffmpeg -v error -y -framerate "$fps" -i "$in/f_%04d.png" -i "$pal" \
  -lavfi "paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 "$out"
rm -f "$pal"
ls -l "$out" | awk '{print $5, $9}'
