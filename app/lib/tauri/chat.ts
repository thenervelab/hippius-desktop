// Typed wrappers around the Rust team-chat IPC commands.
//
// The Rust source of truth is `src-tauri/src/chat/`. This is the only file
// in the frontend that names those commands: the Matrix client itself runs
// in the webview (`app/lib/chat/`), but everything that is a credential or
// a decision — feature gate, OIDC sign-in, keyring session, token refresh,
// the secret-storage key derived from the account mnemonic — is owned by
// Rust and reached through here.

import { invoke } from "@tauri-apps/api/core";

import type { IncomingMessage } from "@/lib/chat/notifications";

/** `chat::config::ChatConfig` — decided in Rust; the frontend keeps no copy. */
export interface ChatConfig {
  enabled: boolean;
  serverName: string;
  fallbackBaseUrl: string;
  communitySpaceAlias: string;
  /** Fixed secret-storage key id shared with the web console. */
  secretStorageKeyId: string;
  secretStorageKeyName: string;
  apiBaseUrl: string;
}

/**
 * Where a session's device keeps its SDK stores (`chat::session::ChatStoreLayout`).
 * New sign-ins record `"user-device"`, whose store names carry a per-user
 * scope the stale-store sweep is confined to; `"device"` is the console's
 * unscoped layout, kept for sessions recorded before the scope existed so
 * their stores keep their names. The field stays optional so a store-name
 * decision made on a session missing it (never expected) falls back to the
 * legacy layout instead of opening another device's store.
 */
export type ChatStoreLayout = "device" | "user-device";

/** `chat::session::ChatSession` — same wire shape as the console's session. */
export interface ChatSession {
  /** Client-server base URL the tokens were issued against. */
  baseUrl: string;
  /** OAuth issuer that minted the tokens. */
  issuer: string;
  clientId: string;
  /** Full Matrix user id, `@local:server`. */
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when `accessToken` expires, if the issuer said. */
  expiresAt?: number;
  storeLayout?: ChatStoreLayout;
}

export interface BeginSignIn {
  flowId: string;
  /** Open in the system browser; Rust waits on the loopback redirect. */
  authorizeUrl: string;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface SecretStorageKeyMaterial {
  /** 32 bytes, standard base64. Decode, use, zero. */
  keyBase64: string;
  keyId: string;
  keyName: string;
}

export function chatGetConfig(): Promise<ChatConfig> {
  return invoke<ChatConfig>("chat_get_config");
}

/**
 * The active account's stored session, or `null` when signed out of chat.
 * Rejects when the OS credential store cannot be read — callers must NOT
 * read a rejection as "signed out" (see `isChatKeyringUnavailable`).
 */
export function chatGetSession(): Promise<ChatSession | null> {
  return invoke<ChatSession | null>("chat_get_session");
}

export function chatBeginSignIn(): Promise<BeginSignIn> {
  return invoke<BeginSignIn>("chat_begin_sign_in");
}

/** Blocks until the browser comes back (up to the Rust-side timeout). */
export function chatCompleteSignIn(flowId: string): Promise<ChatSession> {
  return invoke<ChatSession>("chat_complete_sign_in", { flowId });
}

export function chatCancelSignIn(flowId: string): Promise<void> {
  return invoke<void>("chat_cancel_sign_in", { flowId });
}

/** Refresh through Rust so the keyring copy is the one that moves. */
export function chatRefreshTokens(): Promise<RefreshedTokens> {
  return invoke<RefreshedTokens>("chat_refresh_tokens");
}

/** Revoke tokens (best effort) and forget the session. */
export function chatSignOut(): Promise<void> {
  return invoke<void>("chat_sign_out");
}

/** Forget the session without revoking: the "expired" path. */
export function chatClearSession(): Promise<void> {
  return invoke<void>("chat_clear_session");
}

export function chatDeriveSecretStorageKey(): Promise<SecretStorageKeyMaterial> {
  return invoke<SecretStorageKeyMaterial>("chat_derive_secret_storage_key");
}

/**
 * Whether a `chat_get_session` rejection means the OS keyring could not be
 * read (as opposed to a genuine auth failure). Rust surfaces
 * `SessionStoreError::Unavailable` as `AppError::Auth` with this exact
 * wording; the UI shows "chat is unavailable, retry" for it and never a
 * sign-in button, which would only fail again at the keyring write.
 */
export function isChatKeyringUnavailable(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : String((error as { message?: unknown } | null | undefined)?.message ?? "");
  return /credential store is unavailable/i.test(message);
}

/**
 * Whether a `chat_refresh_tokens` rejection means the stored session is
 * dead for good — the issuer rejected the refresh token, or there was none.
 * Rust (`chat::sign_in::SESSION_EXPIRED`) uses this exact wording for that
 * case only and has already deleted the session by then; any other refresh
 * error (issuer unreachable, keyring locked) is transient and must not be
 * read this way, or a network blip would sign the user out of chat.
 */
export function isChatSessionExpired(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : String((error as { message?: unknown } | null | undefined)?.message ?? "");
  return /^chat: session expired/i.test(message);
}

// ---------------------------------------------------------------------------
// Notifications and the unread badge (`chat::notify`)

/**
 * Rust's `chat::notify::IncomingMessage`. Built by the pure
 * `app/lib/chat/notifications.ts::classifyIncoming`; only Matrix facts,
 * the decision to notify is Rust's.
 */
export type { IncomingMessage };

/** Rust's `chat::notify::NotifyOutcome` (snake_case on the wire). */
export type NotifyOutcome = "shown" | "preference_disabled" | "not_mention_or_direct" | "room_visible";

/**
 * Rust's `chat::notify::NotifyResult`: why the OS notification was or was
 * not shown, and whether to play the chime. `playSound` is decided in Rust
 * (shown AND the sound preference is on), so the webview only synthesises
 * the tone — it never re-derives the gate.
 */
export interface NotifyResult {
  outcome: NotifyOutcome;
  playSound: boolean;
}

/** Event Rust broadcasts to every window when the unread count changes. */
export const CHAT_UNREAD_CHANGED_EVENT = "chat_unread_changed";

export interface ChatUnreadChanged {
  count: number;
}

/**
 * Hand an incoming message to Rust, which applies the desktop policy
 * (preference, mentions/DMs, room on screen + window focused) and shows
 * the OS notification. Returns what it decided and whether to play the
 * chime.
 */
export function chatNotifyMessage(message: IncomingMessage): Promise<NotifyResult> {
  return invoke<NotifyResult>("chat_notify_message", { message });
}

/**
 * Report the attention count (`attentionCount` in `app/lib/chat/rooms.ts`).
 * Rust sets the dock/taskbar badge and the `(N) Hippius` window title and
 * broadcasts `CHAT_UNREAD_CHANGED_EVENT`.
 */
export function chatSetUnreadBadge(count: number): Promise<void> {
  return invoke<void>("chat_set_unread_badge", { count });
}

/** The last count reported through `chatSetUnreadBadge` (tray popover seed). */
export function chatGetUnreadCount(): Promise<number> {
  return invoke<number>("chat_get_unread_count");
}

/** The account's "Chat" notification preference (Settings → Notifications). */
export function chatGetNotificationsEnabled(): Promise<boolean> {
  return invoke<boolean>("chat_get_notifications_enabled");
}

export function chatSetNotificationsEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("chat_set_notifications_enabled", { enabled });
}

/** The account's chat notification chime switch (default on; Rust-owned). */
export function chatGetSoundEnabled(): Promise<boolean> {
  return invoke<boolean>("chat_get_sound_enabled");
}

export function chatSetSoundEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("chat_set_sound_enabled", { enabled });
}

// ---------------------------------------------------------------------------
// Workspace invite links (`chat::backend`)
//
// A Matrix invite needs a user id; a link needs the backend's bot to invite
// whoever redeems it. Those calls carry the desktop's Hippius API token, so
// they go through Rust; the webview never holds that token. Every HTTP
// status the UI branches on is already mapped in Rust into a `kind`-tagged
// outcome — the frontend never parses an error message to decide what to
// render. Field names are the backend's (snake_case), as Rust forwards them.

export interface WorkspaceInviteLink {
  token: string;
  /** `https://console.hippius.com/chat/join/<token>` — what gets copied. */
  url: string;
  /** ISO 8601. */
  expires_at: string;
  max_uses: number | null;
  uses: number;
  space_id: string;
}

/** `chat::backend::InviteLinkOutcome`. */
export type InviteLinkOutcome =
  | ({ kind: "link" } & WorkspaceInviteLink)
  /** The caller is not an admin or owner of the Space. */
  | { kind: "forbidden" }
  /** This backend has no invite-link endpoint: invite by handle only. */
  | { kind: "unavailable" };

/** `chat::backend::AcceptInviteOutcome`. */
export type AcceptInviteOutcome =
  | { kind: "accepted"; space_id: string; room_ids: string[] }
  /** Unknown token — or something that does not even look like one. */
  | { kind: "unknown" }
  /** Expired, or every use spent. */
  | { kind: "expired" };

/** `chat::backend::InvitePreviewOutcome`. */
export type InvitePreviewOutcome =
  | { kind: "preview"; space_id: string; workspace_name: string; inviter_display_name: string | null; expires_at: string }
  | { kind: "unknown" }
  | { kind: "expired" };

/** Mint a 7-day, unlimited-use invite link for the Space (admins/owners). */
export function chatCreateWorkspaceInvite(spaceId: string): Promise<InviteLinkOutcome> {
  return invoke<InviteLinkOutcome>("chat_create_workspace_invite", { spaceId });
}

/**
 * Redeem a pasted link or bare token: the backend's bot invites this
 * session's Matrix user to the Space and its default channels. The caller
 * then accepts those Matrix invites (`app/lib/chat/invite-links.ts`).
 */
export function chatAcceptWorkspaceInvite(tokenOrUrl: string): Promise<AcceptInviteOutcome> {
  return invoke<AcceptInviteOutcome>("chat_accept_workspace_invite", { tokenOrUrl });
}

export function chatPreviewWorkspaceInvite(tokenOrUrl: string): Promise<InvitePreviewOutcome> {
  return invoke<InvitePreviewOutcome>("chat_preview_workspace_invite", { tokenOrUrl });
}

/**
 * Header the attachment save command reads its destination from. The body
 * of that invoke is the raw file bytes (an `ArrayBuffer`, not JSON), which
 * leaves no room for other arguments; Tauri forwards custom headers.
 */
export const CHAT_SAVE_DESTINATION_HEADER = "x-destination";

/**
 * Header values must be ASCII-safe; a filename such as `résumé.pdf` is not.
 * Rust decodes only `%XX` sequences, so this must encode `%` itself too —
 * `encodeURIComponent` does, and keeps `/` out of the way by encoding it as
 * well, which the decoder restores.
 */
export function encodeSaveDestination(path: string): string {
  return encodeURIComponent(path);
}

/**
 * Write a decrypted attachment to the path the user picked in the native
 * save dialog. The dialog itself is UI and lives with the caller; the
 * write (absolute path only, atomic temp+rename, no silent overwrite) is
 * Rust's — `chat::attachments::chat_save_attachment`.
 */
export function chatSaveAttachment(destination: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
  const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return invoke<void>("chat_save_attachment", body, {
    headers: { [CHAT_SAVE_DESTINATION_HEADER]: encodeSaveDestination(destination) },
  });
}
