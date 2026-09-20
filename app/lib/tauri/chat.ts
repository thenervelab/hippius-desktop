// Typed wrappers around the Rust team-chat IPC commands.
//
// The Rust source of truth is `src-tauri/src/chat/`. This is the only file
// in the frontend that names those commands: the Matrix client itself runs
// in the webview (`app/lib/chat/`), but everything that is a credential or
// a decision — feature gate, OIDC sign-in, keyring session, token refresh,
// the secret-storage key derived from the account mnemonic — is owned by
// Rust and reached through here.

import { invoke } from "@tauri-apps/api/core";

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
 * Where a session's device keeps its SDK stores. Rust only ever mints
 * `"device"`; the field stays optional so a store-name decision made on a
 * session missing it (never expected) falls back to the legacy layout
 * instead of opening another device's store.
 */
export type ChatStoreLayout = "device";

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
