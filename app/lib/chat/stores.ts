/**
 * Names and lifecycle of the Matrix SDK's IndexedDB stores, per Matrix device.
 *
 * The rust crypto store is bound to exactly one (user, device): the Olm
 * account inside it carries the device id it was created for, and opening
 * it for any other device fails with "the account in the store doesn't
 * match the account in the constructor". Every chat sign-in mints a new
 * device, so a store name that does not include the device is a store two
 * devices will eventually share. Here the name is derived from both, and
 * whatever store is not the current device's is deleted before the client
 * opens anything.
 *
 * Ported from the web console's `lib/chat/stores.ts`; the store layout is
 * the same on purpose (a session record from either client names its
 * stores the same way), with the digest computed through WebCrypto instead
 * of a hashing dependency the desktop does not otherwise carry.
 *
 * Framework-agnostic; nothing here imports React or the SDK.
 */

import type { ChatSession } from "@/app/lib/tauri/chat";

/** Prefix of every store this app creates. */
export const CHAT_STORE_PREFIX = "hippius-chat:";

/**
 * The fixed names the console used before its stores were scoped to the
 * device. The desktop never creates them, but a webview profile that once
 * ran that layout would still hold them, and they can only belong to a
 * device this one is not: recognised so they are swept, never opened.
 */
const CHAT_LEGACY_SYNC_STORE_DB = "hippius-chat-sync";
const CHAT_LEGACY_CRYPTO_DB_PREFIX = "hippius-chat-crypto";

/** The rust crypto stack opens two databases under the prefix it is given. */
const CRYPTO_DB_SUFFIXES = ["::matrix-sdk-crypto", "::matrix-sdk-crypto-meta"] as const;

/**
 * The SDK's `IndexedDBStore` does not open the database under the `dbName`
 * it is given: its backend prefixes it with this. The browser only knows
 * the prefixed name, so that is the one to delete and to recognise; the
 * bare `dbName` names no database. Pinned against the SDK in the tests.
 */
export const SYNC_STORE_DATABASE_PREFIX = "matrix-js-sdk:";

/** The database the SDK's `IndexedDBStore` actually creates for a `dbName`. */
export function syncStoreDatabase(dbName: string): string {
  return `${SYNC_STORE_DATABASE_PREFIX}${dbName}`;
}

export interface ChatStoreNames {
  /** `dbName` for the SDK's `IndexedDBStore`. Not itself a database name: see `syncStoreDatabase`. */
  syncStore: string;
  /** `cryptoDatabasePrefix` for `initRustCrypto` / `clearStores`. */
  cryptoPrefix: string;
  /** Every database the two stores above create, as the browser names them, for deletion. */
  databases: readonly string[];
}

function storeNames(syncStore: string, cryptoPrefix: string): ChatStoreNames {
  return {
    syncStore,
    cryptoPrefix,
    databases: [
      syncStoreDatabase(syncStore),
      ...CRYPTO_DB_SUFFIXES.map((suffix) => `${cryptoPrefix}${suffix}`),
    ],
  };
}

/** The console's pre-device-scoping layout, for recognition and deletion only. */
export function legacyChatStoreNames(): ChatStoreNames {
  return storeNames(CHAT_LEGACY_SYNC_STORE_DB, CHAT_LEGACY_CRYPTO_DB_PREFIX);
}

/** Every database of the legacy layout. */
export const CHAT_LEGACY_STORE_DATABASES: readonly string[] =
  legacyChatStoreNames().databases;

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The store names for one device of one account. Deterministic: the same
 * session always opens the same stores; a different device (or a different
 * account) never opens these. The ids are hashed so the database list does
 * not spell out who is signed in. Same digest as the console
 * (`sha256("<userId>:<deviceId>")`, hex).
 */
export async function chatStoreNames(userId: string, deviceId: string): Promise<ChatStoreNames> {
  const digest = bytesToHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}:${deviceId}`)),
  );
  const scope = `${CHAT_STORE_PREFIX}${digest}`;
  return storeNames(`${scope}:sync`, `${scope}:crypto`);
}

/**
 * The stores a signed-in session's device owns, per its recorded layout.
 * Rust always records `"device"`; a session without it (never expected)
 * resolves to the legacy names rather than guessing at device-scoped ones.
 */
export function chatStoreNamesFor(
  session: Pick<ChatSession, "userId" | "deviceId" | "storeLayout">,
): Promise<ChatStoreNames> {
  return session.storeLayout === "device"
    ? chatStoreNames(session.userId, session.deviceId)
    : Promise.resolve(legacyChatStoreNames());
}

/**
 * Whether a database name, as `indexedDB.databases()` reports it, belongs
 * to the chat's sync/crypto stores (current layout or legacy). The crypto
 * databases carry the chat prefix themselves; the sync database carries it
 * behind the SDK's own.
 */
export function isChatStoreDatabase(name: string): boolean {
  return (
    name.startsWith(CHAT_STORE_PREFIX) ||
    name.startsWith(syncStoreDatabase(CHAT_STORE_PREFIX)) ||
    CHAT_LEGACY_STORE_DATABASES.includes(name)
  );
}

/** Drop a whole IndexedDB database. Resolves even if it did not exist. */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve();
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve();
      return;
    }
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/**
 * Every chat store database the webview currently has. Where it cannot
 * list them (`indexedDB.databases()` missing or failing) the legacy fixed
 * names are assumed: they are the only ones that can be named blind, and
 * deleting a database that does not exist is free.
 */
export async function listChatStoreDatabases(): Promise<string[]> {
  if (typeof indexedDB !== "undefined" && typeof indexedDB.databases === "function") {
    try {
      const listed = await indexedDB.databases();
      return listed
        .map(({ name }) => name)
        .filter((name): name is string => !!name && isChatStoreDatabase(name));
    } catch {
      // Fall through to the blind list.
    }
  }
  return [...CHAT_LEGACY_STORE_DATABASES];
}

/** Delete the stores of one device. */
export async function deleteChatStores(names: ChatStoreNames): Promise<void> {
  await Promise.all(names.databases.map(deleteDatabase));
}

/**
 * Delete every chat store that is not `keep`'s: any device-scoped store
 * left by an earlier device (a sign-in whose sign-out never ran, a window
 * closed mid-sign-out) and the legacy names. Called before a client opens
 * its stores, so a stale store is never opened, and at sign-out with
 * `keep = null`, which deletes them all. Returns what was deleted.
 */
export async function deleteOtherChatStores(keep: ChatStoreNames | null): Promise<string[]> {
  const keepSet = new Set(keep?.databases ?? []);
  const doomed = (await listChatStoreDatabases()).filter((name) => !keepSet.has(name));
  await Promise.all(doomed.map(deleteDatabase));
  return doomed;
}
