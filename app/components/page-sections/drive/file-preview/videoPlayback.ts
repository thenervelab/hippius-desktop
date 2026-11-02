import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// How the app plays a video file, apart from the viewer that draws it, so
// the Insights panel's preview plays a recording the same way without
// loading the full viewer.

/**
 * How Rust says to play a video (`video_playback_source`, `video_stream.rs`).
 * `webview`: the asset URL (macOS, Windows). `stream`: a loopback URL
 * (Linux, where WebKitGTK cannot play media from `asset://`), with how long
 * the player may take to show a frame and the line to show if it does not.
 * `decoderMissing` / `unavailable`: no player, Rust's line instead.
 */
export type VideoPlayback =
  | { kind: "webview" }
  | { kind: "stream"; url: string; startWithinMs: number; startFailedMessage: string }
  | { kind: "decoderMissing"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * Ask Rust how to play the file at `localPath`; `null` until it answers. A
 * stream's token is released when the viewer moves on or closes.
 */
export function useVideoPlayback(localPath: string): { playback: VideoPlayback | null; failed: boolean } {
  const [state, setState] = useState<{ playback: VideoPlayback | null; failed: boolean }>({
    playback: null,
    failed: false,
  });
  useEffect(() => {
    setState({ playback: null, failed: false });
    if (!localPath) return;
    let cancelled = false;
    let streamUrl: string | null = null;
    invoke<VideoPlayback>("video_playback_source", { sourcePath: localPath })
      .then((playback) => {
        if (playback?.kind === "stream") streamUrl = playback.url;
        if (cancelled) {
          if (streamUrl) void invoke("video_stream_release", { url: streamUrl }).catch(() => {});
          return;
        }
        setState({ playback, failed: false });
      })
      .catch((err: unknown) => {
        console.error("Failed to prepare the video for playback:", err);
        if (!cancelled) setState({ playback: null, failed: true });
      });
    return () => {
      cancelled = true;
      if (streamUrl) void invoke("video_stream_release", { url: streamUrl }).catch(() => {});
    };
  }, [localPath]);
  return state;
}
