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
//    on-disk copy, decodes off the WebView, and disk-caches the small JPEG
//    (re-implementing it in TS put image processing in the frontend against
//    the repo's Rust-owns-logic rule, uncached);
//  - formats a JPEG thumbnail would degrade (animation, transparency) and
//    files without server ids keep the original url instead;
//  - a Rust failure degrades to the original url, loudly, never to a
//    missing thumbnail.

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

const syncedJpg = {
  name: "pic.jpg",
  actualFileName: "pic.jpg",
  source: "/Users/me/Hippius/pic.jpg",
  syncStatus: "synced",
  fileId: "fid1",
  label: "Camera Uploads",
  arionHash: "ahash",
} as FormattedUserFile;

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
      useThumbnail(syncedJpg, { enabled: false, maxDim: 160 }),
    );

    expect(result.current.url).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("routes an in-view synced jpg through the Rust thumbnailer", async () => {
    const { result } = renderHook(() =>
      useThumbnail(syncedJpg, { enabled: true, maxDim: 160 }),
    );

    await waitFor(() =>
      expect(result.current.url).toBe(`asset://localhost/${CACHE_PATH}`),
    );
    expect(invokeMock).toHaveBeenCalledWith("get_thumbnail", {
      accountId: "5Test",
      label: "Camera Uploads",
      fileId: "fid1",
      arionHash: "ahash",
      source: "/Users/me/Hippius/pic.jpg",
      maxDim: 160,
    });
    expect(result.current.error).toBeNull();
  });

  it("keeps the original url for formats a JPEG thumbnail would degrade", () => {
    const png = { ...syncedJpg, name: "shot.png", actualFileName: "shot.png" };
    const { result } = renderHook(() =>
      useThumbnail(png as FormattedUserFile, { enabled: true, maxDim: 160 }),
    );

    expect(result.current.url).toBe("asset://localhost//Users/me/Hippius/pic.jpg");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps the original url for a local file without server ids", () => {
    const unuploaded = { ...syncedJpg, fileId: "", arionHash: "" };
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
      useThumbnail(syncedJpg, { enabled: true, maxDim: 160 }),
    );

    await waitFor(() => expect(result.current.url).toBe(ORIGINAL_URL));
    expect(result.current.error).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
