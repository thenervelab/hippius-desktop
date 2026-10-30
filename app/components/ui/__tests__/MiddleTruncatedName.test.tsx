import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import MiddleTruncatedName from "../MiddleTruncatedName";

describe("MiddleTruncatedName", () => {
  const original = globalThis.ResizeObserver;
  afterEach(() => {
    globalThis.ResizeObserver = original;
  });

  // A row's link icon usually arrives after the first measure, once the share
  // listing loads. Watching only the name's box left the icon clipped off the
  // end of a name that had just fitted without it.
  it("measures again when its suffix changes size, not only its own box", () => {
    const observed: Element[] = [];
    globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: (el: Element) => observed.push(el),
      unobserve: () => {},
      disconnect: () => {},
    })) as unknown as typeof ResizeObserver;

    render(<MiddleTruncatedName name="Recording 2026-10-30 at 11.09.18.mp4" suffix={<span data-testid="icon" />} />);

    const suffix = screen.getByTestId("icon").parentElement;
    expect(observed).toContain(suffix);
    expect(observed.length).toBe(2);
  });
});
