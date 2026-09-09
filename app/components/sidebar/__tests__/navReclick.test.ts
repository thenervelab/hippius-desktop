import { describe, it, expect } from "vitest";
import { nextReclick, shouldHandleReclick } from "../navReclick";

describe("nextReclick", () => {
  it("starts at one", () => {
    expect(nextReclick(null, "/files")).toEqual({ href: "/files", nonce: 1 });
  });

  // A flag would collapse the second click into the first; the user
  // clicking Drive twice must reset twice.
  it("advances on every click so a repeat still registers", () => {
    const first = nextReclick(null, "/files");
    const second = nextReclick(first, "/files");
    expect(second.nonce).toBeGreaterThan(first.nonce);
  });

  // Monotonic across hrefs, not per-href: a per-href counter could hand a
  // consumer a nonce it has already handled after visiting two items.
  it("keeps advancing when the user switches items", () => {
    const files = nextReclick(null, "/files");
    const settings = nextReclick(files, "/settings");
    const backToFiles = nextReclick(settings, "/files");
    expect(backToFiles.nonce).toBeGreaterThan(files.nonce);
  });
});

describe("shouldHandleReclick", () => {
  it("ignores an empty signal", () => {
    expect(shouldHandleReclick(null, "/files", 0)).toBe(false);
  });

  it("ignores another item's click", () => {
    expect(shouldHandleReclick({ href: "/settings", nonce: 1 }, "/files", 0)).toBe(false);
  });

  it("handles a new click", () => {
    expect(shouldHandleReclick({ href: "/files", nonce: 1 }, "/files", 0)).toBe(true);
  });

  // The effect re-runs on unrelated re-renders; without the nonce compare
  // it would yank the user back to the root while they navigate.
  it("does not act twice on the same click", () => {
    expect(shouldHandleReclick({ href: "/files", nonce: 4 }, "/files", 4)).toBe(false);
  });

  it("acts again on the next click", () => {
    expect(shouldHandleReclick({ href: "/files", nonce: 5 }, "/files", 4)).toBe(true);
  });
});
