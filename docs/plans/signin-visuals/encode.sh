#!/usr/bin/env bash
# Encode a folder of frames from render-frames.mjs into a looping GIF.
#   encode.sh <frames-dir> <out.gif> [fps] [colors]
# Frames are averaged down to 1620 x 911 first (render-frames.mjs draws them
# larger), so edges are smooth and land on the same pixels every frame.
# Then two passes: one palette for the whole clip, built from every pixel
# (not only the changing ones, so the still scene keeps its exact colours),
# and every frame mapped to it without dithering (dither noise shifts between
# frames and shimmers). Only changed pixels are stored per frame (diff_mode),
# which keeps the still parts of a scene free.
set -euo pipefail
in="$1"; out="$2"; fps="${3:-30}"; colors="${4:-128}"
size="scale=1620:911:flags=area"
pal="$(mktemp -t signin-palette).png"
ffmpeg -v error -y -framerate "$fps" -i "$in/f_%04d.png" \
  -vf "${size},palettegen=max_colors=${colors}:stats_mode=full" "$pal"
ffmpeg -v error -y -framerate "$fps" -i "$in/f_%04d.png" -i "$pal" \
  -lavfi "[0:v]${size}[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle" -loop 0 "$out"
rm -f "$pal"
ls -l "$out" | awk '{print $5, $9}'
