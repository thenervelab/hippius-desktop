import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BootstrapMode,
  bootstrapEncryption,
  CrossSigningNotPublishedError,
  decideCrossSigningSetup,
  decideDeviceSignature,
  encryptionNeedsBootstrap,
  type PrivateKeyAvailability,
  verifyServerState,
} from "@/app/lib/chat/crypto/bootstrap";
import {
  clearSecretStorageKey,
  hasSecretStorageKey,
} from "@/app/lib/chat/crypto/secret-storage-keys";
import type { EncryptionServerState } from "@/app/lib/chat/crypto/server-state";
import {
  addForeignDefaultKey,
  addOurDefaultKey,
  defaultKeyId,
  DEVICE,
  makeClient,
  makeWorld,
  OUR_MATERIAL,
  OUR_KEY_ID,
  secretUnder,
  storeSecret,
  USER,
} from "@/app/lib/chat/crypto/testing/fake-world";

// The bootstrap narrates its decisions on the console for users to paste;
// the assertions here are on the server model, not on the narration.
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  clearSecretStorageKey();
  vi.restoreAllMocks();
});

describe("bootstrapEncryption", () => {
  it("fresh account: creates our key, then cross-signing under it, then a backup — server ends up complete", async () => {
    const w = makeWorld();
    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.createdSecretStorage).toBe(true);
    expect(outcome.createdBackup).toBe(true);
    expect(outcome.signedDevice).toBe(false); // the SDK signed it while creating the keys
    expect(outcome.backup).toEqual({ version: "1", readable: true });
    expect(outcome.warnings).toEqual([]);

    // Order: 4S key before anything that exports to it.
    const order = w.calls.filter((c) => !c.startsWith("keys/query"));
    expect(order).toEqual([
      `addKey(${OUR_KEY_ID})`,
      `setDefaultKeyId(${OUR_KEY_ID})`,
      "bootstrapSecretStorage(new4S=false,newBackup=false)",
      "bootstrapCrossSigning(reset=true)",
      "resetKeyBackup",
    ]);

    // Acceptance: what the server must hold afterwards.
    expect(defaultKeyId(w)).toBe(OUR_KEY_ID);
    expect(w.accountData.has(`m.secret_storage.key.${OUR_KEY_ID}`)).toBe(true);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"]) {
      expect(secretUnder(w, s, OUR_KEY_ID), s).toBe(true);
    }
    expect(w.published.deviceSigned).toBe(true);
    expect(hasSecretStorageKey()).toBe(true);
  });

  it("published keys but no secret storage and an unsigned device (the incomplete state): stores the cached keys and signs the device", async () => {
    // What the first, broken bootstrap left behind: public keys on the
    // server, private keys only in this device's crypto store, nothing in
    // account data, device unsigned.
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      crypto: { privateKeysCached: true, heldBackupKeyTag: null, activeBackupVersion: null },
    });
    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);

    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.signedDevice).toBe(true);
    expect(outcome.warnings).toEqual([]);
    expect(w.calls).toContain("bootstrapCrossSigning(reset=false)");
    expect(w.calls).toContain(`crossSignDevice(${DEVICE})`);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]) {
      expect(secretUnder(w, s, OUR_KEY_ID), s).toBe(true);
    }
    expect(w.published.deviceSigned).toBe(true);
  });

  it("second device: private keys recoverable from secret storage -> imports and signs the device silently", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      backupVersion: "1",
      backupKeyTag: "key-v1",
    });
    await addOurDefaultKey(w);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"]) {
      storeSecret(w, s, OUR_KEY_ID);
    }

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.createdSecretStorage).toBe(false);
    expect(outcome.createdBackup).toBe(false);
    expect(outcome.signedDevice).toBe(true);
    expect(outcome.restoredKeys).toBe(2);
    expect(outcome.backup).toEqual({ version: "1", readable: true });
    expect(outcome.warnings).toEqual([]);
    expect(w.calls).not.toContain(`addKey(${OUR_KEY_ID})`);
    expect(w.calls).toContain("bootstrapCrossSigning(reset=false)");
    expect(w.calls).toContain(`crossSignDevice(${DEVICE})`);
    expect(w.calls).toContain("loadSessionBackupPrivateKeyFromSecretStorage");
    expect(w.calls).toContain("restoreKeyBackup");
    expect(w.calls).not.toContain("resetKeyBackup");
  });

  it("foreign default key: refuses, touches nothing, reports whether adopting is possible", async () => {
    const w = makeWorld({ crypto: { privateKeysCached: true, heldBackupKeyTag: null, activeBackupVersion: null } });
    await addForeignDefaultKey(w);
    const before = new Map(w.accountData);

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(outcome).toEqual({ status: "foreign-key", keyId: "ELEMENTKEY", keyName: "Element recovery key", canAdopt: true });
    expect(w.calls).toEqual([]);
    expect(w.accountData).toEqual(before);

    w.crypto.privateKeysCached = false;
    const again = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(again).toMatchObject({ status: "foreign-key", canAdopt: false });
  });

  it("adopt-derived-key with cached private keys: makes our key the default and re-stores the secrets under it", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: true },
      crypto: { privateKeysCached: true, heldBackupKeyTag: "key-v1", activeBackupVersion: "1" },
      backupVersion: "1",
      backupKeyTag: "key-v1",
    });
    await addForeignDefaultKey(w);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"]) {
      storeSecret(w, s, "ELEMENTKEY");
    }

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL, { mode: "adopt-derived-key" });
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.createdSecretStorage).toBe(true);
    expect(outcome.warnings).toEqual([]);
    expect(defaultKeyId(w)).toBe(OUR_KEY_ID);
    // The foreign key and its copies stay: other clients keep working.
    expect(w.accountData.has("m.secret_storage.key.ELEMENTKEY")).toBe(true);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"]) {
      expect(secretUnder(w, s, "ELEMENTKEY"), s).toBe(true);
      expect(secretUnder(w, s, OUR_KEY_ID), s).toBe(true);
    }
    expect(w.calls).toContain("bootstrapCrossSigning(reset=false)");
  });

  it("adopt-derived-key without cached private keys: stops with foreign-key (only a reset can continue)", async () => {
    const w = makeWorld({ published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false } });
    await addForeignDefaultKey(w);

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL, { mode: "adopt-derived-key" });
    expect(outcome).toMatchObject({ status: "foreign-key", canAdopt: false });
    expect(w.calls.some((c) => c.startsWith("bootstrapCrossSigning"))).toBe(false);
  });

  it("reset-cross-signing: forces new keys even though the server publishes some", async () => {
    const w = makeWorld({ published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false } });
    await addOurDefaultKey(w);

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL, { mode: "reset-cross-signing" });
    expect(outcome.status).toBe("ready");
    expect(w.calls).toContain("bootstrapCrossSigning(reset=true)");
  });

  it("homeserver demands approval for the upload: cross-signing-blocked with the MSC3967 url", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      crossSigningError: Object.assign(new Error("UIA"), {
        httpStatus: 401,
        data: { params: { "org.matrix.cross_signing_reset": { url: "https://account.example.org/reset" } } },
      }),
    });
    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL, { accountManagementUrl: "https://account.example.org/" });
    expect(outcome).toEqual({
      status: "cross-signing-blocked",
      accountManagementUrl: "https://account.example.org/reset",
      detail: "UIA",
    });
  });

  it("backup created elsewhere with a key we cannot read: kept, reported, not restored; replaced only on request", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      crypto: { privateKeysCached: true, heldBackupKeyTag: null, activeBackupVersion: null },
      backupVersion: "1",
      backupKeyTag: "element-x-key",
    });

    const kept = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(kept.status).toBe("ready");
    if (kept.status !== "ready") return;
    expect(kept.backup).toEqual({ version: "1", readable: false });
    expect(kept.warnings.some((x) => x.includes("decryption key is not in secret storage"))).toBe(true);
    // Not a server-check failure: nothing is missing that we could have written.
    expect(kept.warnings.some((x) => x.startsWith("Server check"))).toBe(false);
    expect(w.calls).not.toContain("resetKeyBackup");
    expect(w.calls).not.toContain("restoreKeyBackup");
    expect(w.backupVersion).toBe("1");

    w.calls.length = 0;
    const replaced = await bootstrapEncryption(makeClient(w), OUR_MATERIAL, { replaceUnreadableBackup: true });
    expect(replaced.status).toBe("ready");
    if (replaced.status !== "ready") return;
    expect(w.calls).toContain("resetKeyBackup");
    expect(replaced.createdBackup).toBe(true);
    expect(replaced.backup).toEqual({ version: "2", readable: true });
    expect(secretUnder(w, "m.megolm_backup.v1", OUR_KEY_ID)).toBe(true);
  });

  it("interrupted first setup (private keys stored, public keys never uploaded): the next run publishes a set instead of stopping at the cached keys", async () => {
    const w = makeWorld({ interruptNextPublish: true });

    // Run 1 dies during the upload. What it leaves behind is exactly the
    // SDK's order: secret storage complete, crypto store holding the keys,
    // server publishing nothing.
    await expect(bootstrapEncryption(makeClient(w), OUR_MATERIAL)).rejects.toThrow("fetch failed");
    expect(w.crypto.privateKeysCached).toBe(true);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]) {
      expect(secretUnder(w, s, OUR_KEY_ID), s).toBe(true);
    }
    expect(w.published.master).toBe(false);

    // Run 2: with `setupNewCrossSigning: false` the SDK would find the
    // cached keys and "do nothing"; we must ask for a fresh set.
    w.calls.length = 0;
    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(w.calls).toContain("bootstrapCrossSigning(reset=true)");
    expect(w.published).toEqual({ master: true, selfSigning: true, userSigning: true, deviceSigned: true });
    expect(outcome.warnings).toEqual([]);
  });

  it("interrupted first setup seen from a device without the cached keys: fresh set, not a failing import", async () => {
    // Same server state as above, but this device's crypto store is empty:
    // the SDK's import path needs the public identity and would throw on
    // every retry.
    const w = makeWorld();
    await addOurDefaultKey(w);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]) {
      storeSecret(w, s, OUR_KEY_ID);
    }

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(outcome.status).toBe("ready");
    expect(w.calls).toContain("bootstrapCrossSigning(reset=true)");
    expect(w.published.master).toBe(true);
  });

  it("partial publication (master without self-signing / user-signing): replaced, not imported", async () => {
    const w = makeWorld({ published: { master: true, selfSigning: false, userSigning: false, deviceSigned: false } });
    await addOurDefaultKey(w);
    for (const s of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing"]) {
      storeSecret(w, s, OUR_KEY_ID);
    }

    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(outcome.status).toBe("ready");
    expect(w.calls).toContain("bootstrapCrossSigning(reset=true)");
    expect(w.published).toMatchObject({ master: true, selfSigning: true, userSigning: true });
  });

  it("keys still not on the server after bootstrapCrossSigning: fails loudly instead of reporting ready", async () => {
    const w = makeWorld();
    const client = makeClient(w);
    const crypto = client.getCrypto() as unknown as Record<string, unknown>;
    // An SDK that resolves without publishing anything.
    crypto.bootstrapCrossSigning = async () => {
      w.calls.push("bootstrapCrossSigning(stub)");
    };
    await expect(bootstrapEncryption(client, OUR_MATERIAL)).rejects.toBeInstanceOf(CrossSigningNotPublishedError);
    await expect(bootstrapEncryption(client, OUR_MATERIAL)).rejects.toThrow(/missing: master, selfSigning, userSigning/);
    // Nothing after cross-signing ran: no backup was created on a broken account.
    expect(w.calls).not.toContain("resetKeyBackup");
  });

  it("stale sync store swallowed the default-key write: falls back to a direct write", async () => {
    const w = makeWorld({ staleDefaultKey: true });
    const outcome = await bootstrapEncryption(makeClient(w), OUR_MATERIAL);
    expect(outcome.status).toBe("ready");
    expect(w.calls).toContain("setAccountDataRaw(m.secret_storage.default_key)");
    expect(defaultKeyId(w)).toBe(OUR_KEY_ID);
  });

  it("unsigned device without the self-signing key here: device-unsigned pointing at another device, backup still handled, server gaps listed", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      backupVersion: "1",
      backupKeyTag: "key-v1",
    });
    await addOurDefaultKey(w);
    storeSecret(w, "m.megolm_backup.v1", OUR_KEY_ID);
    // Private keys neither cached nor in 4S -> the SDK would reset; make
    // the fake publish but leave the device unsigned with no key to sign it.
    const client = makeClient(w);
    const crypto = client.getCrypto() as unknown as Record<string, unknown>;
    crypto.bootstrapCrossSigning = async () => {
      w.calls.push("bootstrapCrossSigning(stub)");
    };
    const outcome = await bootstrapEncryption(client, OUR_MATERIAL);
    expect(outcome.status).toBe("device-unsigned");
    if (outcome.status !== "device-unsigned") return;
    expect(outcome.selfSigningKeyAvailable).toBe(false);
    expect(outcome.detail).toBe("The self-signing private key is not on this device.");
    expect(w.calls).not.toContain(`crossSignDevice(${DEVICE})`);
    // History does not wait for the signature.
    expect(w.calls).toContain("restoreKeyBackup");
    expect(outcome.restoredKeys).toBe(2);
    expect(outcome.backup).toEqual({ version: "1", readable: true });
    expect(outcome.warnings).toContain("Server check: cross-signing private keys are not stored under the default secret-storage key.");
    expect(outcome.warnings).toContain("Server check: this device is not signed by the self-signing key.");
  });

  it("unsigned device with the self-signing key here but the signature upload fails: device-unsigned, re-run can sign", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      crypto: { privateKeysCached: true, heldBackupKeyTag: null, activeBackupVersion: null },
    });
    await addOurDefaultKey(w);
    const client = makeClient(w);
    const crypto = client.getCrypto() as unknown as Record<string, unknown>;
    let attempts = 0;
    crypto.crossSignDevice = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("fetch failed");
      w.published.deviceSigned = true;
    };

    const first = await bootstrapEncryption(client, OUR_MATERIAL);
    expect(first.status).toBe("device-unsigned");
    if (first.status !== "device-unsigned") return;
    expect(first.selfSigningKeyAvailable).toBe(true);
    expect(first.detail).toBe("Could not sign this device: fetch failed");

    // The repair path: same bootstrap again, the signature lands.
    const second = await bootstrapEncryption(client, OUR_MATERIAL);
    expect(second.status).toBe("ready");
    if (second.status !== "ready") return;
    expect(second.signedDevice).toBe(true);
    expect(second.warnings).toEqual([]);
  });

  it("never returns ready while /keys/query shows no self-signing signature on this device", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      crypto: { privateKeysCached: true, heldBackupKeyTag: null, activeBackupVersion: null },
    });
    await addOurDefaultKey(w);
    const client = makeClient(w);
    const crypto = client.getCrypto() as unknown as Record<string, unknown>;
    // Signing "succeeds" but the server does not reflect it.
    crypto.crossSignDevice = async () => {
      w.calls.push(`crossSignDevice(${DEVICE})`);
    };
    const outcome = await bootstrapEncryption(client, OUR_MATERIAL);
    expect(outcome.status).toBe("device-unsigned");
    if (outcome.status !== "device-unsigned") return;
    expect(outcome.selfSigningKeyAvailable).toBe(true);
    expect(outcome.detail).toMatch(/server does not show it/);
  });
});

describe("decideDeviceSignature", () => {
  it.each<[string, boolean, boolean, ReturnType<typeof decideDeviceSignature>]>([
    ["signed on the server, key cached", true, true, "signed"],
    ["signed on the server, key not cached", true, false, "signed"],
    ["unsigned, key cached: sign it here", false, true, "sign"],
    ["unsigned, key not cached: another device must", false, false, "needs-other-device"],
  ])("%s", (_name, signedOnServer, keyCached, expected) => {
    expect(decideDeviceSignature(signedOnServer, keyCached)).toBe(expected);
  });
});

describe("decideCrossSigningSetup", () => {
  const all = { master: true, selfSigning: true, userSigning: true };
  const none = { master: false, selfSigning: false, userSigning: false };
  const cached = { cached: true, inSecretStorage: false };
  const stored = { cached: false, inSecretStorage: true };
  const nowhere = { cached: false, inSecretStorage: false };

  it.each<[string, typeof all, BootstrapMode, PrivateKeyAvailability, ReturnType<typeof decideCrossSigningSetup>]>([
    ["complete identity, private keys cached, auto", all, "auto", cached, { setupNew: false, reason: "published" }],
    ["complete identity, private keys in secret storage, auto", all, "auto", stored, { setupNew: false, reason: "published" }],
    ["complete identity, private keys cached, adopt", all, "adopt-derived-key", cached, { setupNew: false, reason: "published" }],
    ["complete identity, explicit reset", all, "reset-cross-signing", cached, { setupNew: true, reason: "reset" }],
    // The production state: an earlier run uploaded the public keys and
    // died before secret storage existed; a new device cannot reach the
    // private keys anywhere.
    ["complete identity, private keys nowhere", all, "auto", nowhere, { setupNew: true, reason: "unrecoverable" }],
    ["nothing published (first setup or interrupted upload)", none, "auto", nowhere, { setupNew: true, reason: "unpublished" }],
    ["nothing published, keys cached (upload never landed)", none, "auto", cached, { setupNew: true, reason: "unpublished" }],
    ["nothing published, adopt", none, "adopt-derived-key", nowhere, { setupNew: true, reason: "unpublished" }],
    ["master only", { ...none, master: true }, "auto", stored, { setupNew: true, reason: "partial" }],
    ["master + self-signing, no user-signing", { ...all, userSigning: false }, "auto", cached, { setupNew: true, reason: "partial" }],
    ["self-signing + user-signing, no master", { ...all, master: false }, "auto", cached, { setupNew: true, reason: "partial" }],
  ])("%s", (_name, published, mode, privateKeys, expected) => {
    expect(decideCrossSigningSetup(published, mode, privateKeys)).toEqual(expected);
  });

  it("never imports from a server that lacks any of the three keys (the SDK import would fail forever)", () => {
    for (const master of [true, false]) {
      for (const selfSigning of [true, false]) {
        for (const userSigning of [true, false]) {
          const complete = master && selfSigning && userSigning;
          expect(decideCrossSigningSetup({ master, selfSigning, userSigning }, "auto", stored).setupNew).toBe(!complete);
        }
      }
    }
  });

  it("never keeps a published identity whose private keys are unreachable from here", () => {
    expect(decideCrossSigningSetup(all, "auto", nowhere).setupNew).toBe(true);
    expect(decideCrossSigningSetup(all, "adopt-derived-key", nowhere).setupNew).toBe(true);
  });
});

describe("encryptionNeedsBootstrap", () => {
  it("is true while this device is not signed, even when everything else is ready", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: false },
      crypto: { privateKeysCached: true, heldBackupKeyTag: "k", activeBackupVersion: "1" },
      backupVersion: "1",
      backupKeyTag: "k",
    });
    await addOurDefaultKey(w);
    storeSecret(w, "m.cross_signing.master", OUR_KEY_ID);
    expect(await encryptionNeedsBootstrap(makeClient(w))).toBe(true);
    w.published.deviceSigned = true;
    expect(await encryptionNeedsBootstrap(makeClient(w))).toBe(false);
  });

  it("is true when the crypto store does not know this device at all (no status), account otherwise ready", async () => {
    const w = makeWorld({
      published: { master: true, selfSigning: true, userSigning: true, deviceSigned: true },
      crypto: { privateKeysCached: true, heldBackupKeyTag: "k", activeBackupVersion: "1" },
      backupVersion: "1",
      backupKeyTag: "k",
    });
    await addOurDefaultKey(w);
    storeSecret(w, "m.cross_signing.master", OUR_KEY_ID);
    const client = makeClient(w);
    (client.getCrypto() as unknown as Record<string, unknown>).getDeviceVerificationStatus = async () => null;
    expect(await encryptionNeedsBootstrap(client)).toBe(true);
  });
});

describe("verifyServerState", () => {
  const complete: EncryptionServerState = {
    userId: USER,
    deviceId: DEVICE,
    secretStorage: {
      defaultKeyId: OUR_KEY_ID,
      defaultKeyName: "Hippius Console recovery key",
      defaultKeyIsDerived: true,
      hippiusKeyPresent: true,
      secretsUnderDefaultKey: { master: true, selfSigning: true, userSigning: true, backup: true },
    },
    crossSigning: {
      published: { master: true, selfSigning: true, userSigning: true },
      privateKeysCached: { master: true, selfSigning: true, userSigning: true },
    },
    device: { signedBySelfSigningKey: true, keysPublished: true },
    backup: { version: "1", algorithm: "a", count: 0, decryptionKeyHeld: true, activeVersion: "1" },
  };

  it("is silent on a complete account", () => {
    expect(verifyServerState(complete, true)).toEqual([]);
  });

  it("names each missing piece", () => {
    const broken: EncryptionServerState = {
      ...complete,
      secretStorage: { ...complete.secretStorage, defaultKeyId: null, secretsUnderDefaultKey: { master: false, selfSigning: false, userSigning: false, backup: false } },
    };
    expect(verifyServerState(broken, false)).toEqual([
      "Server check: no default secret-storage key on the server.",
      "Server check: cross-signing private keys are not stored under the default secret-storage key.",
      "Server check: this device is not signed by the self-signing key.",
      "Server check: the key-backup decryption key is not stored under the default secret-storage key.",
    ]);
  });
});
