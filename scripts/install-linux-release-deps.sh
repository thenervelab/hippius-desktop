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

# A mirror that stops answering used to hang apt until the job's timeout
# cancelled it. Give each request a timeout and retry it, so a stalled
# mirror fails over in seconds instead.
echo 'Acquire::Retries "5"; Acquire::http::Timeout "30"; Acquire::https::Timeout "30";' |
  sudo tee /etc/apt/apt.conf.d/80-hippius-retries >/dev/null

sudo apt-get update
sudo apt-get install -y libunwind-dev
sudo apt-get install -y \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgstreamer1.0-dev \
  libgstreamer-plugins-base1.0-dev
