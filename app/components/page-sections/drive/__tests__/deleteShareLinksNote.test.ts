import { describe, expect, it } from "vitest";
import { deleteShareLinksNote } from "../deleteShareLinksNote";

describe("the delete dialogs' line about share links", () => {
  it("says links from a file or a folder keep working, and where to turn them off", () => {
    expect(deleteShareLinksNote([{ isFolder: false }])).toBe(
      "Share links made from it keep working. Turn them off in Shared Links.",
    );
    expect(deleteShareLinksNote([{}])).toBe("Share links made from it keep working. Turn them off in Shared Links.");
    expect(deleteShareLinksNote([{ isFolder: true }])).toBe(
      "Share links made from files in it keep working. Turn them off in Shared Links.",
    );
  });

  it("speaks of several items together", () => {
    expect(deleteShareLinksNote([{}, {}])).toBe("Share links made from them keep working. Turn them off in Shared Links.");
    expect(deleteShareLinksNote([{}, { isFolder: true }])).toBe(
      "Share links made from them or files in them keep working. Turn them off in Shared Links.",
    );
  });
});
