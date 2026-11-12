#!/usr/bin/env bash
# Build the video preview engine: a small LGPL ffmpeg the viewer runs as a
# child process to convert videos the webview cannot play (WMV, AVI, MKV,
# MPEG-2, ...) into H.264 + AAC (src-tauri/src/video_engine/).
#
#   build-ffmpeg.sh                 host build (development, tests)
#   build-ffmpeg.sh --universal     macOS arm64 + x86_64 (release)
#
# Prints the built binary's path on stdout (logs go to stderr). The binary is
# also copied to src-tauri/binaries/hippius-ffmpeg-<target triple>[.exe],
# the name Tauri's `externalBin` (src-tauri/tauri.video-engine.conf.json)
# expects, and beside the cargo target's binaries, where a debug
# `pnpm tauri:dev` looks for it.
#
# Licensing: configured WITHOUT --enable-gpl, --enable-version3 or
# --enable-nonfree, so the result is LGPL 2.1+ and ships as a separate
# program, never linked into the app. The exact source (pinned tarball +
# checksum below) and this script are what the LGPL asks us to offer.
# The H.264 encoder is the operating system's (VideoToolbox on macOS, Media
# Foundation on Windows) or Cisco's BSD-licensed OpenH264 (Linux, and the
# software fallback elsewhere). x264 is GPL and is never used.
#
# Only the decoders, demuxers and filters the preview needs are compiled in,
# which keeps the binary a few MB and shrinks the attack surface: everything
# else is --disable-everything.
#
# Env:
#   FFMPEG_BUILD_DIR   where sources and objects go (default: a temp dir)
#   FFMPEG_JOBS        make -j (default: CPU count)
#   OPENH264=0         skip OpenH264 (default: built on Linux and Windows)
set -euo pipefail

FFMPEG_VERSION="8.1.3"
FFMPEG_SHA256="7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3"
OPENH264_VERSION="2.6.0"

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
jobs="${FFMPEG_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

case "$(uname -s)" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) echo "unsupported build host $(uname -s)" >&2; exit 1 ;;
esac

want_openh264="${OPENH264:-}"
if [[ -z "${want_openh264}" ]]; then
  if [[ "${os}" == macos ]]; then want_openh264=0; else want_openh264=1; fi
fi

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

# OpenH264 as a static library under ${build_dir}/prefix-<arch>.
build_openh264() {
  local prefix="$1"
  if [[ -f "${prefix}/lib/libopenh264.a" ]]; then return; fi
  local src="${build_dir}/openh264-${OPENH264_VERSION}"
  if [[ ! -d "${src}" ]]; then
    curl -fsSL --retry 3 -o "${build_dir}/openh264.tar.gz" \
      "https://github.com/cisco/openh264/archive/refs/tags/v${OPENH264_VERSION}.tar.gz"
    tar -xzf "${build_dir}/openh264.tar.gz" -C "${build_dir}"
  fi
  local os_flag=()
  if [[ "${os}" == windows ]]; then os_flag=(OS=mingw_nt); fi
  make -C "${src}" -j"${jobs}" ${os_flag[@]+"${os_flag[@]}"} PREFIX="${prefix}" install-static >&2
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
  # HLS for the stream, MP4 for a remux, the rest for test fixtures.
  --enable-muxer=hls,mpegts,mp4,mov,ipod,null,asf,avi,matroska,flv,mpeg1system,mpeg2vob
  --enable-decoder=h264,hevc,vc1,vc1image,wmv1,wmv2,wmv3,wmv3image,mpeg1video,mpeg2video,mpeg4,msmpeg4v1,msmpeg4v2,msmpeg4v3,h263,h263p,flv,vp6,vp6a,vp6f,vp8,vp9,theora,mjpeg,prores,dvvideo,svq3,cinepak,msvideo1,rawvideo,wrapped_avframe
  --enable-decoder=aac,aac_latm,mp1,mp2,mp3,mp3float,ac3,eac3,dca,truehd,mlp,flac,opus,vorbis,wmav1,wmav2,wmapro,wmalossless,wmavoice,alac,amrnb,amrwb,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw,pcm_dvd,pcm_bluray,adpcm_ms,adpcm_ima_wav
  # aac is the preview's audio; the others make test fixtures or decode to null.
  --enable-encoder=aac,wmv2,wmav2,mpeg2video,mpeg4,msmpeg4v3,flv,mp2,ac3,wrapped_avframe,pcm_s16le
  --enable-parser=h264,hevc,vc1,mpegvideo,mpeg4video,aac,aac_latm,ac3,mpegaudio,flac,opus,vorbis,vp8,vp9,dca,h263,mjpeg,mlp
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc,extract_extradata,mpeg4_unpack_bframes,vp9_superframe
  --enable-filter=scale,setsar,format,aformat,aresample,fps,null,anull,bwdif,setpts,asetpts,testsrc2,sine,hwdownload
)

configure_and_build() {
  local arch="$1" out="$2"
  local obj="${build_dir}/obj-${arch}"
  local exe="ffmpeg"
  [[ "${os}" == windows ]] && exe="ffmpeg.exe"
  local prefix="${build_dir}/prefix-${arch}"
  rm -rf "${obj}"
  mkdir -p "${obj}" "${prefix}"
  local flags=("${common_flags[@]}")
  local extra_cflags="" extra_ldflags=""
  case "${os}" in
    macos)
      # shellcheck disable=SC2054
      flags+=(--enable-videotoolbox --enable-zlib
        --enable-encoder=h264_videotoolbox,hevc_videotoolbox
        --enable-hwaccel=h264_videotoolbox,hevc_videotoolbox,mpeg2_videotoolbox,mpeg4_videotoolbox)
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
        --enable-encoder=h264_mf
        --enable-hwaccel=h264_d3d11va,hevc_d3d11va,vc1_d3d11va,wmv3_d3d11va,mpeg2_d3d11va)
      extra_ldflags="-static"
      ;;
  esac
  if [[ "${want_openh264}" == 1 ]]; then
    build_openh264 "${prefix}"
    flags+=(--enable-libopenh264 --enable-encoder=libopenh264)
    extra_cflags+=" -I${prefix}/include"
    extra_ldflags+=" -L${prefix}/lib"
    export PKG_CONFIG_PATH="${prefix}/lib/pkgconfig"
  else
    # Never let a Homebrew or system .pc file add a library to the build.
    export PKG_CONFIG_PATH=""
  fi
  (
    cd "${obj}"
    "${build_dir}/ffmpeg-src/configure" "${flags[@]}" \
      --pkg-config-flags=--static \
      --extra-cflags="${extra_cflags}" --extra-ldflags="${extra_ldflags}" \
      --extra-libs="$([[ "${want_openh264}" == 1 && "${os}" != windows ]] && echo "-lstdc++ -lm" || echo "")" >&2
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
# or a missing piece the preview depends on.
conf="$("${built}" -hide_banner -buildconf 2>&1 || true)"
if grep -Eq -- '--enable-(gpl|nonfree|version3)' <<<"${conf}"; then
  echo "ERROR: the engine was configured with a GPL/nonfree flag" >&2
  exit 1
fi
encoders="$("${built}" -hide_banner -encoders 2>/dev/null || true)"
needed_encoders=(aac)
case "${os}" in
  macos) needed_encoders+=(h264_videotoolbox) ;;
  windows) needed_encoders+=(h264_mf) ;;
esac
[[ "${want_openh264}" == 1 ]] && needed_encoders+=(libopenh264)
for needed in "${needed_encoders[@]}"; do
  grep -q " ${needed} " <<<"${encoders}" || { echo "ERROR: encoder ${needed} missing" >&2; exit 1; }
done

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
