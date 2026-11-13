# Third-party notices

Hippius includes the following third-party software. This file and the
licence texts in `licenses/` are installed with the app.

## FFmpeg

Hippius ships a separate program, `hippius-ffmpeg`, built from FFmpeg, to
preview videos the built-in player cannot play. It runs as its own process
and is not linked into Hippius.

- Version: FFmpeg 8.1.3
- Licence: GNU Lesser General Public License, version 2.1 or later
  (`licenses/LGPL-2.1.txt`). It is built without any GPL or nonfree
  component.
- Copyright: the FFmpeg developers, https://ffmpeg.org
- Exact source: https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz
  (SHA-256 `7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3`)
- How it is built: `scripts/video-engine/build-ffmpeg.sh` in
  https://github.com/thenervelab/hippius-desktop. Every Hippius release on
  https://github.com/thenervelab/hippius-desktop/releases carries the source
  tarball, that script and each platform's configuration as release assets,
  so the program can be rebuilt and replaced.

## hls.js

The file viewer plays converted videos with hls.js.

- Licence: Apache License 2.0 (`licenses/hls.js-LICENSE.txt`)
- Copyright: Dailymotion and the hls.js contributors,
  https://github.com/video-dev/hls.js
