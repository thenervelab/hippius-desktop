import type { MatrixClient } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";

import { decodeSecretStorageKey, getSecretStorageKeyBytes } from "@/lib/chat/crypto/secret-storage-keys";
import { chatDeriveSecretStorageKey } from "@/lib/tauri/chat";

/**
 * Data helpers behind the chat Preferences dialog. Pure where possible;
 * anything that decides something (which key, whether to notify) is
 * Rust's — this file only formats and lists.
 */

// ---------------------------------------------------------------------------
// Recovery key

/**
 * The secret-storage key in the format other Matrix clients call a
 * "Security Key" / "Recovery Key" (base58, 4-char groups). Uses the key
 * already in memory when encryption is unlocked; otherwise asks Rust for
 * it (`chat_derive_secret_storage_key`, derived from the account mnemonic
 * Rust holds — the webview never sees the mnemonic). Every copy handled
 * here is zeroed before returning.
 */
export async function recoveryKeyText(): Promise<string | null> {
  let bytes = getSecretStorageKeyBytes();
  if (!bytes) {
    const material = await chatDeriveSecretStorageKey();
    bytes = decodeSecretStorageKey(material.keyBase64);
  }
  try {
    return encodeRecoveryKey(bytes) ?? null;
  } finally {
    bytes.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Devices

export interface DeviceRow {
  deviceId: string;
  displayName: string;
  lastSeenTs: number | null;
  lastSeenIp: string | null;
  isCurrent: boolean;
  /** null = no crypto info (device never uploaded keys, or crypto is off). */
  verified: boolean | null;
}

/** Own devices, current first, then most recently seen. */
export async function listOwnDevices(client: MatrixClient): Promise<DeviceRow[]> {
  const me = client.getUserId();
  const current = client.getDeviceId();
  const crypto = client.getCrypto();
  const { devices } = await client.getDevices();
  const rows = await Promise.all(
    devices.map(async (d) => {
      let verified: boolean | null = null;
      if (crypto && me) {
        const status = await crypto.getDeviceVerificationStatus(me, d.device_id).catch(() => null);
        verified = status ? status.isVerified() : null;
      }
      return {
        deviceId: d.device_id,
        displayName: d.display_name?.trim() || d.device_id,
        lastSeenTs: d.last_seen_ts ?? null,
        lastSeenIp: d.last_seen_ip ?? null,
        isCurrent: d.device_id === current,
        verified,
      };
    }),
  );
  return rows.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0));
}
