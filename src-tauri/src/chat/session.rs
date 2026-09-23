//! Matrix session persistence in the OS keyring.
//!
//! The console keeps its chat session (OAuth tokens, device id, user id) in
//! IndexedDB because a browser has nothing better. The desktop has the OS
//! credential store, so the session lives there under the service
//! `hippius-chat`, one entry per Hippius account, and never in
//! localStorage/IndexedDB — a webview store is readable by anything that
//! can read the profile directory, and an access token is a bearer
//! credential for every message the account can see.
//!
//! The record is the console's `ChatSession` shape (camelCase JSON) so the
//! ported client code consumes it unchanged. The webview receives it over
//! IPC when it opens the client and keeps it in memory only.
//!
//! ## Backends
//!
//! Same `keyring` crate and backend set as `auth::keychain` (macOS Keychain,
//! Windows Credential Manager, Secret Service on Linux). Failures are typed
//! ([`SessionStoreError`]) so the UI can tell "signed out" from "the keyring
//! is unreachable"; the latter is surfaced, never silently treated as
//! signed out, because that would send the user through a fresh sign-in
//! that mints a new Matrix device every launch.
//!
//! ## Tests / headless CI
//!
//! `HIPPIUS_DISABLE_CHAT_KEYCHAIN=1` swaps the OS store for a per-process
//! in-memory map. The commands and the sign-in flow are exercised against
//! that map so no test can leave a session in a developer's keychain.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::error::{AppError, Result};

/// Keyring service name. Distinct from the mnemonic (`com.hippius.desktop`)
/// and API-token (`com.hippius.desktop.token`) services so a vault audit
/// tells the three apart and a misdirected lookup cannot cross them.
pub const SERVICE: &str = "hippius-chat";

const DISABLE_ENV_VAR: &str = "HIPPIUS_DISABLE_CHAT_KEYCHAIN";

fn keychain_disabled() -> bool {
    std::env::var_os(DISABLE_ENV_VAR).is_some_and(|v| !v.is_empty())
}

/// How the sync/crypto IndexedDB stores are named. The ported `stores.ts`
/// keys its naming decision on it, exactly as the console does, so a store
/// is only ever opened under the layout it was created with.
///
/// `user-device` is the only layout a new sign-in writes. Its store names
/// carry a per-Matrix-user scope, so the boot-time sweep of stale stores
/// can be confined to the signed-in user and never reaches the stores of
/// another Hippius account signed in on the same machine (the keyring
/// holds one chat session per account, and the webview profile is shared).
/// `device` — the console's layout, an opaque digest over user and device —
/// stays for sessions recorded before the scope existed: their stores keep
/// their names, which is what keeps their crypto stores (and with them the
/// account's decryptable history) alive across the upgrade.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChatStoreLayout {
    Device,
    UserDevice,
}

/// One signed-in Matrix device. Field names are the console's `ChatSession`
/// wire shape; the frontend `ChatSession` type mirrors them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    /// Homeserver base URL the tokens are valid for.
    pub base_url: String,
    /// OAuth issuer that minted the tokens.
    pub issuer: String,
    /// OAuth client id this install registered with the issuer.
    pub client_id: String,
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix ms at which `access_token` expires, when the issuer said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    #[serde(default = "default_layout")]
    pub store_layout: ChatStoreLayout,
}

fn default_layout() -> ChatStoreLayout {
    ChatStoreLayout::Device
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(rt) = self.refresh_token.as_mut() {
            rt.zeroize();
        }
    }
}

/// Why a session could not be read or written.
#[derive(Debug, thiserror::Error)]
pub enum SessionStoreError {
    #[error("the OS credential store is unavailable: {0}")]
    Unavailable(String),
    #[error("stored chat session is unreadable: {0}")]
    Corrupt(String),
}

impl From<SessionStoreError> for AppError {
    fn from(e: SessionStoreError) -> Self {
        AppError::Auth(e.to_string())
    }
}

fn memory_store() -> &'static Mutex<HashMap<String, String>> {
    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Where the record lives. Chosen once per call from the env toggle; tests
/// address [`Backend::Memory`] directly so they never depend on process env.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
    Keyring,
    Memory,
}

fn backend() -> Backend {
    if keychain_disabled() { Backend::Memory } else { Backend::Keyring }
}

fn load_with(backend: Backend, account_id: &str) -> std::result::Result<Option<ChatSession>, SessionStoreError> {
    let raw = match backend {
        Backend::Memory => memory_store()
            .lock()
            .map_err(|e| SessionStoreError::Unavailable(e.to_string()))?
            .get(account_id)
            .cloned(),
        Backend::Keyring => {
            let entry = Entry::new(SERVICE, account_id).map_err(|e| SessionStoreError::Unavailable(format!("entry init: {e}")))?;
            match entry.get_password() {
                Ok(raw) => Some(raw),
                Err(keyring::Error::NoEntry) => None,
                Err(e) => return Err(SessionStoreError::Unavailable(format!("get_password: {e}"))),
            }
        }
    };
    let Some(mut raw) = raw else { return Ok(None) };
    let parsed = serde_json::from_str::<ChatSession>(&raw).map_err(|e| SessionStoreError::Corrupt(e.to_string()));
    raw.zeroize();
    parsed.map(Some)
}

fn save_with(backend: Backend, account_id: &str, session: &ChatSession) -> std::result::Result<(), SessionStoreError> {
    let mut raw = serde_json::to_string(session).map_err(|e| SessionStoreError::Corrupt(e.to_string()))?;
    let outcome = match backend {
        Backend::Memory => memory_store()
            .lock()
            .map_err(|e| SessionStoreError::Unavailable(e.to_string()))
            .map(|mut m| {
                m.insert(account_id.to_string(), raw.clone());
            }),
        Backend::Keyring => Entry::new(SERVICE, account_id)
            .and_then(|entry| entry.set_password(&raw))
            .map_err(|e| SessionStoreError::Unavailable(format!("set_password: {e}"))),
    };
    raw.zeroize();
    outcome
}

fn delete_with(backend: Backend, account_id: &str) -> std::result::Result<(), SessionStoreError> {
    match backend {
        Backend::Memory => {
            memory_store()
                .lock()
                .map_err(|e| SessionStoreError::Unavailable(e.to_string()))?
                .remove(account_id);
            Ok(())
        }
        Backend::Keyring => {
            let entry = Entry::new(SERVICE, account_id).map_err(|e| SessionStoreError::Unavailable(format!("entry init: {e}")))?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(SessionStoreError::Unavailable(format!("delete_credential: {e}"))),
            }
        }
    }
}

/// Read the session stored for `account_id`. `Ok(None)` means signed out.
pub fn load_session(account_id: &str) -> std::result::Result<Option<ChatSession>, SessionStoreError> {
    load_with(backend(), account_id)
}

/// Persist `session` for `account_id`, replacing any previous one.
pub fn save_session(account_id: &str, session: &ChatSession) -> std::result::Result<(), SessionStoreError> {
    save_with(backend(), account_id, session)
}

/// Remove the session for `account_id`. Idempotent.
pub fn delete_session(account_id: &str) -> std::result::Result<(), SessionStoreError> {
    delete_with(backend(), account_id)
}

/// The active account's chat session, or `None` when signed out of chat.
///
/// Scoped to the active Hippius account: switching accounts on one machine
/// switches chat sessions with it, and one account can never see another's
/// tokens.
#[tauri::command]
pub async fn chat_get_session(state: tauri::State<'_, crate::app_state::AppState>) -> Result<Option<ChatSession>> {
    let account_id = state.current_account_id()?;
    tokio::task::spawn_blocking(move || load_session(&account_id))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))?
        .map_err(AppError::from)
}

/// Forget the chat session for the active account WITHOUT revoking tokens.
/// The sign-out command (`sign_in::chat_sign_out`) revokes first and then
/// calls this; this is exposed separately for the "session expired" path
/// where there is nothing left to revoke.
#[tauri::command]
pub async fn chat_clear_session(state: tauri::State<'_, crate::app_state::AppState>) -> Result<()> {
    let account_id = state.current_account_id()?;
    tokio::task::spawn_blocking(move || delete_session(&account_id))
        .await
        .map_err(|e| AppError::Other(format!("keyring task: {e}")))?
        .map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(user: &str) -> ChatSession {
        ChatSession {
            base_url: "https://chat.hippius.com".into(),
            issuer: "https://chat.hippius.com/".into(),
            client_id: "01ABC".into(),
            user_id: format!("@{user}:hippius.com"),
            device_id: "ABCDEFGHIJ".into(),
            access_token: "mat_secret".into(),
            refresh_token: Some("mar_secret".into()),
            expires_at: Some(1_800_000_000_000),
            store_layout: ChatStoreLayout::Device,
        }
    }

    #[test]
    fn wire_shape_matches_the_console_session_record() {
        let json = serde_json::to_value(sample("alice")).unwrap();
        assert_eq!(json["baseUrl"], "https://chat.hippius.com");
        assert_eq!(json["clientId"], "01ABC");
        assert_eq!(json["userId"], "@alice:hippius.com");
        assert_eq!(json["deviceId"], "ABCDEFGHIJ");
        assert_eq!(json["accessToken"], "mat_secret");
        assert_eq!(json["refreshToken"], "mar_secret");
        assert_eq!(json["expiresAt"], 1_800_000_000_000_i64);
        assert_eq!(json["storeLayout"], "device");
        // Absent optionals are omitted, not null, like the console record.
        let mut no_refresh = sample("bob");
        no_refresh.refresh_token = None;
        no_refresh.expires_at = None;
        let json = serde_json::to_value(&no_refresh).unwrap();
        assert!(json.get("refreshToken").is_none());
        assert!(json.get("expiresAt").is_none());
    }

    #[test]
    fn memory_store_round_trips_and_isolates_accounts() {
        let m = Backend::Memory;
        let a = "5Faccount-a-session";
        let b = "5Faccount-b-session";
        delete_with(m, a).unwrap();
        delete_with(m, b).unwrap();
        assert!(load_with(m, a).unwrap().is_none());

        save_with(m, a, &sample("alice")).unwrap();
        assert_eq!(load_with(m, a).unwrap().unwrap().user_id, "@alice:hippius.com");
        assert!(load_with(m, b).unwrap().is_none(), "account B must not see account A's session");

        save_with(m, a, &sample("alice2")).unwrap();
        assert_eq!(load_with(m, a).unwrap().unwrap().user_id, "@alice2:hippius.com", "save replaces");

        delete_with(m, a).unwrap();
        assert!(load_with(m, a).unwrap().is_none());
        delete_with(m, a).unwrap(); // idempotent
    }

    #[test]
    fn corrupt_record_is_reported_not_treated_as_signed_out() {
        let id = "5Faccount-corrupt-session";
        memory_store().lock().unwrap().insert(id.to_string(), "{not json".to_string());
        assert!(matches!(load_with(Backend::Memory, id), Err(SessionStoreError::Corrupt(_))));
        delete_with(Backend::Memory, id).unwrap();
    }

    #[test]
    fn legacy_record_without_layout_defaults_to_device() {
        let raw = r#"{"baseUrl":"https://chat.hippius.com","issuer":"https://chat.hippius.com/","clientId":"c","userId":"@u:hippius.com","deviceId":"D","accessToken":"t"}"#;
        let s: ChatSession = serde_json::from_str(raw).unwrap();
        assert_eq!(s.store_layout, ChatStoreLayout::Device);
        assert!(s.refresh_token.is_none());
    }

    /// The layout is a wire contract with `stores.ts`, which dispatches on
    /// the exact string: `user-device` is the scoped layout new sign-ins
    /// record, and a `device` record written before the scope existed must
    /// still read back as `Device` so its stores keep their names.
    #[test]
    fn store_layouts_round_trip_under_their_wire_names() {
        let mut scoped = sample("alice");
        scoped.store_layout = ChatStoreLayout::UserDevice;
        let json = serde_json::to_value(&scoped).unwrap();
        assert_eq!(json["storeLayout"], "user-device");
        let back: ChatSession = serde_json::from_value(json).unwrap();
        assert_eq!(back.store_layout, ChatStoreLayout::UserDevice);

        let raw = r#"{"baseUrl":"b","issuer":"i","clientId":"c","userId":"@u:hippius.com","deviceId":"D","accessToken":"t","storeLayout":"device"}"#;
        let s: ChatSession = serde_json::from_str(raw).unwrap();
        assert_eq!(s.store_layout, ChatStoreLayout::Device);
    }
}
