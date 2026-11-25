import { describe, expect, it } from "vitest";

import { isKnownEmptyFolder } from "@/lib/utils/emptyFolder";

describe("isKnownEmptyFolder", () => {
  it("is a folder the server or the walk counts no files in", () => {
    expect(isKnownEmptyFolder({ isFolder: true, fileCount: 0 })).toBe(true);
  });

  it("is not a folder with files, or one whose count is not known", () => {
    expect(isKnownEmptyFolder({ isFolder: true, fileCount: 3 })).toBe(false);
    expect(isKnownEmptyFolder({ isFolder: true })).toBe(false);
    expect(isKnownEmptyFolder({ isFolder: true, fileCount: null })).toBe(false);
  });

  it("is never a file, even one of 0 bytes", () => {
    expect(isKnownEmptyFolder({ isFolder: false, fileCount: 0 })).toBe(false);
  });
});
