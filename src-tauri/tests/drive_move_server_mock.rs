//! A move between drives against a stand-in for hcfs-server's
//! `/v1/drive_moves` routes and the upload-session routes its copies use.
//!
//! Drives the REAL staging and commit code (`drive_move::stage_all`,
//! `drive_move::commit_staged`) with no Tauri runtime: open, a session per
//! copy whose chunks reassemble into the destination's ciphertext of the
//! source bytes, finalize, commit; abort on a refusal and on cancel; a
//! commit with no answer is never aborted, since it may have landed.

use axum::Router;
use axum::extract::{Path as AxPath, State};
use axum::http::StatusCode;
use axum::routing::{post, put};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri_project_lib::sync::drive_move::api::MoveApi;
use tauri_project_lib::sync::drive_move::plan::{PlannedCopy, RemoteEntryKey};
use tauri_project_lib::sync::drive_move::wire::MoveFolder;
use tauri_project_lib::sync::drive_move::{CopyEvent, CopyJob, MoveFailure, Plaintext, Staging, commit_staged, stage_all};
use tauri_project_lib::sync::identity::DriveIdentity;

const SOURCE_OWNER: &str = "5SourceOwner";
const DEST_OWNER: &str = "5DestOwner";
const DEST_HASH: &str = "fedcba9876543210";

/// Chunk bodies by (session id, index).
type Chunks = BTreeMap<(String, u32), Vec<u8>>;

#[derive(Clone, Default)]
struct Mock {
    opened: Arc<Mutex<Vec<serde_json::Value>>>,
    sessions: Arc<Mutex<Vec<serde_json::Value>>>,
    chunks: Arc<Mutex<Chunks>>,
    finalized: Arc<Mutex<Vec<String>>>,
    commits: Arc<Mutex<Vec<serde_json::Value>>>,
    aborts: Arc<AtomicUsize>,
    /// The (status, body) the next session create answers instead.
    session_refusal: Arc<Mutex<Option<(u16, serde_json::Value)>>>,
    /// The (status, body) every commit answers instead.
    commit_refusal: Arc<Mutex<Option<(u16, serde_json::Value)>>>,
}

async fn open(State(m): State<Mock>, body: axum::Json<serde_json::Value>) -> (StatusCode, axum::Json<serde_json::Value>) {
    m.opened.lock().unwrap().push(body.0);
    (
        StatusCode::CREATED,
        axum::Json(serde_json::json!({ "Success": { "move_id": "0123456789abcdef0123456789abcdef", "expires_at": 1 } })),
    )
}

async fn session(
    State(m): State<Mock>,
    AxPath(_id): AxPath<String>,
    body: axum::Json<serde_json::Value>,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    if let Some((status, body)) = m.session_refusal.lock().unwrap().take() {
        return (StatusCode::from_u16(status).unwrap(), axum::Json(body));
    }
    let n = {
        let mut sessions = m.sessions.lock().unwrap();
        sessions.push(body.0);
        sessions.len()
    };
    (
        StatusCode::CREATED,
        axum::Json(serde_json::json!({ "Success": { "session_id": format!("s{n}"), "expires_at": 1 } })),
    )
}

async fn chunk(State(m): State<Mock>, AxPath((sid, index)): AxPath<(String, u32)>, body: axum::body::Bytes) -> axum::Json<serde_json::Value> {
    m.chunks.lock().unwrap().insert((sid, index), body.to_vec());
    axum::Json(serde_json::json!({ "chunk_index": index }))
}

async fn finalize(State(m): State<Mock>, AxPath(sid): AxPath<String>) -> axum::Json<serde_json::Value> {
    m.finalized.lock().unwrap().push(sid);
    axum::Json(serde_json::json!({ "Success": {
        "upload_id": "u", "bytes_accepted": 1, "timestamp": 1, "revision_id": vec![9u8; 32], "created_at": 1, "updated_at": 1
    }}))
}

async fn commit(
    State(m): State<Mock>,
    AxPath(_id): AxPath<String>,
    body: axum::Json<serde_json::Value>,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    m.commits.lock().unwrap().push(body.0.clone());
    if let Some((status, body)) = m.commit_refusal.lock().unwrap().clone() {
        return (StatusCode::from_u16(status).unwrap(), axum::Json(body));
    }
    let files: Vec<serde_json::Value> = body.0["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| serde_json::json!({ "source_path_hash": h, "dest_path_hash": h, "revision_id": vec![9u8; 32] }))
        .collect();
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": { "files": files, "revoked": {
            "folder_grants": [{ "member_ss58": "5Member", "path_prefix": "Trip" }], "folder_links": ["t"], "invites": [],
            "backups_moved": [], "backups_removed": []
        }}})),
    )
}

async fn abort(State(m): State<Mock>, AxPath(_id): AxPath<String>) -> StatusCode {
    m.aborts.fetch_add(1, Ordering::SeqCst);
    StatusCode::NO_CONTENT
}

async fn start(mock: Mock) -> String {
    let app = Router::new()
        .route("/v1/drive_moves", post(open))
        .route("/v1/drive_moves/{id}/sessions", post(session))
        .route("/v1/drive_moves/{id}/commit", post(commit))
        .route("/v1/drive_moves/{id}/abort", post(abort))
        .route("/upload/session/{sid}/chunk/{index}", put(chunk))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .route("/upload/session/{sid}/finalize", post(finalize))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

struct Fixture {
    mock: Mock,
    api: MoveApi,
    dir: tempfile::TempDir,
    scratch: tempfile::TempDir,
    jobs: Vec<CopyJob>,
    key: hcfs_crypto::FileKey,
    signing: ed25519_dalek::SigningKey,
    source: DriveIdentity,
    dest: DriveIdentity,
}

/// Two source files, read in place, with rows that match their bytes.
async fn fixture(files: &[(&str, Vec<u8>)]) -> Fixture {
    let mock = Mock::default();
    let base_url = start(mock.clone()).await;
    let dir = tempfile::tempdir().unwrap();
    let jobs = files
        .iter()
        .enumerate()
        .map(|(i, (path, body))| {
            let local = dir.path().join(path);
            std::fs::create_dir_all(local.parent().unwrap()).unwrap();
            std::fs::write(&local, body).unwrap();
            let (salted, size) = hcfs_crypto::compute_salted_hash(&mut body.as_slice(), SOURCE_OWNER).unwrap();
            CopyJob {
                copy: PlannedCopy {
                    source: RemoteEntryKey {
                        path: (*path).to_string(),
                        path_hash: hcfs_crypto::compute_path_hash(path),
                        revision_id: [i as u8 + 1; 32],
                        salted_hash: salted,
                        size_bytes: size,
                    },
                    dest_path: format!("Albums/{path}"),
                },
                plaintext: Plaintext::Local(local),
            }
        })
        .collect();
    Fixture {
        mock,
        api: MoveApi {
            http: reqwest::Client::new(),
            base_url,
            bearer: "token".into(),
        },
        dir,
        scratch: tempfile::tempdir().unwrap(),
        jobs,
        key: hcfs_crypto::FileKey::from_bytes([5; 32]),
        signing: ed25519_dalek::SigningKey::from_bytes(&[6; 32]),
        source: DriveIdentity::own(SOURCE_OWNER, "0123456789abcdef"),
        dest: DriveIdentity {
            wire_ss58: DEST_OWNER.into(),
            wire_folder_hash: DEST_HASH.into(),
            is_member: true,
        },
    }
}

fn no_progress(_: usize, _: CopyEvent) {}

impl Fixture {
    fn staging<'a>(&'a self, cancel: &'a Arc<AtomicBool>, progress: &'a (dyn Fn(usize, CopyEvent) + Send + Sync)) -> Staging<'a> {
        Staging {
            api: &self.api,
            source: &self.source,
            dest: &self.dest,
            dest_key: &self.key,
            dest_signing_key: &self.signing,
            jobs: &self.jobs,
            fetcher: None,
            scratch: self.scratch.path(),
            cancel,
            progress,
        }
    }
}

#[tokio::test]
async fn open_stage_each_then_commit() {
    // Over one 8 MiB transport chunk, so the copy takes a multi-chunk session.
    let big: Vec<u8> = (0..9 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
    let f = fixture(&[("Trip/a.jpg", b"small".to_vec()), ("Trip/b.mov", big.clone())]).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let staged = stage_all(&f.staging(&cancel, &no_progress)).await.expect("staged");

    let opened = f.mock.opened.lock().unwrap()[0].clone();
    assert_eq!(opened["source"]["ss58_address"], SOURCE_OWNER);
    assert_eq!(opened["dest"]["folder_hash"], DEST_HASH);

    let sessions = f.mock.sessions.lock().unwrap().clone();
    assert_eq!(sessions.len(), 2);
    for (session, job) in sessions.iter().zip(&f.jobs) {
        let manifest = &session["session"]["manifest"];
        assert_eq!(manifest["ss58_address"], DEST_OWNER, "the copy lands in the destination's namespace");
        assert_eq!(manifest["folder_hash"], DEST_HASH);
        assert!(manifest["base_revision_id"].is_null(), "a copy creates its path");
        assert_eq!(manifest["relative_path"], job.copy.dest_path);
        let expected: Vec<u8> = session["expected_revision_id"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(expected, job.copy.source.revision_id.to_vec(), "names the revision it read");
        let (salted, _) =
            hcfs_crypto::compute_salted_hash(&mut std::fs::File::open(f.dir.path().join(&job.copy.source.path)).unwrap(), DEST_OWNER).unwrap();
        let manifest_salted: Vec<u8> = manifest["salted_hash"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(
            manifest_salted,
            salted.to_vec(),
            "salted with the destination's owner, as its engine scans"
        );
    }
    assert_eq!(sessions[1]["session"]["chunk_count"], 2);

    // Each session's chunks reassemble into a ciphertext that opens, with
    // the destination's key, to the source's bytes.
    let chunks = f.mock.chunks.lock().unwrap().clone();
    for (n, job) in f.jobs.iter().enumerate() {
        let sid = format!("s{}", n + 1);
        let cipher: Vec<u8> = chunks.iter().filter(|((s, _), _)| *s == sid).flat_map(|(_, c)| c.clone()).collect();
        let mut plain = Vec::new();
        hcfs_crypto::decrypt_stream(&mut cipher.as_slice(), &mut plain, &f.key, None, None::<fn(u64, u64)>).unwrap();
        assert_eq!(plain, std::fs::read(f.dir.path().join(&job.copy.source.path)).unwrap());
    }
    assert_eq!(*f.mock.finalized.lock().unwrap(), vec!["s1".to_string(), "s2".to_string()]);
    assert_eq!(staged.locals.len(), 2);
    assert!(
        staged.locals[0].source.is_some(),
        "read in place: the local side may move the file itself"
    );

    let folders = vec![MoveFolder {
        from: "Trip".into(),
        to: "Albums/Trip".into(),
    }];
    let result = commit_staged(&f.api, &staged.move_id, &f.jobs, &folders).await.expect("committed");
    let commit = f.mock.commits.lock().unwrap()[0].clone();
    assert_eq!(commit["files"].as_array().unwrap().len(), 2);
    assert_eq!(commit["folders"][0]["to"], "Albums/Trip");
    assert_eq!(
        result.revoked.notice().as_deref(),
        Some("Its share link was turned off and 1 person lost access.")
    );
    assert_eq!(f.mock.aborts.load(Ordering::SeqCst), 0);
    assert_eq!(std::fs::read_dir(f.scratch.path()).unwrap().count(), 0, "no ciphertext is left behind");
}

#[tokio::test]
async fn a_refused_copy_aborts_the_move() {
    let f = fixture(&[("a.txt", b"a".to_vec()), ("b.txt", b"b".to_vec())]).await;
    *f.mock.session_refusal.lock().unwrap() = Some((413, serde_json::json!({ "Error": { "error": "too_many_files", "message": "x" } })));
    let cancel = Arc::new(AtomicBool::new(false));
    let failure = stage_all(&f.staging(&cancel, &no_progress)).await.unwrap_err();
    let MoveFailure::Refused(refusal) = &failure else {
        panic!("{failure:?}")
    };
    assert_eq!(refusal.code.as_deref(), Some("too_many_files"));
    assert_eq!(
        failure.sentence(),
        "That's more than 2,000 files. Move fewer at a time. Nothing was moved."
    );
    assert_eq!(f.mock.aborts.load(Ordering::SeqCst), 1);
    assert!(f.mock.commits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancel_aborts_and_never_commits() {
    let f = fixture(&[("a.txt", b"a".to_vec()), ("b.txt", b"b".to_vec())]).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let progress = move |_: usize, event: CopyEvent| {
        if event == CopyEvent::Staged {
            flag.store(true, Ordering::SeqCst);
        }
    };
    let failure = stage_all(&f.staging(&cancel, &progress)).await.unwrap_err();
    assert!(matches!(failure, MoveFailure::Cancelled), "{failure:?}");
    assert_eq!(f.mock.sessions.lock().unwrap().len(), 1, "stops before the next copy");
    assert_eq!(f.mock.aborts.load(Ordering::SeqCst), 1);
    assert!(f.mock.commits.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_file_that_differs_from_its_revision_aborts_the_move() {
    let f = fixture(&[("a.txt", b"as listed".to_vec())]).await;
    std::fs::write(f.dir.path().join("a.txt"), b"edited, not synced yet").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let failure = stage_all(&f.staging(&cancel, &no_progress)).await.unwrap_err();
    assert!(matches!(failure, MoveFailure::Changed), "{failure:?}");
    assert!(f.mock.sessions.lock().unwrap().is_empty(), "nothing of it is uploaded");
    assert_eq!(f.mock.aborts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_refused_commit_aborts_in_a_200_or_an_error() {
    for (status, body) in [
        (
            409,
            serde_json::json!({ "Error": { "error": "revision_mismatch", "message": "x", "path_hashes": [vec![1u8; 32]] } }),
        ),
        (200, serde_json::json!({ "Error": { "error": "target_exists", "message": "x" } })),
        (
            403,
            serde_json::json!({ "error": "recording_limit_reached", "message": "x", "limit": 25 }),
        ),
    ] {
        let f = fixture(&[("a.txt", b"a".to_vec())]).await;
        *f.mock.commit_refusal.lock().unwrap() = Some((status, body));
        let cancel = Arc::new(AtomicBool::new(false));
        let staged = stage_all(&f.staging(&cancel, &no_progress)).await.unwrap();
        let failure = commit_staged(&f.api, &staged.move_id, &f.jobs, &[]).await.unwrap_err();
        assert!(matches!(failure, MoveFailure::Refused(_)), "{status}: {failure:?}");
        assert!(failure.sentence().ends_with("Nothing was moved."));
        assert_eq!(f.mock.aborts.load(Ordering::SeqCst), 1, "{status}");
    }
}

#[tokio::test]
async fn a_commit_with_no_answer_is_asked_again_and_never_aborted() {
    let f = fixture(&[("a.txt", b"a".to_vec())]).await;
    // A gateway's 503 names no refusal: the commit may have landed.
    *f.mock.commit_refusal.lock().unwrap() = Some((503, serde_json::json!({ "message": "upstream timed out" })));
    let cancel = Arc::new(AtomicBool::new(false));
    let staged = stage_all(&f.staging(&cancel, &no_progress)).await.unwrap();
    let failure = commit_staged(&f.api, &staged.move_id, &f.jobs, &[]).await.unwrap_err();
    assert!(matches!(failure, MoveFailure::Unconfirmed), "{failure:?}");
    assert_eq!(
        f.mock.commits.lock().unwrap().len(),
        3,
        "a repeated commit answers the first one's result"
    );
    assert_eq!(f.mock.aborts.load(Ordering::SeqCst), 0, "it may have landed: never aborted");
    assert!(failure.sentence().contains("Check both drives"));
}

/// A screen recording keeps its mark across the move: its copy declares no
/// capture, so the commit gives the destination row the SOURCE's kind
/// (`COALESCE(c.capture_kind, s.capture_kind)`, hcfs#1313) and the Free
/// plan's recording count is unchanged. A declaration here would be a guess
/// the server does not need, and one on an ordinary video would make it a
/// recording.
#[tokio::test]
async fn a_recordings_copy_declares_no_capture_so_it_keeps_the_source_kind() {
    let f = fixture(&[("Captures/Recording 2026-11-13.mp4", b"\0\0\0\x18ftypmp42 a recording".to_vec())]).await;
    let cancel = Arc::new(AtomicBool::new(false));
    stage_all(&f.staging(&cancel, &no_progress)).await.expect("staged");
    let session = f.mock.sessions.lock().unwrap()[0].clone();
    let manifest = session["session"]["manifest"].as_object().expect("a manifest").clone();
    assert!(!manifest.contains_key("capture"), "the copy declares no capture: {manifest:?}");
    // And the manifest still reads back as one hcfs accepts, with no capture.
    let parsed: hcfs_shared::network::Manifest = serde_json::from_value(serde_json::Value::Object(manifest)).expect("a valid manifest");
    assert!(parsed.capture.is_none());
}
