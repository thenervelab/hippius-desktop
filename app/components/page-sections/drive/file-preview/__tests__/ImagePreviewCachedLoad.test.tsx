// Pins the image viewer against the cached-`<img>` race.
//
// The bug: the thumbnail rail serves a local file from `convertFileSrc(source)`
// — the SAME url the main viewer uses, at full size (`useThumbnail` hands the
// strip `plan.url` directly). So by the time the eye icon is clicked the bitmap
// is already in the WebView cache, the main `<img>` completes while React is
// still attaching its props, and the `load` event fires before `onLoad` exists
// to hear it.
//
// `imageLoaded` gates VISIBILITY, not just the spinner (`opacity-0` until it
// flips), so the photo rendered fully decoded at opacity 0 under a spinner that
// never went away. Confirmed live: every `<img>` reported `complete: true` with
// `naturalWidth: 3024` while the viewer still showed the loading state.
//
// A cached image therefore has to be adopted on mount rather than waited for.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

const IMAGE_URL = "asset://localhost/drive/Images/photo.jpeg";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ os: "macos", supportsLivePhotoMotion: true }),
  convertFileSrc: (path: string) => path,
}));

vi.mock("@/app/lib/hooks/useViewableFileUrl", () => ({
  useViewableFileUrl: () => ({
    url: IMAGE_URL,
    localPath: "/drive/Images/photo.jpeg",
    isLoading: false,
    error: null,
  }),
}));

// The Live Photo probe settles fast and reports "not live" for an ordinary
// jpeg (verified live: 4ms), so `imageUrl` is the resolved url immediately.
vi.mock("@/app/lib/hooks/usePreparedImagePreview", () => ({
  usePreparedImagePreview: () => ({
    imageUrl: IMAGE_URL,
    liveVideoUrl: "",
    isPreparing: false,
    error: null,
  }),
}));

vi.mock("@/app/lib/wallet-auth-context", () => ({
  useWalletAuth: () => ({ polkadotAddress: "5Test" }),
}));

import ImagePreviewBody from "../ImagePreviewBody";

const file: FormattedUserFile = {
  name: "photo.jpeg",
  actualFileName: "Images/photo.jpeg",
  createdAt: 0,
  arionHash: "hash",
  arionCid: "cid",
  minerIds: [],
  isAssigned: true,
  lastChargedAt: 0,
  isErasureCoded: false,
  mainReqHash: "req",
  source: "/drive/Images/photo.jpeg",
  label: "drive",
  syncStatus: "synced",
};

/**
 * jsdom's own `complete` / `naturalWidth` / `naturalHeight` accessors, saved
 * before the first override so `afterEach` can put them back. Deleting them
 * instead would leave every later test in this file seeing `undefined` rather
 * than real image semantics.
 */
const nativeImageDescriptors = new Map<string, PropertyDescriptor | undefined>();

/** Make every `<img>` behave as one already decoded in the WebView cache. */
function serveFromCache(naturalWidth: number) {
  for (const [prop, value] of [
    ["complete", true],
    ["naturalWidth", naturalWidth],
    ["naturalHeight", naturalWidth === 0 ? 0 : 600],
  ] as const) {
    if (!nativeImageDescriptors.has(prop)) {
      nativeImageDescriptors.set(
        prop,
        Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, prop),
      );
    }
    Object.defineProperty(HTMLImageElement.prototype, prop, {
      configurable: true,
      get: () => value,
    });
  }
}

beforeEach(() => {
  // `ImagePreviewBody` observes its media area once an image reports a size.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  for (const [prop, descriptor] of nativeImageDescriptors) {
    if (descriptor) {
      Object.defineProperty(HTMLImageElement.prototype, prop, descriptor);
    } else {
      Reflect.deleteProperty(HTMLImageElement.prototype, prop);
    }
  }
  nativeImageDescriptors.clear();
  vi.unstubAllGlobals();
});

describe("ImagePreviewBody: an image already in the WebView cache", () => {
  it("shows a cached image whose load event fired before React could hear it", async () => {
    serveFromCache(3024);

    const { container } = render(
      <ImagePreviewBody file={file} handleFileDownload={vi.fn()} />,
    );

    // Deliberately never fire `load`: that is the whole failure mode. The
    // browser already dispatched it against an element React had not finished
    // wiring, so no handler can ever run for this image.
    const image = await screen.findByAltText("photo.jpeg");

    expect(image.className).toContain("opacity-100");
    expect(image.className).not.toMatch(/(^|\s)opacity-0(\s|$)/);
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("still reports a cached image that decoded to nothing instead of spinning", async () => {
    // `complete` is also true for an image the browser gave up on; a zero
    // intrinsic width is what separates the two. Adopting it blindly would
    // swap an endless spinner for an invisible blank frame.
    serveFromCache(0);

    const { container } = render(
      <ImagePreviewBody file={file} handleFileDownload={vi.fn()} />,
    );

    // The body must say something the title does not: the bytes arrived and
    // the decode failed, which points at the file rather than the download.
    expect(await screen.findByText(/could not be decoded/i)).toBeInTheDocument();
    expect(screen.getByText(/failed to load image/i)).toBeInTheDocument();
    // The fallback's download affordance is the point: a failed preview must
    // still offer the file.
    expect(screen.getByRole("button", { name: /download/i })).toBeInTheDocument();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("still waits for a genuine network load when nothing is cached", async () => {
    // The control: an uncached image must keep its spinner until `load`, or
    // the fix would simply be "assume every image is ready".
    const { container } = render(
      <ImagePreviewBody file={file} handleFileDownload={vi.fn()} />,
    );

    expect(container.querySelector(".animate-spin")).not.toBeNull();

    const image = await screen.findByAltText("photo.jpeg");
    serveFromCache(800);
    fireEvent.load(image);

    expect(image.className).toContain("opacity-100");
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
