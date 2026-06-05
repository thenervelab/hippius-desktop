import { describe, it, expect, vi, beforeEach } from "vitest";

// dispatchSigningError calls toast.error; capture it.
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import { isNotReady, dispatchSigningError } from "@/lib/utils/dispatchTauriError";

describe("isNotReady", () => {
  it("matches a specific NotReadyKind via subkind, independent of message text", () => {
    const err = { kind: "NotReady", subkind: "INSUFFICIENT_CREDITS", message: "totally reworded text" };
    expect(isNotReady(err, "INSUFFICIENT_CREDITS")).toBe(true);
  });

  it("does NOT match a different subkind even if the message contains the old words", () => {
    // The regression this fix targets: a reworded/overlapping Display string
    // must never drive control flow — only the stable subkind does.
    const err = { kind: "NotReady", subkind: "SYNC_IN_PROGRESS", message: "insufficient credits to upload" };
    expect(isNotReady(err, "INSUFFICIENT_CREDITS")).toBe(false);
  });

  it("matches any NotReady when no kind is given", () => {
    expect(isNotReady({ kind: "NotReady", subkind: "CONFIG_MISSING" })).toBe(true);
  });

  it("returns false for non-NotReady errors and null", () => {
    expect(isNotReady({ kind: "Auth", message: "x" }, "INSUFFICIENT_CREDITS")).toBe(false);
    expect(isNotReady(null)).toBe(false);
  });
});

describe("dispatchSigningError", () => {
  beforeEach(() => toastError.mockClear());

  it("handles SIGNING_KEY_UNAVAILABLE via subkind (not message) and shows the reauth toast", () => {
    const onReAuth = vi.fn();
    const handled = dispatchSigningError(
      { kind: "NotReady", subkind: "SIGNING_KEY_UNAVAILABLE", message: "reworded display text" },
      onReAuth
    );
    expect(handled).toBe(true);
    expect(toastError).toHaveBeenCalledOnce();
  });

  it("returns false (caller handles it) for other NotReady subkinds", () => {
    expect(dispatchSigningError({ kind: "NotReady", subkind: "CONFIG_MISSING" }, () => {})).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });
});
