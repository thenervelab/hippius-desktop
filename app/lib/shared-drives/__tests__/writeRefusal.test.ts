import { describe, it, expect } from "vitest";
import { driveWriteRefusal, frozenNotice } from "../writeRefusal";
import { parseDriveRole } from "../roles";

describe("driveWriteRefusal", () => {
  // A drop lands on the page whatever the permission, so a silent refusal
  // reads as the app being broken.
  it("explains a Viewer's refusal in words they can act on", () => {
    const message = driveWriteRefusal("reader");
    expect(message).not.toBeNull();
    // Names the role they have, and the one to ask for.
    expect(message).toContain("Viewer");
    expect(message).toContain("Editor");
    // Asking the owner is the only thing that changes the answer.
    expect(message).toMatch(/ask whoever shared it/i);
  });

  it("lets an Editor write", () => {
    expect(driveWriteRefusal("writer")).toBeNull();
  });

  // A former Manager parses as an Editor and keeps writing.
  it("lets a wire manager write, as an Editor", () => {
    expect(driveWriteRefusal(parseDriveRole("manager"))).toBeNull();
  });

  // An own drive has no role at all.
  it("lets an own drive write", () => {
    expect(driveWriteRefusal(null)).toBeNull();
  });

  // The server refuses anyway; inventing a reason for a permission nobody
  // has established is worse than letting the real error speak.
  it("stays quiet while the role is unknown", () => {
    expect(driveWriteRefusal(undefined)).toBeNull();
  });

  // The wire word must never reach the reader.
  it("never says reader or writer", () => {
    const message = driveWriteRefusal("reader") ?? "";
    expect(message).not.toMatch(/\breader\b/);
    expect(message).not.toMatch(/\bwriter\b/);
  });

  it("refuses every role when the drive is frozen", () => {
    expect(driveWriteRefusal("writer", { frozen: true })).toMatch(/frozen/i);
    expect(driveWriteRefusal(null, { frozen: true })).toMatch(/frozen/i);
  });
});

describe("frozenNotice", () => {
  it("reads the server's timestamp as a date", () => {
    expect(frozenNotice("2026-10-01T12:00:00Z")).toBe(
      "Frozen until Oct 1, 2026. Files can be opened but not changed.",
    );
  });

  it("never shows a raw or broken timestamp", () => {
    expect(frozenNotice(undefined)).toBe(
      "This drive is frozen. Files can be opened but not changed.",
    );
    expect(frozenNotice("not a date")).not.toContain("Invalid");
  });
});
