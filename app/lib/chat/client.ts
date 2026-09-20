/**
 * Build, start and tear down the Matrix client for a stored chat session.
 *
 * One client per app. The React layer (`ChatProvider`) owns the instance and
 * calls `startChatClient` / `stopChatClient`; everything Matrix-specific
 * about how the client is configured lives here so it can be exercised
 * without React.
 *
 * Ported from the console's `lib/chat/client.ts` with one structural
 * change: the console refreshes and revokes OAuth tokens in the browser
 * (`OAuth2` + `TokenRefresher`); on the desktop those are Rust's
 * (`chat_refresh_tokens`, `chat_sign_out`), so the SDK's
 * `tokenRefreshFunction` is a thin call into Rust and the keyring copy of
 * the session is the one that moves. No token endpoint is contacted from
 * the webview.
 */

import {
  ClientEvent,
  createClient,
  HttpApiEvent,
  IndexedDBStore,
  type MatrixClient,
  MatrixError,
  SyncState,
  type SyncStateData,
} from "matrix-js-sdk";
import { type MSC3575List, SlidingSync } from "matrix-js-sdk/lib/sliding-sync";

import {
  chatCryptoCallbacks,
  clearSecretStorageKey,
} from "@/app/lib/chat/crypto/secret-storage-keys";
import {
  type ChatStoreNames,
  chatStoreNamesFor,
  deleteChatStores,
  deleteOtherChatStores,
} from "@/app/lib/chat/stores";
import {
  type ChatSession,
  chatRefreshTokens,
  chatSignOut,
  type RefreshedTokens,
} from "@/app/lib/tauri/chat";

/** How long the server may hold a sliding-sync request open. */
const SLIDING_SYNC_TIMEOUT_MS = 30_000;

/**
 * How long the first sync may take before boot is failed. The SDK reports
 * an error only after three failed requests, each bounded by the request
 * timeout; this covers that and a hung request that never errors.
 */
const INITIAL_SYNC_DEADLINE_MS = 2 * SLIDING_SYNC_TIMEOUT_MS + 15_000;

/**
 * The rust crypto store refused to open because the Olm account inside it
 * was created for another (user, device) than the one the client was built
 * for. Device-scoped store names rule this out by construction; a store
 * left by a sign-out that never ran can still meet it once. Either way the
 * store is one this device cannot use and can only be wiped.
 */
export function isStoreAccountMismatch(error: unknown): boolean {
  let message: string;
  if (typeof error === "string") message = error;
  else if (error instanceof Error) message = error.message;
  else message = String((error as { message?: unknown } | null | undefined)?.message ?? "");
  return /account in the store doesn't match the account in the constructor/i.test(message);
}

/** What the user sees when the wipe-and-retry did not clear the mismatch. */
const STORE_MISMATCH_MESSAGE =
  "The chat data kept on this device belongs to another session and could not be reset. Sign out of chat and sign in again.";

/** A sentence the "Chat is unavailable" screen can show for a failed boot. */
export function initialSyncError(error: unknown): Error {
  if (error instanceof MatrixError) {
    if (error.errcode === "M_UNKNOWN_TOKEN") {
      return new Error("Your chat session has expired. Sign in again to continue.");
    }
    if (error.httpStatus && error.httpStatus >= 500) {
      return new Error(
        `The chat server is not responding (HTTP ${error.httpStatus}). Try again in a moment.`,
      );
    }
  }
  return new Error("Could not reach the chat server. Check your connection and try again.");
}

/** State events every room needs for the list and the header. */
const ROOM_REQUIRED_STATE: string[][] = [
  ["m.room.name", ""],
  ["m.room.topic", ""],
  ["m.room.avatar", ""],
  ["m.room.canonical_alias", ""],
  ["m.room.create", ""],
  ["m.room.encryption", ""],
  ["m.room.join_rules", ""],
  ["m.room.power_levels", ""],
  ["m.room.tombstone", ""],
  ["m.room.history_visibility", ""],
  // Space hierarchy: a Space's child links and a room's parent links are
  // what scopes the channel list to a workspace.
  ["m.space.child", "*"],
  ["m.space.parent", "*"],
  // Own membership and lazy-loaded heroes (`$ME`, `$LAZY` per MSC4186).
  ["m.room.member", "$ME"],
  ["m.room.member", "$LAZY"],
];

/** The lists sent on every sync. Same shape as the console's. */
export function buildSlidingSyncLists(): Map<string, MSC3575List> {
  const lists = new Map<string, MSC3575List>();
  lists.set("rooms", {
    ranges: [[0, 199]],
    sort: ["by_notification_level", "by_recency"],
    timeline_limit: 1,
    required_state: ROOM_REQUIRED_STATE,
    filters: { is_invite: false },
  });
  lists.set("invites", {
    ranges: [[0, 49]],
    sort: ["by_recency"],
    timeline_limit: 0,
    required_state: ROOM_REQUIRED_STATE,
    filters: { is_invite: true },
  });
  return lists;
}

/** Room subscription used when a room is opened: enough timeline to fill the view. */
export const OPEN_ROOM_SUBSCRIPTION = {
  timeline_limit: 50,
  required_state: [
    ...ROOM_REQUIRED_STATE,
    ["m.room.member", "*"],
    ["m.room.pinned_events", ""],
  ],
};

export interface ChatClientCallbacks {
  /** Tokens rotated (Rust already persisted them): the in-memory copy moved. */
  onSessionUpdated?: (session: ChatSession) => void;
  /** The homeserver says the token is dead and cannot be refreshed. */
  onSessionExpired?: () => void;
  /** Sync state transitions, for the connection indicator. */
  onSyncState?: (state: SyncState, previous: SyncState | null) => void;
}

export interface ChatClientHandle {
  client: MatrixClient;
  slidingSync: SlidingSync;
  /** Resolves once the first sync has landed and rooms are available. */
  ready: Promise<void>;
  /** The session as of now: tokens rotate silently while the client runs. */
  getSession: () => ChatSession;
  /**
   * Stop syncing and detach: after this resolves no token refresh started
   * by this client is reported, and no callback fires. Waits for a refresh
   * already in flight to settle so the caller sees the final tokens.
   * Idempotent.
   */
  dispose: () => Promise<void>;
}

/** Merge what Rust returned from a refresh into the in-memory session. */
export function applyRefreshedTokens(session: ChatSession, tokens: RefreshedTokens): ChatSession {
  return {
    ...session,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? session.refreshToken,
    expiresAt: tokens.expiresAt,
  };
}

/** Test seam: the SDK's refresh callback shape, satisfied by Rust. */
export type TokenRefreshFunction = (
  refreshToken: string,
) => Promise<{ accessToken: string; refreshToken?: string; expiry?: Date }>;

/**
 * Open this device's sync store, build the client on it and open the rust
 * crypto store. If the crypto store cannot be opened the sync store is
 * closed again before the error propagates, so the caller can delete both
 * without a dangling connection blocking the delete.
 */
async function openClient(
  session: ChatSession,
  names: ChatStoreNames,
  tokenRefreshFunction: TokenRefreshFunction,
): Promise<MatrixClient> {
  const store = new IndexedDBStore({
    indexedDB: window.indexedDB,
    dbName: names.syncStore,
    localStorage: window.localStorage,
  });
  await store.startup();

  const client = createClient({
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    tokenRefreshFunction,
    userId: session.userId,
    deviceId: session.deviceId,
    store,
    cryptoCallbacks: chatCryptoCallbacks,
    timelineSupport: true,
  });

  try {
    await client.initRustCrypto({
      useIndexedDB: true,
      cryptoDatabasePrefix: names.cryptoPrefix,
    });
  } catch (error) {
    store.destroy();
    throw error;
  }
  return client;
}

/**
 * Create the client with persistent stores and rust crypto, and start
 * syncing. Does NOT bootstrap encryption — that needs the key from Rust
 * and is driven by the UI (`crypto/bootstrap.ts`).
 */
export async function startChatClient(
  session: ChatSession,
  callbacks: ChatClientCallbacks = {},
): Promise<ChatClientHandle> {
  let current: ChatSession = session;
  // Set by `dispose()`. Once true this handle reports nothing: a refresh
  // that lands after sign-out must not resurface tokens the sign-out just
  // revoked.
  let disposed = false;
  let inflightRefresh: Promise<void> | null = null;

  // The SDK hands us the refresh token it holds; Rust refreshes from the
  // keyring copy (the same token — both came from the same sign-in or the
  // same previous refresh) and persists the result before answering.
  const tokenRefreshFunction: TokenRefreshFunction = () => {
    if (disposed) return Promise.reject(new Error("Chat client disposed"));
    const request = chatRefreshTokens().then((tokens) => {
      current = applyRefreshedTokens(current, tokens);
      if (!disposed) callbacks.onSessionUpdated?.(current);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiry: tokens.expiresAt !== undefined ? new Date(tokens.expiresAt) : undefined,
      };
    });
    const settled: Promise<void> = request.then(
      () => undefined,
      () => undefined,
    );
    inflightRefresh = settled;
    void settled.then(() => {
      if (inflightRefresh === settled) inflightRefresh = null;
    });
    return request;
  };

  // Whatever store of THIS user is not this device's is deleted before
  // anything opens: a store left behind by an earlier device of the same
  // account whose sign-out never ran, or the console's legacy names. Such a
  // store is never opened. Scoped to the user on purpose: another Hippius
  // account's chat session lives on in the keyring across an account
  // switch, and its crypto store must survive with it.
  const names = await chatStoreNamesFor(session);
  const swept = await deleteOtherChatStores(session.userId, names);
  if (swept.length > 0) {
    console.info(
      `[chat] removed ${swept.length} store(s) of other devices before opening ${session.deviceId}'s`,
    );
  }

  let client: MatrixClient;
  try {
    client = await openClient(session, names, tokenRefreshFunction);
  } catch (error) {
    if (!isStoreAccountMismatch(error)) throw error;
    // The store this session owns holds another device's account. It is
    // useless to this device: wipe it and open fresh ones under the same
    // names, once. A second mismatch is reported as such, not retried into
    // a loop.
    console.warn(
      `[chat] crypto store does not belong to device ${session.deviceId}; wiping and recreating it (${error instanceof Error ? error.message : String(error)})`,
    );
    await deleteChatStores(names);
    try {
      client = await openClient(session, names, tokenRefreshFunction);
    } catch (again) {
      throw isStoreAccountMismatch(again) ? new Error(STORE_MISMATCH_MESSAGE) : again;
    }
  }

  client.on(HttpApiEvent.SessionLoggedOut, () => {
    if (!disposed) callbacks.onSessionExpired?.();
  });

  const slidingSync = new SlidingSync(
    session.baseUrl,
    buildSlidingSyncLists(),
    { timeline_limit: 1, required_state: ROOM_REQUIRED_STATE },
    client,
    SLIDING_SYNC_TIMEOUT_MS,
  );

  // Settles the `ready` promise from outside the sync listener so that
  // `dispose()` can fail a boot that is still waiting.
  let settleReady: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = { resolve, reject };
    let synced = false;
    // Safety net for a first request that neither answers nor errors: the
    // sliding-sync request itself times out at SLIDING_SYNC_TIMEOUT_MS, so
    // anything longer is stuck.
    const deadline = setTimeout(() => {
      if (synced || disposed) return;
      reject(new Error("The chat server did not answer the first sync in time."));
    }, INITIAL_SYNC_DEADLINE_MS);
    const onSync = (state: SyncState, previous: SyncState | null, data?: SyncStateData) => {
      if (disposed) return;
      callbacks.onSyncState?.(state, previous);
      if (state === SyncState.Prepared || state === SyncState.Syncing) {
        synced = true;
        clearTimeout(deadline);
        resolve();
      } else if (state === SyncState.Error && !synced) {
        // The first sync never landed. Errors after the first successful
        // sync are retried by the SDK and surfaced through onSyncState only.
        clearTimeout(deadline);
        reject(initialSyncError(data?.error));
      }
    };
    client.on(ClientEvent.Sync, onSync);
  });
  // Nobody awaits `ready` when the boot is abandoned; keep the rejection
  // from surfacing as an unhandled promise.
  ready.catch(() => undefined);

  await client.startClient({
    slidingSync,
    threadSupport: true,
    lazyLoadMembers: true,
  });

  const dispose = async (): Promise<void> => {
    if (!disposed) {
      disposed = true;
      slidingSync.stop();
      client.stopClient();
      settleReady?.reject(new Error("Chat client disposed"));
    }
    if (inflightRefresh) await inflightRefresh;
  };

  return { client, slidingSync, ready, getSession: () => current, dispose };
}

const OPEN_ROOM_SUBSCRIPTION_NAME = "open-room";
const registeredOpenSubscription = new WeakSet<SlidingSync>();

/**
 * Point the sliding-sync room subscription at the room being viewed so its
 * full timeline and member list are streamed; the previous room drops back
 * to the list's `timeline_limit: 1`. Pass `null` when no room is open.
 */
export function subscribeToRoom(handle: ChatClientHandle, roomId: string | null): void {
  const { slidingSync } = handle;
  if (!registeredOpenSubscription.has(slidingSync)) {
    slidingSync.addCustomSubscription(OPEN_ROOM_SUBSCRIPTION_NAME, OPEN_ROOM_SUBSCRIPTION);
    registeredOpenSubscription.add(slidingSync);
  }
  if (roomId) {
    slidingSync.useCustomSubscription(roomId, OPEN_ROOM_SUBSCRIPTION_NAME);
    slidingSync.modifyRoomSubscriptions(new Set([roomId]));
  } else {
    slidingSync.modifyRoomSubscriptions(new Set());
  }
}

/** Stop syncing and release the stores, keeping the session for next time. */
export function stopChatClient(handle: ChatClientHandle): void {
  void handle.dispose();
  clearSecretStorageKey();
}

/**
 * Full sign-out: stop the client, wipe every chat database, then have Rust
 * revoke the tokens and forget the keyring session. The next visit starts
 * from the signed-out state.
 *
 * `session` is the fallback for when no client is running (sign-out from
 * an error state) and is only used to name the stores to delete; the
 * tokens to revoke are read by Rust from the keyring, which a refresh
 * always updates first.
 *
 * The device's stores — and any stale store of the same user — are gone
 * before this resolves, and before the session record is cleared: the next
 * sign-in creates a new device, and that device must never find this one's
 * crypto store under any name. Other users' stores are not touched: they
 * belong to sessions the keyring still holds for other Hippius accounts.
 */
export async function signOutChat(
  handle: ChatClientHandle | null,
  session: ChatSession | null,
): Promise<void> {
  let ending = session;
  if (handle) {
    await handle.dispose();
    ending = handle.getSession();
    try {
      await handle.client.clearStores({
        cryptoDatabasePrefix: (await chatStoreNamesFor(ending)).cryptoPrefix,
      });
    } catch {
      // Best effort: fall through to the explicit deletes below.
    }
  }
  clearSecretStorageKey();
  if (ending) await deleteChatStores(await chatStoreNamesFor(ending));
  await deleteOtherChatStores(ending?.userId ?? null, null);
  await chatSignOut();
}
