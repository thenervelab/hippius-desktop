#!/usr/bin/env bash
# System packages the Linux release build needs, in one place for the three
# release workflows and the CI job that proves they install.
#
# The release builds run on ubuntu-22.04 (an older glibc, so the app runs on
# older distributions). There, libgstreamer1.0-dev depends on libunwind-dev,
# which conflicts with the image's preinstalled libunwind-14-dev. apt will
# not remove a package for an indirect dependency, so it stopped with "held
# broken packages". Asking for libunwind-dev by name lets apt replace the
# clashing package first.
set -euo pipefail

retry="$(dirname "$0")/apt-get-retry.sh"
bash "$retry" update
bash "$retry" install -y libunwind-dev
bash "$retry" install -y \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev
