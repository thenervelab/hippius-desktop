import { describe, it, expect } from "vitest";
import { canRenameFile } from "@/app/lib/utils/renameGating";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";

// Rename is a destructive on-disk op (`rename_entry` → fs::rename + server-side
// propagation), so the gate must only enable rows that are assigned, present on
// THIS device, and at rest. A regression here either lets a user rename a
// cloud-only / mid-sync row (the data-loss race CLAUDE.md calls out) or wrongly
// disables a perfectly renameable local file. Exercise every guard clause.

function file(overrides: Partial<FormattedUserFile>): FormattedUserFile {
  // Only the four fields the gate reads matter; the rest of FormattedUserFile
  // is irrelevant to this pure predicate.
  return {
    isAssigned: true,
    fileId: undefined,
    source: "/Users/me/Hippius/a.txt",
    syncStatus: "synced",
    ...overrides,
  } as FormattedUserFile;
}

describe("canRenameFile", () => {
  it("enables a settled, assigned, on-disk synced file", () => {
    expect(canRenameFile(file({}))).toBe(true);
  });

  it("enables a plain local listing with no syncStatus set", () => {
    // Disk-walk entries never set syncStatus; `undefined` must stay renameable.
    expect(canRenameFile(file({ syncStatus: undefined }))).toBe(true);
  });

  it("enables a local row even when it carries a fileId, as long as source is present", () => {
    // A synced file can have both a server fileId AND a local source — only the
    // fileId-WITHOUT-source combination means cloud-only.
    expect(canRenameFile(file({ fileId: "abc123", source: "/Users/me/Hippius/a.txt" }))).toBe(
      true
    );
  });

  it("disables an unassigned (mid-upload) row", () => {
    expect(canRenameFile(file({ isAssigned: false }))).toBe(false);
  });

  it("disables a cloud-only row (fileId present, no local source)", () => {
    expect(canRenameFile(file({ fileId: "abc123", source: undefined }))).toBe(false);
  });

  it("disables a row with a non-synced explicit status", () => {
    for (const status of ["pending", "uploading", "failed", "downloading"]) {
      expect(
        canRenameFile(file({ syncStatus: status as FormattedUserFile["syncStatus"] })),
        `syncStatus=${status} must be non-renameable`
      ).toBe(false);
    }
  });

  it("unassigned takes precedence even if other fields look renameable", () => {
    expect(canRenameFile(file({ isAssigned: false, syncStatus: "synced" }))).toBe(false);
  });
});
