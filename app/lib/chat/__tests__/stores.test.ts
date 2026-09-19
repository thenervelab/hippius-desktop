import { IndexedDBStore } from "matrix-js-sdk/lib/store/indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeFakeIndexedDB } from "@/app/lib/chat/testing/fake-indexeddb";
import {
  CHAT_LEGACY_STORE_DATABASES,
  CHAT_STORE_PREFIX,
  chatStoreNames,
  chatStoreNamesFor,
  deleteOtherChatStores,
  isChatStoreDatabase,
  legacyChatStoreNames,
  SYNC_STORE_DATABASE_PREFIX,
  syncStoreDatabase,
} from "@/app/lib/chat/stores";

/**
 * The database the SDK opens for a given `dbName`, read off the SDK itself:
 * `IndexedDBStore.exists` opens exactly the database the store would.
 */
async function databaseTheSdkOpensFor(dbName: string): Promise<string> {
  const opened: string[] = [];
  const factory = {
    open(name: string) {
      const req: { onsuccess?: () => void; onupgradeneeded?: () => void; result?: unknown } = {};
      opened.push(name);
      queueMicrotask(() => {
        req.result = { close() {} };
        req.onsuccess?.();
      });
      return req;
    },
  } as unknown as IDBFactory;
  await IndexedDBStore.exists(factory, dbName);
  expect(opened).toHaveLength(1);
  return opened[0];
}

const USER = "@dubs:hippius.com";
const OLD_DEVICE = "3G0yuJNTvy";
const NEW_DEVICE = "5FlfZDBbpL";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chatStoreNames", () => {
  it("names the stores by account AND device, so two devices of one account never share a database", async () => {
    const old = await chatStoreNames(USER, OLD_DEVICE);
    const fresh = await chatStoreNames(USER, NEW_DEVICE);
    expect(old.syncStore).not.toBe(fresh.syncStore);
    expect(old.cryptoPrefix).not.toBe(fresh.cryptoPrefix);
    expect(old.databases.filter((n) => fresh.databases.includes(n))).toEqual([]);
  });

  it("differs between two accounts sharing a device id", async () => {
    expect((await chatStoreNames("@a:hippius.com", "DEV")).syncStore).not.toBe(
      (await chatStoreNames("@b:hippius.com", "DEV")).syncStore,
    );
  });

  // Same digest as the console (`sha256("<userId>:<deviceId>")`, hex): a
  // desktop and a console session for the same device would name the same
  // stores. Frozen as a known answer so a change to the hashing here is a
  // visible cross-client break, not a silent one.
  it("is deterministic and carries sha256(userId:deviceId) under the chat prefix", async () => {
    const names = await chatStoreNames(USER, NEW_DEVICE);
    expect(await chatStoreNames(USER, NEW_DEVICE)).toEqual(names);
    // `sha256sum <<< "@dubs:hippius.com:5FlfZDBbpL"` (no newline).
    const digest = "822136ced44848350f711794c1138cccb775899f6e4af40df31c1c2e0b022f2b";
    expect(names.syncStore).toBe(`${CHAT_STORE_PREFIX}${digest}:sync`);
    expect(names.cryptoPrefix).toBe(`${CHAT_STORE_PREFIX}${digest}:crypto`);
    expect(names.databases).toEqual([
      `matrix-js-sdk:${names.syncStore}`,
      `${names.cryptoPrefix}::matrix-sdk-crypto`,
      `${names.cryptoPrefix}::matrix-sdk-crypto-meta`,
    ]);
  });

  /**
   * `IndexedDBStore({ dbName })` does not create a database called `dbName`.
   * Deleting the bare name deletes nothing, and the boot sweep would never
   * recognise the real sync databases either. The physical name is read off
   * the SDK, so an SDK upgrade that changes it fails here, not in production.
   */
  it("lists the sync database under the name the SDK actually creates", async () => {
    const names = await chatStoreNames(USER, NEW_DEVICE);
    expect(await databaseTheSdkOpensFor(names.syncStore)).toBe(names.databases[0]);
    expect(await databaseTheSdkOpensFor(legacyChatStoreNames().syncStore)).toBe(
      CHAT_LEGACY_STORE_DATABASES[0],
    );
    expect(await databaseTheSdkOpensFor("any")).toBe(`${SYNC_STORE_DATABASE_PREFIX}any`);
    expect(syncStoreDatabase(names.syncStore)).toBe(names.databases[0]);
    expect(names.databases).not.toContain(names.syncStore);
  });

  it("does not spell the user or device id out in the database name", async () => {
    const names = await chatStoreNames(USER, NEW_DEVICE);
    for (const name of names.databases) {
      expect(name).not.toContain("dubs");
      expect(name).not.toContain(NEW_DEVICE);
    }
  });
});

describe("chatStoreNamesFor", () => {
  const base = { userId: USER, deviceId: NEW_DEVICE };

  it("gives a session recorded under the device layout its device-scoped stores", async () => {
    expect(await chatStoreNamesFor({ ...base, storeLayout: "device" })).toEqual(
      await chatStoreNames(USER, NEW_DEVICE),
    );
  });

  // Rust always records `"device"`; a session missing it must not be
  // guessed into device-scoped names, or the boot sweep would delete the
  // stores it actually owns as "another device's".
  it("gives a session with no recorded layout the legacy stores", async () => {
    const names = await chatStoreNamesFor(base);
    expect(names).toEqual(legacyChatStoreNames());
    expect(names.databases).toEqual([...CHAT_LEGACY_STORE_DATABASES]);
  });

  it("without indexedDB.databases(), the blind legacy list is not deleted under a legacy session", async () => {
    const idb = makeFakeIndexedDB([...CHAT_LEGACY_STORE_DATABASES], { listable: false });
    vi.stubGlobal("indexedDB", idb);

    expect(await deleteOtherChatStores(await chatStoreNamesFor(base))).toEqual([]);
    expect(idb.deleted).toEqual([]);
  });
});

describe("isChatStoreDatabase", () => {
  it("recognises device-scoped and legacy names, never unrelated ones", async () => {
    for (const name of (await chatStoreNames(USER, NEW_DEVICE)).databases) {
      expect(isChatStoreDatabase(name)).toBe(true);
    }
    for (const name of CHAT_LEGACY_STORE_DATABASES) expect(isChatStoreDatabase(name)).toBe(true);
    expect(isChatStoreDatabase("hippius.db")).toBe(false);
    expect(isChatStoreDatabase("somebody-else")).toBe(false);
  });

  it("recognises the SDK-prefixed sync database of any device, and not other SDK stores", async () => {
    expect(
      isChatStoreDatabase(`matrix-js-sdk:${(await chatStoreNames(USER, OLD_DEVICE)).syncStore}`),
    ).toBe(true);
    expect(isChatStoreDatabase("matrix-js-sdk:hippius-chat-sync")).toBe(true);
    expect(isChatStoreDatabase("matrix-js-sdk:default")).toBe(false);
  });
});

describe("deleteOtherChatStores", () => {
  it("deletes the legacy stores and every other device's stores, keeps this device's and unrelated databases", async () => {
    const mine = await chatStoreNames(USER, NEW_DEVICE);
    const previous = await chatStoreNames(USER, OLD_DEVICE);
    const idb = makeFakeIndexedDB([
      ...mine.databases,
      ...previous.databases,
      ...CHAT_LEGACY_STORE_DATABASES,
      "unrelated-app-db",
    ]);
    vi.stubGlobal("indexedDB", idb);

    const deleted = await deleteOtherChatStores(mine);

    expect(new Set(deleted)).toEqual(
      new Set([...previous.databases, ...CHAT_LEGACY_STORE_DATABASES]),
    );
    const remaining = (await idb.databases()).map((d) => d.name);
    expect(new Set(remaining)).toEqual(new Set([...mine.databases, "unrelated-app-db"]));
  });

  it("with nothing to keep, deletes every chat store (sign-out with no known device)", async () => {
    const a = await chatStoreNames(USER, OLD_DEVICE);
    const b = await chatStoreNames(USER, NEW_DEVICE);
    const idb = makeFakeIndexedDB([...a.databases, ...b.databases, "unrelated-app-db"]);
    vi.stubGlobal("indexedDB", idb);

    await deleteOtherChatStores(null);

    expect([...idb.names]).toEqual(["unrelated-app-db"]);
  });
});
