// Pins the local-image thumbnail pipeline against the 13k-photo freeze.
//
// The bug: `useThumbnail`'s local branch resolved the url IMMEDIATELY —
// skipping the `enabled` (in-view) gate on the reasoning that "serving an
// on-disk path is free" — and the url it served was `convertFileSrc(<full
// size original>)`. Serving is free; fetching + decoding is not: the viewer
// filmstrip mounted a cell per file, so opening one photo in a 13,089-file
// camera folder kicked off ~30 GB of full-resolution image fetches through
// the asset protocol and froze the WebView (support ticket 142).
//
// The rules pinned here:
//  - nothing resolves until the cell is in view (`enabled`);
//  - a synced local image goes through the Rust `get_thumbnail` command —
//    the SAME pipeline cloud thumbnails use, which short-circuits to the
//    on-disk copy, decodes off the WebView, and disk-caches the small JPEG;
//  - the gate keys on `arionHash` (fileId as fallback): LOCAL listing rows
//    NEVER carry a fileId — Rust's `get_user_files` sets `file_id: ""` and
//    the nested mapper leaves it undefined — so a fileId-only gate silently
//    turns the whole Rust path into dead code (found in review; the fixture
//    below is production-shaped on purpose);
//  - formats a JPEG thumbnail would degrade, formats the Rust decoder is
//    not built with, and rows without ids keep the original url instead;
//  - a Rust failure degrades to the original url, loudly;
//  - a remount reuses the already-resolved url without a second IPC (the
//    virtualised filmstrip unmounts and remounts cells as it scrolls).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Test" }),
}));

import { useThumbnail } from "../useThumbnail";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const CACHE_PATH = "/Users/me/.hippius/thumbnail-cache/ahash_160.jpg";

// Production-shaped LOCAL row: arionHash set, fileId EMPTY — the shape every
// drive listing produces for a synced on-disk file.
const localJpg = (arionHash: string, name = "pic.jpg") =>
  ({
    name,
    actualFileName: name,
    source: "/Users/me/Hippius/pic.jpg",
    syncStatus: "synced",
    fileId: "",
    label: "Camera Uploads",
    arionHash,
  }) as FormattedUserFile;

const ORIGINAL_URL = "asset://localhost//Users/me/Hippius/pic.jpg";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(CACHE_PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useThumbnail local-image gating", () => {
  it("resolves nothing while the cell is off-screen (enabled: false)", () => {
    const { result } = renderHook(() =>
      useThumbnail(localJpg("hash-gate"), { enabled: false, maxDim: 160 }),
    );

    expect(result.current.url).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes an in-view synced jpg (arionHash, NO fileId) through the Rust thumbnailer", async () => {
    const { result } = renderHook(() =>
      useThumbnail(localJpg("hash-route"), { enabled: true, maxDim: 160 }),
    );

    await waitFor(() =>
      expect(result.current.url).toBe(`asset://localhost/${CACHE_PATH}`),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_thumbnail", {
      accountId: "5Test",
      label: "Camera Uploads",
      fileId: "",
      arionHash: "hash-route",
      source: "/Users/me/Hippius/pic.jpg",
      maxDim: 160,
    });
    expect(result.current.error).toBeNull();
  });

  it("keeps the original url for formats a JPEG thumbnail would degrade", () => {
    const { result } = renderHook(() =>
      useThumbnail(localJpg("hash-png", "shot.png"), { enabled: true, maxDim: 160 }),
    );

    expect(result.current.url).toBe(ORIGINAL_URL);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the original url for formats the Rust decoder is not built with", () => {
    // Cargo.toml pins the image crate to jpeg+png+bmp; a tiff request is a
    // guaranteed decode error, so it must not be issued at all.
    const { result } = renderHook(() =>
      useThumbnail(localJpg("hash-tif", "scan.tif"), { enabled: true, maxDim: 160 }),
    );

    expect(result.current.url).toBe(ORIGINAL_URL);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the original url for a local file without server ids", () => {
    const unuploaded = { ...localJpg(""), arionHash: "" };
    const { result } = renderHook(() =>
      useThumbnail(unuploaded as FormattedUserFile, { enabled: true, maxDim: 160 }),
    );

    expect(result.current.url).toBe(ORIGINAL_URL);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("falls back to the original url, loudly, when the Rust thumbnailer fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValue(new Error("decode image for thumbnail: bad file"));

    const { result } = renderHook(() =>
      useThumbnail(localJpg("hash-fail"), { enabled: true, maxDim: 160 }),
    );

    await waitFor(() => expect(result.current.url).toBe(ORIGINAL_URL));
    expect(result.current.error).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("serves a remount from the resolved-url cache without a second IPC", async () => {
    const file = localJpg("hash-remount");
    const first = renderHook(() => useThumbnail(file, { enabled: true, maxDim: 160 }));
    await waitFor(() =>
      expect(first.result.current.url).toBe(`asset://localhost/${CACHE_PATH}`),
    );
    first.unmount();

    const second = renderHook(() => useThumbnail(file, { enabled: true, maxDim: 160 }));
    // Synchronous: a scrolled-back-into-view cell must not flash the icon.
    expect(second.result.current.url).toBe(`asset://localhost/${CACHE_PATH}`);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
