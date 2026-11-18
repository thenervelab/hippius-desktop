//! Drive Trash against a stand-in for hcfs-server's `/v1/trash/...` routes.
//!
//! Drives the REAL request and loop code (`trash::run`, `trash::api`) with
//! no Tauri runtime: a folder of any size goes in batches as one item that
//! continues across them, restore and empty follow `more` to the end, delete
//! forever goes in batches, keep both sends signed renames, and a server
//! with Trash switched off answers a bare 404 that is never read as success.

use axum::Router;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri_project_lib::sync::trash::api::TrashApi;
use tauri_project_lib::sync::trash::run::{
    FileToTrash, delete_forever_in_batches, empty_until_done, plan_restore_renames, restore_in_place, restore_renamed, trash_in_batches,
};

const OWNER: &str = "5Owner";
const HASH: &str = "0123456789abcdef";

#[derive(Clone, Default)]
struct Mock {
    trash_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    restore_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    delete_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    /// How many more restore / empty calls answer `more: true`.
    restore_more: Arc<Mutex<u32>>,
    empty_more: Arc<Mutex<u32>>,
    list_queries: Arc<Mutex<Vec<HashMap<String, String>>>>,
    /// Trash switched off: every route answers a bare 404.
    off: Arc<Mutex<bool>>,
}

fn off(m: &Mock) -> Option<(StatusCode, axum::Json<serde_json::Value>)> {
    (*m.off.lock().unwrap()).then_some((StatusCode::NOT_FOUND, axum::Json(serde_json::Value::Null)))
}

async fn trash_files(
    State(m): State<Mock>,
    AxPath((ss58, hash)): AxPath<(String, String)>,
    body: axum::Json<serde_json::Value>,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    if let Some(answer) = off(&m) {
        return answer;
    }
    assert_eq!((ss58.as_str(), hash.as_str()), (OWNER, HASH));
    m.trash_bodies.lock().unwrap().push(body.0.clone());
    let ids: Vec<String> = serde_json::from_value(body.0["file_ids"].clone()).unwrap();
    // The first id of the second loose batch changed on another device.
    let trashed: Vec<serde_json::Value> = ids
        .iter()
        .filter(|id| !id.starts_with("ff"))
        .map(|id| serde_json::json!({ "file_id": id, "status": "trashed", "item_id": format!("item-{id}") }))
        .collect();
    let errors: Vec<serde_json::Value> = ids
        .iter()
        .filter(|id| id.starts_with("ff"))
        .map(|id| serde_json::json!({ "file_id": id, "code": "conflict", "message": "x" }))
        .collect();
    let item = body
        .0
        .get("folder_path")
        .and_then(|_| body.0.get("item_id").cloned())
        .filter(|v| !v.is_null());
    let item = if body.0.get("folder_path").is_some() {
        item.unwrap_or(serde_json::json!("folder-item-1"))
    } else {
        serde_json::Value::Null
    };
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": { "trashed": trashed, "errors": errors, "item_id": item } })),
    )
}

async fn list(State(m): State<Mock>, Query(q): Query<HashMap<String, String>>) -> (StatusCode, axum::Json<serde_json::Value>) {
    if let Some(answer) = off(&m) {
        return answer;
    }
    m.list_queries.lock().unwrap().push(q);
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": { "items": [], "has_more": false } })),
    )
}

async fn restore(State(m): State<Mock>, body: axum::Json<serde_json::Value>) -> (StatusCode, axum::Json<serde_json::Value>) {
    if let Some(answer) = off(&m) {
        return answer;
    }
    m.restore_bodies.lock().unwrap().push(body.0.clone());
    let ids: Vec<String> = serde_json::from_value(body.0["item_ids"].clone()).unwrap();
    let more = {
        let mut left = m.restore_more.lock().unwrap();
        let more = *left > 0;
        *left = left.saturating_sub(1);
        more
    };
    let items: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            let status = if id == "taken" { "name_taken" } else { "restored" };
            serde_json::json!({ "item_id": id, "status": status })
        })
        .collect();
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": { "items": items, "more": more, "files_restored": 5000 } })),
    )
}

async fn delete(State(m): State<Mock>, body: axum::Json<serde_json::Value>) -> (StatusCode, axum::Json<serde_json::Value>) {
    if let Some(answer) = off(&m) {
        return answer;
    }
    m.delete_bodies.lock().unwrap().push(body.0.clone());
    (StatusCode::OK, axum::Json(serde_json::json!({ "Success": { "more": false } })))
}

async fn empty(State(m): State<Mock>) -> (StatusCode, axum::Json<serde_json::Value>) {
    if let Some(answer) = off(&m) {
        return answer;
    }
    let more = {
        let mut left = m.empty_more.lock().unwrap();
        let more = *left > 0;
        *left = left.saturating_sub(1);
        more
    };
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": { "more": more, "items_deleted": 100 } })),
    )
}

async fn start(mock: Mock) -> TrashApi {
    let app = Router::new()
        .route("/v1/trash/{ss58}/{hash}", get(list))
        .route("/v1/trash/{ss58}/{hash}/files", post(trash_files))
        .route("/v1/trash/{ss58}/{hash}/restore", post(restore))
        .route("/v1/trash/{ss58}/{hash}/delete", post(delete))
        .route("/v1/trash/{ss58}/{hash}/empty", post(empty))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    TrashApi {
        http: reqwest::Client::new(),
        base_url: format!("http://{addr}"),
        bearer: "token".into(),
    }
}

fn files(n: usize, first: u8) -> Vec<FileToTrash> {
    (0..n)
        .map(|i| {
            let mut hash = [first; 32];
            hash[30] = (i >> 8) as u8;
            hash[31] = i as u8;
            FileToTrash {
                path_hash: hash,
                revision_id: [7; 32],
            }
        })
        .collect()
}

#[tokio::test]
async fn a_large_folder_goes_in_batches_as_one_item_with_its_revisions() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let folder = files(2_500, 1);
    let mut announced = Vec::new();
    let mut progress = Vec::new();
    let outcome = trash_in_batches(
        &api,
        OWNER,
        HASH,
        &folder,
        Some(("Projects/Big", None)),
        |item| announced.push(item.to_string()),
        |n| progress.push(n),
    )
    .await
    .unwrap();

    let bodies = mock.trash_bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 3, "2,500 files are three batches, never refused");
    assert_eq!(
        bodies.iter().map(|b| b["file_ids"].as_array().unwrap().len()).collect::<Vec<_>>(),
        vec![1000, 1000, 500]
    );
    assert!(bodies.iter().all(|b| b["folder_path"] == "Projects/Big"));
    assert!(bodies[0].get("item_id").is_none(), "the first batch starts the item");
    assert_eq!(bodies[1]["item_id"], "folder-item-1", "later batches continue it");
    assert_eq!(bodies[2]["item_id"], "folder-item-1");
    let first_id = bodies[0]["file_ids"][0].as_str().unwrap().to_string();
    assert_eq!(
        bodies[0]["expected_revision_ids"][&first_id][0], 7,
        "each file goes at the revision listed"
    );
    assert_eq!(
        announced,
        vec!["folder-item-1".to_string()],
        "the item is announced once, before batch two"
    );
    assert_eq!(progress, vec![1000, 2000, 2500]);
    assert_eq!(outcome.trashed, 2_500);
    assert_eq!(outcome.folder_item.as_deref(), Some("folder-item-1"));
}

#[tokio::test]
async fn a_stopped_folder_resumes_into_the_same_item() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let mut announced = Vec::new();
    trash_in_batches(
        &api,
        OWNER,
        HASH,
        &files(10, 1),
        Some(("Big", Some("item-from-journal".into()))),
        |i| announced.push(i.to_string()),
        |_| {},
    )
    .await
    .unwrap();
    let bodies = mock.trash_bodies.lock().unwrap().clone();
    assert_eq!(bodies[0]["item_id"], "item-from-journal");
    assert!(announced.is_empty(), "nothing new to record");
}

#[tokio::test]
async fn an_empty_folder_still_makes_its_item() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let outcome = trash_in_batches(&api, OWNER, HASH, &[], Some(("Empty", None)), |_| {}, |_| {})
        .await
        .unwrap();
    assert_eq!(mock.trash_bodies.lock().unwrap().len(), 1);
    assert_eq!(outcome.folder_item.as_deref(), Some("folder-item-1"));
}

#[tokio::test]
async fn loose_files_report_each_item_and_keep_a_changed_file() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let mut batch = files(2, 1);
    batch.extend(files(1, 0xff));
    let outcome = trash_in_batches(&api, OWNER, HASH, &batch, None, |_| {}, |_| {}).await.unwrap();
    assert_eq!(outcome.trashed, 2);
    assert_eq!(outcome.kept.len(), 1);
    assert_eq!(outcome.kept[0].1, "conflict");
    assert_eq!(outcome.item_of_file.len(), 2);
    assert!(mock.trash_bodies.lock().unwrap()[0].get("folder_path").is_none());
}

#[tokio::test]
async fn restore_follows_more_until_done() {
    let mock = Mock::default();
    *mock.restore_more.lock().unwrap() = 2;
    let api = start(mock.clone()).await;
    let mut progress = Vec::new();
    let statuses = restore_in_place(&api, OWNER, HASH, &["a".into(), "taken".into()], |n| progress.push(n))
        .await
        .unwrap();
    assert_eq!(mock.restore_bodies.lock().unwrap().len(), 3);
    assert_eq!(progress, vec![5000, 10000, 15000]);
    assert_eq!(statuses["a"], "restored");
    assert_eq!(statuses["taken"], "name_taken");
    assert_eq!(mock.restore_bodies.lock().unwrap()[0]["on_conflict"], "fail");
}

#[tokio::test]
async fn keep_both_sends_signed_renames_in_batches() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let key = hcfs_crypto::FileKey::from_bytes([3; 32]);
    let listed: Vec<(String, [u8; 32], [u8; 32])> = (0..4_500u32).map(|i| (format!("Trip/{i}.jpg"), [(i % 250) as u8; 32], [1; 32])).collect();
    let renames = plan_restore_renames(&listed, "Trip", "Trip (1)", &key).unwrap();
    let signing = ed25519_dalek::SigningKey::from_bytes(&[4; 32]);
    let status = restore_renamed(&api, OWNER, HASH, "item-9", "Trip (1)", &renames, &signing, |_| {})
        .await
        .unwrap();
    assert_eq!(status, "restored");
    let bodies = mock.restore_bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 3, "4,500 renames are three calls, never refused");
    for body in &bodies {
        assert_eq!(body["item_ids"], serde_json::json!(["item-9"]));
        assert_eq!(body["rename"]["new_path"], "Trip (1)");
        assert_eq!(body["rename"]["signature"].as_array().unwrap().len(), 64);
        assert_eq!(body["rename"]["signing_key"].as_array().unwrap().len(), 32);
    }
    assert_eq!(bodies[0]["rename"]["renames"].as_array().unwrap().len(), 2000);
    assert_eq!(bodies[2]["rename"]["renames"].as_array().unwrap().len(), 500);
    assert_eq!(bodies[0]["rename"]["renames"][0]["new_relative_path"], "Trip (1)/0.jpg");
}

#[tokio::test]
async fn delete_forever_goes_a_hundred_items_at_a_time() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let ids: Vec<String> = (0..250).map(|i| format!("i{i}")).collect();
    let mut progress = Vec::new();
    delete_forever_in_batches(&api, OWNER, HASH, &ids, |n| progress.push(n)).await.unwrap();
    let bodies = mock.delete_bodies.lock().unwrap().clone();
    assert_eq!(
        bodies.iter().map(|b| b["item_ids"].as_array().unwrap().len()).collect::<Vec<_>>(),
        vec![100, 100, 50]
    );
    assert_eq!(progress, vec![100, 200, 250]);
}

#[tokio::test]
async fn empty_asks_again_while_the_server_says_more() {
    let mock = Mock::default();
    *mock.empty_more.lock().unwrap() = 3;
    let api = start(mock).await;
    assert_eq!(empty_until_done(&api, OWNER, HASH).await.unwrap(), 400);
}

#[tokio::test]
async fn the_listing_pages_by_keyset() {
    let mock = Mock::default();
    let api = start(mock.clone()).await;
    let cursor = tauri_project_lib::sync::trash::wire::ListCursor {
        after_trashed_at: 1_700_000_000,
        after_item_id: "a b/c".into(),
    };
    api.list(OWNER, HASH, Some(&cursor)).await.unwrap();
    let query = mock.list_queries.lock().unwrap()[0].clone();
    assert_eq!(query["limit"], "200");
    assert_eq!(query["after_trashed_at"], "1700000000");
    assert_eq!(query["after_item_id"], "a b/c", "the cursor survives encoding");
}

#[tokio::test]
async fn a_server_with_trash_off_is_never_read_as_success() {
    let mock = Mock::default();
    *mock.off.lock().unwrap() = true;
    let api = start(mock).await;
    let refusal = trash_in_batches(&api, OWNER, HASH, &files(3, 1), None, |_| {}, |_| {}).await.unwrap_err();
    assert!(refusal.is_unavailable());
    assert_eq!(refusal.sentence(), "Trash isn't available yet.");
    assert!(
        restore_in_place(&api, OWNER, HASH, &["a".into()], |_| {})
            .await
            .unwrap_err()
            .is_unavailable()
    );
    assert!(empty_until_done(&api, OWNER, HASH).await.unwrap_err().is_unavailable());
}
