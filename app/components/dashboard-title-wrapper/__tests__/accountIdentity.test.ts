import { describe, it, expect } from "vitest";
import {
  resolveAccountIdentity,
  truncateAddress,
  truncateIdentity,
} from "../accountIdentity";
import type { OAuthSession } from "@/app/lib/types/oAuth";

const ADDRESS = "5HHap2Pe1234567890abcdefghijklmnopqrstuvwxyzqFQkYdsT";

const session = (over: Partial<OAuthSession> = {}): OAuthSession =>
  ({ token: "t", userId: 1, username: "ahmad_rao", expiresAt: "", ...over }) as OAuthSession;

describe("truncateAddress", () => {
  // Truncated from the middle so both ends stay checkable against a
  // block explorer; the middle is the part nobody reads.
  it("keeps both ends of a long address", () => {
    const out = truncateAddress(ADDRESS);
    expect(out.startsWith(ADDRESS.slice(0, 8))).toBe(true);
    expect(out.endsWith(ADDRESS.slice(-8))).toBe(true);
    expect(out).toContain("...");
  });

  it("leaves a short address alone rather than padding it with dots", () => {
    expect(truncateAddress("5HHap2Pe")).toBe("5HHap2Pe");
  });
});

describe("truncateIdentity", () => {
  // "@gmail" says nothing about which account this is — nearly every
  // address shares it — so the host is what gives way, not the name.
  it("drops the mail host and keeps the name and the TLD", () => {
    expect(truncateIdentity("ahmadraosanawarali@gmail.com")).toBe(
      "ahmadraosanawar….com",
    );
  });

  // A short name against a long host keeps the whole name; there is no
  // reason to trim what already fits.
  it("keeps a short local part whole", () => {
    expect(truncateIdentity("bob@some-really-long-domain.com")).toBe("bob….com");
  });

  it("leaves anything that already fits alone", () => {
    expect(truncateIdentity("a@b.com")).toBe("a@b.com");
    expect(truncateIdentity("@ahmad_rao")).toBe("@ahmad_rao");
  });

  // No "@" to exploit, so there is no uninteresting part to single out.
  it("falls back to a middle cut for a handle or an address", () => {
    expect(truncateIdentity("noatsign-but-really-long-name")).toBe(
      "noatsign-…-long-name",
    );
  });

  it("never exceeds the budget it is given", () => {
    for (const value of [
      "ahmadraosanawarali@gmail.com",
      "verylongusername.with.dots@some-company-domain.co.uk",
      "@a-github-handle-that-runs-on-and-on",
      "noatsign-but-really-long-name",
    ]) {
      expect(truncateIdentity(value).length).toBeLessThanOrEqual(20);
    }
  });
});

describe("resolveAccountIdentity", () => {
  // Users were mistaking the SS58 for a deposit address and sending
  // tokens to it, so the sign-in identity leads instead.
  it("leads with the email for a Google account", () => {
    const id = resolveAccountIdentity(
      session({ provider: "google", email: "a@b.com" }),
      ADDRESS,
    );
    expect(id.primary).toBe("a@b.com");
    expect(id.providerLabel).toBe("Google");
    expect(id.isOAuthAccount).toBe(true);
  });

  // GitHub signs in as a handle, not an email.
  it("leads with the handle for a GitHub account", () => {
    const id = resolveAccountIdentity(
      session({ provider: "github", username: "ahmad_rao", email: "a@b.com" }),
      ADDRESS,
    );
    expect(id.primary).toBe("@ahmad_rao");
    expect(id.providerLabel).toBe("GitHub");
  });

  // The card's line is shortened to fit the rail; the menu below it
  // still shows the address in full.
  it("shortens a long email on the card line", () => {
    const id = resolveAccountIdentity(
      session({ provider: "google", email: "ahmadraosanawarali@gmail.com" }),
      ADDRESS,
    );
    expect(id.primary).toBe("ahmadraosanawar….com");
    expect(id.menuEmail).toBe("ahmadraosanawarali@gmail.com");
  });

  it("names the account and its email separately in the menu", () => {
    const id = resolveAccountIdentity(
      session({ provider: "google", username: "ahmad_rao", email: "a@b.com" }),
      ADDRESS,
    );
    expect(id.menuName).toBe("ahmad_rao");
    expect(id.menuEmail).toBe("a@b.com");
  });

  // Printing the same string twice, once under the other, reads as a
  // rendering bug.
  it("drops the email when it only repeats the name", () => {
    const id = resolveAccountIdentity(
      session({ provider: "google", username: "a@b.com", email: "a@b.com" }),
      ADDRESS,
    );
    expect(id.menuEmail).toBeUndefined();
  });

  // A mnemonic account has no sign-in identity to show.
  it("keeps the address for a mnemonic account", () => {
    const id = resolveAccountIdentity(session({ provider: "mnemonic" }), ADDRESS);
    expect(id.primary).toBe(id.truncatedAddress);
    expect(id.isOAuthAccount).toBe(false);
    expect(id.providerLabel).toBeUndefined();
  });

  it("keeps the address when there is no session at all", () => {
    const id = resolveAccountIdentity(null, ADDRESS);
    expect(id.primary).toBe(id.truncatedAddress);
    expect(id.isOAuthAccount).toBe(false);
  });

  // An OAuth session that carries neither handle nor email must still
  // render something rather than an empty line.
  it("falls back to the address when the session names nobody", () => {
    const id = resolveAccountIdentity(
      { token: "t", userId: 1, username: "", provider: "apple", expiresAt: "" } as OAuthSession,
      ADDRESS,
    );
    expect(id.primary).toBe(id.truncatedAddress);
    expect(id.menuName).toBe(id.truncatedAddress);
    expect(id.providerLabel).toBe("Apple");
  });
});
