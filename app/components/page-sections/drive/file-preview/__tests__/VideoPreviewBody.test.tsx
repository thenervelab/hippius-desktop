import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

/**
 * Linux plays no video in the viewer (Rust's `supportsInAppVideo` is false:
 * WebKitGTK showed a screen recording as a black frame with a spinner), so
 * the viewer offers the system's video player and Download instead, like
 * the Linux PDF path. macOS and Windows keep the built-in player.
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

vi.mock("@/app/components/page-sections/drive/files-table/VideoPlayer", () => ({
  default: ({ videoUrl }: { videoUrl: string }) => <div data-testid="video-player">{videoUrl}</div>,
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

function platform(supportsInAppVideo: boolean) {
  tauri.onInvoke("get_platform_info", () => ({
    os: supportsInAppVideo ? "macos" : "linux",
    supportsInAppVideo,
  }));
}

beforeEach(() => {
  tauri.reset();
  opener.openPath.mockClear();
  resolved.value = {
    url: "asset://localhost/drive/Captures/Recording.mp4",
    localPath: "/drive/Captures/Recording.mp4",
    isLoading: false,
    error: null,
  };
});

describe("VideoPreviewBody", () => {
  it("keeps the built-in player where the webview plays video", async () => {
    platform(true);
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByTestId("video-player")).toBeInTheDocument();
    expect(screen.queryByText("Open in your video player")).toBeNull();
  });

  it("offers the system video player and Download on Linux, never the player", async () => {
    platform(false);
    const download = vi.fn();
    render(<VideoPreviewBody file={file} handleFileDownload={download} />);
    const open = await screen.findByRole("button", { name: /Open in your video player/ });
    expect(screen.queryByTestId("video-player")).toBeNull();
    fireEvent.click(open);
    await waitFor(() => expect(opener.openPath).toHaveBeenCalledWith("/drive/Captures/Recording.mp4"));
    fireEvent.click(screen.getByRole("button", { name: /Download File/ }));
    expect(download).toHaveBeenCalledWith(file, "5Test");
  });

  // A cloud-only recording is fetched into the preview cache first; until
  // then the button waits rather than opening nothing.
  it("waits for a cloud-only file before opening it", async () => {
    platform(false);
    resolved.value = { url: "", localPath: "", isLoading: true, error: null };
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    const open = await screen.findByRole("button", { name: /Open in your video player/ });
    expect(open).toBeDisabled();
    expect(screen.getByText("Getting the video ready to open…")).toBeInTheDocument();
    fireEvent.click(open);
    expect(opener.openPath).not.toHaveBeenCalled();
  });

  it("says why when the file could not be fetched, and still offers Download", async () => {
    platform(false);
    resolved.value = { url: "", localPath: "", isLoading: false, error: "This file can't be previewed." };
    render(<VideoPreviewBody file={file} handleFileDownload={vi.fn()} />);
    expect(await screen.findByText("This file can't be previewed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open in your video player/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Download File/ })).toBeInTheDocument();
  });
});
