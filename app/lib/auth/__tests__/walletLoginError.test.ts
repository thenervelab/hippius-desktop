import { describe, it, expect } from "vitest";
import { WALLET_VERIFICATION_REQUIRED, walletLoginErrorText } from "../walletLoginError";

describe("walletLoginErrorText", () => {
  it("shows the Rust verification message from an AppError", () => {
    const message = `${WALLET_VERIFICATION_REQUIRED}: update Hippius, or sign in at console.hippius.com.`;
    expect(walletLoginErrorText({ kind: "Other", message })).toBe(message);
  });

  it("keeps the generic text for any other login failure", () => {
    const generic = walletLoginErrorText({ kind: "Other", message: "Authentication failed (HTTP 401). Please try again." });
    expect(generic).toMatch(/^Invalid access key/);
    expect(walletLoginErrorText({ kind: "Other", message: "Invalid BIP-39 mnemonic: bad word" })).toBe(generic);
  });

  it("shows an Error's own message, as before", () => {
    expect(walletLoginErrorText(new Error("boom"))).toBe("boom");
  });
});
