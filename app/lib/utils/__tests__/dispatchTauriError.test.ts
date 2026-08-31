import { describe, it, expect, vi, beforeEach } from "vitest";

// dispatchSigningError calls toast.error; capture it.
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import {
  isNotReady,
  isMasterMnemonicUnrecoverable,
  isIoError,
  dispatchSigningError,
  tauriErrorMessage,
} from "@/lib/utils/dispatchTauriError";

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

describe("isMasterMnemonicUnrecoverable", () => {
  it("keys on subkind so a reworded banner cannot miss the reauth path", () => {
    expect(
      isMasterMnemonicUnrecoverable({
        kind: "NotReady",
        subkind: "MASTER_MNEMONIC_UNRECOVERABLE",
        message: "reworded",
      })
    ).toBe(true);
    expect(
      isMasterMnemonicUnrecoverable({
        kind: "NotReady",
        subkind: "CONFIG_MISSING",
        message: "mnemonic unrecoverable",
      })
    ).toBe(false);
  });
});

describe("isIoError", () => {
  it("matches kind Io and nothing else", () => {
    expect(
      isIoError({
        kind: "Io",
        message: "I/O error: No such file or directory (os error 2)",
      }),
    ).toBe(true);
    expect(
      isIoError({
        kind: "Other",
        message: "Couldn't open the file manager (xdg-open was not found).",
      }),
    ).toBe(false);
    expect(isIoError(new Error("No such file or directory"))).toBe(false);
  });
});

describe("tauriErrorMessage", () => {
  it("reads .message off the plain serialized AppError object (NOT instanceof Error)", () => {
    // The regression this targets: Tauri rejects invoke() with a plain
    // {kind,message} object, so `err instanceof Error` is always false and the
    // real message must be read off the object.
    const err = { kind: "Vpn", message: "mesh enrollment failed: boom" };
    expect(err instanceof Error).toBe(false);
    expect(tauriErrorMessage(err)).toBe("mesh enrollment failed: boom");
  });

  it("surfaces the NotReady display message", () => {
    const err = { kind: "NotReady", subkind: "VPN_NOT_CONNECTED", message: "Connect to the VPN before opening a VM connection." };
    expect(tauriErrorMessage(err)).toContain("Connect to the VPN");
  });

  it("falls back to a thrown string, then a generic label", () => {
    expect(tauriErrorMessage("raw string error")).toBe("raw string error");
    expect(tauriErrorMessage(null)).toBe("Unknown error");
    expect(tauriErrorMessage({})).toBe("Unknown error");
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
