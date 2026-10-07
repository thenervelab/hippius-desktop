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
vi.mock("@tauri-apps/api/core", () => tauri.core);
vi.mock("@tauri-apps/api/event", () => tauri.event);

const opener = vi.hoisted(() => ({ openPath: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

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
}));
vi.mock("@/app/components/page-sections/drive/files-table/VideoPlayer", () => ({
  default: ({
    videoUrl,
    onPlaybackStarted,
    onPlaybackFailed,
  }: {
    videoUrl: string;
    onPlaybackStarted?: () => void;
    onPlaybackFailed?: () => void;
  }) => {
    player.started = onPlaybackStarted;
    player.failed = onPlaybackFailed;
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
const START_FAILED = "This video didn't start in Hippius. Open it in your video player, or download it.";
const DECODER_LINE =
  "Videos need an H.264 decoder your system doesn't have. Install gstreamer1.0-libav, then restart Hippius.";

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
  opener.openPath.mockClear();
  player.started = undefined;
  player.failed = undefined;
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
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stream();
    const { unmount } = render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toHaveTextContent(STREAM_URL);
    act(() => player.started?.());
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByTestId("video-player")).toBeInTheDocument();
    expect(screen.queryByText(START_FAILED)).toBeNull();
    // Closing the viewer gives the token back.
    unmount();
    await waitFor(() =>
      expect(tauri.core.invoke).toHaveBeenCalledWith("video_stream_release", { url: STREAM_URL }),
    );
  });

  it("falls back to the system player when no frame arrives in time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stream();
    const download = vi.fn();
    render(<VideoPreviewBody file={file} handleFileDownload={download} />);
    await screen.findByTestId("video-player");
    act(() => {
      vi.advanceTimersByTime(8_001);
    });
    expect(await screen.findByText(START_FAILED)).toBeInTheDocument();
    expect(screen.queryByTestId("video-player")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open in your video player/ }));
    await waitFor(() => expect(opener.openPath).toHaveBeenCalledWith("/drive/Captures/Recording.mp4"));
    fireEvent.click(screen.getByRole("button", { name: /Download File/ }));
    expect(download).toHaveBeenCalledWith(file, "5Test");
  });

  it("falls back at once when the player errors", async () => {
    stream();
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    await screen.findByTestId("video-player");
    act(() => player.failed?.());
    expect(await screen.findByText(START_FAILED)).toBeInTheDocument();
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
