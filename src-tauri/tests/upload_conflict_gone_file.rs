//! An upload conflict that names no current revision (all zeros) is never
//! answered: not by "keep my version" and not by the automatic skip.
//!
//! hcfs-server sends that conflict when the file an upload session would
//! overwrite was moved (a folder rename) or deleted while the session was
//! being opened. Before hcfs#667, hcfs-client took the zero id as a real
//! revision. "keep_local" resent the file with it as the base, which the
//! server took as a new file at the old path. Skip saved it as the file's
//! base, so every later cycle sent it. The server now refuses a zero base
//! where no row is stored (`409 target_gone`), and hcfs-client leaves such a
//! conflict for the next sync and keeps the last synced base.
//!
//! These tests run the pinned hcfs code through
//! `DriveManager::sync_with_resolutions` (the call the desktop's reviewed
//! sync makes; an empty map is the automatic skip) against a stand-in
//! server, so an hcfs bump that brings either behaviour back fails here. The
//! stand-in answers `POST /upload` with the conflict, which the real server
//! sends only from `POST /upload/session`; hcfs-client turns both into the
//! same conflict, so the code under test is the same.

use axum::Router;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::engine::manager::DriveManager;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// A fixed mnemonic, so the drive is created without generating one.
const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon art";

const PASSWORD: &str = "test-password";

/// The revision the stand-in assigns to every accepted upload.
const STORED_REVISION: [u8; 32] = [42; 32];

/// What the stand-in serves and what it received.
#[derive(Clone, Default)]
struct Server {
    /// The `get_state` rows served.
    listing: Arc<Mutex<Vec<serde_json::Value>>>,
    /// The body of every upload request received, accepted or not.
    uploads: Arc<Mutex<Vec<Vec<u8>>>>,
    /// The `current_revision_id` of the 409 every upload gets once set;
    /// `None` accepts uploads.
    conflict_revision: Arc<Mutex<Option<[u8; 32]>>>,
}

impl Server {
    fn uploads(&self) -> usize {
        self.uploads.lock().expect("uploads lock").len()
    }

    /// Whether the last upload's manifest carried `revision` as its base.
    fn last_upload_based_on(&self, revision: [u8; 32]) -> bool {
        let uploads = self.uploads.lock().expect("uploads lock");
        let last = uploads.last().expect("an upload was sent");
        let digits: Vec<String> = revision.iter().map(u8::to_string).collect();
        let needle = format!("\"base_revision_id\":[{}]", digits.join(","));
        String::from_utf8_lossy(last).contains(&needle)
    }

    fn serve(&self, rows: Vec<serde_json::Value>) {
        *self.listing.lock().expect("listing lock") = rows;
    }

    fn conflict_with(&self, revision: [u8; 32]) {
        *self.conflict_revision.lock().expect("conflict lock") = Some(revision);
    }

    fn accept_uploads(&self) {
        *self.conflict_revision.lock().expect("conflict lock") = None;
    }
}

/// One complete `get_state` page listing every served row.
async fn get_state(State(server): State<Server>) -> axum::Json<serde_json::Value> {
    let files = server.listing.lock().expect("listing lock").clone();
    let total = files.len();
    axum::Json(serde_json::json!({
        "Success": {
            "ss58_address": "test_user",
            "folder_hash": "abcdef0123456789",
            "files": files,
            "total_count": total,
            "has_more": false,
            "offset": 0,
            "limit": 1000
        }
    }))
}

/// Accept an upload, or answer the configured conflict.
async fn upload(State(server): State<Server>, body: axum::body::Bytes) -> (StatusCode, axum::Json<serde_json::Value>) {
    server.uploads.lock().expect("uploads lock").push(body.to_vec());
    let conflict = *server.conflict_revision.lock().expect("conflict lock");
    if let Some(revision) = conflict {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "Conflict": {
                    "error": "conflict",
                    "message": "The file was moved or deleted",
                    "current_revision_id": revision.to_vec(),
                    "current_revision_seq": 0
                }
            })),
        );
    }
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({
            "Success": {
                "upload_id": "upload-1",
                "bytes_accepted": 100,
                "timestamp": 1_234_567_890,
                "revision_id": STORED_REVISION.to_vec(),
                "created_at": 1_700_000_000,
                "updated_at": 1_700_000_000,
            }
        })),
    )
}

/// Start the stand-in on a free local port; returns its base URL.
async fn start(server: Server) -> String {
    let app = Router::new()
        .route("/get_state/{*rest}", get(get_state))
        .route("/upload", post(upload))
        .with_state(server);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    format!("http://{addr}")
}

fn config(base_url: String) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url,
        bearer_token: "test-token".to_string(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: "test_user".to_string(),
        folder_hash: "abcdef0123456789".to_string(),
        shared_drive_member: false,
        read_timeout_ms: None,
    }
}

/// A drive holding one synced file, the server listing it, and that file's
/// id in the hex form the reviewed sync's resolutions are keyed by.
async fn drive_with_one_synced_file(root: &std::path::Path, config_dir: &std::path::Path, server: &Server) -> (DriveManager, String) {
    std::fs::write(root.join("a.txt"), "first").expect("write file");
    let base_url = start(server.clone()).await;

    let mut manager = DriveManager::new(root.to_path_buf(), config_dir.to_path_buf());
    manager.init(PASSWORD, Some(MNEMONIC)).await.expect("init");
    manager.unlock(PASSWORD).expect("unlock");
    manager.set_config(config(base_url)).expect("config");
    manager.sync_with_resolutions(HashMap::new()).await.expect("first sync");

    let state = manager.load_sync_state().await.expect("state");
    let [(id, meta)] = state.synced.files.iter().collect::<Vec<_>>()[..] else {
        panic!("one synced file: {:?}", state.synced.files.keys());
    };
    assert_eq!(meta.revision_id, STORED_REVISION);
    server.serve(vec![serde_json::json!({
        "path_hash": id.to_vec(),
        "salted_hash": meta.salted_hash.to_vec(),
        "size_bytes": meta.size_bytes,
        "revision_seq": meta.revision_seq,
        "revision_id": meta.revision_id.to_vec(),
        "encrypted_path": Vec::<u8>::new(),
        "file_name": "a.txt",
    })]);
    (manager, hex::encode(id))
}

/// The user chose "keep my version" for the file, and the server answers
/// its upload with the conflict that names no current revision. Nothing is
/// resent, and the file keeps its last synced revision as its base.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keep_local_does_not_resend_a_file_the_server_no_longer_has() {
    let root = tempfile::tempdir().expect("root");
    let config_dir = tempfile::tempdir().expect("config");
    let server = Server::default();
    let (mut manager, file_id) = drive_with_one_synced_file(root.path(), config_dir.path(), &server).await;

    std::fs::write(root.path().join("a.txt"), "edited while the folder moved").expect("edit file");
    server.conflict_with([0; 32]);
    let before = server.uploads();

    let resolutions = HashMap::from([(file_id, "keep_local".to_string())]);
    let outcome = manager.sync_with_resolutions(resolutions).await.expect("the cycle completes");

    assert_eq!(
        server.uploads() - before,
        1,
        "one upload, refused; keeping the local copy must not resend it with the zero revision"
    );
    assert_eq!(outcome.files_uploaded, 0, "{outcome:?}");
    assert_eq!(outcome.conflicts_skipped, 1, "{outcome:?}");
    let state = manager.load_sync_state().await.expect("state");
    let synced = state.synced.files.values().next().expect("baseline kept");
    assert_eq!(synced.revision_id, STORED_REVISION, "the zero revision never becomes the base");
}

/// With no answer for the file (the automatic skip the engine uses), the
/// conflict is skipped and the next upload of the file is based on the
/// revision last synced, never on the zero id. Before hcfs#667 the skip
/// saved the zero id as the base, so every later cycle sent it, and the
/// server now refuses that base for good (`409 target_gone`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_skipped_gone_conflict_keeps_the_synced_base_for_the_next_upload() {
    let root = tempfile::tempdir().expect("root");
    let config_dir = tempfile::tempdir().expect("config");
    let server = Server::default();
    let (mut manager, _) = drive_with_one_synced_file(root.path(), config_dir.path(), &server).await;

    std::fs::write(root.path().join("a.txt"), "edited while the folder moved").expect("edit file");
    server.conflict_with([0; 32]);
    let skipped = manager.sync_with_resolutions(HashMap::new()).await.expect("the cycle completes");
    assert_eq!(skipped.conflicts_skipped, 1, "{skipped:?}");
    assert!(
        server.last_upload_based_on(STORED_REVISION),
        "the refused upload was based on the synced revision"
    );

    server.accept_uploads();
    let before = server.uploads();
    manager.sync_with_resolutions(HashMap::new()).await.expect("the next cycle uploads");

    assert_eq!(server.uploads() - before, 1, "the edit is uploaded on the next cycle");
    assert!(
        server.last_upload_based_on(STORED_REVISION),
        "the next upload is based on the synced revision"
    );
    assert!(!server.last_upload_based_on([0; 32]), "the next upload is never based on the zero id");
}

/// The same answer to an ordinary conflict, where the server names the
/// revision it holds, still uploads the local copy over it. Without this
/// the test above would also pass if "keep my version" stopped working.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keep_local_still_resends_over_a_named_revision() {
    let root = tempfile::tempdir().expect("root");
    let config_dir = tempfile::tempdir().expect("config");
    let server = Server::default();
    let (mut manager, file_id) = drive_with_one_synced_file(root.path(), config_dir.path(), &server).await;

    std::fs::write(root.path().join("a.txt"), "edited on this computer").expect("edit file");
    server.conflict_with([7; 32]);
    let before = server.uploads();

    let resolutions = HashMap::from([(file_id, "keep_local".to_string())]);
    // The resend gets the same 409; whether the cycle reports it is not the
    // point, only that the local copy was sent again.
    let _ = manager.sync_with_resolutions(resolutions).await;

    assert!(
        server.uploads() - before >= 2,
        "keep_local resends over a named revision (got {} upload(s))",
        server.uploads() - before
    );
}
