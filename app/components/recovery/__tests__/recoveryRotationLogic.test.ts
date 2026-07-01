import { describe, it, expect } from "vitest";
import {
  isPasswordMismatch,
  isSameAsCurrent,
  canSubmitRecoveryRotation,
  classifyRotationError,
} from "@/components/recovery/recoveryRotationLogic";

const ok = { acceptableForSubmit: true };

// A fully-valid form; tests flip one field at a time.
const validForm = {
  submitting: false,
  current: "old-pass",
  next: "new-strong-pass",
  confirm: "new-strong-pass",
  strength: ok,
};

describe("isPasswordMismatch", () => {
  it("is false until confirm is typed", () => {
    expect(isPasswordMismatch("abc", "")).toBe(false);
  });
  it("is true when confirm disagrees", () => {
    expect(isPasswordMismatch("abc", "abd")).toBe(true);
  });
  it("is false when confirm matches", () => {
    expect(isPasswordMismatch("abc", "abc")).toBe(false);
  });
});

describe("isSameAsCurrent", () => {
  it("is false for an empty next", () => {
    expect(isSameAsCurrent("abc", "")).toBe(false);
  });
  it("is true when next equals current", () => {
    expect(isSameAsCurrent("abc", "abc")).toBe(true);
  });
});

describe("canSubmitRecoveryRotation", () => {
  it("accepts a fully-valid form", () => {
    expect(canSubmitRecoveryRotation(validForm)).toBe(true);
  });

  it("rejects while submitting", () => {
    expect(canSubmitRecoveryRotation({ ...validForm, submitting: true })).toBe(false);
  });

  it("requires all three fields", () => {
    expect(canSubmitRecoveryRotation({ ...validForm, current: "" })).toBe(false);
    expect(canSubmitRecoveryRotation({ ...validForm, next: "" })).toBe(false);
    expect(canSubmitRecoveryRotation({ ...validForm, confirm: "" })).toBe(false);
  });

  it("requires the strength meter to accept", () => {
    expect(canSubmitRecoveryRotation({ ...validForm, strength: null })).toBe(false);
    expect(
      canSubmitRecoveryRotation({ ...validForm, strength: { acceptableForSubmit: false } })
    ).toBe(false);
  });

  it("rejects a mismatched confirm", () => {
    expect(
      canSubmitRecoveryRotation({ ...validForm, confirm: "different" })
    ).toBe(false);
  });

  it("rejects a no-op rotation (next === current)", () => {
    expect(
      canSubmitRecoveryRotation({ ...validForm, next: "old-pass", confirm: "old-pass" })
    ).toBe(false);
  });
});

describe("classifyRotationError", () => {
  it("maps a wrong-passphrase message (any case) to wrong_password", () => {
    expect(classifyRotationError("Wrong passphrase.")).toBe("wrong_password");
    expect(classifyRotationError("wrong passphrase")).toBe("wrong_password");
    expect(classifyRotationError("Validation: WRONG PASSPHRASE")).toBe("wrong_password");
  });

  it("maps anything else to generic", () => {
    expect(classifyRotationError("Network timeout")).toBe("generic");
    expect(classifyRotationError("")).toBe("generic");
  });
});
