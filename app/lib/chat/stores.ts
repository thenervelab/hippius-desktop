/**
 * Names and lifecycle of the Matrix SDK's IndexedDB stores, per Matrix device.
 *
 * The rust crypto store is bound to exactly one (user, device): the Olm
 * account inside it carries the device id it was created for, and opening
 * it for any other device fails with "the account in the store doesn't
 * match the account in the constructor". Every chat sign-in mints a new
 * device, so a store name that does not include the device is a store two
 * devices will eventually share. Here the name is derived from both, and
 * whatever store of the SAME user is not the current device's is deleted
 * before the client opens anything.
 *
 * Two layouts, chosen by the session's `storeLayout` (minted in Rust):
 *
 * - `user-device` (every new sign-in): `hippius-chat:<sha256(user)>:<sha256(user:device)>`.
 *   The first digest is a per-user scope. The webview profile is shared by
 *   every Hippius account on the machine and the keyring keeps one chat
 *   session per account, so the sweep must be able to tell "an earlier
 *   device of this user" from "another account's device": it only ever
 *   deletes inside the signed-in user's scope.
 * - `device` (sessions recorded before the scope existed; the console's
 *   layout): `hippius-chat:<sha256(user:device)>`. Opaque — nothing in the
 *   name says whose it is — so such a store is opened when it is the
 *   session's own and otherwise left alone, never swept. Deleting it blind
 *   is exactly how another account's crypto store (and with it that
 *   account's decryptable history) used to be lost on an account switch.
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

async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

/**
 * The per-user scope every `user-device` store name of `userId` starts
 * with. The user id is hashed so the database list does not spell out who
 * is signed in. Ends with the separator so a scope is never a prefix of
 * another scope.
 */
export async function chatUserScope(userId: string): Promise<string> {
  return `${CHAT_STORE_PREFIX}${await sha256Hex(userId)}:`;
}

/**
 * The `device`-layout store names for one device of one account — the
 * console's layout, an opaque `sha256("<userId>:<deviceId>")` under the chat
 * prefix. Deterministic: the same session always opens the same stores; a
 * different device (or a different account) never opens these. Only
 * sessions recorded under that layout resolve here; nothing new is created
 * under it.
 */
export async function chatStoreNames(userId: string, deviceId: string): Promise<ChatStoreNames> {
  const scope = `${CHAT_STORE_PREFIX}${await sha256Hex(`${userId}:${deviceId}`)}`;
  return storeNames(`${scope}:sync`, `${scope}:crypto`);
}

/**
 * The `user-device`-layout store names: the same device digest as
 * `chatStoreNames`, placed inside the user's scope so the sweep can
 * attribute the store to its user without opening it.
 */
export async function userScopedChatStoreNames(
  userId: string,
  deviceId: string,
): Promise<ChatStoreNames> {
  const scope = `${await chatUserScope(userId)}${await sha256Hex(`${userId}:${deviceId}`)}`;
  return storeNames(`${scope}:sync`, `${scope}:crypto`);
}

/**
 * The stores a signed-in session's device owns, per its recorded layout.
 * A session without one (never expected) resolves to the legacy names
 * rather than guessing at device-scoped ones.
 */
export function chatStoreNamesFor(
  session: Pick<ChatSession, "userId" | "deviceId" | "storeLayout">,
): Promise<ChatStoreNames> {
  switch (session.storeLayout) {
    case "user-device":
      return userScopedChatStoreNames(session.userId, session.deviceId);
    case "device":
      return chatStoreNames(session.userId, session.deviceId);
    default:
      return Promise.resolve(legacyChatStoreNames());
  }
}

/**
 * Whether a database, as `indexedDB.databases()` reports it, is a
 * `user-device` store inside `scope` (from `chatUserScope`). The sync
 * database carries the scope behind the SDK's own prefix.
 */
export function isInChatUserScope(name: string, scope: string): boolean {
  return name.startsWith(scope) || name.startsWith(syncStoreDatabase(scope));
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
 * Delete every chat store of `userId` that is not `keep`'s — a store left by
 * an earlier device of that user (a session the issuer expired, a sign-in
 * whose sign-out never ran) — plus the legacy console names, which no
 * desktop device ever owns. Called before a client opens its stores, so a
 * stale store is never opened, and at sign-out with `keep = null`, which
 * deletes every store of that user. Returns what was deleted.
 *
 * Only `user-device` stores inside the user's scope are candidates: a
 * store of another Matrix user — another Hippius account signed in on this
 * machine, whose session the keyring still holds — is not this user's to
 * delete, and an unscoped `device`-layout store cannot be attributed to
 * anyone, so it is left where it is. With no `userId` (a sign-out from a
 * state with no session record) nothing but the legacy names goes.
 */
export async function deleteOtherChatStores(
  userId: string | null,
  keep: ChatStoreNames | null,
): Promise<string[]> {
  const scope = userId === null ? null : await chatUserScope(userId);
  const keepSet = new Set(keep?.databases ?? []);
  const doomed = (await listChatStoreDatabases()).filter(
    (name) =>
      !keepSet.has(name) &&
      (CHAT_LEGACY_STORE_DATABASES.includes(name) ||
        (scope !== null && isInChatUserScope(name, scope))),
  );
  await Promise.all(doomed.map(deleteDatabase));
  return doomed;
}
