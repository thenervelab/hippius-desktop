import { beforeEach, describe, expect, it } from "vitest";

import type { OAuthSession } from "@/app/lib/types/oAuth";
import {
  OAUTH_SESSION_EXPIRY_KEY,
  OAUTH_SESSION_KEY,
  clearOAuthSessionHint,
  persistOAuthSessionHint,
  scrubLegacyOAuthToken,
  toOAuthSessionHint,
} from "@/app/lib/auth/oauthSessionHint";

const SESSION: OAuthSession = {
  token: "super-secret-bearer-token",
  userId: 42,
  username: "someone",
  email: "someone@example.com",
  substrateAddress: "5RowAddress",
  provider: "google",
  expiresAt: "2026-09-05T00:00:00.000Z",
};

function storedHint(): Record<string, unknown> | null {
  const raw = localStorage.getItem(OAUTH_SESSION_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

describe("oauthSessionHint", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // The whole point of the module: a live 30-day bearer token must never
  // reach Web Storage (audit S-4).
  it("never writes the bearer token to localStorage", () => {
    persistOAuthSessionHint(SESSION);

    const hint = storedHint();
    expect(hint).not.toBeNull();
    expect(hint).not.toHaveProperty("token");
    expect(JSON.stringify(hint)).not.toContain(SESSION.token);
  });

  // The hint still has to answer "is someone signed in, and until when?"
  // synchronously — that is what /auth/callback and DeepLinkListener read
  // before the restore_session IPC resolves.
  it("keeps the fields the synchronous boot checks depend on", () => {
    persistOAuthSessionHint(SESSION);

    expect(storedHint()).toMatchObject({
      substrateAddress: SESSION.substrateAddress,
      provider: SESSION.provider,
      expiresAt: SESSION.expiresAt,
    });
    expect(localStorage.getItem(OAUTH_SESSION_EXPIRY_KEY)).toBe(
      SESSION.expiresAt,
    );
  });

  it("strips only the token, leaving the rest of the session intact", () => {
    const hint = toOAuthSessionHint(SESSION);

    expect(hint).not.toHaveProperty("token");
    expect(hint).toEqual({
      userId: SESSION.userId,
      username: SESSION.username,
      email: SESSION.email,
      substrateAddress: SESSION.substrateAddress,
      provider: SESSION.provider,
      expiresAt: SESSION.expiresAt,
    });
  });

  it("clears both keys together", () => {
    persistOAuthSessionHint(SESSION);
    clearOAuthSessionHint();

    expect(localStorage.getItem(OAUTH_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(OAUTH_SESSION_EXPIRY_KEY)).toBeNull();
  });

  describe("scrubLegacyOAuthToken", () => {
    // Upgrade path: a pre-S-4 build already wrote the token to disk, so
    // ignoring it is not enough — it has to be actively removed.
    it("removes a token written by an older build but keeps the hint usable", () => {
      localStorage.setItem(OAUTH_SESSION_KEY, JSON.stringify(SESSION));

      expect(scrubLegacyOAuthToken()).toBe(true);
      const hint = storedHint();
      expect(hint).not.toHaveProperty("token");
      expect(hint).toMatchObject({
        substrateAddress: SESSION.substrateAddress,
        expiresAt: SESSION.expiresAt,
      });
    });

    it("is a no-op when there is nothing to scrub", () => {
      expect(scrubLegacyOAuthToken()).toBe(false);

      persistOAuthSessionHint(SESSION);
      const before = localStorage.getItem(OAUTH_SESSION_KEY);
      expect(scrubLegacyOAuthToken()).toBe(false);
      expect(localStorage.getItem(OAUTH_SESSION_KEY)).toBe(before);
    });

    // An entry we cannot parse can neither serve as a hint nor be proven
    // token-free, so it is dropped rather than left on disk.
    it("drops an unparseable entry entirely", () => {
      localStorage.setItem(OAUTH_SESSION_KEY, "{not json");

      expect(scrubLegacyOAuthToken()).toBe(true);
      expect(localStorage.getItem(OAUTH_SESSION_KEY)).toBeNull();
    });
  });
});
