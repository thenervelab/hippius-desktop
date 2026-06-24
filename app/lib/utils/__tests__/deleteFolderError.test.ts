import { describe, it, expect } from "vitest";
import { deleteFolderErrorToast } from "@/lib/utils/deleteFolderError";

describe("deleteFolderErrorToast", () => {
  it("surfaces the real AppError message instead of a fixed string (F-2)", () => {
    // The shape Rust commands return: { kind, message }.
    const appError = { kind: "Hcfs", message: "connection timed out" };
    expect(deleteFolderErrorToast(appError)).toBe(
      "Failed to delete folder: connection timed out",
    );
  });

  it("embeds a bare string error", () => {
    expect(deleteFolderErrorToast("boom")).toBe("Failed to delete folder: boom");
  });

  it("falls back to String() for an opaque error", () => {
    expect(deleteFolderErrorToast(42)).toBe("Failed to delete folder: 42");
  });
});
