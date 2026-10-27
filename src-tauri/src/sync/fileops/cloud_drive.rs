//! Make a new drive that lives only on Hippius, with no folder on this
//! computer.
//!
//! "Share a drive" offers New drive so a drive can be made and shared in one
//! go, the way the web console does it. Routing that through Sync a Folder
//! asked for a local folder the person never wanted, so this registers the
//! drive with the server and nothing else.
//!
//! A drive is nothing more than a registry row on the server:
//! `{ ss58, folder_hash, label, device_name }`, with
//! `folder_hash = SHA256(label)[..16]` (`hcfs_client::drive::keys::folder_hash`)
//! and the drive's key derived from the master mnemonic and the label when
//! it is first needed. The console, the mobile app and the sync engine all use
//! that same rule, so a drive made here is the same drive everywhere: it shows
//! up in every client's drive list as not synced, can be shared at once
//! (sharing derives its key from the master, no local row needed), and "Sync
//! to this computer" in its menu can bind it to a folder later.
//!
//! Registering is an upsert keyed on the folder hash, so a name that is
//! already a drive would silently relabel it rather than fail. The name is
//! therefore checked against every drive the account has, on this computer and
//! on the server, before anything is sent, and a server listing that cannot
//! be read stops the create instead of guessing.

use std::collections::HashSet;

use hcfs_client::sync::SyncError;
use hcfs_shared::network::RemoteFolderInfo;
use serde::Serialize;
use tracing::{info, warn};
use unicode_normalization::UnicodeNormalization;

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::identity::DriveIdentity;
use crate::sync::mnemonic::folder_hash;
use crate::sync::paths::SyncPathResult;

/// The longest drive name, in characters. The console's limit, so a name one
/// client accepts the other does too.
pub const MAX_DRIVE_NAME_CHARS: usize = 100;

/// Characters a drive name may not hold: path separators and the characters
/// a folder name cannot carry on Windows, so the drive can be synced to a
/// folder of the same name on any computer later. The console's set.
const FORBIDDEN_NAME_CHARS: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

pub(crate) const NAME_REQUIRED: &str = "Give the drive a name.";
pub(crate) const NAME_TOO_LONG: &str = "Keep the drive name to 100 characters or fewer.";
pub(crate) const NAME_BAD_CHARS: &str = "A drive name can't contain / \\ : * ? \" < > | or control characters.";
pub(crate) const NAME_RESERVED: &str = "That name is reserved. Choose another.";
pub(crate) const NAME_NEEDS_LETTER: &str = "Use at least one letter or number in the drive name.";
pub(crate) const OFFLINE: &str = "Couldn't reach Hippius, so the drive wasn't created. Try again in a moment.";
pub(crate) const BUSY: &str = "Hippius is busy right now, so the drive wasn't created. Try again in a moment.";
pub(crate) const SESSION_EXPIRED: &str = "Your session has expired. Sign in again to create a drive.";
pub(crate) const READ_ONLY: &str = "Your account is read-only right now, so new drives can't be created. Check your plan in Settings > Billing.";
pub(crate) const SUSPENDED: &str = "Your account is suspended, so new drives can't be created.";
pub(crate) const PLAN_REFUSED: &str = "Your plan doesn't allow a new drive right now. Check your plan in Settings > Billing.";
pub(crate) const CREATE_FAILED: &str = "Hippius couldn't create the drive just now. Try again in a moment.";

/// The drive that was made: its name, which is also its label everywhere,
/// and the folder hash the server keys it by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedCloudDrive {
    pub label: String,
    pub folder_hash: String,
}

/// The name a drive will be made with, or why it cannot be.
///
/// Trimmed, and otherwise kept byte for byte: the label is hashed and fed to
/// the key derivation verbatim by every client, so normalizing it here would
/// put the drive in a different namespace from the one the console computes
/// for the same name.
///
/// Beyond the console's rules, a name must keep at least one letter, digit,
/// `-` or `_` once `folders::sanitize_label` has stripped it, because that is
/// the folder name "Sync to this computer" makes for it; a name of only
/// symbols could be made but never synced.
pub(crate) fn validate_drive_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::Validation(NAME_REQUIRED.into()));
    }
    if name.chars().count() > MAX_DRIVE_NAME_CHARS {
        return Err(AppError::Validation(NAME_TOO_LONG.into()));
    }
    if name.chars().any(|c| FORBIDDEN_NAME_CHARS.contains(&c) || c.is_control()) {
        return Err(AppError::Validation(NAME_BAD_CHARS.into()));
    }
    if name == "." || name == ".." {
        return Err(AppError::Validation(NAME_RESERVED.into()));
    }
    if crate::sync::folders::sanitize_label(name).is_err() {
        return Err(AppError::Validation(NAME_NEEDS_LETTER.into()));
    }
    Ok(name.to_string())
}

/// How two names are compared for "already a drive": NFC, then lowercase.
///
/// Stricter than the server, which keys on the exact label's hash, on
/// purpose. "Photos" and "photos" are two drives to the server but would be
/// one folder on a Mac that syncs both, and two rows nobody can tell apart in
/// every drive list.
fn name_key(name: &str) -> String {
    name.trim().nfc().collect::<String>().to_lowercase()
}

/// Every name and folder hash the account's drives already use.
#[derive(Debug, Default)]
pub(crate) struct ExistingDrives {
    names: HashSet<String>,
    hashes: HashSet<String>,
}

impl ExistingDrives {
    /// From the drives on this computer and the server's own listing.
    ///
    /// A local drive counts under its label (what the share and browse IPCs
    /// resolve by, so reusing it would resolve to THAT drive, a joined one
    /// included) and under its folder's name (what it is registered and
    /// shown as). A server drive counts under its label and its hash.
    pub(crate) fn new(local: &[SyncPathResult], remote: &[RemoteFolderInfo]) -> Self {
        let mut existing = Self::default();
        for drive in local {
            existing.names.insert(name_key(&drive.label));
            if let Some(folder) = std::path::Path::new(&drive.path).file_name().and_then(|n| n.to_str()) {
                existing.names.insert(name_key(folder));
            }
            existing.hashes.insert(folder_hash(&drive.label));
        }
        for drive in remote {
            existing.names.insert(name_key(&drive.label));
            existing.hashes.insert(drive.folder_hash.clone());
        }
        existing
    }

    /// Refuses `name` when a drive already answers to it.
    pub(crate) fn refuse_taken(&self, name: &str) -> Result<()> {
        if self.hashes.contains(&folder_hash(name)) || self.names.contains(&name_key(name)) {
            return Err(AppError::Validation(format!(
                "You already have a drive called \u{201c}{name}\u{201d}. Choose another name."
            )));
        }
        Ok(())
    }
}

/// The sentence for a create that the server or the network refused.
///
/// Matched on the typed error (status and slug), never on its English. Every
/// branch is a sentence the dialog shows as is; the raw error goes to the log.
pub(crate) fn create_failure(error: &SyncError) -> AppError {
    match error {
        SyncError::Network(_) => AppError::Other(OFFLINE.into()),
        SyncError::RateLimited { .. } | SyncError::Http { status: 429, .. } => AppError::Other(BUSY.into()),
        SyncError::Http { status: 401, .. } => AppError::Other(SESSION_EXPIRED.into()),
        SyncError::Http { status: 402, .. } => AppError::Validation(PLAN_REFUSED.into()),
        SyncError::Http { status: 403, code, .. } => match code.as_deref() {
            Some("account_read_only") => AppError::Validation(READ_ONLY.into()),
            Some("account_suspended") => AppError::Validation(SUSPENDED.into()),
            _ => AppError::Other(CREATE_FAILED.into()),
        },
        _ => AppError::Other(CREATE_FAILED.into()),
    }
}

/// The create, given a client for this account and the drives on this
/// computer. Split from the command so it runs against a stand-in server.
pub(crate) async fn create_cloud_drive_with(
    client: &hcfs_client::client::HcfsClient,
    account_id: &str,
    raw_name: &str,
    local: &[SyncPathResult],
    device_name: Option<&str>,
) -> Result<CreatedCloudDrive> {
    let name = validate_drive_name(raw_name)?;

    // Fresh from the server every time: the drive list on screen may be
    // minutes old, and a drive made on another device since would otherwise
    // be relabelled by the upsert below.
    let remote = client.list_remote_folders(account_id).await.map_err(|e| {
        warn!(error = %e, "create_cloud_drive: could not list the account's drives");
        create_failure(&e)
    })?;
    ExistingDrives::new(local, &remote).refuse_taken(&name)?;

    let hash = folder_hash(&name);
    // This computer's name, as a synced drive registers with. The drive then
    // reads "Not synced here" on this computer and "On <this computer>"
    // elsewhere, which is where it was made.
    client.register_folder(account_id, &hash, &name, device_name).await.map_err(|e| {
        warn!(error = %e, folder_hash = %hash, "create_cloud_drive: register_folder failed");
        create_failure(&e)
    })?;
    info!(folder_hash = %hash, "Created a drive on Hippius with no local folder");
    Ok(CreatedCloudDrive {
        label: name,
        folder_hash: hash,
    })
}

/// Make a drive on Hippius with no folder on this computer.
///
/// No plan check here: making a drive is open to every plan, as on the
/// console. The callers that go on to share it check the sharing plan rule
/// themselves (Share a drive offers New drive only on a plan that shares, and
/// the invite mint is refused by the server otherwise).
#[tauri::command]
pub async fn create_cloud_drive(state: tauri::State<'_, AppState>, account_id: String, name: String) -> Result<CreatedCloudDrive> {
    let account_id = state.require_session_account(&account_id)?;
    // Refused before any read, so a bad name never waits on the network.
    validate_drive_name(&name)?;
    let pool = state.pool()?;
    // A failed read fails the create: an empty list would let a name that is
    // already a drive here through.
    let local = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id).await?;
    let device_name = crate::sync::device::get_device_name_internal(pool).await.ok();
    // Account-scoped: listing and registering name the drive in their own
    // arguments, so the client carries no folder hash.
    let client = crate::sync::remote::build_client(pool, &account_id, &DriveIdentity::own(&account_id, "")).await?;
    create_cloud_drive_with(&client, &account_id, &name, &local, device_name.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(label: &str, path: &str) -> SyncPathResult {
        SyncPathResult {
            path: path.to_string(),
            is_public: false,
            label: label.to_string(),
            is_paused: false,
        }
    }

    fn remote(label: &str, hash: &str) -> RemoteFolderInfo {
        serde_json::from_value(serde_json::json!({
            "label": label,
            "folder_hash": hash,
            "file_count": 0,
            "total_bytes": 0,
            "created_at": 0,
            "updated_at": 0,
            "device_name": "Laptop",
        }))
        .expect("a listing row")
    }

    fn message(err: AppError) -> String {
        match err {
            AppError::Validation(m) | AppError::Other(m) => m,
            other => panic!("expected a sentence for the dialog, got {other:?}"),
        }
    }

    #[test]
    fn a_name_is_trimmed_and_otherwise_kept_byte_for_byte() {
        assert_eq!(validate_drive_name("  Team projects ").expect("valid"), "Team projects");
        // Decomposed e + combining acute stays decomposed: every client
        // hashes the label as typed.
        let decomposed = "Caf\u{65}\u{301}";
        assert_eq!(validate_drive_name(decomposed).expect("valid"), decomposed);
    }

    #[test]
    fn the_folder_hash_is_the_one_every_client_derives() {
        // SHA256("Team projects")[..16], the rule the console and mobile
        // mirror. A change here forks the drive's namespace across clients.
        assert_eq!(folder_hash("Team projects"), "6100ffb58a6945c5");
        assert_eq!(folder_hash("Team projects").len(), 16);
    }

    #[test]
    fn names_the_console_refuses_are_refused_with_its_reasons() {
        assert_eq!(message(validate_drive_name("   ").unwrap_err()), NAME_REQUIRED);
        assert_eq!(message(validate_drive_name(&"a".repeat(101)).unwrap_err()), NAME_TOO_LONG);
        assert!(validate_drive_name(&"a".repeat(100)).is_ok());
        for bad in ["a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "a\u{7}b"] {
            assert_eq!(message(validate_drive_name(bad).unwrap_err()), NAME_BAD_CHARS, "{bad:?}");
        }
        assert_eq!(message(validate_drive_name("..").unwrap_err()), NAME_RESERVED);
        assert_eq!(message(validate_drive_name(".").unwrap_err()), NAME_RESERVED);
    }

    #[test]
    fn a_name_that_could_never_be_synced_to_a_folder_is_refused() {
        // `sanitize_label` would turn these into an empty folder name, so
        // "Sync to this computer" could never bind the drive.
        assert_eq!(message(validate_drive_name("###").unwrap_err()), NAME_NEEDS_LETTER);
        assert_eq!(message(validate_drive_name("@@ ##").unwrap_err()), NAME_NEEDS_LETTER);
        assert!(validate_drive_name("Équipe 2").is_ok(), "letters in any script are fine");
    }

    #[test]
    fn a_name_already_used_by_any_drive_is_taken() {
        let local_rows = [local("tags-2", "/Users/a/halo2/tags"), local("default", "/Users/a/Hippius")];
        let remote_rows = [remote("Design", "00000000000000aa")];
        let existing = ExistingDrives::new(&local_rows, &remote_rows);

        // A server drive, by its label, in any case.
        assert!(existing.refuse_taken("Design").is_err());
        assert!(existing.refuse_taken("design").is_err());
        // A local drive by its label, and by the folder name it is shown as.
        assert!(existing.refuse_taken("tags-2").is_err());
        assert!(existing.refuse_taken("tags").is_err());
        assert!(existing.refuse_taken("default").is_err());
        assert!(existing.refuse_taken("Hippius").is_err());
        // A new name is free.
        assert!(existing.refuse_taken("Launch").is_ok());

        let err = message(existing.refuse_taken("Design").unwrap_err());
        assert_eq!(err, "You already have a drive called \u{201c}Design\u{201d}. Choose another name.");
    }

    #[test]
    fn a_name_whose_hash_is_already_a_drive_is_taken_whatever_its_shown_label() {
        // A server row registered under another display label but this
        // name's hash: registering would relabel it.
        let remote_rows = [remote("Shown otherwise", &folder_hash("Launch"))];
        let existing = ExistingDrives::new(&[], &remote_rows);
        assert!(existing.refuse_taken("Launch").is_err());
    }

    #[test]
    fn names_compare_after_nfc() {
        let remote_rows = [remote("Caf\u{e9}", "00000000000000bb")];
        let existing = ExistingDrives::new(&[], &remote_rows);
        assert!(existing.refuse_taken("Caf\u{65}\u{301}").is_err());
    }

    #[test]
    fn refusals_are_worded_from_the_status_and_slug() {
        let http = |status: u16, code: Option<&str>| SyncError::Http {
            status,
            code: code.map(str::to_string),
            message: "server words".into(),
        };
        assert_eq!(message(create_failure(&SyncError::Network("connection refused".into()))), OFFLINE);
        assert_eq!(message(create_failure(&SyncError::RateLimited { retry_after_secs: 3 })), BUSY);
        assert_eq!(message(create_failure(&http(429, None))), BUSY);
        assert_eq!(message(create_failure(&http(401, Some("unauthorized")))), SESSION_EXPIRED);
        assert_eq!(message(create_failure(&http(402, None))), PLAN_REFUSED);
        assert_eq!(message(create_failure(&http(403, Some("account_read_only")))), READ_ONLY);
        assert_eq!(message(create_failure(&http(403, Some("account_suspended")))), SUSPENDED);
        assert_eq!(message(create_failure(&http(403, Some("forbidden")))), CREATE_FAILED);
        assert_eq!(message(create_failure(&http(500, Some("internal_error")))), CREATE_FAILED);
        // The server's own English never reaches the dialog.
        assert!(!message(create_failure(&http(500, None))).contains("server words"));
    }

    /// What the stand-in server saw.
    #[derive(Default)]
    struct Seen {
        registered: std::sync::Mutex<Vec<serde_json::Value>>,
    }

    /// A stand-in hcfs server: `/list_folders` answers with `listing` (or
    /// `list_status` with an error body), and `/register_folder` records the
    /// request and answers `register_status`.
    async fn serve(
        listing: Vec<RemoteFolderInfo>,
        list_status: u16,
        register_status: u16,
    ) -> (String, std::sync::Arc<Seen>, tokio::task::JoinHandle<()>) {
        use axum::http::StatusCode;
        use axum::response::IntoResponse;
        use axum::routing::{get, post};
        use axum::{Json, Router};
        use serde_json::json;

        let seen = std::sync::Arc::new(Seen::default());
        let record = std::sync::Arc::clone(&seen);
        let folders = serde_json::to_value(&listing).expect("listing json");
        let router = Router::new()
            .route(
                "/list_folders/{base}",
                get(move || {
                    let folders = folders.clone();
                    async move {
                        if list_status == 200 {
                            return Json(json!({ "Success": { "base_address": "5Owner", "folders": folders } })).into_response();
                        }
                        let status = StatusCode::from_u16(list_status).expect("status");
                        (status, Json(json!({ "error": "account_read_only", "message": "read only" }))).into_response()
                    }
                }),
            )
            .route(
                "/register_folder",
                post(move |Json(body): Json<serde_json::Value>| {
                    record.registered.lock().expect("lock").push(body);
                    async move {
                        if register_status == 200 {
                            return Json(json!({ "Success": { "status": "registered" } })).into_response();
                        }
                        let status = StatusCode::from_u16(register_status).expect("status");
                        (status, Json(json!({ "error": "account_read_only", "message": "read only" }))).into_response()
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("serve");
        });
        (format!("http://{addr}"), seen, server)
    }

    fn client_for(base: &str) -> hcfs_client::client::HcfsClient {
        let config = crate::sync::drive::config::build_hcfs_config(base, "bearer", &DriveIdentity::own("5Owner", ""));
        hcfs_client::client::HcfsClient::new(config).expect("client")
    }

    #[tokio::test]
    async fn a_new_name_registers_one_drive_under_its_own_hash_and_label() {
        let (base, seen, server) = serve(vec![remote("Design", "00000000000000aa")], 200, 200).await;
        let created = create_cloud_drive_with(&client_for(&base), "5Owner", "  Launch ", &[], Some("Studio Mac"))
            .await
            .expect("created");

        assert_eq!(
            created,
            CreatedCloudDrive {
                label: "Launch".into(),
                folder_hash: folder_hash("Launch"),
            }
        );
        let registered = seen.registered.lock().expect("lock").clone();
        assert_eq!(registered.len(), 1, "exactly one register");
        assert_eq!(registered[0]["ss58_address"], "5Owner");
        assert_eq!(registered[0]["folder_hash"], folder_hash("Launch"));
        assert_eq!(registered[0]["label"], "Launch");
        assert_eq!(registered[0]["device_name"], "Studio Mac");
        server.abort();
    }

    #[tokio::test]
    async fn a_name_already_on_the_server_registers_nothing() {
        let (base, seen, server) = serve(vec![remote("Launch", &folder_hash("Launch"))], 200, 200).await;
        let err = create_cloud_drive_with(&client_for(&base), "5Owner", "launch", &[], None)
            .await
            .expect_err("taken");
        assert!(message(err).starts_with("You already have a drive called"));
        assert!(
            seen.registered.lock().expect("lock").is_empty(),
            "the upsert must never be sent for a taken name"
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_listing_that_cannot_be_read_stops_the_create() {
        let (base, seen, server) = serve(vec![], 403, 200).await;
        let err = create_cloud_drive_with(&client_for(&base), "5Owner", "Launch", &[], None)
            .await
            .expect_err("no listing, no create");
        assert_eq!(message(err), READ_ONLY);
        assert!(seen.registered.lock().expect("lock").is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn a_refused_register_is_worded_for_the_dialog() {
        let (base, _seen, server) = serve(vec![], 200, 403).await;
        let err = create_cloud_drive_with(&client_for(&base), "5Owner", "Launch", &[], None)
            .await
            .expect_err("refused");
        assert_eq!(message(err), READ_ONLY);
        server.abort();
    }

    #[tokio::test]
    async fn an_unreachable_server_says_so() {
        // Bind and drop, so the port refuses connections.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        drop(listener);
        let err = create_cloud_drive_with(&client_for(&base), "5Owner", "Launch", &[], None)
            .await
            .expect_err("offline");
        assert_eq!(message(err), OFFLINE);
    }

    #[tokio::test]
    async fn a_bad_name_never_reaches_the_server() {
        let (base, seen, server) = serve(vec![], 200, 200).await;
        let err = create_cloud_drive_with(&client_for(&base), "5Owner", "a/b", &[], None)
            .await
            .expect_err("bad name");
        assert_eq!(message(err), NAME_BAD_CHARS);
        assert!(seen.registered.lock().expect("lock").is_empty());
        server.abort();
    }
}
