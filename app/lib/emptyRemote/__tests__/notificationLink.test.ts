import { describe, it, expect } from "vitest";
import { emptyRemoteFromLink } from "@/app/lib/emptyRemote/notificationLink";
import { classifyEmptyRemoteError } from "@/app/lib/tauri/emptyRemote";

describe("emptyRemoteFromLink", () => {
  it("reads the drive Rust wrote into the row's link", () => {
    // `create_empty_remote_notification` pins this exact link.
    expect(emptyRemoteFromLink("/files?emptyDrive=1&drive=Photo+%26+Video")).toBe("Photo & Video");
  });

  it("ignores every other link", () => {
    expect(emptyRemoteFromLink("/files?heldDelete=server&drive=Photos")).toBeNull();
    expect(emptyRemoteFromLink("/files")).toBeNull();
    expect(emptyRemoteFromLink("/billing?emptyDrive=1&drive=Photos")).toBeNull();
    expect(emptyRemoteFromLink("/files?emptyDrive=1")).toBeNull();
  });
});

describe("classifyEmptyRemoteError", () => {
  // The message is the same on purpose: classification comes from
  // `subkind`, never from the words.
  const notReady = (subkind: string) => ({ kind: "NotReady", subkind, message: "same" });

  it("matches each refusal by subkind", () => {
    expect(classifyEmptyRemoteError(notReady("EMPTY_REMOTE_NOTHING_HELD"))).toEqual({
      type: "nothingHeld",
      message: "same",
    });
    expect(classifyEmptyRemoteError(notReady("EMPTY_REMOTE_MEMBER_CANNOT_CONFIRM"))).toEqual({
      type: "memberCannotConfirm",
      message: "same",
    });
    expect(classifyEmptyRemoteError(notReady("MASS_DELETE_NOTHING_HELD"))).toEqual({ type: "other" });
    expect(classifyEmptyRemoteError(new Error("boom"))).toEqual({ type: "other" });
  });
});
