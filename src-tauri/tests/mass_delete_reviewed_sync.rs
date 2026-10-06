//! The reviewed-conflict sync applies a requested restore and reports a
//! hold exactly as an engine cycle does.
//!
//! `sync_with_conflict_resolutions` runs `DriveManager::sync_with_resolutions`
//! (hcfs's `Drive::sync_with_resolver`), not the engine's cycle, and reads
//! the hold and restore results off its `SyncOutcome` itself. That is only
//! right if the reviewed entry point goes through the same cycle body as
//! the engine's (`sync_with_resolver_inner`: read the markers, begin the
//! restores, report holds). These tests run the pinned hcfs code against a
//! stand-in server, so an hcfs bump that splits the two paths fails here.
//!
//! The local side is used because restoring it uploads, which the stand-in
//! accepts without needing encrypted content to serve.

use axum::Router;
use axum::extract::State;
use axum::routing::{get, post};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::sync::{MassDeleteHold, MassDeleteSide};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// A fixed mnemonic, so the drive is created without generating one.
const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon art";

const PASSWORD: &str = "test-password";

/// What the stand-in server lists and how many uploads it accepted.
#[derive(Clone, Default)]
struct Server {
    /// The `get_state` rows served.
    listing: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Upload requests received.
    uploads: Arc<AtomicUsize>,
}

impl Server {
    fn uploads(&self) -> usize {
        self.uploads.load(Ordering::SeqCst)
    }

    fn serve(&self, rows: Vec<serde_json::Value>) {
        *self.listing.lock().expect("listing lock") = rows;
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

/// Accept any upload, as hcfs's own guard tests do.
async fn upload(State(server): State<Server>, _body: axum::body::Bytes) -> axum::Json<serde_json::Value> {
    server.uploads.fetch_add(1, Ordering::SeqCst);
    axum::Json(serde_json::json!({
        "Success": {
            "upload_id": "upload-1",
            "bytes_accepted": 100,
            "timestamp": 1_234_567_890,
            "revision_id": vec![42u8; 32],
            "created_at": 1_700_000_000,
            "updated_at": 1_700_000_000,
        }
    }))
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

/// A drive whose `count` files the first reviewed sync uploaded, and the
/// server's rows for them.
async fn synced_drive(root: &std::path::Path, config_dir: &std::path::Path, server: &Server, count: usize) -> (DriveManager, Vec<serde_json::Value>) {
    for n in 0..count {
        std::fs::write(root.join(format!("f{n}.txt")), format!("content {n}")).expect("write file");
    }
    let base_url = start(server.clone()).await;

    let mut manager = DriveManager::new(root.to_path_buf(), config_dir.to_path_buf());
    manager.init(PASSWORD, Some(MNEMONIC)).await.expect("init");
    manager.unlock(PASSWORD).expect("unlock");
    manager.set_config(config(base_url)).expect("config");
    manager.sync_with_resolutions(HashMap::new()).await.expect("first sync");

    let state = manager.load_sync_state().await.expect("state");
    assert_eq!(state.synced.files.len(), count);
    let rows = state
        .synced
        .files
        .iter()
        .map(|(id, meta)| {
            serde_json::json!({
                "path_hash": id.to_vec(),
                "salted_hash": meta.salted_hash.to_vec(),
                "size_bytes": meta.size_bytes,
                "revision_seq": meta.revision_seq,
                "revision_id": meta.revision_id.to_vec(),
                "encrypted_path": Vec::<u8>::new(),
                "file_name": state.path_index[id].display().to_string(),
            })
        })
        .collect();
    (manager, rows)
}

/// A listing that lost most of the drive is held by a reviewed sync, and a
/// restore requested the way `restore_mass_delete` does (a marker) is
/// applied by the next reviewed sync, which uploads the files back.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reviewed_sync_holds_and_restores_like_an_engine_cycle() {
    let root = tempfile::tempdir().expect("root");
    let config_dir = tempfile::tempdir().expect("config");
    let server = Server::default();
    let (mut manager, rows) = synced_drive(root.path(), config_dir.path(), &server, 120).await;
    server.serve(rows.into_iter().take(5).collect());

    let held = manager.sync_with_resolutions(HashMap::new()).await.expect("held, not failed");
    assert_eq!(
        held.mass_deletes_held,
        vec![MassDeleteHold {
            side: MassDeleteSide::Local,
            count: 115,
            synced_count: 120,
        }],
        "the reviewed sync reports the hold on its outcome"
    );
    assert_eq!(held.files_deleted_locally, 0);

    manager.restore_mass_delete(MassDeleteSide::Local, 115).expect("restore requested");
    let uploads_before = server.uploads();
    let restored = manager.sync_with_resolutions(HashMap::new()).await.expect("restore cycle");

    let [restore] = restored.mass_delete_restores.as_slice() else {
        panic!("one restore reported: {restored:?}");
    };
    assert_eq!(restore.side, MassDeleteSide::Local);
    assert_eq!(restore.refused, None);
    assert_eq!(restore.restored + restore.pending, 115, "{restore:?}");
    assert!(restored.mass_deletes_held.is_empty(), "the restore withdrew the hold: {restored:?}");
    assert_eq!(server.uploads() - uploads_before, 115, "the held files were uploaded back");
}
