/**
 * Test double for the encryption bootstrap: a fake homeserver plus a fake
 * `CryptoApi` that behave like the rust stack does at the level the
 * bootstrap cares about. Account data is a map, `/keys/query` answers from
 * `published`, and the crypto methods mutate both the way the SDK's
 * implementations do (export to 4S only when a default key exists, sign
 * the device on create/import, store the backup key on reset).
 *
 * Shared by the bootstrap unit tests and the `ChatProvider` tests, so the
 * provider is exercised against the same model of the server that the
 * bootstrap itself is tested on. Test-only: excluded from coverage in
 * `vitest.config.ts`; nothing outside a test file imports this.
 *
 * Ported from the console's `crypto/testing/fake-world.ts`. The desktop
 * derives the secret-storage key in Rust, so instead of a mnemonic this
 * world carries the derived key bytes (`OUR_KEY`) and the fixed id/name
 * Rust publishes them under — what `chat_derive_secret_storage_key`
 * answers in the provider tests.
 */

import type { MatrixClient } from "matrix-js-sdk";
import { SecretStorage } from "matrix-js-sdk";

import type { SecretStorageKeyMaterialBytes } from "@/app/lib/chat/crypto/bootstrap";

export const USER = "@alice:example.org";
export const DEVICE = "DESKTOPDEV";
/** Stand-in for what Rust derives from the account mnemonic. */
export const OUR_KEY = new Uint8Array(32).fill(42) as Uint8Array<ArrayBuffer>;
/** Rust's `CHAT_4S_KEY_ID` / `CHAT_4S_KEY_NAME` (`src-tauri/src/chat/keys.rs`). */
export const OUR_KEY_ID = "hippius-console-v1";
export const OUR_KEY_NAME = "Hippius Console recovery key";
export const OUR_MATERIAL: SecretStorageKeyMaterialBytes = {
  key: OUR_KEY,
  keyId: OUR_KEY_ID,
  keyName: OUR_KEY_NAME,
};
const FOREIGN_KEY = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>;

export interface Published {
  master: boolean;
  selfSigning: boolean;
  userSigning: boolean;
  deviceSigned: boolean;
}

export interface World {
  accountData: Map<string, Record<string, unknown>>;
  published: Published;
  backupVersion: string | null;
  /** Decryption key (as an opaque tag) the backup was created with. */
  backupKeyTag: string | null;
  crypto: {
    privateKeysCached: boolean;
    /** Tag of the backup key held locally, if any. */
    heldBackupKeyTag: string | null;
    activeBackupVersion: string | null;
  };
  calls: string[];
  /** Make `setDefaultKeyId` a silent no-op (stale-store shortcut). */
  staleDefaultKey?: boolean;
  /** Make `bootstrapCrossSigning` throw this. */
  crossSigningError?: unknown;
  /**
   * Interrupt the next `resetCrossSigning` the way the SDK fails for real:
   * private keys already cached and exported to secret storage, then the
   * upload of the public keys dies (network / tab closed).
   */
  interruptNextPublish?: boolean;
  /**
   * Every crypto read takes a macrotask, like the real rust stack reading
   * its IndexedDB store does. Without it the fake answers within the same
   * microtask queue, which hides any ordering bug between a React render
   * and an awaited crypto call.
   */
  latency?: boolean;
}

export function makeWorld(overrides: Partial<World> = {}): World {
  return {
    accountData: new Map(),
    published: { master: false, selfSigning: false, userSigning: false, deviceSigned: false },
    backupVersion: null,
    backupKeyTag: null,
    crypto: { privateKeysCached: false, heldBackupKeyTag: null, activeBackupVersion: null },
    calls: [],
    ...overrides,
  };
}

export function defaultKeyId(w: World): string | null {
  return (w.accountData.get("m.secret_storage.default_key")?.key as string | undefined) ?? null;
}

export function storeSecret(w: World, name: string, keyId: string): void {
  const existing = (w.accountData.get(name)?.encrypted as Record<string, unknown> | undefined) ?? {};
  w.accountData.set(name, { encrypted: { ...existing, [keyId]: { iv: "iv", ciphertext: "ct", mac: "mac" } } });
}

export function secretUnder(w: World, name: string, keyId: string): boolean {
  const enc = w.accountData.get(name)?.encrypted as Record<string, unknown> | undefined;
  return Boolean(enc && keyId in enc);
}

export async function addForeignDefaultKey(w: World, keyId = "ELEMENTKEY"): Promise<void> {
  const { iv, mac } = await SecretStorage.calculateKeyCheck(FOREIGN_KEY);
  w.accountData.set(`m.secret_storage.key.${keyId}`, {
    algorithm: SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES,
    name: "Element recovery key",
    iv,
    mac,
  });
  w.accountData.set("m.secret_storage.default_key", { key: keyId });
}

export async function addOurDefaultKey(w: World): Promise<void> {
  const { iv, mac } = await SecretStorage.calculateKeyCheck(OUR_KEY);
  w.accountData.set(`m.secret_storage.key.${OUR_KEY_ID}`, {
    algorithm: SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES,
    name: OUR_KEY_NAME,
    iv,
    mac,
  });
  w.accountData.set("m.secret_storage.default_key", { key: OUR_KEY_ID });
}

function exportCrossSigningToStorage(w: World): void {
  const id = defaultKeyId(w);
  if (!id) return;
  for (const name of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]) {
    if (!secretUnder(w, name, id)) storeSecret(w, name, id);
  }
}

// A few ms, like an IndexedDB round trip; well past the scheduler tick React
// uses to flush a state update made from a passive effect.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export function makeClient(w: World): MatrixClient {
  const notFound = () => Object.assign(new Error("not found"), { errcode: "M_NOT_FOUND", httpStatus: 404 });
  const io = async () => {
    if (w.latency) await tick();
  };

  const crypto = {
    async getCrossSigningStatus() {
      await io();
      const c = w.crypto.privateKeysCached;
      return {
        publicKeysOnDevice: w.published.master,
        privateKeysInSecretStorage: false,
        privateKeysCachedLocally: { masterKey: c, selfSigningKey: c, userSigningKey: c },
      };
    },
    async bootstrapSecretStorage(opts: { setupNewSecretStorage?: boolean; setupNewKeyBackup?: boolean }) {
      await io();
      w.calls.push(`bootstrapSecretStorage(new4S=${opts.setupNewSecretStorage},newBackup=${opts.setupNewKeyBackup})`);
      if (opts.setupNewSecretStorage) throw new Error("test: unexpected new 4S key creation");
      if (w.crypto.privateKeysCached) exportCrossSigningToStorage(w);
      const id = defaultKeyId(w);
      if (id && w.backupVersion && w.crypto.heldBackupKeyTag === w.backupKeyTag && !secretUnder(w, "m.megolm_backup.v1", id)) {
        storeSecret(w, "m.megolm_backup.v1", id);
      }
    },
    async bootstrapCrossSigning(opts: { setupNewCrossSigning?: boolean }) {
      await io();
      w.calls.push(`bootstrapCrossSigning(reset=${opts.setupNewCrossSigning})`);
      if (w.crossSigningError) throw w.crossSigningError;
      const id = defaultKeyId(w);
      const inStorage = Boolean(
        id &&
          secretUnder(w, "m.cross_signing.master", id) &&
          secretUnder(w, "m.cross_signing.self_signing", id) &&
          secretUnder(w, "m.cross_signing.user_signing", id),
      );
      if (opts.setupNewCrossSigning || (!w.crypto.privateKeysCached && !inStorage)) {
        // resetCrossSigning: new keys, export if 4S exists, publish + self-sign.
        w.crypto.privateKeysCached = true;
        exportCrossSigningToStorage(w);
        if (w.interruptNextPublish) {
          w.interruptNextPublish = false;
          throw Object.assign(new Error("fetch failed"), { name: "ConnectionError" });
        }
        w.published = { master: true, selfSigning: true, userSigning: true, deviceSigned: true };
        return;
      }
      if (w.crypto.privateKeysCached) {
        // The SDK's "Olm device has private keys ... doing nothing" branch:
        // nothing is published here even when the server has nothing.
        if (id && !inStorage) exportCrossSigningToStorage(w);
        return;
      }
      // Import from 4S. The real SDK needs the public identity from the
      // server for this and throws when it is missing or incomplete.
      if (!(w.published.master && w.published.selfSigning && w.published.userSigning)) {
        throw new Error("importCrossSigningKeys failed to import the keys");
      }
      // The real SDK also signs the device here; this fake deliberately
      // does not, so the explicit self-sign step is exercised.
      w.crypto.privateKeysCached = true;
    },
    async crossSignDevice(deviceId: string) {
      await io();
      w.calls.push(`crossSignDevice(${deviceId})`);
      if (!w.crypto.privateKeysCached) throw new Error("no private keys");
      w.published.deviceSigned = true;
    },
    async getKeyBackupInfo() {
      await io();
      return w.backupVersion ? { version: w.backupVersion, algorithm: "m.megolm_backup.v1.curve25519-aes-sha2", count: 2, etag: "", auth_data: {} } : null;
    },
    async isKeyBackupTrusted() {
      await io();
      const matches = w.crypto.heldBackupKeyTag !== null && w.crypto.heldBackupKeyTag === w.backupKeyTag;
      return { trusted: matches, matchesDecryptionKey: matches };
    },
    async getSessionBackupPrivateKey() {
      await io();
      return w.crypto.heldBackupKeyTag ? new Uint8Array(32) : null;
    },
    async getActiveSessionBackupVersion() {
      await io();
      return w.crypto.activeBackupVersion;
    },
    async loadSessionBackupPrivateKeyFromSecretStorage() {
      await io();
      w.calls.push("loadSessionBackupPrivateKeyFromSecretStorage");
      const id = defaultKeyId(w);
      if (!id || !secretUnder(w, "m.megolm_backup.v1", id)) {
        throw new Error("missing decryption key in secret storage");
      }
      w.crypto.heldBackupKeyTag = w.backupKeyTag;
    },
    async checkKeyBackupAndEnable() {
      await io();
      w.calls.push("checkKeyBackupAndEnable");
      const trust = await this.isKeyBackupTrusted();
      if (trust.trusted) w.crypto.activeBackupVersion = w.backupVersion;
      return w.backupVersion ? { backupInfo: { version: w.backupVersion }, trustInfo: trust } : null;
    },
    async restoreKeyBackup() {
      await io();
      w.calls.push("restoreKeyBackup");
      return { total: 2, imported: 2 };
    },
    async resetKeyBackup() {
      await io();
      w.calls.push("resetKeyBackup");
      w.backupVersion = String(Number(w.backupVersion ?? "0") + 1);
      w.backupKeyTag = `key-v${w.backupVersion}`;
      w.crypto.heldBackupKeyTag = w.backupKeyTag;
      w.crypto.activeBackupVersion = w.backupVersion;
      const id = defaultKeyId(w);
      if (id) storeSecret(w, "m.megolm_backup.v1", id);
    },
    async isCrossSigningReady() {
      await io();
      return w.published.master && w.crypto.privateKeysCached;
    },
    async isSecretStorageReady() {
      await io();
      const id = defaultKeyId(w);
      return Boolean(id && secretUnder(w, "m.cross_signing.master", id));
    },
    async getDeviceVerificationStatus() {
      await io();
      return { signedByOwner: w.published.deviceSigned, crossSigningVerified: w.published.deviceSigned };
    },
  };

  const client = {
    getUserId: () => USER,
    getDeviceId: () => DEVICE,
    getCrypto: () => crypto,
    async getAuthMetadata() {
      return { account_management_uri: "https://account.example.org/" };
    },
    http: {
      async authedRequest(method: string, path: string) {
        const m = /^\/user\/[^/]+\/account_data\/(.+)$/.exec(path);
        if (method !== "GET" || !m) throw new Error(`unexpected request ${method} ${path}`);
        const type = decodeURIComponent(m[1]);
        const value = w.accountData.get(type);
        if (!value) throw notFound();
        return value;
      },
    },
    async downloadKeysForUsers() {
      w.calls.push("keys/query");
      const ssk = "SSKPUB";
      const deviceSignatures: Record<string, string> = { [`ed25519:${DEVICE}`]: "self" };
      if (w.published.deviceSigned) deviceSignatures[`ed25519:${ssk}`] = "sig";
      return {
        failures: {},
        device_keys: {
          [USER]: {
            [DEVICE]: { algorithms: [], device_id: DEVICE, user_id: USER, keys: {}, signatures: { [USER]: deviceSignatures } },
          },
        },
        master_keys: w.published.master ? { [USER]: { keys: { "ed25519:MSK": "MSK" }, usage: ["master"], user_id: USER } } : undefined,
        self_signing_keys: w.published.selfSigning ? { [USER]: { keys: { [`ed25519:${ssk}`]: ssk }, usage: ["self_signing"], user_id: USER, signatures: {} } } : undefined,
        user_signing_keys: w.published.userSigning ? { [USER]: { keys: { "ed25519:USK": "USK" }, usage: ["user_signing"], user_id: USER, signatures: {} } } : undefined,
      };
    },
    secretStorage: {
      async addKey(algorithm: string, opts: { name?: string; key: Uint8Array<ArrayBuffer> }, keyId: string) {
        w.calls.push(`addKey(${keyId})`);
        const { iv, mac } = await SecretStorage.calculateKeyCheck(opts.key);
        const keyInfo = { algorithm, name: opts.name, iv, mac };
        w.accountData.set(`m.secret_storage.key.${keyId}`, keyInfo);
        return { keyId, keyInfo };
      },
      async setDefaultKeyId(keyId: string) {
        w.calls.push(`setDefaultKeyId(${keyId})`);
        if (w.staleDefaultKey) return;
        w.accountData.set("m.secret_storage.default_key", { key: keyId });
      },
    },
    async setAccountDataRaw(type: string, content: Record<string, unknown>) {
      w.calls.push(`setAccountDataRaw(${type})`);
      w.accountData.set(type, content);
    },
  };
  return client as unknown as MatrixClient;
}
