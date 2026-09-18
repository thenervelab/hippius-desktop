import { describe, it, expect } from "vitest";
import { driveWriteRefusal } from "../writeRefusal";

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

  it.each(["writer", "manager"] as const)("lets %s write", (role) => {
    expect(driveWriteRefusal(role)).toBeNull();
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
});
