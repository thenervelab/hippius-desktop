import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onTauriEvent } from "@/lib/utils/tauriListeners";

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

/**
 * How Rust says to preview a video the webview may not play
 * (`video_preview_open`, `src-tauri/src/video_engine/`). `native`: the
 * existing path above. `file`: a converted copy at `path`, played like any
 * local video. `stream`: an HLS playlist whose segments Rust converts on
 * request (`hlsIpcLoader.ts`). `unsupported`: no player, Rust's line.
 */
export type VideoPreview =
  | { kind: "native" }
  | { kind: "file"; path: string }
  | { kind: "stream"; url: string; durationSecs: number }
  | { kind: "unsupported"; message: string };

/** What the viewer shows while Rust prepares, and then what it plays. */
export type VideoPreviewState =
  | { status: "idle" }
  | { status: "preparing"; percent: number | null }
  | { status: "ready"; preview: VideoPreview }
  | { status: "failed" };

/** Rust's progress event for a converted copy (`PROGRESS_EVENT`). */
const PROGRESS_EVENT = "video-preview-progress";

function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Ask Rust how to preview the file at `localPath`. `webviewFailed` is set
 * once the webview's own player errored on the file, which lets Rust convert
 * an MP4/MOV too. The preview is closed (its engine stopped, its converted
 * copy deleted) when the file changes or the viewer closes.
 */
export function useVideoPreview(localPath: string, webviewFailed: boolean): VideoPreviewState {
  const [state, setState] = useState<VideoPreviewState>({ status: "idle" });
  useEffect(() => {
    if (!localPath) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "preparing", percent: null });
    const sessionId = newSessionId();
    let cancelled = false;
    const stopProgress = onTauriEvent<{ sessionId: string; percent: number }>(PROGRESS_EVENT, (e) => {
      if (e.payload?.sessionId !== sessionId || cancelled) return;
      setState({ status: "preparing", percent: e.payload.percent });
    });
    invoke<VideoPreview>("video_preview_open", { sourcePath: localPath, sessionId, webviewFailed })
      .then((preview) => {
        if (!cancelled) setState({ status: "ready", preview });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("Failed to prepare the video preview:", err);
        setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
      stopProgress();
      void invoke("video_preview_close", { sessionId }).catch(() => {});
    };
  }, [localPath, webviewFailed]);
  return state;
}
