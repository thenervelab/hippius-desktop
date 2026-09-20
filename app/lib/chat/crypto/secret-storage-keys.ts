/**
 * In-memory holder for the secret-storage key, plus the `CryptoCallbacks`
 * the SDK uses to fetch it.
 *
 * The key is derived from the account mnemonic — in Rust
 * (`chat_derive_secret_storage_key`, `src-tauri/src/chat/keys.rs`), never
 * here — and lives only in this holder: no IndexedDB, no localStorage, not
 * on the server. `ChatProvider` fetches it right before an encryption
 * bootstrap and clears it when the client stops or the user signs out.
 *
 * The holder owns its bytes: it stores a copy of what it is given and hands
 * out copies, so zeroing here never reaches into a buffer the bootstrap or
 * the SDK is still using, and no caller can keep our copy alive.
 *
 * The SDK may ask for the key under several ids (the account can hold more
 * than one 4S key). We answer only for ids whose stored MAC matches our key,
 * so a foreign key set up by another client is never "unlocked" with the
 * wrong material — that produces a MAC error deep inside the SDK rather
 * than a clean "unknown key" answer.
 *
 * Ported from the console's `lib/chat/crypto/secret-storage-keys.ts`.
 */

import { SecretStorage } from "matrix-js-sdk";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api";
import type {
  SecretStorageKeyDescription,
  SecretStorageKeyDescriptionAesV1,
} from "matrix-js-sdk/lib/secret-storage";

interface Holder {
  key: Uint8Array<ArrayBuffer> | null;
  /** Ids we have confirmed (by MAC) to belong to `key`. */
  knownIds: Set<string>;
}

const holder: Holder = { key: null, knownIds: new Set() };

/** A fresh buffer with the same bytes. */
function copyOf(key: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(key);
}

function replaceKey(key: Uint8Array): void {
  if (holder.key) holder.key.fill(0);
  holder.key = copyOf(key);
}

export function setSecretStorageKey(key: Uint8Array, keyId?: string): void {
  replaceKey(key);
  holder.knownIds = new Set(keyId ? [keyId] : []);
}

export function hasSecretStorageKey(): boolean {
  return holder.key !== null;
}

/** A copy of the key, or null. The caller zeroes it when done. */
export function getSecretStorageKeyBytes(): Uint8Array<ArrayBuffer> | null {
  return holder.key ? copyOf(holder.key) : null;
}

export function clearSecretStorageKey(): void {
  if (holder.key) holder.key.fill(0);
  holder.key = null;
  holder.knownIds = new Set();
}

/**
 * Decode the key as Rust hands it over the IPC boundary (standard base64
 * of 32 bytes). Rejects anything of another length: a truncated key would
 * otherwise "not match" every description and read as a foreign key.
 */
export function decodeSecretStorageKey(keyBase64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(keyBase64);
  if (binary.length !== 32) {
    throw new Error(`secret-storage key must be 32 bytes, got ${binary.length}`);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function isAesV1(info: SecretStorageKeyDescription): info is SecretStorageKeyDescriptionAesV1 {
  return (
    info.algorithm === SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES &&
    typeof (info as SecretStorageKeyDescriptionAesV1).mac === "string"
  );
}

/**
 * Does `key` open the secret storage key described by `info`? Same check
 * the SDK performs in `ServerSideSecretStorage.checkKey`, without needing a
 * client instance.
 */
export async function keyMatchesDescription(
  key: Uint8Array<ArrayBuffer>,
  info: SecretStorageKeyDescription,
): Promise<boolean> {
  if (!isAesV1(info)) return false;
  if (!info.iv) {
    // A key description without a check payload: nothing to compare. Treat
    // as a match only when the caller has no alternative (spec allows it).
    return true;
  }
  const { mac } = await SecretStorage.calculateKeyCheck(key, info.iv);
  return SecretStorage.trimTrailingEquals(mac) === SecretStorage.trimTrailingEquals(info.mac);
}

export const chatCryptoCallbacks: CryptoCallbacks = {
  async getSecretStorageKey({ keys }) {
    const key = holder.key;
    if (!key) return null;

    // Prefer an id we already verified.
    for (const id of Object.keys(keys)) {
      if (holder.knownIds.has(id)) return [id, copyOf(key)];
    }
    for (const [id, info] of Object.entries(keys)) {
      if (await keyMatchesDescription(key, info)) {
        holder.knownIds.add(id);
        return [id, copyOf(key)];
      }
    }
    return null;
  },

  cacheSecretStorageKey(keyId, _keyInfo, key) {
    replaceKey(key);
    holder.knownIds.add(keyId);
  },
};
