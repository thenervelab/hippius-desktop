import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  abortError,
  isAbortReason,
  previewErrorMessage,
  readPreviewBytes,
} from "../previewBytes";

// Block body on purpose: `mockReset()` returns the mock, and Vitest
// treats a function returned from `beforeEach` as a teardown callback —
// which would call `invoke()` with no arguments after every test.
beforeEach(() => {
  invoke.mockReset();
});

describe("previewErrorMessage", () => {
  it("reads the structured IPC shape rather than sniffing a message string", () => {
    // Rust's AppError serialises to `{ kind, message }`. Matching on the shape
    // is what lets Rust own the copy (the over-cap wording lives there) without
    // the two sides drifting.
    expect(
      previewErrorMessage({
        kind: "Validation",
        message: "This file is too large to preview. Download it to open it.",
      }),
    ).toBe("This file is too large to preview. Download it to open it.");
  });

  it("falls back through the other rejection shapes", () => {
    expect(previewErrorMessage("plain string failure")).toBe("plain string failure");
    expect(previewErrorMessage(new Error("boom"))).toBe("boom");
    expect(previewErrorMessage(undefined)).toBe("This file could not be previewed.");
    expect(previewErrorMessage({ nope: 1 })).toBe("This file could not be previewed.");
  });
});

describe("isAbortReason", () => {
  it("recognises our own cancellation, which is not a failure to report", () => {
    expect(isAbortReason(abortError())).toBe(true);
    expect(isAbortReason(new DOMException("x", "AbortError"))).toBe(true);
    expect(isAbortReason(new Error("real failure"))).toBe(false);
    expect(isAbortReason("nope")).toBe(false);
  });
});

describe("readPreviewBytes", () => {
  it("asks Rust for the bytes under the caller's cap", async () => {
    invoke.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);

    const bytes = await readPreviewBytes("/drive/a.docx", 1234, new AbortController().signal);

    expect(invoke).toHaveBeenCalledWith("read_preview_bytes", {
      sourcePath: "/drive/a.docx",
      maxBytes: 1234,
    });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("does not call Rust at all when the request is already stale", async () => {
    // The user pressed the arrow key before this load even started.
    const controller = new AbortController();
    controller.abort();

    await expect(readPreviewBytes("/drive/a.docx", 10, controller.signal)).rejects.toThrow(
      /cancelled/i,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("drops a response that arrives after the request was abandoned", async () => {
    // The IPC itself cannot be interrupted, so the guard is on the way back:
    // a late 20 MB read must never be handed to a renderer whose file has
    // already been replaced on screen.
    const controller = new AbortController();
    invoke.mockImplementation(async () => {
      controller.abort();
      return new Uint8Array([9]).buffer;
    });

    await expect(readPreviewBytes("/drive/a.docx", 10, controller.signal)).rejects.toThrow(
      /cancelled/i,
    );
  });
});
