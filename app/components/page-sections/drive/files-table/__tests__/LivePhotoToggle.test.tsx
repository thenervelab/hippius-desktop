// Pins the Live Photo badge's "why can't I play this?" affordance.
//
// The bug this file guards: on Linux the badge correctly went disabled (the
// not-allowed cursor showed on hover) but the explanatory tooltip never became
// visible. The tooltip is portalled to `document.body`, so it escapes the
// viewer dialog's stacking context and has to out-rank the viewer overlay by
// hand — it was hard-coded at `z-[200]` while `FileViewerLayout`'s overlay
// renders at 999, so it was painted behind the full-screen viewer. A user on
// Linux therefore got a dead-looking button and no explanation anywhere.
//
// The tooltip's stacking is now derived from the overlay constant rather than
// guessed, and this test asserts the relationship (not a magic number) so the
// two can never drift apart again.
//
// Hover is additionally wired on both event families, with a native `title`
// as a fallback needing neither React events nor the portal's stacking. That
// is redundancy rather than a second fix: the pointer-event path was verified
// working on WebKitGTK once the stacking was corrected. These cases pin the
// redundancy so a later cleanup does not quietly reduce it back to one path.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { FILE_VIEWER_OVERLAY_Z_INDEX } from "@/app/components/page-sections/drive/file-viewer";
import {
  LivePhotoToggle,
  LIVE_PHOTO_LINUX_MESSAGE,
  LIVE_PHOTO_UNSUPPORTED_MESSAGE,
  getLivePlaybackError,
} from "../ImageDialog";

// ImageDialog's module graph reaches the Tauri IPC bridge and the auth context
// at import time; the badge itself needs neither.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ os: "linux", supportsLivePhotoMotion: false }),
  convertFileSrc: (path: string) => path,
}));

describe("getLivePlaybackError", () => {
  it("names Linux explicitly when the backend reports a Linux host", () => {
    expect(getLivePlaybackError("linux")).toBe(LIVE_PHOTO_LINUX_MESSAGE);
    expect(getLivePlaybackError("linux")).toMatch(/Linux/);
  });

  it("falls back to a device-neutral message on supported platforms", () => {
    expect(getLivePlaybackError("macos")).toBe(LIVE_PHOTO_UNSUPPORTED_MESSAGE);
    expect(getLivePlaybackError("windows")).toBe(LIVE_PHOTO_UNSUPPORTED_MESSAGE);
  });
});

describe("LivePhotoToggle when motion playback is unavailable", () => {
  it("reveals the explanation on hover", () => {
    render(
      <LivePhotoToggle
        playing={false}
        error={LIVE_PHOTO_LINUX_MESSAGE}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    fireEvent.pointerEnter(screen.getByRole("button"));

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      LIVE_PHOTO_LINUX_MESSAGE,
    );
  });

  // The disabled LOOK is pure CSS `:hover` and paints wherever the cursor
  // lands, so a WebView that delivers only classic mouse events would grey the
  // badge out and say nothing. A plain `mouseenter` must therefore be enough
  // on its own, with no Pointer Event involved.
  it("reveals the explanation from a plain mouseenter, with no pointer event", () => {
    render(
      <LivePhotoToggle
        playing={false}
        error={LIVE_PHOTO_LINUX_MESSAGE}
        onClick={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button"));

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      LIVE_PHOTO_LINUX_MESSAGE,
    );

    fireEvent.mouseLeave(screen.getByRole("button"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  // Last-resort fallback that depends on neither React events nor the
  // portalled tooltip's stacking: whatever else breaks, hovering the badge
  // still surfaces the reason natively.
  it("carries the reason as a native title until the real tooltip opens", () => {
    render(
      <LivePhotoToggle
        playing={false}
        error={LIVE_PHOTO_LINUX_MESSAGE}
        onClick={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", LIVE_PHOTO_LINUX_MESSAGE);

    // Once the styled tooltip is up the native one is dropped, so the two
    // never render the same sentence twice.
    fireEvent.pointerEnter(button);
    expect(button).not.toHaveAttribute("title");
  });

  it("renders that explanation ABOVE the full-screen viewer overlay", () => {
    render(
      <LivePhotoToggle
        playing={false}
        error={LIVE_PHOTO_LINUX_MESSAGE}
        onClick={vi.fn()}
      />,
    );
    fireEvent.pointerEnter(screen.getByRole("button"));

    const zIndex = Number(screen.getByRole("tooltip").style.zIndex);
    expect(Number.isNaN(zIndex)).toBe(false);
    expect(zIndex).toBeGreaterThan(FILE_VIEWER_OVERLAY_Z_INDEX);
  });

  it("keeps the explanation reachable by keyboard and by screen readers", () => {
    render(
      <LivePhotoToggle
        playing={false}
        error={LIVE_PHOTO_LINUX_MESSAGE}
        onClick={vi.fn()}
      />,
    );

    const button = screen.getByRole("button");
    // The message is on the control itself, not only in the portalled tooltip:
    // Radix marks body-level siblings of an open modal `aria-hidden`.
    expect(button).toHaveAttribute("aria-label", LIVE_PHOTO_LINUX_MESSAGE);
    expect(button).toHaveAttribute("aria-disabled", "true");

    fireEvent.focus(button);
    const tooltip = screen.getByRole("tooltip");
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);

    fireEvent.blur(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("explains instead of playing when clicked", () => {
    const onClick = vi.fn();
    render(
      <LivePhotoToggle
        playing={false}
        error={LIVE_PHOTO_LINUX_MESSAGE}
        onClick={onClick}
      />,
    );

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      LIVE_PHOTO_LINUX_MESSAGE,
    );
  });
});

describe("LivePhotoToggle when motion playback works", () => {
  it("plays and shows no tooltip", () => {
    const onClick = vi.fn();
    render(<LivePhotoToggle playing={false} error={null} onClick={onClick} />);

    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button);
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(button).not.toHaveAttribute("title");

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).not.toHaveAttribute("aria-disabled", "true");
  });
});
