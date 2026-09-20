import { describe, expect, it } from "vitest";

import { encodeSaveDestination, isChatKeyringUnavailable } from "@/app/lib/tauri/chat";

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

// The save command carries its destination in a request header because the
// invoke body is the raw attachment bytes. Rust (`percent_decode`) undoes
// exactly `%XX`; anything this encoder emits must be in that alphabet.
describe("encodeSaveDestination", () => {
  it("emits only ASCII and round-trips the characters Rust decodes", () => {
    const encoded = encodeSaveDestination("/Users/j/Downloads/résumé 100%.pdf");
    expect(/^[\x21-\x7e]*$/.test(encoded)).toBe(true);
    expect(decodeURIComponent(encoded)).toBe("/Users/j/Downloads/résumé 100%.pdf");
    // `%` itself is escaped, so a literal percent cannot be misread as a sequence.
    expect(encoded).toContain("100%25.pdf");
  });
});
