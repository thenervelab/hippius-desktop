import { describe, expect, it } from "vitest";

import {
  OAUTH_CALLBACK_FALLBACK_MESSAGE,
  oauthCallbackErrorMessage,
} from "@/app/lib/auth/oauthCallbackError";

describe("oauthCallbackErrorMessage", () => {
  // The regression this file exists for: `invoke()` rejects with the
  // serialized AppError, a plain object. The old `err instanceof Error`
  // test was always false, so these messages never reached the user.
  it.each([
    [
      "expired sign-in",
      "This sign-in expired or was already completed. Please start a new sign-in from the Hippius app — reopening the link from your browser won't work.",
    ],
    [
      "replayed link",
      "This sign-in link has expired or was already used. Please start a new sign-in from the Hippius app.",
    ],
    [
      "provider rejection",
      "The sign-in provider rejected the request: access_denied",
    ],
    [
      "missing address",
      "Sign-in did not return an account address. Please try again.",
    ],
  ])("surfaces the Rust message for a %s", (_label, message) => {
    expect(oauthCallbackErrorMessage({ kind: "Auth", message })).toBe(message);
  });

  it("surfaces an Api rejection, which carries the exchange status", () => {
    expect(
      oauthCallbackErrorMessage({
        kind: "Api",
        message: "API error 400: invalid_grant",
      }),
    ).toBe("API error 400: invalid_grant");
  });

  it("accepts a bare string rejection (legacy commands)", () => {
    expect(oauthCallbackErrorMessage("something broke")).toBe(
      "something broke",
    );
  });

  it("still unwraps a real Error", () => {
    expect(oauthCallbackErrorMessage(new Error("boom"))).toBe("boom");
  });

  // An empty `{}` is a real IPC transport case (see isExpectedNoSessionError);
  // "[object Object]" in the UI would be worse than the generic sentence.
  it.each([
    ["an empty object", {}],
    ["an empty message", { kind: "Auth", message: "   " }],
    ["undefined", undefined],
    ["null", null],
  ])("falls back for %s", (_label, value) => {
    expect(oauthCallbackErrorMessage(value)).toBe(
      OAUTH_CALLBACK_FALLBACK_MESSAGE,
    );
  });
});
