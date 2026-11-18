#!/usr/bin/env bash
# Build the video preview engine: a small LGPL ffmpeg the viewer runs as a
# child process for videos the webview cannot play (src-tauri/src/video_engine/).
#
#   build-ffmpeg.sh                 host build (development, tests)
#   build-ffmpeg.sh --universal     macOS arm64 + x86_64 (release)
#
# Prints the built binary's path on stdout (logs go to stderr). The binary is
# also copied to src-tauri/binaries/hippius-ffmpeg-<target triple>[.exe],
# the name Tauri's `externalBin` (src-tauri/tauri.video-engine.conf.json)
# expects, and beside the cargo target's binaries, where a debug
# `pnpm tauri:dev` looks for it. The source tarball it built from and a
# record of the configuration stay in FFMPEG_BUILD_DIR, which is what the
# release workflows attach to each release (the LGPL's corresponding source).
#
# Licensing: configured WITHOUT --enable-gpl, --enable-version3 or
# --enable-nonfree, so the result is LGPL 2.1+ and ships as a separate
# program, never linked into the app.
#
# Patents: the engine carries no decoder or encoder for a codec with a live
# patent pool. There is no H.264, HEVC or AAC decoder at all (H.264 and HEVC
# are only ever copied, never decoded) and no ffmpeg encoder: the only
# encoders are the operating system's own (VideoToolbox and AudioToolbox on
# macOS, Media Foundation on Windows), whose licences come with the OS.
# Linux has no system encoder, so its engine only copies streams. OpenH264
# is not used: Cisco's patent licence covers only Cisco's own binaries.
# The checks after the build refuse a binary that breaks any of this, and
# tests/video_engine_wiring.rs pins the flags below.
#
# Env:
#   FFMPEG_BUILD_DIR   where sources and objects go (default: a temp dir)
#   FFMPEG_JOBS        make -j (default: CPU count)
set -euo pipefail

FFMPEG_VERSION="8.1.3"
FFMPEG_SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"

universal=0
case "${1:-}" in
  --universal) universal=1 ;;
  "") ;;
  *) echo "usage: $0 [--universal]" >&2; exit 2 ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
build_dir="${FFMPEG_BUILD_DIR:-$(mktemp -d)}"
mkdir -p "${build_dir}"
build_dir="$(cd "${build_dir}" && pwd)"
jobs="${FFMPEG_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) echo "unsupported build host $(uname -s)" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch_ffmpeg() {
  local tarball="${build_dir}/ffmpeg-${FFMPEG_VERSION}.tar.xz"
  if [[ ! -f "${tarball}" ]]; then
    curl -fsSL --retry 3 -o "${tarball}" "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
  fi
  local got
  got="$(sha256 "${tarball}")"
  if [[ "${got}" != "${FFMPEG_SHA256}" ]]; then
    echo "ERROR: ffmpeg tarball checksum ${got} != ${FFMPEG_SHA256}" >&2
    exit 1
  fi
  rm -rf "${build_dir}/ffmpeg-src"
  mkdir -p "${build_dir}/ffmpeg-src"
  tar -xJf "${tarball}" -C "${build_dir}/ffmpeg-src" --strip-components=1
}

# Commas are ffmpeg's own list syntax inside each flag, not array separators.
# shellcheck disable=SC2054
common_flags=(
  --disable-everything
  --disable-autodetect
  --disable-programs --enable-ffmpeg
  --disable-doc --disable-network --disable-debug
  --enable-static --disable-shared
  --enable-avdevice --enable-indev=lavfi
  --enable-avfilter --enable-swscale --enable-swresample
  --enable-protocol=file,pipe
  # What a customer's video can come in.
  --enable-demuxer=asf,avi,matroska,flv,live_flv,mpegps,mpegts,mpegvideo,mov,ogg,dv,h264,hevc,m4v,mp3,aac,ac3,wav
  # MPEG-TS for a stream, MP4 for a copy; ASF and Matroska to lengthen test clips.
  --enable-muxer=mpegts,mp4,mov,null,asf,matroska
  # Old formats only. No h264, hevc, svq3, prores: H.264 and HEVC are copied, never decoded.
  --enable-decoder=vc1,vc1image,wmv1,wmv2,wmv3,wmv3image,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,h263,h263p,flv,vp6,vp6a,vp6f,vp8,vp9,theora,mjpeg,dvvideo,cinepak,msvideo1,rawvideo,wrapped_avframe
  # No aac, aac_latm, eac3, dca, truehd, mlp, amrnb, amrwb, wmavoice.
  --enable-decoder=mp1,mp2,mp3,mp3float,ac3,wmav1,wmav2,wmapro,wmalossless,flac,opus,vorbis,alac,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw,pcm_dvd,pcm_bluray,adpcm_ms,adpcm_ima_wav
  # Not codecs: what `-f null` needs. The real encoders are the OS's, below.
  --enable-encoder=wrapped_avframe,pcm_s16le
  # Parsers and bitstream filters read stream headers; they decode nothing.
  --enable-parser=h264,hevc,vc1,mpegvideo,mpeg4video,aac,ac3,mpegaudio,flac,opus,vorbis,vp8,vp9,h263,mjpeg
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,mpeg4_unpack_bframes,vp9_superframe
  --enable-filter=scale,setsar,format,aformat,aresample,fps,null,anull,bwdif,setpts,asetpts,testsrc2,sine,hwdownload
)

configure_and_build() {
  local arch="$1" out="$2"
  local obj="${build_dir}/obj-${arch}"
  local exe="ffmpeg"
  [[ "${os}" == windows ]] && exe="ffmpeg.exe"
  rm -rf "${obj}"
  mkdir -p "${obj}"
  local flags=("${common_flags[@]}")
  local extra_cflags="" extra_ldflags=""
  case "${os}" in
    macos)
      # shellcheck disable=SC2054
      flags+=(--enable-videotoolbox --enable-audiotoolbox --enable-zlib
        --enable-encoder=h264_videotoolbox,aac_at
        --enable-hwaccel=mpeg2_videotoolbox,mpeg4_videotoolbox)
      extra_cflags="-mmacosx-version-min=11.0"
      extra_ldflags="-mmacosx-version-min=11.0"
      if [[ "${arch}" != "$(uname -m)" ]]; then
        flags+=(--enable-cross-compile --arch="${arch}" --target-os=darwin)
        extra_cflags+=" -arch ${arch}"
        extra_ldflags+=" -arch ${arch}"
      fi
      if [[ "${arch}" == x86_64 ]]; then
        # Without nasm the x86 SIMD is skipped; slower but still correct.
        command -v nasm >/dev/null 2>&1 || flags+=(--disable-x86asm)
      fi
      ;;
    linux)
      flags+=(--enable-zlib)
      command -v nasm >/dev/null 2>&1 || flags+=(--disable-x86asm)
      ;;
    windows)
      # shellcheck disable=SC2054
      flags+=(--enable-mediafoundation --enable-d3d11va --enable-dxva2 --enable-zlib
        --enable-encoder=h264_mf,aac_mf
        --enable-hwaccel=vc1_d3d11va,wmv3_d3d11va,mpeg2_d3d11va)
      extra_ldflags="-static"
      ;;
  esac
  # Never let a Homebrew or system .pc file add a library to the build.
  export PKG_CONFIG_PATH=""
  printf '%s\n' "${flags[@]}" >"${build_dir}/configure-flags-${os}-${arch}.txt"
  (
    cd "${obj}"
    "${build_dir}/ffmpeg-src/configure" "${flags[@]}" \
      --pkg-config-flags=--static \
      --extra-cflags="${extra_cflags}" --extra-ldflags="${extra_ldflags}" >&2
    # The make target carries the executable suffix (ffmpeg.exe on Windows).
    make -j"${jobs}" "${exe}" >&2
  )
  cp "${obj}/${exe}" "${out}"
  strip "${out}" 2>/dev/null || true
}

fetch_ffmpeg

triple="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"
suffix=""
[[ "${os}" == windows ]] && suffix=".exe"
built="${build_dir}/hippius-ffmpeg${suffix}"

if ((universal)); then
  if [[ "${os}" != macos ]]; then echo "--universal is macOS only" >&2; exit 2; fi
  configure_and_build arm64 "${build_dir}/hippius-ffmpeg-arm64"
  configure_and_build x86_64 "${build_dir}/hippius-ffmpeg-x86_64"
  lipo -create -output "${built}" "${build_dir}/hippius-ffmpeg-arm64" "${build_dir}/hippius-ffmpeg-x86_64"
  triple="universal-apple-darwin"
else
  configure_and_build "$(uname -m)" "${built}"
fi

# Refuse a build that is not what this script promises: GPL or nonfree code,
# a decoder or encoder for a patent-pooled codec, any encoder that is not the
# operating system's, or a missing one the preview depends on.
conf="$("${built}" -hide_banner -buildconf 2>&1 || true)"
if grep -Eq -- '--enable-(gpl|nonfree|version3|libopenh264|libx26[45])' <<<"${conf}"; then
  echo "ERROR: the engine was configured with a GPL, nonfree or third-party encoder flag" >&2
  exit 1
fi
codec_names() { "${built}" -hide_banner "$1" 2>/dev/null | awk 'p && NF >= 2 {print $2} /^ *-+$/ {p=1}'; }
decoders="$(codec_names -decoders)"
for banned in h264 hevc svq3 prores aac aac_fixed aac_latm eac3 dca truehd mlp amrnb amrwb wmavoice; do
  if grep -qx "${banned}" <<<"${decoders}"; then
    echo "ERROR: decoder ${banned} is in the engine" >&2
    exit 1
  fi
done
case "${os}" in
  macos) allowed_encoders="h264_videotoolbox aac_at" ;;
  windows) allowed_encoders="h264_mf aac_mf" ;;
  linux) allowed_encoders="" ;;
esac
encoders="$(codec_names -encoders)"
for encoder in ${encoders}; do
  case " ${allowed_encoders} wrapped_avframe pcm_s16le " in
    *" ${encoder} "*) ;;
    *) echo "ERROR: encoder ${encoder} is in the engine; only the OS's own are allowed" >&2; exit 1 ;;
  esac
done
for needed in ${allowed_encoders}; do
  grep -qx "${needed}" <<<"${encoders}" || { echo "ERROR: encoder ${needed} missing" >&2; exit 1; }
done
printf '%s\n' "${conf}" >"${build_dir}/hippius-ffmpeg-buildconf-${triple}.txt"

dest_dir="${repo_root}/src-tauri/binaries"
mkdir -p "${dest_dir}"
cp -f "${built}" "${dest_dir}/hippius-ffmpeg-${triple}${suffix}"
if ((universal)); then
  # A universal Tauri build compiles each architecture on its own, and each
  # of those looks for its own triple's sidecar too.
  cp -f "${build_dir}/hippius-ffmpeg-arm64" "${dest_dir}/hippius-ffmpeg-aarch64-apple-darwin"
  cp -f "${build_dir}/hippius-ffmpeg-x86_64" "${dest_dir}/hippius-ffmpeg-x86_64-apple-darwin"
fi
echo "engine: ${dest_dir}/hippius-ffmpeg-${triple}${suffix} ($(wc -c <"${built}" | tr -d ' ') bytes)" >&2
if ((!universal)); then
  target_root="${CARGO_TARGET_DIR:-${repo_root}/src-tauri/target}"
  for profile in debug release; do
    if [[ -d "${target_root}/${profile}" ]]; then
      cp -f "${built}" "${target_root}/${profile}/hippius-ffmpeg${suffix}"
      echo "copied engine to ${target_root}/${profile}/hippius-ffmpeg${suffix}" >&2
    fi
  done
fi
echo "${built}"
