/**
 * Local-wallet keypair helper for the bridge.
 *
 * The hippius-web build hands `bridgeAlphaToHAlpha` / `bridgeHAlphaToAlpha`
 * a `keypair` object derived from the user's mnemonic so signing doesn't
 * round-trip through a wallet extension. On desktop the mnemonic lives
 * encrypted in Rust; we ask Rust to decrypt it for this one bridge
 * operation, derive an Sr25519 pair in JS, and drop the mnemonic + seed
 * the moment the call finishes.
 *
 * This mirrors the convention used by Stake / Unstake / Send: collect
 * the password inline, hand it to a verified-once IPC, sign, forget.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  cryptoWaitReady,
  mnemonicToMiniSecret,
  sr25519PairFromSeed,
  sr25519Sign,
} from "@polkadot/util-crypto";

export interface BridgeKeypair {
  publicKey: Uint8Array;
  sign: (payload: Uint8Array) => Uint8Array;
}

/**
 * Build a one-shot bridge keypair from a verified password.
 *
 * Throws if the password is wrong or no wallet is active. Callers are
 * expected to have already verified the password via
 * `LocalWalletContext.verifyPassword` so users see "Incorrect password"
 * inline instead of mid-flight.
 */
export async function deriveBridgeKeypair(
  walletId: number,
  password: string,
): Promise<BridgeKeypair> {
  const mnemonic = await invoke<string>("local_wallet_get_decrypted_mnemonic", {
    id: walletId,
    password,
  });
  if (!mnemonic) {
    throw new Error("Failed to decrypt wallet mnemonic.");
  }

  await cryptoWaitReady();
  const seed = mnemonicToMiniSecret(mnemonic);
  const pair = sr25519PairFromSeed(seed);

  return {
    publicKey: pair.publicKey,
    sign: (payload: Uint8Array) => sr25519Sign(payload, pair),
  };
}
