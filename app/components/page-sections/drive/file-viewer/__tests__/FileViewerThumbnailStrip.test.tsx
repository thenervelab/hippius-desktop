// Pins the filmstrip against the 13k-cell mount.
//
// The strip used to `files.map(...)` over the viewer's WHOLE file list —
// which is the full filtered listing, not the page's scroll window — so
// opening one photo in a 13,089-file camera folder mounted 13k buttons, 13k
// IntersectionObservers, and (through the local-thumbnail fast path) 13k
// full-resolution `<img>` fetches. The strip virtualises instead: spacer
// divs preserve the row's real geometry (so the scrollbar still spans the
// whole folder, like `SpreadsheetGrid`'s row virtualisation), and only the
// cells near the scroll position mount.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// The strip's cells resolve thumbnails through useThumbnail (wallet context,
// Tauri runtime); the behaviour under test is independent of all of that.
let thumbnailUrl: string | null = null;
const evictMock = vi.fn();
vi.mock("@/app/lib/hooks/useThumbnail", () => ({
  useThumbnail: () => ({ url: thumbnailUrl, isLoading: false, error: null }),
  evictResolvedThumbnailUrl: (...args: unknown[]) => evictMock(...args),
}));

import FileViewerThumbnailStrip from "../FileViewerThumbnailStrip";

const makeFiles = (count: number): FormattedUserFile[] =>
  Array.from({ length: count }, (_, i) =>
    ({
      name: `IMG_${i}.jpg`,
      actualFileName: `IMG_${i}.jpg`,
      arionHash: `hash-${i}`,
    }) as FormattedUserFile,
  );

beforeEach(() => {
  // jsdom implements neither; the strip guards both, and the render window
  // is driven by state, not by real layout.
  Element.prototype.scrollTo = vi.fn();
  thumbnailUrl = null;
});

describe("FileViewerThumbnailStrip virtualisation", () => {
  it("renders every cell of a small folder", () => {
    const files = makeFiles(10);
    render(
      <FileViewerThumbnailStrip
        files={files}
        currentFile={files[4]}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByRole("button")).toHaveLength(10);
  });

  it("bounds the mounted cells of a huge folder to a window around the active file", () => {
    const files = makeFiles(500);
    render(
      <FileViewerThumbnailStrip
        files={files}
        currentFile={files[250]}
        onSelect={() => {}}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeLessThan(files.length);
    expect(buttons.length).toBeLessThanOrEqual(201);

    expect(screen.getByLabelText("Open IMG_250.jpg")).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText("Open IMG_249.jpg")).toBeInTheDocument();
    expect(screen.getByLabelText("Open IMG_251.jpg")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open IMG_0.jpg")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Open IMG_499.jpg")).not.toBeInTheDocument();
  });

  it("preserves the row's full geometry with spacers so the scrollbar spans the folder", () => {
    const files = makeFiles(500);
    render(
      <FileViewerThumbnailStrip
        files={files}
        currentFile={files[250]}
        onSelect={() => {}}
      />,
    );

    const leading = screen.getByTestId("strip-leading-spacer");
    const trailing = screen.getByTestId("strip-trailing-spacer");
    expect(parseInt(leading.style.width, 10)).toBeGreaterThan(0);
    expect(parseInt(trailing.style.width, 10)).toBeGreaterThan(0);
  });

  it("keeps the window anchored at the start when the active file is first", () => {
    const files = makeFiles(500);
    render(
      <FileViewerThumbnailStrip
        files={files}
        currentFile={files[0]}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByLabelText("Open IMG_0.jpg")).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText("Open IMG_1.jpg")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open IMG_499.jpg")).not.toBeInTheDocument();
  });

  it("mounts the cells under the scrollbar when the user drags far from the active file", async () => {
    const files = makeFiles(500);
    render(
      <FileViewerThumbnailStrip
        files={files}
        currentFile={files[0]}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Open IMG_400.jpg")).not.toBeInTheDocument();

    // Drag the scrollbar deep into the folder: cell 400 sits at ~400 cell
    // pitches from the start. jsdom does no layout, so scrollLeft is set
    // directly and the scroll event drives the render window.
    const scroller = screen.getByTestId("strip-scroll");
    scroller.scrollLeft = 400 * 148;
    fireEvent.scroll(scroller);

    await waitFor(() =>
      expect(screen.getByLabelText("Open IMG_400.jpg")).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Open IMG_0.jpg")).not.toBeInTheDocument();
  });

  it("falls back to the file-type icon when a thumbnail img fails to load", () => {
    // A resolved url whose fetch the WebView then refuses (asset-scope or a
    // deleted cache file) must degrade to the icon, never a broken-image
    // glyph — the failure mode 0.6.0-beta.8 shipped with.
    thumbnailUrl = "asset://localhost/thumb.jpg";
    const files = makeFiles(3);
    const { container } = render(
      <FileViewerThumbnailStrip
        files={files}
        currentFile={files[1]}
        onSelect={() => {}}
      />,
    );

    const images = container.querySelectorAll("img");
    expect(images.length).toBe(3);
    fireEvent.error(images[1]);

    expect(container.querySelectorAll("img").length).toBe(2);
    // The failed cell still renders — as its file-type icon — and the dead
    // url is evicted so the next in-view resolution asks Rust again.
    expect(screen.getByLabelText("Open IMG_1.jpg")).toBeInTheDocument();
    expect(evictMock).toHaveBeenCalledWith(files[1], 160);
  });

  it("does not jump to the folder start when the active file is missing from the list", () => {
    const files = makeFiles(500);
    const gone = {
      name: "GONE.jpg",
      actualFileName: "GONE.jpg",
      arionHash: "hash-gone",
    } as FormattedUserFile;

    render(
      <FileViewerThumbnailStrip files={files} currentFile={gone} onSelect={() => {}} />,
    );

    // Position is untouched (still at the row start here); only the
    // highlight is lost — no cell claims to be the open photo.
    const current = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(0);
    expect(screen.getByLabelText("Open IMG_0.jpg")).toBeInTheDocument();
  });
});
