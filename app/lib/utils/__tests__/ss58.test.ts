import { describe, it, expect } from "vitest";

import { sameAccount, ss58PublicKeyHex } from "../ss58";

// One account (the well-known development key) under three prefixes.
const ALICE_KEY = "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
const ALICE_GENERIC = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_POLKADOT = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
const ALICE_KUSAMA = "HNZata7iMYWmk5RvZRTiAsSDhV8366zq2YGb3tLH5Upf74F";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

describe("ss58", () => {
  it("reads the public key out of an address under any prefix", () => {
    expect(ss58PublicKeyHex(ALICE_GENERIC)).toBe(ALICE_KEY);
    expect(ss58PublicKeyHex(ALICE_POLKADOT)).toBe(ALICE_KEY);
    expect(ss58PublicKeyHex(ALICE_KUSAMA)).toBe(ALICE_KEY);
  });

  it("answers null for anything that is not an account address", () => {
    expect(ss58PublicKeyHex("")).toBeNull();
    expect(ss58PublicKeyHex("_none")).toBeNull();
    expect(ss58PublicKeyHex("5Owner")).toBeNull();
    expect(ss58PublicKeyHex("0OIl")).toBeNull();
  });

  it("compares accounts, not text", () => {
    expect(sameAccount(ALICE_GENERIC, ALICE_POLKADOT)).toBe(true);
    expect(sameAccount(ALICE_KUSAMA, ALICE_GENERIC)).toBe(true);
    expect(sameAccount(ALICE_GENERIC, BOB)).toBe(false);
    expect(sameAccount("5Owner", "5Owner")).toBe(true);
    expect(sameAccount("5Owner", "5Other")).toBe(false);
    expect(sameAccount(undefined, ALICE_GENERIC)).toBe(false);
    expect(sameAccount("", "")).toBe(false);
  });
});
