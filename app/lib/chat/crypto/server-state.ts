/**
 * What the homeserver actually holds for this account's encryption setup.
 *
 * Everything here is read from the server, never from the client's sync
 * store or from what the local crypto store believes: account data is
 * fetched with a direct GET (the sync store may lag or be stale after an
 * out-of-band change), cross-signing keys and device signatures come from
 * `/keys/query`, the backup from `/room_keys/version`. The only local facts
 * mixed in are the ones that have no server counterpart (private keys
 * cached in the crypto store, the backup decryption key we hold), and they
 * are labelled as such.
 *
 * Used by the bootstrap to decide what to do and to verify what it did.
 * Ported from the console's `lib/chat/crypto/server-state.ts`; the fixed
 * key id is a parameter here because Rust owns it (`chat_get_config`).
 */

import { type MatrixClient, Method } from "matrix-js-sdk";
import type { CryptoApi } from "matrix-js-sdk/lib/crypto-api";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";

import {
  getSecretStorageKeyBytes,
  keyMatchesDescription,
} from "@/app/lib/chat/crypto/secret-storage-keys";

export const SECRET_NAMES = {
  master: "m.cross_signing.master",
  selfSigning: "m.cross_signing.self_signing",
  userSigning: "m.cross_signing.user_signing",
  backup: "m.megolm_backup.v1",
} as const;

export type SecretName = keyof typeof SECRET_NAMES;

/** Global account data as the server has it right now, or null when absent. */
export async function fetchAccountData<T extends object = Record<string, unknown>>(
  client: MatrixClient,
  eventType: string,
): Promise<T | null> {
  const userId = client.getUserId();
  if (!userId) throw new Error("fetchAccountData: client has no user id");
  const path = `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(eventType)}`;
  try {
    const content = await client.http.authedRequest<T>(Method.Get, path);
    // An emptied entry (the SDK "deletes" by writing `{}`) counts as absent.
    if (!content || Object.keys(content).length === 0) return null;
    return content;
  } catch (error) {
    if ((error as { errcode?: string } | undefined)?.errcode === "M_NOT_FOUND") return null;
    throw error;
  }
}

interface EncryptedSecret {
  encrypted?: Record<string, unknown>;
}

/** Key ids a secret is encrypted under, per the server. Empty when absent. */
export async function secretKeyIds(client: MatrixClient, secretName: string): Promise<string[]> {
  const content = await fetchAccountData<EncryptedSecret>(client, secretName);
  return content?.encrypted ? Object.keys(content.encrypted) : [];
}

export interface PublishedKeys {
  master: boolean;
  selfSigning: boolean;
  userSigning: boolean;
  /** Public part of the self-signing key, when published. */
  selfSigningPublicKey: string | null;
  /** Our own device carries a signature by the published self-signing key. */
  deviceSignedBySelfSigningKey: boolean;
  /** Our own device has uploaded its keys at all. */
  deviceKeysPublished: boolean;
}

/**
 * `/keys/query` for our own user: which cross-signing keys the server
 * publishes, and whether our device is signed by the self-signing key.
 */
export async function queryPublishedKeys(client: MatrixClient): Promise<PublishedKeys> {
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  if (!userId || !deviceId) throw new Error("queryPublishedKeys: client has no user or device id");

  const result = await client.downloadKeysForUsers([userId]);
  const master = result.master_keys?.[userId];
  const selfSigning = result.self_signing_keys?.[userId];
  const userSigning = result.user_signing_keys?.[userId];
  const selfSigningPublicKey = selfSigning ? (Object.values(selfSigning.keys)[0] ?? null) : null;

  const device = result.device_keys?.[userId]?.[deviceId];
  const deviceSignatures = device?.signatures?.[userId] ?? {};
  const deviceSignedBySelfSigningKey =
    selfSigningPublicKey !== null && `ed25519:${selfSigningPublicKey}` in deviceSignatures;

  return {
    master: Boolean(master),
    selfSigning: Boolean(selfSigning),
    userSigning: Boolean(userSigning),
    selfSigningPublicKey,
    deviceSignedBySelfSigningKey,
    deviceKeysPublished: Boolean(device),
  };
}

export interface EncryptionServerState {
  userId: string;
  deviceId: string;
  secretStorage: {
    defaultKeyId: string | null;
    defaultKeyName: string | null;
    /**
     * The default key opens with the mnemonic-derived key. `null` when no
     * derived key is in memory (Console locked) or there is no default key.
     */
    defaultKeyIsDerived: boolean | null;
    /** The Hippius fixed key id (`hippiusKeyId`) exists on the server (default or not). */
    hippiusKeyPresent: boolean;
    /** Which secrets are stored under the *default* key. */
    secretsUnderDefaultKey: Record<SecretName, boolean>;
  };
  crossSigning: {
    /** Public keys the server publishes (`/keys/query`). */
    published: { master: boolean; selfSigning: boolean; userSigning: boolean };
    /** Private keys in this device's crypto store (local fact). */
    privateKeysCached: { master: boolean; selfSigning: boolean; userSigning: boolean };
  };
  device: {
    /** The server holds a signature on this device by the self-signing key. */
    signedBySelfSigningKey: boolean;
    /** This device's own keys are on the server at all. */
    keysPublished: boolean;
  };
  backup: {
    /** Server-side backup version, or null when there is none. */
    version: string | null;
    algorithm: string | null;
    /** Room keys in the backup, per the server. */
    count: number | null;
    /** We hold the decryption key for *this* backup version (local fact). */
    decryptionKeyHeld: boolean;
    /** The backup is active on this device (keys are uploaded to it). */
    activeVersion: string | null;
  };
}

function cryptoOf(client: MatrixClient): CryptoApi {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("readEncryptionServerState: crypto is not initialised");
  return crypto;
}

/**
 * Full picture. `hippiusKeyId` is the fixed secret-storage key id shared
 * with the console (from Rust's `ChatConfig.secretStorageKeyId`).
 * `derivedKey` is compared to the default key description when given;
 * otherwise the in-memory holder is used when it has a key.
 */
export async function readEncryptionServerState(
  client: MatrixClient,
  hippiusKeyId: string,
  derivedKey?: Uint8Array<ArrayBuffer> | null,
): Promise<EncryptionServerState> {
  const crypto = cryptoOf(client);
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  if (!userId || !deviceId) throw new Error("readEncryptionServerState: client has no user or device id");

  const [defaultKey, hippiusKey, published, crossSigningStatus, backupInfo, activeVersion, backupKey] =
    await Promise.all([
      fetchAccountData<{ key?: string }>(client, "m.secret_storage.default_key"),
      fetchAccountData<SecretStorageKeyDescription>(client, `m.secret_storage.key.${hippiusKeyId}`),
      queryPublishedKeys(client),
      crypto.getCrossSigningStatus(),
      crypto.getKeyBackupInfo(),
      crypto.getActiveSessionBackupVersion(),
      crypto.getSessionBackupPrivateKey(),
    ]);

  const defaultKeyId = defaultKey?.key ?? null;
  const defaultKeyInfo = defaultKeyId
    ? await fetchAccountData<SecretStorageKeyDescription>(client, `m.secret_storage.key.${defaultKeyId}`)
    : null;

  let defaultKeyIsDerived: boolean | null = null;
  if (defaultKeyInfo) {
    const key = derivedKey ?? getSecretStorageKeyBytes();
    if (key) {
      try {
        defaultKeyIsDerived = await keyMatchesDescription(key, defaultKeyInfo);
      } finally {
        if (key !== derivedKey) key.fill(0);
      }
    }
  }

  const secretsUnderDefaultKey = {} as Record<SecretName, boolean>;
  await Promise.all(
    (Object.keys(SECRET_NAMES) as SecretName[]).map(async (name) => {
      const ids = await secretKeyIds(client, SECRET_NAMES[name]);
      secretsUnderDefaultKey[name] = defaultKeyId !== null && ids.includes(defaultKeyId);
    }),
  );

  let decryptionKeyHeld = false;
  if (backupInfo?.version && backupKey) {
    decryptionKeyHeld = (await crypto.isKeyBackupTrusted(backupInfo)).matchesDecryptionKey;
  }
  backupKey?.fill(0);

  return {
    userId,
    deviceId,
    secretStorage: {
      defaultKeyId,
      defaultKeyName: defaultKeyInfo?.name ?? null,
      defaultKeyIsDerived,
      hippiusKeyPresent: hippiusKey !== null,
      secretsUnderDefaultKey,
    },
    crossSigning: {
      published: {
        master: published.master,
        selfSigning: published.selfSigning,
        userSigning: published.userSigning,
      },
      privateKeysCached: {
        master: crossSigningStatus.privateKeysCachedLocally.masterKey,
        selfSigning: crossSigningStatus.privateKeysCachedLocally.selfSigningKey,
        userSigning: crossSigningStatus.privateKeysCachedLocally.userSigningKey,
      },
    },
    device: {
      signedBySelfSigningKey: published.deviceSignedBySelfSigningKey,
      keysPublished: published.deviceKeysPublished,
    },
    backup: {
      version: backupInfo?.version ?? null,
      algorithm: backupInfo?.algorithm ?? null,
      count: backupInfo?.count ?? null,
      decryptionKeyHeld,
      activeVersion,
    },
  };
}
