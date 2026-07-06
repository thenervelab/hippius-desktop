import { describe, it, expect } from "vitest";
import { buildOAuthSession, type LoginResult } from "@/app/lib/auth/buildOAuthSession";

const base: LoginResult = {
  substrateAddress: "5Grw...",
  ethAddress: "0xabc",
  userId: 42,
  username: "alice",
  provider: "google",
  token: "tok",
  tokenExpiry: Date.parse("2026-06-24T00:00:00.000Z"),
  isNew: false,
};

describe("buildOAuthSession", () => {
  it("maps a full result straight through", () => {
    expect(buildOAuthSession(base)).toEqual({
      token: "tok",
      userId: 42,
      username: "alice",
      provider: "google",
      expiresAt: "2026-06-24T00:00:00.000Z",
      substrateAddress: "5Grw...",
      isNew: false,
    });
  });

  it("collapses a non-numeric userId to 0", () => {
    expect(buildOAuthSession({ ...base, userId: "42" }).userId).toBe(0);
    expect(buildOAuthSession({ ...base, userId: null }).userId).toBe(0);
  });

  it("prefers providerOverride over the result provider", () => {
    expect(buildOAuthSession(base, "mnemonic").provider).toBe("mnemonic");
  });

  it("falls back to 'mnemonic' when neither override nor result provider is set", () => {
    expect(
      buildOAuthSession({ ...base, provider: undefined as unknown as string }).provider
    ).toBe("mnemonic");
  });

  it("renders the epoch-ms tokenExpiry to ISO-8601", () => {
    expect(buildOAuthSession({ ...base, tokenExpiry: 0 }).expiresAt).toBe(
      "1970-01-01T00:00:00.000Z"
    );
  });
});
