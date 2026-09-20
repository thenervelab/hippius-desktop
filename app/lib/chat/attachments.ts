/**
 * End-to-end encrypted attachments, as specified by the Matrix spec
 * ("Sending encrypted attachments", `EncryptedFile` v2):
 *
 * - key: 256-bit AES, random per file, carried as a JWK (`kty: oct`,
 *   `alg: A256CTR`, `k` base64url without padding, `ext: true`);
 * - iv: 16 bytes, the first 8 random, the low 8 bytes zero (so the CTR
 *   counter cannot overflow into the nonce), base64 *with* padding;
 * - hashes.sha256: base64 (unpadded) SHA-256 of the ciphertext.
 *
 * WebCrypto only; no third-party dependency. Works in browsers and in
 * Node >= 20 for the tests.
 */

export interface EncryptedFile {
  url: string;
  key: {
    kty: "oct";
    key_ops: string[];
    alg: "A256CTR";
    k: string;
    ext: true;
  };
  iv: string;
  hashes: { sha256: string };
  v: "v2";
}

export interface EncryptedAttachment {
  /** Ciphertext to upload. */
  data: Uint8Array<ArrayBuffer>;
  /** Everything but `url`, which is known only after upload. */
  info: Omit<EncryptedFile, "url">;
}

function subtle(): SubtleCrypto {
  if (!crypto?.subtle) throw new Error("WebCrypto is not available");
  return crypto.subtle;
}

export function toBase64(bytes: Uint8Array, padded: boolean): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  const encoded = btoa(binary);
  return padded ? encoded : encoded.replace(/=+$/, "");
}

export function fromBase64(input: string): Uint8Array<ArrayBuffer> {
  const normalised = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes, false).replace(/\+/g, "-").replace(/\//g, "_");
}

/** Encrypt bytes for upload. */
function asBytes(input: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  if (input instanceof Uint8Array) {
    // Copy into a plain ArrayBuffer-backed view so WebCrypto's BufferSource
    // typing (which excludes SharedArrayBuffer) is satisfied.
    return input.buffer instanceof ArrayBuffer && input.byteOffset === 0 && input.byteLength === input.buffer.byteLength
      ? (input as Uint8Array<ArrayBuffer>)
      : new Uint8Array(input);
  }
  return new Uint8Array(input);
}

export async function encryptAttachment(plaintext: ArrayBuffer | Uint8Array): Promise<EncryptedAttachment> {
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));
  const subtleCrypto = subtle();
  const key = await subtleCrypto.generateKey({ name: "AES-CTR", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await subtleCrypto.exportKey("raw", key));
  const input = asBytes(plaintext);
  const ciphertext = new Uint8Array(
    await subtleCrypto.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, input),
  );
  const digest = new Uint8Array(await subtleCrypto.digest("SHA-256", ciphertext));
  return {
    data: ciphertext,
    info: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: toBase64Url(rawKey),
        ext: true,
      },
      iv: toBase64(iv, true),
      hashes: { sha256: toBase64(digest, false) },
      v: "v2",
    },
  };
}

/** Verify the hash and decrypt. Throws on tampering or an unsupported version. */
export async function decryptAttachment(
  ciphertext: ArrayBuffer | Uint8Array,
  file: Omit<EncryptedFile, "url">,
): Promise<Uint8Array<ArrayBuffer>> {
  if (file.v !== "v2") throw new Error(`Unsupported encrypted file version: ${file.v}`);
  if (file.key.alg !== "A256CTR" || file.key.kty !== "oct") {
    throw new Error("Unsupported attachment key");
  }
  const subtleCrypto = subtle();
  const data = asBytes(ciphertext);

  const digest = new Uint8Array(await subtleCrypto.digest("SHA-256", data));
  const expected = fromBase64(file.hashes.sha256);
  if (digest.length !== expected.length || !digest.every((b, i) => b === expected[i])) {
    throw new Error("Attachment hash mismatch");
  }

  const key = await subtleCrypto.importKey("raw", fromBase64(file.key.k), { name: "AES-CTR" }, false, [
    "decrypt",
  ]);
  const iv = fromBase64(file.iv);
  if (iv.length !== 16) throw new Error("Attachment IV must be 16 bytes");
  return new Uint8Array(await subtleCrypto.decrypt({ name: "AES-CTR", counter: iv, length: 64 }, key, data));
}

/**
 * Top-level content flag on an `m.video` that stands in for a GIF (silent,
 * short, loops): the timeline plays it like one. `m.image` GIFs need no
 * flag, their mimetype says it.
 */
export const GIF_CONTENT_FLAG = "com.hippius.chat.gif";

/** Matrix `msgtype` for a file, from its MIME type. */
export function msgTypeForMime(mime: string): "m.image" | "m.video" | "m.audio" | "m.file" {
  if (mime.startsWith("image/")) return "m.image";
  if (mime.startsWith("video/")) return "m.video";
  if (mime.startsWith("audio/")) return "m.audio";
  return "m.file";
}

/** "1.2 MB" style size for attachment chips. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
