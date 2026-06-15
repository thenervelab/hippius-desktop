/**
 * Bridge signer adapter for the desktop's local-wallet keystore.
 *
 * Web's `bridgeAlphaToHAlpha` / `bridgeHAlphaToAlpha` accept a
 * `keypair = { publicKey, sign }` object and hand it to
 * `getPolkadotSigner`. On web the keypair lives in the renderer
 * because the user's mnemonic is loaded into JS at session start by
 * the polkadot-js extension.
 *
 * Desktop is the opposite: the mnemonic lives encrypted in SQLite
 * inside the Rust process and we don't want it ever crossing the IPC
 * boundary. This module builds a keypair-shaped object whose `sign`
 * callback round-trips through Rust's `local_wallet_sign` IPC — Rust
 * decrypts the mnemonic, derives the sr25519 keypair, signs the
 * payload, and drops everything before returning the 64-byte
 * signature.
 *
 * The user's password is captured once in a closure when the bridge
 * submit begins (after the inline-password confirmation step) and is
 * referenced by every `sign` call within that closure's lifetime.
 * When the submit finishes (success, failure, or cancel) the closure
 * is dropped and the password becomes unreachable. The mnemonic
 * never enters the renderer at any point.
 */

import { invoke } from "@tauri-apps/api/core";

export interface BridgeKeypair {
  /** Raw 32-byte Sr25519 public key — used by polkadot-api's
   *  `getPolkadotSigner` to identify the signer; not sensitive. */
  publicKey: Uint8Array;
  /** Sign callback. polkadot-api accepts a Promise return, so the
   *  IPC round-trip lives behind this async signature without
   *  requiring any changes to the upstream service. */
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
}

function uint8ToB64(bytes: Uint8Array): string {
  // Browser-safe — `btoa` only accepts binary strings.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Build a signer object that the bridge service can hand to
 * polkadot-api. Captures `password` in a closure so each sign call
 * doesn't need to re-prompt — but the password never escapes this
 * module other than as a `string` arg to the Rust IPC.
 *
 * Note: `password` here is **not** persisted anywhere. It lives in
 * the closure for the lifetime of one bridge submit and is released
 * when the dialog teardown drops every reference to the returned
 * signer.
 */
export async function buildBridgeSigner(
  walletId: number,
  password: string,
): Promise<BridgeKeypair> {
  const publicKeyB64 = await invoke<string>("local_wallet_get_public_key", {
    id: walletId,
  });
  const publicKey = b64ToUint8(publicKeyB64);

  const sign = async (payload: Uint8Array): Promise<Uint8Array> => {
    const sigB64 = await invoke<string>("local_wallet_sign", {
      id: walletId,
      password,
      payloadB64: uint8ToB64(payload),
    });
    return b64ToUint8(sigB64);
  };

  return { publicKey, sign };
}
