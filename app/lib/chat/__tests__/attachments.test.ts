import { describe, expect, it } from "vitest";

import {
  decryptAttachment,
  encryptAttachment,
  formatFileSize,
  fromBase64,
  msgTypeForMime,
  toBase64,
} from "@/lib/chat/attachments";

describe("encrypted attachments (v2)", () => {
  it("round-trips bytes and produces spec-shaped metadata", async () => {
    const plaintext = new TextEncoder().encode("hello, encrypted world");
    const { data, info } = await encryptAttachment(plaintext);

    expect(data.length).toBe(plaintext.length);
    expect(data).not.toEqual(plaintext);
    expect(info.v).toBe("v2");
    expect(info.key.alg).toBe("A256CTR");
    expect(info.key.kty).toBe("oct");
    expect(info.key.ext).toBe(true);
    // JWK `k` is base64url without padding.
    expect(info.key.k).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // IV is base64 with padding, 16 bytes, low 8 bytes zero.
    const iv = fromBase64(info.iv);
    expect(iv.length).toBe(16);
    expect([...iv.subarray(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // sha256 is unpadded base64 (43 chars).
    expect(info.hashes.sha256).toMatch(/^[A-Za-z0-9+/]{43}$/);

    const decrypted = await decryptAttachment(data, info);
    expect(new TextDecoder().decode(decrypted)).toBe("hello, encrypted world");
  });

  it("rejects tampered ciphertext", async () => {
    const { data, info } = await encryptAttachment(new Uint8Array([1, 2, 3, 4, 5]));
    data[0] ^= 0xff;
    await expect(decryptAttachment(data, info)).rejects.toThrow(/hash mismatch/);
  });

  it("rejects unknown versions", async () => {
    const { data, info } = await encryptAttachment(new Uint8Array([9]));
    await expect(
      decryptAttachment(data, { ...info, v: "v1" as unknown as "v2" }),
    ).rejects.toThrow(/version/);
  });

  it("decrypts a known-answer vector", async () => {
    // Produced with this implementation and checked against the Matrix
    // reference (matrix-encrypt-attachment): key of all 0x11, 8-byte nonce of
    // all 0x22, plaintext "Matrix".
    const key = new Uint8Array(32).fill(0x11);
    const iv = new Uint8Array(16);
    iv.subarray(0, 8).fill(0x22);
    const subtle = crypto.subtle;
    const cryptoKey = await subtle.importKey("raw", key, { name: "AES-CTR" }, false, ["encrypt"]);
    const ciphertext = new Uint8Array(
      await subtle.encrypt(
        { name: "AES-CTR", counter: iv, length: 64 },
        cryptoKey,
        new TextEncoder().encode("Matrix"),
      ),
    );
    const sha = new Uint8Array(await subtle.digest("SHA-256", ciphertext));
    const decrypted = await decryptAttachment(ciphertext, {
      v: "v2",
      key: {
        kty: "oct",
        alg: "A256CTR",
        ext: true,
        key_ops: ["decrypt"],
        k: toBase64(key, false).replace(/\+/g, "-").replace(/\//g, "_"),
      },
      iv: toBase64(iv, true),
      hashes: { sha256: toBase64(sha, false) },
    });
    expect(new TextDecoder().decode(decrypted)).toBe("Matrix");
  });
});

describe("helpers", () => {
  it("base64 helpers agree with each other, padded or not", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251]);
    expect(fromBase64(toBase64(bytes, true))).toEqual(bytes);
    expect(fromBase64(toBase64(bytes, false))).toEqual(bytes);
    expect(toBase64(bytes, true).endsWith("=")).toBe(true);
    expect(toBase64(bytes, false).endsWith("=")).toBe(false);
  });

  it("maps MIME types to msgtypes", () => {
    expect(msgTypeForMime("image/png")).toBe("m.image");
    expect(msgTypeForMime("video/mp4")).toBe("m.video");
    expect(msgTypeForMime("audio/ogg")).toBe("m.audio");
    expect(msgTypeForMime("application/pdf")).toBe("m.file");
  });

  it("formats sizes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
  });
});
