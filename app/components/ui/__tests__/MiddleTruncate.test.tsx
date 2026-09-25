// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import MiddleTruncate from "../MiddleTruncate";

const EMAIL = "julien.du.bois@starkleytech.com";
const SS58 = "5DSQAMf3JVb3VqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqK7x5Wd";

/*
 * jsdom has no layout and no canvas. Give it both: every character 8px wide,
 * the box `boxWidth` wide, and the zero-height full copy as wide as its text,
 * which is what a browser reports.
 */
let boxWidth = 0;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-middle-truncate") ? boxWidth : 0;
  });
  // The full copy is drawn from `data-text` by CSS, so its width is that text's.
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return [...(this.getAttribute("data-text") ?? this.textContent ?? "")].length * 8;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        font: "",
        measureText: (text: string) => ({ width: [...text].length * 8 }),
      }) as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  boxWidth = 0;
});

/** What the eye sees: the line, not the zero-height copy or the screen reader text. */
const shown = (root: HTMLElement) => root.querySelector("[data-middle-truncate] > span:first-child")?.textContent;

describe("MiddleTruncate", () => {
  it("shows the whole text when it fits", () => {
    boxWidth = 400;
    const { container } = render(<MiddleTruncate text={EMAIL} />);
    expect(shown(container)).toBe(EMAIL);
  });

  it("shortens an email in the middle and keeps its domain, before the first paint", () => {
    boxWidth = 25 * 8;
    const { container } = render(<MiddleTruncate text={EMAIL} />);
    const line = shown(container) ?? "";
    expect(line.endsWith("@starkleytech.com")).toBe(true);
    expect(line.split("…")).toHaveLength(2);
    expect(line.length).toBeLessThanOrEqual(24);
  });

  it("keeps an address's two ends", () => {
    boxWidth = 20 * 8;
    const { container } = render(<MiddleTruncate text={SS58} />);
    const line = shown(container) ?? "";
    expect(line.startsWith(SS58.slice(0, 6))).toBe(true);
    expect(line.endsWith(SS58.slice(-6))).toBe(true);
  });

  it("keeps the full value in the title and for screen readers when shortened", () => {
    boxWidth = 10 * 8;
    const { container, getByText } = render(<MiddleTruncate text={EMAIL} />);
    const box = container.querySelector("[data-middle-truncate]")!;
    expect(box.getAttribute("title")).toBe(EMAIL);
    expect(box.querySelector("span:first-child")!.getAttribute("aria-hidden")).toBe("true");
    expect(getByText(EMAIL, { selector: ".sr-only" })).toBeInTheDocument();
  });

  // Unshortened, the line itself is read, so the words are in the page once.
  it("reads the line itself when nothing is cut", () => {
    boxWidth = 400;
    const { container, getAllByText } = render(<MiddleTruncate text={EMAIL} />);
    expect(getAllByText(EMAIL)).toHaveLength(1);
    expect(container.querySelector(".sr-only")).toBeNull();
    expect(container.querySelector("[data-middle-truncate] > span:first-child")!.hasAttribute("aria-hidden")).toBe(
      false,
    );
  });

  it("drops the title when a tooltip around it says more", () => {
    const { container } = render(<MiddleTruncate text={EMAIL} title={null} />);
    expect(container.querySelector("[data-middle-truncate]")!.hasAttribute("title")).toBe(false);
  });

  // An end ellipsis on top of the middle one is the double cut this replaces.
  it("never cuts at the end with CSS", () => {
    const { container } = render(<MiddleTruncate text={EMAIL} className="text-xs" />);
    const box = container.querySelector("[data-middle-truncate]")!;
    expect(box.className).not.toMatch(/\btruncate\b|text-ellipsis/);
    expect(box.className).toMatch(/\bmin-w-0\b/);
    expect(box.className).toMatch(/\boverflow-hidden\b/);
  });

  it("leaves the full text in place when there is no layout to measure", () => {
    boxWidth = 0;
    const { container } = render(<MiddleTruncate text={SS58} />);
    expect(shown(container)).toBe(SS58);
  });
});
