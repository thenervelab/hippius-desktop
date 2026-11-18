#!/usr/bin/env bash
# Attach to a GitHub release the exact source the bundled video engine was
# built from: the ffmpeg source tarball (checksum-pinned in build-ffmpeg.sh),
# the build script itself, and each platform's configure flags and
# `-buildconf` record. This is the LGPL's "corresponding source", offered
# beside the installers it belongs to.
#
#   attach-source.sh <release tag> <FFMPEG_BUILD_DIR used for the build>
#
# Every OS job runs it after its build; the tarball and the script are the
# same on all three, so --clobber just replaces them with identical files.
set -euo pipefail

tag="${1:?usage: attach-source.sh <release tag> <build dir>}"
build_dir="${2:?usage: attach-source.sh <release tag> <build dir>}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp -f "${script_dir}/build-ffmpeg.sh" "${build_dir}/hippius-ffmpeg-build-ffmpeg.sh"
shopt -s nullglob
files=("${build_dir}"/ffmpeg-*.tar.xz "${build_dir}"/hippius-ffmpeg-buildconf-*.txt "${build_dir}"/configure-flags-*.txt)
if ((${#files[@]} < 3)); then
  echo "::error::the engine's source tarball or build records are missing from ${build_dir}"
  exit 1
fi
gh release upload "${tag}" "${files[@]}" "${build_dir}/hippius-ffmpeg-build-ffmpeg.sh" --clobber
echo "attached the video engine's source to ${tag}: ${files[*]##*/}"
