import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Rust decides how a video plays (`video_playback_source`): the asset URL on
 * macOS and Windows; on Linux a loopback stream (WebKitGTK cannot play media
 * from `asset://`), or no player with a line naming the package when there
 * is no H.264 decoder. A stream that errors or shows no frame in time falls
 * back to the system's video player and Download, never a spinner forever.
 */
const tauri = await vi.hoisted(async () => {
  const { makeTauriMock } = await import("@/app/lib/test-utils/tauriMock");
  return makeTauriMock();
});
vi.mock("@tauri-apps/api/core", () => ({
  ...tauri.core,
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));
vi.mock("@tauri-apps/api/event", () => tauri.event);


const resolved = vi.hoisted(() => ({
  value: { url: "", localPath: "", isLoading: false, error: null as string | null },
}));
vi.mock("@/app/lib/hooks/useViewableFileUrl", () => ({
  useViewableFileUrl: () => resolved.value,
  default: () => resolved.value,
}));

// The player stands in for vidstack: it shows its URL and hands the test its
// callbacks, so a test can play the first frame or an error.
const player = vi.hoisted(() => ({
  started: undefined as undefined | (() => void),
  failed: undefined as undefined | (() => void),
  stuttered: undefined as undefined | (() => void),
  hls: false,
}));
vi.mock("@/app/components/page-sections/drive/files-table/VideoPlayer", () => ({
  default: ({
    videoUrl,
    onPlaybackStarted,
    onPlaybackFailed,
    onPlaybackStuttered,
    hls,
  }: {
    videoUrl: string;
    onPlaybackStarted?: () => void;
    onPlaybackFailed?: () => void;
    onPlaybackStuttered?: () => void;
    hls?: boolean;
  }) => {
    player.hls = Boolean(hls);
    player.started = onPlaybackStarted;
    player.failed = onPlaybackFailed;
    player.stuttered = onPlaybackStuttered;
    return <div data-testid="video-player">{videoUrl}</div>;
  },
}));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Test" }),
}));

import VideoPreviewBody from "../VideoPreviewBody";

const file = {
  name: "Recording 2026-10-02 at 10.00.00.mp4",
  actualFileName: "Recording 2026-10-02 at 10.00.00.mp4",
  source: "/drive/Captures/Recording.mp4",
  label: "drive",
  syncStatus: "synced",
} as unknown as FormattedUserFile;

const STREAM_URL = `http://127.0.0.1:40123/v/${"a".repeat(64)}`;
const STUTTER_LINE = "Not playing smoothly? Your video player may play it better.";
const START_FAILED = "This video didn't start in Hippius. Open it in your video player, or download it.";
const DECODER_LINE =
  "Videos need an H.264 decoder your system doesn't have. Install gstreamer1.0-libav, then restart Hippius.";

// Lets the IPC answer land without moving the fake clock, so a slow runner
// can never push the start watchdog past its deadline before the test looks.
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function stream() {
  tauri.onInvoke("video_playback_source", () => ({
    kind: "stream",
    url: STREAM_URL,
    startWithinMs: 8000,
    startFailedMessage: START_FAILED,
  }));
}

beforeEach(() => {
  tauri.reset();
  tauri.onInvoke("video_stream_release", () => undefined);
  // Opened through Rust, which checks the file is in a synced folder.
  tauri.onInvoke("open_in_default_app", () => null);
  player.started = undefined;
  player.failed = undefined;
  player.stuttered = undefined;
  player.hls = false;
  tauri.onInvoke("video_preview_close", () => undefined);
  // Rust's answer for an MP4: the webview plays it; once that failed, no
  // engine in this test can convert it either.
  tauri.onInvoke("video_preview_open", (args) =>
    (args as { webviewFailed: boolean }).webviewFailed
      ? { kind: "unsupported", message: "This video can't be previewed. Download it to play it." }
      : { kind: "native" },
  );
  resolved.value = {
    url: "asset://localhost/drive/Captures/Recording.mp4",
    localPath: "/drive/Captures/Recording.mp4",
    isLoading: false,
    error: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("VideoPreviewBody", () => {
  it("plays the asset URL where the webview plays video", async () => {
    tauri.onInvoke("video_playback_source", () => ({ kind: "webview" }));
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toHaveTextContent(
      "asset://localhost/drive/Captures/Recording.mp4",
    );
    expect(tauri.core.invoke).toHaveBeenCalledWith("video_playback_source", {
      sourcePath: "/drive/Captures/Recording.mp4",
    });
    // No watchdog off Linux: the player keeps its own error handling.
    expect(player.started).toBeUndefined();
    expect(screen.queryByText("Open in your video player")).toBeNull();
  });

  it("plays the loopback stream on Linux and keeps playing once a frame arrives", async () => {
    vi.useFakeTimers();
    stream();
    const { unmount } = render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    await settle();
    expect(screen.getByTestId("video-player")).toHaveTextContent(STREAM_URL);
    act(() => player.started?.());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByTestId("video-player")).toBeInTheDocument();
    expect(screen.queryByText(START_FAILED)).toBeNull();
    vi.useRealTimers();
    // Closing the viewer gives the token back.
    unmount();
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("video_stream_release", { url: STREAM_URL }),
    );
  });

  it("falls back to the system player when no frame arrives in time", async () => {
    vi.useFakeTimers();
    stream();
    const download = vi.fn();
    render(<VideoPreviewBody file={file} handleFileDownload={download} />);
    await settle();
    expect(screen.getByTestId("video-player")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(7_999);
    });
    expect(screen.getByTestId("video-player")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    // The conversion is tried first (no engine here), then the fallback.
    await settle();
    await settle();
    expect(screen.getByText(START_FAILED)).toBeInTheDocument();
    vi.useRealTimers();
    expect(screen.queryByTestId("video-player")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open in your video player/ }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("open_in_default_app", { path: "/drive/Captures/Recording.mp4" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Download File/ }));
    expect(download).toHaveBeenCalledWith(file, "5Test");
  });

  it("offers the system player beside a stream that keeps stopping, and keeps playing", async () => {
    stream();
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    await screen.findByTestId("video-player");
    act(() => player.started?.());
    expect(screen.queryByText(STUTTER_LINE)).toBeNull();
    await waitFor(() => {
      act(() => player.stuttered?.());
      expect(screen.getByText(STUTTER_LINE)).toBeInTheDocument();
    });
    // Beside the player, not instead of it.
    expect(screen.getByTestId("video-player")).toHaveTextContent(STREAM_URL);
    fireEvent.click(screen.getByRole("button", { name: "Open in your video player" }));
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("open_in_default_app", { path: "/drive/Captures/Recording.mp4" }),
    );
  });

  it("never offers it where the webview plays the file itself", async () => {
    tauri.onInvoke("video_playback_source", () => ({ kind: "webview" }));
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    await screen.findByTestId("video-player");
    expect(player.stuttered).toBeUndefined();
  });

  it("falls back at once when the player errors", async () => {
    stream();
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    await screen.findByTestId("video-player");
    // The player hands over a fresh callback on every render; on a slow
    // runner the one read first can be stale, so report until it lands.
    await waitFor(() => {
      act(() => player.failed?.());
      expect(screen.getByText(START_FAILED)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Open in your video player/ })).toBeEnabled();
  });

  it("says which package to install when there is no H.264 decoder, and never mounts the player", async () => {
    tauri.onInvoke("video_playback_source", () => ({ kind: "decoderMissing", message: DECODER_LINE }));
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByText(DECODER_LINE)).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(screen.getByRole("button", { name: /Open in your video player/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download File/ })).toBeInTheDocument();
  });

  it("offers the system player when Rust refuses the file", async () => {
    tauri.onInvoke("video_playback_source", () => {
      throw { kind: "Validation", message: "outside" };
    });
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(
      await screen.findByText("This video can't be played here. Open it in your video player, or download it."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).toBeNull();
  });

  // A cloud-only video is fetched into the preview cache first; Rust is asked
  // only once there is a local copy.
  it("waits for a cloud-only file before asking how to play it", async () => {
    stream();
    resolved.value = { url: "", localPath: "", isLoading: true, error: null };
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(screen.getByText("Loading video…")).toBeInTheDocument();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("video_playback_source", expect.anything());
  });

  it("says why when the file could not be fetched, and still offers Download", async () => {
    resolved.value = { url: "", localPath: "", isLoading: false, error: "This file can't be previewed." };
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByText("This file can't be previewed.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download File/ })).toBeInTheDocument();
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("video_playback_source", expect.anything());
  });
});

/**
 * Videos the webview cannot play (WMV, AVI, MKV, ...): Rust converts them
 * (`video_preview_open`, `src-tauri/src/video_engine/`) into a copy or an
 * HLS stream, and says when it cannot.
 */
describe("VideoPreviewBody conversion", () => {
  const wmv = {
    ...file,
    name: "Holiday.wmv",
    actualFileName: "Holiday.wmv",
    source: "/drive/Holiday.wmv",
  } as unknown as FormattedUserFile;
  const HLS_URL = "hippius-video://s1/index.m3u8";

  beforeEach(() => {
    resolved.value = {
      url: "asset://localhost/drive/Holiday.wmv",
      localPath: "/drive/Holiday.wmv",
      isLoading: false,
      error: null,
    };
  });

  it("plays a WMV as a converted stream, says it is preparing until the first frame, and closes it", async () => {
    let sessionId = "";
    tauri.onInvoke("video_preview_open", (args) => {
      const a = args as { sourcePath: string; sessionId: string; webviewFailed: boolean };
      expect(a.sourcePath).toBe("/drive/Holiday.wmv");
      expect(a.webviewFailed).toBe(false);
      sessionId = a.sessionId;
      return { kind: "stream", url: HLS_URL, durationSecs: 600 };
    });
    const { unmount } = render(<VideoPreviewBody file={wmv} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toHaveTextContent(HLS_URL);
    expect(player.hls).toBe(true);
    expect(screen.getByText("Preparing preview…")).toBeInTheDocument();
    // The original file is never handed to the webview.
    expect(tauri.core.invoke).not.toHaveBeenCalledWith("video_playback_source", expect.anything());
    await waitFor(() => {
      act(() => player.started?.());
      expect(screen.queryByText("Preparing preview…")).toBeNull();
    });
    unmount();
    await waitFor(() => expect(tauri.core.invoke).toHaveBeenCalledWith("video_preview_close", { sessionId }));
    expect(sessionId).not.toBe("");
  });

  it("shows the copy's progress, then plays the converted copy like any local video", async () => {
    let finish: (v: unknown) => void = () => {};
    let sessionId = "";
    tauri.onInvoke("video_preview_open", (args) => {
      sessionId = (args as { sessionId: string }).sessionId;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    tauri.onInvoke("video_playback_source", () => ({ kind: "webview" }));
    render(<VideoPreviewBody file={wmv} handleFileDownload={vi.fn()} />);
    expect(await screen.findByText("Loading video…")).toBeInTheDocument();
    await waitFor(() => expect(sessionId).not.toBe(""));
    // Another preview's progress is not this one's.
    await act(async () => {
      await tauri.emitEvent("video-preview-progress", { sessionId: "other", percent: 90 });
      await tauri.emitEvent("video-preview-progress", { sessionId, percent: 42 });
    });
    expect(screen.getByText("Preparing preview… 42%")).toBeInTheDocument();
    await act(async () => {
      finish({ kind: "file", path: "/home/.hippius/preview-cache/converted/s.mp4" });
    });
    expect(await screen.findByTestId("video-player")).toHaveTextContent(
      "asset://localhost/home/.hippius/preview-cache/converted/s.mp4",
    );
    expect(player.hls).toBe(false);
    expect(tauri.core.invoke).toHaveBeenCalledWith("video_playback_source", {
      sourcePath: "/home/.hippius/preview-cache/converted/s.mp4",
    });
  });

  it("says beside the player when the video plays without its sound", async () => {
    const NOTICE = "Playing without sound: Hippius can't play this video's audio track.";
    tauri.onInvoke("video_preview_open", () => ({
      kind: "file",
      path: "/home/.hippius/preview-cache/converted/s.mp4",
      notice: NOTICE,
    }));
    tauri.onInvoke("video_playback_source", () => ({ kind: "webview" }));
    render(<VideoPreviewBody file={wmv} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toBeInTheDocument();
    expect(screen.getByText(NOTICE)).toHaveAttribute("role", "status");
  });

  it("shows no line when the sound plays", async () => {
    tauri.onInvoke("video_preview_open", () => ({ kind: "stream", url: HLS_URL, durationSecs: 60, notice: null }));
    render(<VideoPreviewBody file={wmv} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toBeInTheDocument();
    expect(screen.queryByText(/Playing without sound/)).toBeNull();
  });

  it("says plainly when the video cannot be previewed and offers Download", async () => {
    tauri.onInvoke("video_preview_open", () => ({
      kind: "unsupported",
      message: "This video can't be previewed. Download it to play it.",
    }));
    const download = vi.fn();
    render(<VideoPreviewBody file={wmv} handleFileDownload={download} />);
    expect(await screen.findByText("This video can't be previewed. Download it to play it.")).toBeInTheDocument();
    expect(screen.getByText("Can't preview this video")).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Download File/ }));
    expect(download).toHaveBeenCalledWith(wmv, "5Test");
  });

  it("converts an MP4 the webview failed to play, and falls back if that fails too", async () => {
    const calls: boolean[] = [];
    tauri.onInvoke("video_preview_open", (args) => {
      const { webviewFailed } = args as { webviewFailed: boolean };
      calls.push(webviewFailed);
      return webviewFailed ? { kind: "stream", url: HLS_URL, durationSecs: 60 } : { kind: "native" };
    });
    tauri.onInvoke("video_playback_source", () => ({ kind: "webview" }));
    resolved.value = {
      url: "asset://localhost/drive/Captures/Recording.mp4",
      localPath: "/drive/Captures/Recording.mp4",
      isLoading: false,
      error: null,
    };
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toHaveTextContent(
      "asset://localhost/drive/Captures/Recording.mp4",
    );
    // HEVC on Windows: the webview's player errors.
    act(() => player.failed?.());
    await waitFor(() => expect(screen.getByTestId("video-player")).toHaveTextContent(HLS_URL));
    expect(calls).toEqual([false, true]);
    // The converted stream fails as well: no loop, the fallback.
    await waitFor(() => {
      act(() => player.failed?.());
      expect(screen.getByText("This video can't be previewed. Download it to play it.")).toBeInTheDocument();
    });
    expect(calls).toEqual([false, true]);
  });
});
