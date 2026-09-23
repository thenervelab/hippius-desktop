import { SecretStorage } from "matrix-js-sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  chatCryptoCallbacks,
  clearSecretStorageKey,
  decodeSecretStorageKey,
  getSecretStorageKeyBytes,
  hasSecretStorageKey,
  keyMatchesDescription,
  setSecretStorageKey,
} from "@/app/lib/chat/crypto/secret-storage-keys";

const bytes = (fill: number) => new Uint8Array(32).fill(fill) as Uint8Array<ArrayBuffer>;

afterEach(() => {
  clearSecretStorageKey();
});

describe("secret-storage key holder", () => {
  it("owns a copy: neither side can zero the other", () => {
    const mine = bytes(7);
    setSecretStorageKey(mine, "k1");
    mine.fill(0);
    expect(getSecretStorageKeyBytes()).toEqual(bytes(7));

    const out = getSecretStorageKeyBytes()!;
    out.fill(0);
    expect(getSecretStorageKeyBytes()).toEqual(bytes(7));

    const again = bytes(7);
    setSecretStorageKey(again, "k1");
    clearSecretStorageKey();
    expect(again).toEqual(bytes(7));
    expect(hasSecretStorageKey()).toBe(false);
  });

  it("zeroes the previous key when replaced, from either entry point", () => {
    setSecretStorageKey(bytes(1), "k1");
    const first = getSecretStorageKeyBytes();
    setSecretStorageKey(bytes(2), "k2");
    expect(first).toEqual(bytes(1));

    const fromSdk = bytes(3);
    chatCryptoCallbacks.cacheSecretStorageKey!(
      "k3",
      { algorithm: "", iv: "", mac: "", passphrase: undefined } as never,
      fromSdk,
    );
    fromSdk.fill(0);
    expect(getSecretStorageKeyBytes()).toEqual(bytes(3));
  });

  it("answers the SDK with a copy for a known id, and nothing once cleared", async () => {
    setSecretStorageKey(bytes(9), "k9");
    const answer = await chatCryptoCallbacks.getSecretStorageKey!({ keys: { k9: {} as never } }, "");
    expect(answer).not.toBeNull();
    const [id, key] = answer!;
    expect(id).toBe("k9");
    expect(key).toEqual(bytes(9));
    key.fill(0);
    expect(getSecretStorageKeyBytes()).toEqual(bytes(9));

    clearSecretStorageKey();
    expect(
      await chatCryptoCallbacks.getSecretStorageKey!({ keys: { k9: {} as never } }, ""),
    ).toBeNull();
  });

  // A foreign key set up by another client must never be "unlocked" with
  // our material: that surfaces as a MAC error deep inside the SDK rather
  // than a clean "unknown key" answer.
  it("answers only for an unknown id whose MAC our key actually opens", async () => {
    const ours = bytes(4);
    const theirs = bytes(5);
    setSecretStorageKey(ours);
    const iv = "AAAAAAAAAAAAAAAAAAAAAA";
    const describeKey = async (key: Uint8Array<ArrayBuffer>) => ({
      algorithm: SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES,
      iv,
      mac: (await SecretStorage.calculateKeyCheck(key, iv)).mac,
    });
    const foreign = await describeKey(theirs);
    const hippius = await describeKey(ours);
    const keys = { foreign, hippius } as never;

    const answer = await chatCryptoCallbacks.getSecretStorageKey!({ keys }, "");
    expect(answer?.[0]).toBe("hippius");
    expect(await keyMatchesDescription(ours, foreign as never)).toBe(false);
    expect(await keyMatchesDescription(ours, hippius as never)).toBe(true);

    // Only the foreign id on offer: no answer, not a wrong one.
    expect(
      await chatCryptoCallbacks.getSecretStorageKey!({ keys: { foreign } as never }, ""),
    ).toBeNull();
  });
});

// The key crosses the IPC boundary as base64 from Rust
// (`SecretStorageKeyMaterial.keyBase64`, 32 bytes).
describe("decodeSecretStorageKey", () => {
  it("decodes the 32 bytes Rust sends", () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i);
    const b64 = Buffer.from(raw).toString("base64");
    expect(decodeSecretStorageKey(b64)).toEqual(raw);
  });

  it("rejects a key of the wrong length instead of returning a truncated one", () => {
    expect(() =>
      decodeSecretStorageKey(Buffer.from(bytes(1).subarray(0, 16)).toString("base64")),
    ).toThrow(/32 bytes, got 16/);
    expect(() => decodeSecretStorageKey("")).toThrow(/32 bytes/);
  });
});
