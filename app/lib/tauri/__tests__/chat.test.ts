import { describe, expect, it, vi } from "vitest";

import {
  chatGetNotificationsEnabled,
  chatGetUnreadCount,
  chatNotifyMessage,
  chatSetNotificationsEnabled,
  chatSetUnreadBadge,
  encodeSaveDestination,
  isChatKeyringUnavailable,
  isChatSessionExpired,
} from "@/app/lib/tauri/chat";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
        message:
          "the OS credential store is unavailable: No such secret service",
      }),
    ).toBe(true);
    expect(
      isChatKeyringUnavailable(
        "the OS credential store is unavailable: locked",
      ),
    ).toBe(true);
  });

  it("does not match a corrupt session or another auth error", () => {
    expect(
      isChatKeyringUnavailable({
        kind: "Auth",
        message: "stored chat session is unreadable: invalid JSON",
      }),
    ).toBe(false);
    expect(
      isChatKeyringUnavailable({ kind: "Auth", message: "session expired" }),
    ).toBe(false);
    expect(isChatKeyringUnavailable(null)).toBe(false);
    expect(isChatKeyringUnavailable(undefined)).toBe(false);
  });
});

// Rust's `chat::sign_in::SESSION_EXPIRED` is the one refresh error that
// means "sign in again"; the token refresher turns exactly it into the SDK's
// logout. The wording is pinned on the Rust side too.
describe("isChatSessionExpired", () => {
  it("recognises the Rust wording in the wire error shape", () => {
    expect(
      isChatSessionExpired({
        kind: "Auth",
        message: "chat: session expired; sign in again",
      }),
    ).toBe(true);
    expect(isChatSessionExpired("chat: session expired; sign in again")).toBe(true);
  });

  it("does not match transient refresh failures or other auth errors", () => {
    expect(
      isChatSessionExpired({
        kind: "Auth",
        message: "the OS credential store is unavailable: locked",
      }),
    ).toBe(false);
    expect(
      isChatSessionExpired({
        kind: "Auth",
        message: "chat: homeserver does not advertise OIDC auth metadata (x)",
      }),
    ).toBe(false);
    expect(isChatSessionExpired({ kind: "Http", message: "timed out" })).toBe(false);
    expect(isChatSessionExpired(null)).toBe(false);
  });
});

// The save command carries its destination in a request header because the
// invoke body is the raw attachment bytes. Rust (`percent_decode`) undoes
// exactly `%XX`; anything this encoder emits must be in that alphabet.
describe("encodeSaveDestination", () => {
  it("emits only ASCII and round-trips the characters Rust decodes", () => {
    const encoded = encodeSaveDestination("/Users/j/Downloads/résumé 100%.pdf");
    expect(/^[\x21-\x7e]*$/.test(encoded)).toBe(true);
    expect(decodeURIComponent(encoded)).toBe(
      "/Users/j/Downloads/résumé 100%.pdf",
    );
    // `%` itself is escaped, so a literal percent cannot be misread as a sequence.
    expect(encoded).toContain("100%25.pdf");
  });
});

// The notification and badge wrappers are the only place the FE names these
// commands; their argument keys are the Rust command parameters (`message`,
// `count`, `enabled`) and the result strings are Rust's `NotifyOutcome`
// serialised snake_case — a drift on either side is invisible to `tsc`.
describe("notification and badge wrappers", () => {
  it("invoke the Rust commands with the parameter names Rust expects", async () => {
    const invoke = vi.mocked((await import("@tauri-apps/api/core")).invoke);
    invoke.mockReset();
    invoke.mockResolvedValueOnce("not_mention_or_direct");
    const message = {
      roomId: "!g",
      roomName: "#general",
      senderName: "bob",
      body: "hi",
      isDirect: false,
      isMention: false,
      roomIsOpen: false,
    };
    await expect(chatNotifyMessage(message)).resolves.toBe(
      "not_mention_or_direct",
    );
    expect(invoke).toHaveBeenLastCalledWith("chat_notify_message", { message });

    invoke.mockResolvedValueOnce(undefined);
    await chatSetUnreadBadge(3);
    expect(invoke).toHaveBeenLastCalledWith("chat_set_unread_badge", {
      count: 3,
    });

    invoke.mockResolvedValueOnce(3);
    await expect(chatGetUnreadCount()).resolves.toBe(3);
    expect(invoke).toHaveBeenLastCalledWith("chat_get_unread_count");

    invoke.mockResolvedValueOnce(undefined);
    await chatSetNotificationsEnabled(false);
    expect(invoke).toHaveBeenLastCalledWith("chat_set_notifications_enabled", {
      enabled: false,
    });

    invoke.mockResolvedValueOnce(false);
    await expect(chatGetNotificationsEnabled()).resolves.toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("chat_get_notifications_enabled");
  });
});
