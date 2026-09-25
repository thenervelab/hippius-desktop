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
    expect(card).toContain("identity.address");
    expect(card).toContain("WalletMinimal");
    expect(card).not.toMatch(/>Copy address</);
  });

  // A node-health reading, not an account fact — this card answers "who
  // am I signed in as", and the chain height competed with the address
  // for the one line under the identity.
  it("shows no chain height, on the card or in the menu", () => {
    expect(card).not.toMatch(/blockNumber|usePolkadotApi/);
  });

  // Without w-full/min-w-0 the row sized to its content, overflowed the
  // clipping parent, and took the chevron off the right edge with it.
  it("lets the identity row shrink so the chevron survives", () => {
    expect(card).toMatch(/flex w-full min-w-0 items-center gap-1\.5/);
    expect(card).toMatch(/ChevronDown[\s\S]*?shrink-0/);
  });

  // A `truncate` over the whole string cut the END, which is where the
  // ".com" is; a head/tail split then let the head's own ellipsis eat the
  // domain. Every identity on the card and in the menu is shortened in the
  // middle instead, to the width it has.
  it("shortens every identity in the middle, never at the end", () => {
    expect(card).toMatch(/<MiddleTruncate\s+text=\{identity\.primary\}/);
    expect(card).toMatch(/<MiddleTruncate\s+text=\{identity\.menuName\}/);
    expect(card).toMatch(/<MiddleTruncate\s+text=\{identity\.menuEmail\}/);
    expect(card).toMatch(/<MiddleTruncate\s+text=\{identity\.address\}/);
    expect(card).not.toMatch(/truncate[^"]*">\s*\{(identity\.|truncatedAddress)/);
  });

  // A character budget cannot know the window, the zoom or the font.
  it("uses no character budget for the identity", () => {
    expect(card).not.toMatch(/truncateIdentity/);
  });
});
