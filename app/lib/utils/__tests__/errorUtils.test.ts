import { describe, it, expect } from "vitest";
import { isExpectedNoSessionError, errorMessage } from "../errorUtils";

describe("errorMessage", () => {
  it("reads strings and {message} objects", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage({ message: "nope" })).toBe("nope");
  });
});

describe("isExpectedNoSessionError", () => {
  it("treats the Rust AppError::Auth shape as expected (boot-gap)", () => {
    expect(
      isExpectedNoSessionError({ kind: "Auth", message: "No active account set" }),
    ).toBe(true);
  });

  it("treats NotReady kinds as expected", () => {
    expect(isExpectedNoSessionError({ kind: "NotReady", message: "x" })).toBe(true);
  });

  it("treats the bare empty-object boot rejection as expected", () => {
    expect(isExpectedNoSessionError({})).toBe(true);
  });

  it("treats null/undefined rejections as expected", () => {
    expect(isExpectedNoSessionError(null)).toBe(true);
    expect(isExpectedNoSessionError(undefined)).toBe(true);
  });

  it("matches no-session / account-transition messages regardless of shape", () => {
    expect(isExpectedNoSessionError("No active account set")).toBe(true);
    expect(isExpectedNoSessionError("Requested account is not the active session account")).toBe(true);
    expect(isExpectedNoSessionError({ message: "wallet not ready" })).toBe(true);
  });

  it("does NOT swallow genuine errors", () => {
    expect(
      isExpectedNoSessionError({ kind: "Database", message: "no such table: notifications" }),
    ).toBe(false);
    expect(isExpectedNoSessionError("disk full")).toBe(false);
    expect(isExpectedNoSessionError({ kind: "Hcfs", message: "500 from server" })).toBe(false);
  });
});
