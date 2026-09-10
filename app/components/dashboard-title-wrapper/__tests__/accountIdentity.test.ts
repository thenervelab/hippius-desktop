import { describe, it, expect } from "vitest";
import {
  resolveAccountIdentity,
  splitIdentity,
  truncateAddress,
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

describe("splitIdentity", () => {
  // No character budget: a count cannot know the window, the zoom or the
  // font, so its own output kept being clipped from the end — losing the
  // ".com" it existed to protect.
  it("pins an email's TLD so only the head can give way", () => {
    expect(splitIdentity("ahmadraosanawarali@gmail.com")).toEqual({
      head: "ahmadraosanawarali@gmail",
      tail: ".com",
    });
  });

  // Nothing is dropped when there is room — the host is only given up
  // under pressure, by the browser, not removed up front.
  it("reassembles to the original address", () => {
    for (const email of ["a@b.com", "ahmadraosanawarali@gmail.com", "x@y.co.uk"]) {
      const { head, tail } = splitIdentity(email);
      expect(head + tail).toBe(email);
    }
  });

  // The host sits at the END of the head, so it is what the browser eats
  // first — before the name, which is the part that identifies anything.
  it("puts the host last in the head, ahead of the name", () => {
    const { head } = splitIdentity("ahmadraosanawarali@gmail.com");
    expect(head.endsWith("@gmail")).toBe(true);
    expect(head.startsWith("ahmadraosanawarali")).toBe(true);
  });

  // A handle or an address has no part worth pinning.
  it("pins nothing when there is no domain to pin", () => {
    expect(splitIdentity("@ahmad_rao")).toEqual({ head: "@ahmad_rao", tail: "" });
    expect(splitIdentity("5HHap2Pe...qFQkYdsT")).toEqual({
      head: "5HHap2Pe...qFQkYdsT",
      tail: "",
    });
  });

  // An empty head would render as a bare ".com".
  it("does not split a malformed address into an empty head", () => {
    expect(splitIdentity("a@.com")).toEqual({ head: "a@.com", tail: "" });
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
    expect(id.primary).toEqual({ head: "a@b", tail: ".com" });
    expect(id.providerLabel).toBe("Google");
    expect(id.isOAuthAccount).toBe(true);
  });

  // GitHub signs in as a handle, not an email.
  it("leads with the handle for a GitHub account", () => {
    const id = resolveAccountIdentity(
      session({ provider: "github", username: "ahmad_rao", email: "a@b.com" }),
      ADDRESS,
    );
    expect(id.primary).toEqual({ head: "@ahmad_rao", tail: "" });
    expect(id.providerLabel).toBe("GitHub");
  });

  // The card's line is split so the rail can shorten it; the menu below
  // it still shows the address in full.
  it("splits a long email for the card line and leaves the menu whole", () => {
    const id = resolveAccountIdentity(
      session({ provider: "google", email: "ahmadraosanawarali@gmail.com" }),
      ADDRESS,
    );
    expect(id.primary.tail).toBe(".com");
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
    expect(id.primary.head).toBe(id.truncatedAddress);
    expect(id.isOAuthAccount).toBe(false);
    expect(id.providerLabel).toBeUndefined();
  });

  it("keeps the address when there is no session at all", () => {
    const id = resolveAccountIdentity(null, ADDRESS);
    expect(id.primary.head).toBe(id.truncatedAddress);
    expect(id.isOAuthAccount).toBe(false);
  });

  // An OAuth session that carries neither handle nor email must still
  // render something rather than an empty line.
  it("falls back to the address when the session names nobody", () => {
    const id = resolveAccountIdentity(
      { token: "t", userId: 1, username: "", provider: "apple", expiresAt: "" } as OAuthSession,
      ADDRESS,
    );
    expect(id.primary.head).toBe(id.truncatedAddress);
    expect(id.menuName).toBe(id.truncatedAddress);
    expect(id.providerLabel).toBe("Apple");
  });
});
