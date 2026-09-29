/**
 * Compare two SS58 addresses by the account they name, not by their text.
 *
 * One account written under two network prefixes is two different strings
 * (`5F...` and `1...`, say), and every place that asks "is this the owner?"
 * or "is this me?" by `===` quietly answers no. The account is the 32-byte
 * public key inside the address, so that is what gets compared.
 *
 * Decoding only, no checksum check: the addresses compared here come from
 * the server and the session, not from typing, and two values that carry
 * the same key bytes name the same account whatever their checksum says.
 * Rust holds the same rule for the search it runs (`same_account` in
 * `sync/fileops/recent_uploads.rs`).
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((c, i) => [c, i]),
);

/** Base58 (Bitcoin alphabet) to bytes, or null for a character outside it. */
function base58Decode(text: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const ch of text) {
    const value = INDEX[ch];
    if (value === undefined) return null;
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading "1" is a leading zero byte.
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/**
 * The account's public key as hex, or null when the text is not a 32-byte
 * SS58 account address. The prefix is one byte below 64 and two bytes
 * from 64 to 127; two checksum bytes follow the key.
 */
export function ss58PublicKeyHex(address: string | null | undefined): string | null {
  const text = address?.trim();
  if (!text) return null;
  const raw = base58Decode(text);
  if (!raw || raw.length === 0) return null;
  const prefixLength = raw[0] < 64 ? 1 : raw[0] < 128 ? 2 : 0;
  if (prefixLength === 0 || raw.length !== prefixLength + 32 + 2) return null;
  return Array.from(raw.subarray(prefixLength, prefixLength + 32), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Same account, whatever prefix each side was written in. Falls back to the
 * strings themselves when either does not decode, so a malformed value still
 * matches an identical one rather than nothing.
 */
export function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = ss58PublicKeyHex(a);
  return ka !== null && ka === ss58PublicKeyHex(b);
}
