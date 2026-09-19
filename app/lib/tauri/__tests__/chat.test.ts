import { describe, expect, it } from "vitest";

import { isChatKeyringUnavailable } from "@/app/lib/tauri/chat";

// Rust's `SessionStoreError::Unavailable` reaches the FE as
// `AppError::Auth` → `{ kind: "Auth", message: "the OS credential store is
// unavailable: <cause>" }`. The UI routes that to "chat unavailable, retry"
// and never to the sign-in button; the `Corrupt` variant and real auth
// failures must NOT be read that way.
describe("isChatKeyringUnavailable", () => {
  it("recognises the Rust wording in the wire error shape", () => {
    expect(
      isChatKeyringUnavailable({
        kind: "Auth",
        message: "the OS credential store is unavailable: No such secret service",
      }),
    ).toBe(true);
    expect(isChatKeyringUnavailable("the OS credential store is unavailable: locked")).toBe(true);
  });

  it("does not match a corrupt session or another auth error", () => {
    expect(
      isChatKeyringUnavailable({
        kind: "Auth",
        message: "stored chat session is unreadable: invalid JSON",
      }),
    ).toBe(false);
    expect(isChatKeyringUnavailable({ kind: "Auth", message: "session expired" })).toBe(false);
    expect(isChatKeyringUnavailable(null)).toBe(false);
    expect(isChatKeyringUnavailable(undefined)).toBe(false);
  });
});
