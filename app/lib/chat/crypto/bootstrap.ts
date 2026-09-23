/**
 * Silent encryption bootstrap: secret storage, cross-signing and key backup,
 * all unlocked by the key derived from the account mnemonic.
 *
 * Ported from the console's `lib/chat/crypto/bootstrap.ts`. One difference:
 * the console derives the key in the browser from the mnemonic it holds in
 * memory; here the derivation is Rust's (`chat_derive_secret_storage_key`,
 * same HKDF parameters, pinned by known-answer tests on both sides) and the
 * bootstrap receives the 32 key bytes plus the fixed key id/name Rust
 * reports. Everything decided against the server is unchanged, so a device
 * set up from the console and one set up from the desktop see the same
 * secret storage.
 *
 * Runs once per signed-in client. Idempotent:
 * on an account that is already set up it restores the private keys, signs
 * this device, restores the backup key and imports history; on a brand-new
 * account it creates everything. Every decision is taken on what the server
 * holds (`server-state.ts`), not on the local sync store, and the result is
 * checked against the server again before `ready` is reported.
 *
 * Order matters with the rust crypto stack:
 *
 * 1. Secret storage key first. `bootstrapCrossSigning` only exports the
 *    private keys to secret storage when a default key already exists, and
 *    `resetKeyBackup` only stores the backup key when it does. Creating the
 *    key afterwards leaves cross-signing keys that no other device can ever
 *    fetch — that is exactly the state this file is here to prevent.
 * 2. `bootstrapSecretStorage`: exports whatever private keys this device
 *    already caches (cross-signing, backup) under our key.
 * 3. `bootstrapCrossSigning`: imports private keys from secret storage when
 *    the server publishes the complete identity; creates and publishes a
 *    fresh set otherwise (`decideCrossSigningSetup`). The server is asked
 *    again afterwards: an identity still not published is a thrown error.
 * 4. Sign this device with the self-signing key if the server does not
 *    already hold that signature (`/keys/query`). A device that is still
 *    unsigned at the end is reported as `device-unsigned`, never `ready`:
 *    the account may be complete, but other devices withhold room keys
 *    from an unsigned one, and `isCrossSigningReady()` does not see that.
 * 5. Key backup: enable and restore the existing one when we hold its key;
 *    create one when there is none. A backup created elsewhere with a key we
 *    cannot read is kept and reported (`backup.readable === false`); replacing
 *    it is a separate, explicit action.
 *
 * The only case it refuses on its own is an account whose default secret
 * storage key is not ours (e.g. created by Element): overwriting that would
 * silently lock the other clients out, so it reports `foreign-key` and lets
 * the UI offer "use my Hippius key" (mode `adopt-derived-key`, needs the
 * private cross-signing keys cached on this device) or a real cross-signing
 * reset (mode `reset-cross-signing`).
 */

import { type MatrixClient, SecretStorage } from "matrix-js-sdk";
import type { CryptoApi } from "matrix-js-sdk/lib/crypto-api";
import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";

import {
  keyMatchesDescription,
  setSecretStorageKey,
} from "@/app/lib/chat/crypto/secret-storage-keys";
import {
  type EncryptionServerState,
  fetchAccountData,
  type PublishedKeys,
  queryPublishedKeys,
  readEncryptionServerState,
  SECRET_NAMES,
  secretKeyIds,
} from "@/app/lib/chat/crypto/server-state";

/**
 * The mnemonic-derived key as Rust hands it over, plus the fixed id and
 * display name it is published under (`ChatConfig.secretStorageKeyId` /
 * `secretStorageKeyName`). The caller keeps ownership of `key` and zeroes
 * it afterwards; the holder keeps its own copy.
 */
export interface SecretStorageKeyMaterialBytes {
  key: Uint8Array<ArrayBuffer>;
  keyId: string;
  keyName: string;
}

export type BootstrapMode =
  /** Set up or repair; refuse to touch a foreign default key. */
  | "auto"
  /**
   * The default key is not ours: make the derived key the default and
   * re-store the cross-signing and backup secrets under it. Requires the
   * private cross-signing keys in this device's crypto store; otherwise the
   * outcome is `foreign-key` again with `canAdopt: false`.
   */
  | "adopt-derived-key"
  /**
   * Real reset: new cross-signing keys, published to the server (the
   * homeserver may demand approval at the account page), stored under the
   * derived key. Other devices must be verified again afterwards.
   */
  | "reset-cross-signing";

export interface BootstrapOptions {
  accountManagementUrl?: string;
  mode?: BootstrapMode;
  /**
   * A backup exists whose decryption key we cannot obtain: replace it with
   * one this device owns (the old one is deleted; devices that held its key
   * lose nothing they have already downloaded). Never done without this
   * flag — the UI asks first.
   */
  replaceUnreadableBackup?: boolean;
}

export interface BackupSummary {
  /** Server-side backup version, null when there is none. */
  version: string | null;
  /** We hold the decryption key: history restores from it. */
  readable: boolean;
}

export type BootstrapOutcome =
  | {
      status: "ready";
      /** True when this call created secret storage (first device ever) or adopted the derived key. */
      createdSecretStorage: boolean;
      /** True when this call created the key backup. */
      createdBackup: boolean;
      /** True when this call uploaded the self-signature for this device. */
      signedDevice: boolean;
      /** Room keys imported from the backup during this call. */
      restoredKeys: number;
      backup: BackupSummary;
      /** Something non-fatal went wrong, or the server still lacks a piece; UI may show a hint. */
      warnings: string[];
    }
  | {
      /**
       * Everything is in place except the one thing other devices look at:
       * this device does not carry the self-signing key's signature on the
       * server, so they withhold room keys from it. Not `ready`.
       */
      status: "device-unsigned";
      /**
       * The private self-signing key is on this device: re-running the
       * bootstrap signs it (this run tried and failed, see `detail`).
       * Otherwise only another signed device (or its keys landing in secret
       * storage) can help.
       */
      selfSigningKeyAvailable: boolean;
      detail: string;
      /** The backup step still ran: history is independent of the signature. */
      restoredKeys: number;
      backup: BackupSummary;
      warnings: string[];
    }
  | {
      /**
       * Secret storage exists but the mnemonic-derived key is not its
       * default. The user set up chat encryption elsewhere with a random
       * recovery key.
       */
      status: "foreign-key";
      keyId: string;
      keyName?: string;
      /**
       * The private cross-signing keys are cached on this device, so
       * `adopt-derived-key` can re-store them without a reset.
       */
      canAdopt: boolean;
    }
  | {
      /**
       * The homeserver refused the cross-signing key upload. With OAuth
       * homeservers this means a reset must be approved at the account
       * management page; `accountManagementUrl` points there when known.
       */
      status: "cross-signing-blocked";
      accountManagementUrl?: string;
      detail: string;
    };

function cryptoOf(client: MatrixClient): CryptoApi {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error("bootstrapEncryption: crypto is not initialised");
  return crypto;
}

type KeyDecision =
  | { kind: "ours"; keyId: string; created: boolean }
  | { kind: "foreign"; keyId: string; keyName?: string };

/**
 * Which secret-storage key to work with, judged on the server's account
 * data. `adopt` makes the derived key the default even when another key
 * currently is.
 */
async function decideSecretStorageKey(
  client: MatrixClient,
  material: SecretStorageKeyMaterialBytes,
  adopt: boolean,
): Promise<KeyDecision> {
  const { key, keyId: hippiusKeyId, keyName } = material;
  const defaultKey = await fetchAccountData<{ key?: string }>(client, "m.secret_storage.default_key");
  const defaultKeyId = defaultKey?.key ?? null;
  const defaultInfo = defaultKeyId
    ? await fetchAccountData<SecretStorageKeyDescription>(client, `m.secret_storage.key.${defaultKeyId}`)
    : null;

  if (defaultKeyId && defaultInfo) {
    if (await keyMatchesDescription(key, defaultInfo)) {
      return { kind: "ours", keyId: defaultKeyId, created: false };
    }
    if (!adopt) {
      return { kind: "foreign", keyId: defaultKeyId, keyName: defaultInfo.name };
    }
  }

  // No usable default key (none, or a dangling id), or we were told to
  // adopt: make ours the default. Reuse our fixed id when it already holds
  // the derived key (demoted by another client); otherwise (re)write it.
  const ours = await fetchAccountData<SecretStorageKeyDescription>(
    client,
    `m.secret_storage.key.${hippiusKeyId}`,
  );
  if (!ours || !(await keyMatchesDescription(key, ours))) {
    await client.secretStorage.addKey(
      SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES,
      { name: keyName, key },
      hippiusKeyId,
    );
  }
  await client.secretStorage.setDefaultKeyId(hippiusKeyId);
  // `setAccountData` skips the request when the sync store already holds
  // the same content; a stale store (server entry gone) would leave the
  // server without a default key. Check the server, write directly if so.
  const onServer = await fetchAccountData<{ key?: string }>(client, "m.secret_storage.default_key");
  if (onServer?.key !== hippiusKeyId) {
    await client.setAccountDataRaw("m.secret_storage.default_key", { key: hippiusKeyId });
  }
  return { kind: "ours", keyId: hippiusKeyId, created: true };
}

interface UiaLikeError {
  httpStatus?: number;
  errcode?: string;
  data?: { params?: Record<string, { url?: string } | undefined> };
}

function isUiaOrForbidden(error: unknown): boolean {
  const e = error as UiaLikeError | undefined;
  return e?.httpStatus === 401 || e?.httpStatus === 403 || e?.errcode === "M_FORBIDDEN";
}

/** MSC3967: the homeserver points at where the reset must be approved. */
function crossSigningResetUrl(error: unknown): string | undefined {
  const e = error as UiaLikeError | undefined;
  return e?.data?.params?.["org.matrix.cross_signing_reset"]?.url;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every decision goes to the console under one prefix, so a user with a
 * problem can paste the lines. Never the key, never the mnemonic.
 */
function log(line: string): void {
  console.info(`[chat/crypto] ${line}`);
}

/**
 * Whether the private cross-signing keys can be reached from here: in the
 * crypto store, or on the server under the secret-storage key we hold
 * (`keyId`). The server is asked directly, as everywhere in this file.
 */
async function privateKeyAvailability(
  client: MatrixClient,
  crypto: CryptoApi,
  keyId: string,
): Promise<PrivateKeyAvailability> {
  const cached = (await crypto.getCrossSigningStatus()).privateKeysCachedLocally;
  const stored = await Promise.all(
    [SECRET_NAMES.master, SECRET_NAMES.selfSigning, SECRET_NAMES.userSigning].map(async (name) =>
      (await secretKeyIds(client, name)).includes(keyId),
    ),
  );
  return {
    cached: cached.masterKey && cached.selfSigningKey && cached.userSigningKey,
    inSecretStorage: stored.every(Boolean),
  };
}

export type CrossSigningSetup =
  /** The server publishes a complete identity and its private keys are reachable: import from secret storage, or export what this device caches. */
  | { setupNew: false; reason: "published" }
  /** Explicit reset requested. */
  | { setupNew: true; reason: "reset" }
  /** The server publishes nothing: first setup, or the upload never landed. */
  | { setupNew: true; reason: "unpublished" }
  /** The server publishes some keys but not all three: unusable, replace. */
  | { setupNew: true; reason: "partial" }
  /**
   * The server publishes a complete identity but its private keys are
   * neither in this device's crypto store nor in secret storage under our
   * key: nobody can ever sign with it again. An interrupted setup that got
   * as far as the upload and no further; replace.
   */
  | { setupNew: true; reason: "unrecoverable" };

/** Where the private cross-signing keys can be found from this device. */
export interface PrivateKeyAvailability {
  /** All three private keys are in this device's crypto store. */
  cached: boolean;
  /** All three secrets are on the server, encrypted under the key we hold. */
  inSecretStorage: boolean;
}

/**
 * Decide `setupNewCrossSigning` on what `/keys/query` reports, so the
 * bootstrap never lands in the SDK's dead ends:
 *
 * - The SDK writes the private keys to secret storage *before* uploading the
 *   public ones (`resetCrossSigning`). An interrupted first run (tab closed,
 *   network) leaves private keys in secret storage and in this device's
 *   crypto store with nothing on the server. On the next run, with
 *   `setupNewCrossSigning: false`, the SDK sees cached keys and does nothing
 *   — publication is never retried (the SDK marks this TODO itself).
 * - With no cached keys, the SDK imports from secret storage; the import
 *   needs the *public* identity from the server and fails when it is absent
 *   or incomplete ("importCrossSigningKeys failed to import the keys") —
 *   every retry hits the same error.
 *
 * Either way the private keys left behind belong to an identity no device
 * can use (never published, so never trusted or used to sign a backup) and
 * cannot be re-published through the crypto API; a fresh set costs nothing
 * and is the only exit.
 *
 * - The mirror image: all three public keys on the server, and the private
 *   keys neither cached here nor in secret storage under our key (a setup
 *   that uploaded and then died before secret storage existed, seen from
 *   a new device). Importing has nothing to import; the SDK would fall
 *   through to a reset on its own, but silently. Decided here, named
 *   `unrecoverable`, so the log says why the identity was replaced — and
 *   why the homeserver may answer with an approval step (MSC3967) for
 *   what is, from its side, a replacement.
 *
 * The server publishing all three keys with the private keys reachable is
 * the one case where importing is right.
 */
export function decideCrossSigningSetup(
  published: Pick<PublishedKeys, "master" | "selfSigning" | "userSigning">,
  mode: BootstrapMode,
  privateKeys: PrivateKeyAvailability,
): CrossSigningSetup {
  if (mode === "reset-cross-signing") return { setupNew: true, reason: "reset" };
  const { master, selfSigning, userSigning } = published;
  if (master && selfSigning && userSigning) {
    if (privateKeys.cached || privateKeys.inSecretStorage) return { setupNew: false, reason: "published" };
    return { setupNew: true, reason: "unrecoverable" };
  }
  if (!master && !selfSigning && !userSigning) return { setupNew: true, reason: "unpublished" };
  return { setupNew: true, reason: "partial" };
}

export type DeviceSignatureAction =
  /** `/keys/query` shows the self-signing key's signature on this device. */
  | "signed"
  /** Not signed, private self-signing key cached here: sign it now. */
  | "sign"
  /** Not signed and the key is not here: another signed device has to do it. */
  | "needs-other-device";

/**
 * What to do about this device's signature, on the server's view of the
 * device and the local fact of whether the self-signing private key is in
 * the crypto store. `isCrossSigningReady()` is about the account identity
 * and says nothing about this device; the SDK's cached-keys bootstrap path
 * does not sign either. An unsigned device is a repair, never `ready`.
 */
export function decideDeviceSignature(
  deviceSignedBySelfSigningKey: boolean,
  selfSigningKeyCached: boolean,
): DeviceSignatureAction {
  if (deviceSignedBySelfSigningKey) return "signed";
  return selfSigningKeyCached ? "sign" : "needs-other-device";
}

/**
 * The bootstrap must never report `ready` on an account whose cross-signing
 * identity is not on the server: another device could neither trust this
 * one nor restore the keys. Thrown (not a warning) so the UI shows a retry.
 */
export class CrossSigningNotPublishedError extends Error {
  constructor(published: Pick<PublishedKeys, "master" | "selfSigning" | "userSigning">) {
    const missing = (["master", "selfSigning", "userSigning"] as const).filter((k) => !published[k]);
    super(`Cross-signing keys were not published to the server (missing: ${missing.join(", ")}). Try again.`);
    this.name = "CrossSigningNotPublishedError";
  }
}

/**
 * Bootstrap everything with the key Rust derived. The caller keeps
 * ownership of `material.key` and zeroes it afterwards; the holder keeps
 * its own copy for the SDK's callbacks.
 */
export async function bootstrapEncryption(
  client: MatrixClient,
  material: SecretStorageKeyMaterialBytes,
  options: BootstrapOptions = {},
): Promise<BootstrapOutcome> {
  const { key } = material;
  const crypto = cryptoOf(client);
  const mode = options.mode ?? "auto";
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  if (!userId || !deviceId) throw new Error("bootstrapEncryption: client has no user or device id");
  const warnings: string[] = [];
  setSecretStorageKey(key);

  // 1. Secret storage key: ours, or bail out.
  const decision = await decideSecretStorageKey(client, material, mode !== "auto");
  if (decision.kind === "foreign") {
    const cached = (await crypto.getCrossSigningStatus()).privateKeysCachedLocally;
    log(`secret storage: default key ${decision.keyId} (${decision.keyName ?? "unnamed"}) is not the derived key; stopping (foreign-key)`);
    return {
      status: "foreign-key",
      keyId: decision.keyId,
      keyName: decision.keyName,
      canAdopt: cached.masterKey && cached.selfSigningKey && cached.userSigningKey,
    };
  }
  setSecretStorageKey(key, decision.keyId);
  log(`secret storage: default key ${decision.keyId} is the derived key${decision.created ? " (made default by this run)" : ""}`);

  if (mode === "adopt-derived-key") {
    const cached = (await crypto.getCrossSigningStatus()).privateKeysCachedLocally;
    if (!(cached.masterKey && cached.selfSigningKey && cached.userSigningKey)) {
      // Nothing to re-store: the key is now ours but the private keys are
      // gone from this device. Only a reset can go further.
      return { status: "foreign-key", keyId: decision.keyId, keyName: material.keyName, canAdopt: false };
    }
  }

  // 2. Store under our key whatever this device already caches. The key
  //    exists (step 1), so the SDK never creates another one here; the
  //    callback is a safety net, not the normal path.
  await crypto.bootstrapSecretStorage({
    createSecretStorageKey: async () => ({
      privateKey: key,
      keyInfo: { name: material.keyName },
    }),
    setupNewSecretStorage: false,
    setupNewKeyBackup: false,
  });

  // 3. Cross-signing. Restores private keys from secret storage when the
  //    server publishes the full identity, otherwise creates a fresh set
  //    and publishes it (`decideCrossSigningSetup` explains why nothing
  //    else exits the interrupted-setup states). On an OAuth homeserver the
  //    very first upload needs no interactive auth; a *replacement* does,
  //    and lands in `cross-signing-blocked`.
  const publishedBefore = await queryPublishedKeys(client);
  const privateKeys = await privateKeyAvailability(client, crypto, decision.keyId);
  const setup = decideCrossSigningSetup(publishedBefore, mode, privateKeys);
  log(
    `cross-signing: published master=${publishedBefore.master} selfSigning=${publishedBefore.selfSigning} userSigning=${publishedBefore.userSigning}; private keys cached=${privateKeys.cached} inSecretStorage=${privateKeys.inSecretStorage}; device signed=${publishedBefore.deviceSignedBySelfSigningKey} -> ${setup.setupNew ? "create a new identity" : "keep the published identity"} (${setup.reason})`,
  );
  try {
    await crypto.bootstrapCrossSigning({
      setupNewCrossSigning: setup.setupNew,
      authUploadDeviceSigningKeys: async (makeRequest) => {
        await makeRequest(null);
      },
    });
  } catch (error) {
    if (isUiaOrForbidden(error)) {
      log(`cross-signing: the homeserver refused the key upload (${messageOf(error)}); approval needed`);
      return {
        status: "cross-signing-blocked",
        accountManagementUrl: crossSigningResetUrl(error) ?? options.accountManagementUrl,
        detail: messageOf(error),
      };
    }
    throw error;
  }

  // The SDK resolves without publishing in some states (cached keys with
  // `setupNewCrossSigning: false`, a partially failed upload). Ask the
  // server; an identity that is still not there is a failure to retry, not
  // a `ready` with a footnote.
  let published = await queryPublishedKeys(client);
  if (!(published.master && published.selfSigning && published.userSigning)) {
    throw new CrossSigningNotPublishedError(published);
  }

  // 4. This device must carry the self-signing key's signature, or other
  //    devices keep treating it as unverified and withhold room keys. The
  //    SDK signs it when it creates or imports the keys; check the server
  //    rather than assume. A device still unsigned at the end is reported
  //    as such (`device-unsigned`), not as `ready` with a footnote.
  let signedDevice = false;
  let signDetail: string | null = null;
  const selfSigningKeyCached = (await crypto.getCrossSigningStatus()).privateKeysCachedLocally.selfSigningKey;
  const signature = decideDeviceSignature(published.deviceSignedBySelfSigningKey, selfSigningKeyCached);
  log(`device ${deviceId}: signed on server=${published.deviceSignedBySelfSigningKey}, self-signing key cached=${selfSigningKeyCached} -> ${signature}`);
  switch (signature) {
    case "signed":
      break;
    case "sign":
      try {
        await crypto.crossSignDevice(deviceId);
        published = await queryPublishedKeys(client);
        if (published.deviceSignedBySelfSigningKey) {
          signedDevice = true;
        } else {
          signDetail = "The signature was uploaded but the server does not show it on this device yet.";
        }
      } catch (error) {
        signDetail = `Could not sign this device: ${messageOf(error)}`;
      }
      break;
    case "needs-other-device":
      signDetail = "The self-signing private key is not on this device.";
      break;
  }

  if (signDetail) log(`device ${deviceId}: ${signDetail}`);

  // 5. Key backup. Independent of the signature: history is restored even
  //    on a device that still needs to be verified.
  const backup = await ensureKeyBackup(crypto, warnings, options.replaceUnreadableBackup === true);
  log(`backup: version=${backup.version ?? "none"} created=${backup.created} readable=${backup.readable} restoredKeys=${backup.restoredKeys}`);

  // 6. Read back what the server holds now; anything missing is a warning
  //    the UI can show, not a silent success.
  const state = await readEncryptionServerState(client, material.keyId, key);
  warnings.push(...verifyServerState(state, published.deviceSignedBySelfSigningKey));
  for (const warning of warnings) log(warning);

  if (!published.deviceSignedBySelfSigningKey) {
    return {
      status: "device-unsigned",
      selfSigningKeyAvailable: selfSigningKeyCached,
      detail: signDetail ?? "This device is not signed by the self-signing key.",
      restoredKeys: backup.restoredKeys,
      backup: { version: backup.version, readable: backup.readable },
      warnings,
    };
  }

  return {
    status: "ready",
    createdSecretStorage: decision.created,
    createdBackup: backup.created,
    signedDevice,
    restoredKeys: backup.restoredKeys,
    backup: { version: backup.version, readable: backup.readable },
    warnings,
  };
}

interface BackupStep {
  created: boolean;
  restoredKeys: number;
  version: string | null;
  readable: boolean;
}

/**
 * Existing backup: get its decryption key (cached, or from secret storage),
 * trust it, import history. No backup: create one; the SDK stores the new
 * decryption key under our secret-storage key. A backup whose key we cannot
 * obtain is left alone and reported, unless `replaceUnreadable` says to
 * replace it (`resetKeyBackup` deletes the old versions itself).
 */
async function ensureKeyBackup(
  crypto: CryptoApi,
  warnings: string[],
  replaceUnreadable: boolean,
): Promise<BackupStep> {
  const existing = await crypto.getKeyBackupInfo();
  const create = async (): Promise<BackupStep> => {
    await crypto.resetKeyBackup();
    const created = await crypto.getKeyBackupInfo();
    return { created: true, restoredKeys: 0, version: created?.version ?? null, readable: true };
  };
  if (!existing?.version) return create();

  let readable = (await crypto.isKeyBackupTrusted(existing)).matchesDecryptionKey;
  if (!readable) {
    try {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      readable = true;
    } catch (error) {
      if (replaceUnreadable) return create();
      // The backup was created by a client that never stored its key in
      // our secret storage (or stored it under another key).
      warnings.push(
        `A key backup exists (version ${existing.version}) but its decryption key is not in secret storage: ${messageOf(error)}`,
      );
    }
  }

  let restoredKeys = 0;
  try {
    const check = await crypto.checkKeyBackupAndEnable();
    if (readable) {
      if (!check?.trustInfo.trusted) {
        warnings.push("Key backup exists but is not trusted by this device yet.");
      }
      const result = await crypto.restoreKeyBackup();
      restoredKeys = result.imported;
    }
  } catch (error) {
    warnings.push(`Could not restore message history from backup: ${messageOf(error)}`);
  }

  return { created: false, restoredKeys, version: existing.version, readable };
}

/** Human-readable list of what the server still lacks after a bootstrap. */
export function verifyServerState(
  state: EncryptionServerState,
  deviceSignedPerKeysQuery: boolean,
): string[] {
  const missing: string[] = [];
  const s = state.secretStorage;
  if (!s.defaultKeyId) missing.push("no default secret-storage key on the server");
  else if (s.defaultKeyIsDerived === false) missing.push("the default secret-storage key is not the mnemonic-derived one");
  if (!s.secretsUnderDefaultKey.master || !s.secretsUnderDefaultKey.selfSigning || !s.secretsUnderDefaultKey.userSigning) {
    missing.push("cross-signing private keys are not stored under the default secret-storage key");
  }
  const p = state.crossSigning.published;
  if (!p.master || !p.selfSigning || !p.userSigning) missing.push("cross-signing public keys are not published");
  if (!deviceSignedPerKeysQuery) missing.push("this device is not signed by the self-signing key");
  if (state.backup.version && state.backup.decryptionKeyHeld && !s.secretsUnderDefaultKey.backup) {
    missing.push("the key-backup decryption key is not stored under the default secret-storage key");
  }
  return missing.map((m) => `Server check: ${m}.`);
}

/**
 * Cheap probe: is there anything to do? Used to decide whether to prompt
 * for the mnemonic at all on a device that is already fully set up. Local
 * views are fine here: a stale "ready" only delays the repair to the next
 * boot, and a stale "needs" costs one idempotent bootstrap.
 *
 * "Ready" requires *this device* to be signed by the owner's self-signing
 * key (`signedByOwner`); the account-level `isCrossSigningReady()` alone
 * would accept a device other devices refuse to share keys with.
 */
export async function encryptionNeedsBootstrap(client: MatrixClient): Promise<boolean> {
  const crypto = client.getCrypto();
  if (!crypto) return true;
  const userId = client.getUserId();
  const deviceId = client.getDeviceId();
  const [crossSigningReady, secretStorageReady, backupVersion, deviceStatus] = await Promise.all([
    crypto.isCrossSigningReady(),
    crypto.isSecretStorageReady(),
    crypto.getActiveSessionBackupVersion(),
    userId && deviceId ? crypto.getDeviceVerificationStatus(userId, deviceId) : Promise.resolve(null),
  ]);
  const deviceSigned = Boolean(deviceStatus?.signedByOwner);
  return !(crossSigningReady && secretStorageReady && backupVersion !== null && deviceSigned);
}
