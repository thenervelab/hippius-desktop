import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const readCode = (rel: string) =>
  readFileSync(join(here, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const card = readCode("../ProfileCard.tsx");

describe("the account card matches the console", () => {
  // One resolver for both clients' rules, so an account is not described
  // two different ways depending on where it is looked at.
  it("resolves the identity rather than deriving it inline", () => {
    expect(card).toContain("resolveAccountIdentity");
    // The old inline slice(0, 8) truncation is gone.
    expect(card).not.toMatch(/displayAddress\.slice\(0,\s*8\)/);
  });

  it("shows the sign-in identity on the collapsed card, not the address", () => {
    expect(card).toContain("identity.primary");
  });

  it("names the account, its email and its provider in the open menu", () => {
    expect(card).toContain("identity.menuName");
    expect(card).toContain("identity.menuEmail");
    expect(card).toContain("identity.providerLabel");
  });

  // A mnemonic account has no sign-in identity, so the header would show
  // its address twice — once there and once on the row below.
  it("shows the header only for an account that has a sign-in identity", () => {
    expect(card).toMatch(/identity\.isOAuthAccount\s*&&/);
  });

  // The old row named the action without ever showing what would be
  // copied.
  it("puts the address itself on the copy row", () => {
    expect(card).toContain("truncatedAddress");
    expect(card).toContain("WalletMinimal");
    expect(card).not.toMatch(/>Copy address</);
  });
});
