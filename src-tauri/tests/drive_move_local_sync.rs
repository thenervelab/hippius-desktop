//! A move between drives brings a SYNCED drive's folder in line with the
//! server without a second transfer, and the pinned sync engine agrees.
//!
//! After the commit, `drive_move::local::place_after_commit` puts the copy's
//! plaintext at its new path in the destination folder and removes the
//! source file. These tests run the pinned hcfs code
//! (`DriveManager::sync_with_resolutions`) against a stand-in server that
//! lists what the commit left, and assert the next cycle transfers nothing,
//! deletes nothing on the server, holds nothing, and records the moved file
//! as synced at the server's revision. A control shows the same cycle
//! WITHOUT the placement downloads the file, so the stand-in can see a
//! transfer when there is one.
//!
//! If an hcfs bump changes how the planner pairs "both created with the same
//! content" or "both deleted", these fail before a move starts costing users
//! a download per file or re-uploading the old copy into the source drive.

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::routing::{get, post};
use hcfs_client::client::HcfsClientConfig;
use hcfs_client::engine::manager::DriveManager;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri_project_lib::sync::drive_move::copy::seal;
use tauri_project_lib::sync::drive_move::local::{FileStamp, LocalFile, place_after_commit};

const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
    abandon abandon abandon abandon abandon art";
const PASSWORD: &str = "test-password";
/// The drive's owner, as the engine salts content hashes with it.
const OWNER: &str = "test_user";
const FOLDER_HASH: &str = "abcdef0123456789";
const STORED_REVISION: [u8; 32] = [42; 32];
/// The revision the move's commit gave the copy.
const COPY_REVISION: [u8; 32] = [77; 32];

#[derive(Clone, Default)]
struct Server {
    listing: Arc<Mutex<Vec<serde_json::Value>>>,
    uploads: Arc<Mutex<usize>>,
    /// Every request other than the listing and the first sync's uploads:
    /// downloads, deletes, renames.
    other: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn serve(&self, rows: Vec<serde_json::Value>) {
        *self.listing.lock().unwrap() = rows;
    }
    fn uploads(&self) -> usize {
        *self.uploads.lock().unwrap()
    }
    fn transfers(&self) -> Vec<String> {
        self.other
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.contains("download") || p.contains("delete") || p.contains("chunk") || p.contains("rename") || p.contains("file"))
            .cloned()
            .collect()
    }
}

async fn get_state(State(server): State<Server>) -> axum::Json<serde_json::Value> {
    let files = server.listing.lock().unwrap().clone();
    let total = files.len();
    axum::Json(serde_json::json!({
        "Success": {
            "ss58_address": OWNER,
            "folder_hash": FOLDER_HASH,
            "files": files,
            "total_count": total,
            "has_more": false,
            "offset": 0,
            "limit": 1000
        }
    }))
}

async fn upload(State(server): State<Server>) -> axum::Json<serde_json::Value> {
    *server.uploads.lock().unwrap() += 1;
    axum::Json(serde_json::json!({
        "Success": {
            "upload_id": "upload-1",
            "bytes_accepted": 1,
            "timestamp": 1_234_567_890,
            "revision_id": STORED_REVISION.to_vec(),
            "created_at": 1_700_000_000,
            "updated_at": 1_700_000_000,
        }
    }))
}

async fn anything_else(State(server): State<Server>, uri: Uri) -> StatusCode {
    server.other.lock().unwrap().push(uri.path().to_string());
    StatusCode::INTERNAL_SERVER_ERROR
}

async fn start(server: Server) -> String {
    let app = Router::new()
        .route("/get_state/{*rest}", get(get_state))
        .route("/upload", post(upload))
        .fallback(anything_else)
        .with_state(server);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn config(base_url: String) -> HcfsClientConfig {
    HcfsClientConfig {
        base_url,
        bearer_token: "test-token".into(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: OWNER.into(),
        folder_hash: FOLDER_HASH.into(),
        shared_drive_member: false,
        read_timeout_ms: None,
    }
}

/// The drive's file key, as `Drive::unlock` derives it from the phrase.
fn drive_key() -> hcfs_crypto::FileKey {
    use std::str::FromStr;
    let seed = bip39::Mnemonic::from_str(MNEMONIC).unwrap().to_seed("");
    let mut key = [0u8; 32];
    key.copy_from_slice(&seed[..32]);
    hcfs_crypto::FileKey::from_bytes(key)
}

/// A server row for `path` holding `content`, as a commit leaves it.
fn row(path: &str, salted_hash: [u8; 32], size: u64, revision: [u8; 32]) -> serde_json::Value {
    serde_json::json!({
        "path_hash": hcfs_crypto::compute_path_hash(path).to_vec(),
        "salted_hash": salted_hash.to_vec(),
        "size_bytes": size,
        "revision_seq": 1,
        "revision_id": revision.to_vec(),
        "encrypted_path": hcfs_crypto::encrypt_small(path.as_bytes(), &drive_key()).unwrap(),
        "file_name": path.rsplit('/').next().unwrap(),
        "relative_path": path,
    })
}

async fn drive(root: &std::path::Path, config_dir: &std::path::Path, server: &Server) -> DriveManager {
    let base_url = start(server.clone()).await;
    let mut manager = DriveManager::new(root.to_path_buf(), config_dir.to_path_buf());
    manager.init(PASSWORD, Some(MNEMONIC)).await.expect("init");
    manager.unlock(PASSWORD).expect("unlock");
    manager.set_config(config(base_url)).expect("config");
    manager
}

/// The copy's hashes, from the same one-read seal the move uses.
fn sealed(plaintext: &std::path::Path) -> ([u8; 32], u64) {
    let scratch = tempfile::tempdir().unwrap();
    let s = seal(plaintext, &scratch.path().join("c"), &drive_key(), OWNER, OWNER).unwrap();
    (s.dest_salted, s.size)
}

/// Destination synced here, source not: the downloaded plaintext is put in
/// place, and the engine's next cycle downloads nothing and records the file
/// as synced at the commit's revision.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_placed_copy_is_already_synced_in_the_destination() {
    let root = tempfile::tempdir().unwrap();
    let config_dir = tempfile::tempdir().unwrap();
    let server = Server::default();
    let mut manager = drive(root.path(), config_dir.path(), &server).await;
    manager.sync_with_resolutions(HashMap::new()).await.expect("first sync of an empty drive");

    let scratch = tempfile::tempdir().unwrap();
    let downloaded = scratch.path().join("plain");
    std::fs::write(&downloaded, "moved from another drive").unwrap();
    let (salted, size) = sealed(&downloaded);

    // The commit landed: the server lists the copy in the destination.
    server.serve(vec![row("In/a.txt", salted, size, COPY_REVISION)]);
    let report = place_after_commit(
        None,
        Some(root.path()),
        &[LocalFile {
            source: None,
            downloaded: Some(downloaded),
            dest_rel: "In/a.txt".into(),
        }],
        &[],
    );
    assert_eq!(report.placed, 1);

    let outcome = manager.sync_with_resolutions(HashMap::new()).await.expect("the next cycle");
    assert_eq!(outcome.files_downloaded, 0, "{outcome:?}");
    assert_eq!(outcome.files_uploaded, 0, "{outcome:?}");
    assert!(server.transfers().is_empty(), "no transfer: {:?}", server.transfers());
    assert_eq!(server.uploads(), 0);

    let state = manager.load_sync_state().await.unwrap();
    let id = hcfs_crypto::compute_path_hash("In/a.txt");
    let base = state.synced.files.get(&id).expect("the moved file is synced");
    assert_eq!(base.revision_id, COPY_REVISION, "the merge base is the server's revision");
}

/// The control: the same commit without the placement is a download, so the
/// stand-in above would have seen one.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_the_placement_the_destination_downloads_the_copy() {
    let root = tempfile::tempdir().unwrap();
    let config_dir = tempfile::tempdir().unwrap();
    let server = Server::default();
    let mut manager = drive(root.path(), config_dir.path(), &server).await;
    manager.sync_with_resolutions(HashMap::new()).await.expect("first sync of an empty drive");

    let scratch = tempfile::tempdir().unwrap();
    let plain = scratch.path().join("plain");
    std::fs::write(&plain, "moved from another drive").unwrap();
    let (salted, size) = sealed(&plain);
    server.serve(vec![row("In/a.txt", salted, size, COPY_REVISION)]);

    let _ = manager.sync_with_resolutions(HashMap::new()).await;
    assert!(!server.transfers().is_empty(), "the engine asked for the file");
}

/// Source synced here, destination not: the moved file is removed locally,
/// and the engine's next cycle neither deletes anything on the server nor
/// uploads the old copy back into the source drive.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_removed_source_is_settled_in_the_source_drive() {
    let root = tempfile::tempdir().unwrap();
    let config_dir = tempfile::tempdir().unwrap();
    let server = Server::default();
    std::fs::create_dir_all(root.path().join("F")).unwrap();
    std::fs::write(root.path().join("F/a.txt"), "goes").unwrap();
    std::fs::write(root.path().join("keep.txt"), "stays").unwrap();
    let mut manager = drive(root.path(), config_dir.path(), &server).await;
    manager.sync_with_resolutions(HashMap::new()).await.expect("first sync uploads both");
    assert_eq!(server.uploads(), 2);

    let state = manager.load_sync_state().await.unwrap();
    let base = |path: &str| state.synced.files.get(&hcfs_crypto::compute_path_hash(path)).expect("synced").clone();
    let keep = base("keep.txt");
    // The commit landed: only keep.txt is left on the server.
    server.serve(vec![row("keep.txt", *keep.salted_hash.as_bytes(), keep.size_bytes, keep.revision_id)]);

    let stamp = FileStamp::of(&root.path().join("F/a.txt")).unwrap();
    let report = place_after_commit(
        Some(root.path()),
        None,
        &[LocalFile {
            source: Some(("F/a.txt".into(), stamp)),
            downloaded: None,
            dest_rel: "a.txt".into(),
        }],
        &["F".into()],
    );
    assert_eq!(report.removed, 1);
    assert!(!root.path().join("F").exists());

    let uploads = server.uploads();
    let outcome = manager.sync_with_resolutions(HashMap::new()).await.expect("the next cycle");
    assert_eq!(server.uploads(), uploads, "the old copy is never uploaded back");
    assert_eq!(outcome.files_deleted_remotely, 0, "{outcome:?}");
    assert_eq!(outcome.files_deleted_locally, 0, "{outcome:?}");
    assert!(outcome.mass_deletes_held.is_empty(), "{outcome:?}");
    assert!(server.transfers().is_empty(), "{:?}", server.transfers());
    let state = manager.load_sync_state().await.unwrap();
    assert!(
        !state.synced.files.contains_key(&hcfs_crypto::compute_path_hash("F/a.txt")),
        "the merge base forgets the moved file"
    );
    assert!(root.path().join("keep.txt").exists());
}

/// Both drives synced here: the source file itself is moved across, and
/// neither engine transfers anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn synced_to_synced_moves_the_file_and_neither_engine_transfers() {
    let src_root = tempfile::tempdir().unwrap();
    let src_config = tempfile::tempdir().unwrap();
    let dst_root = tempfile::tempdir().unwrap();
    let dst_config = tempfile::tempdir().unwrap();
    let src_server = Server::default();
    let dst_server = Server::default();
    std::fs::write(src_root.path().join("a.txt"), "the file").unwrap();
    std::fs::write(src_root.path().join("b.txt"), "another").unwrap();
    let mut src = drive(src_root.path(), src_config.path(), &src_server).await;
    let mut dst = drive(dst_root.path(), dst_config.path(), &dst_server).await;
    src.sync_with_resolutions(HashMap::new()).await.expect("source first sync");
    dst.sync_with_resolutions(HashMap::new()).await.expect("destination first sync");

    let state = src.load_sync_state().await.unwrap();
    let b = state.synced.files.get(&hcfs_crypto::compute_path_hash("b.txt")).unwrap().clone();
    let a_path = src_root.path().join("a.txt");
    let stamp = FileStamp::of(&a_path).unwrap();
    let (salted, size) = sealed(&a_path);

    src_server.serve(vec![row("b.txt", *b.salted_hash.as_bytes(), b.size_bytes, b.revision_id)]);
    dst_server.serve(vec![row("Moved/a.txt", salted, size, COPY_REVISION)]);
    let report = place_after_commit(
        Some(src_root.path()),
        Some(dst_root.path()),
        &[LocalFile {
            source: Some(("a.txt".into(), stamp)),
            downloaded: None,
            dest_rel: "Moved/a.txt".into(),
        }],
        &[],
    );
    assert_eq!((report.placed, report.removed), (1, 1));

    let (src_up, dst_up) = (src_server.uploads(), dst_server.uploads());
    let s = src.sync_with_resolutions(HashMap::new()).await.expect("source cycle");
    let d = dst.sync_with_resolutions(HashMap::new()).await.expect("destination cycle");
    assert_eq!((s.files_uploaded, s.files_deleted_remotely, s.files_deleted_locally), (0, 0, 0), "{s:?}");
    assert_eq!((d.files_uploaded, d.files_downloaded), (0, 0), "{d:?}");
    assert_eq!((src_server.uploads(), dst_server.uploads()), (src_up, dst_up));
    assert!(src_server.transfers().is_empty() && dst_server.transfers().is_empty());
    assert_eq!(std::fs::read_to_string(dst_root.path().join("Moved/a.txt")).unwrap(), "the file");
}
