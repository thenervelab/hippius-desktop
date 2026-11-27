//! Drive Trash against a stand-in for hcfs-server's `/v1/trash/...` routes,
//! answering in the shipped contract (hcfs-shared's `network::trash`).
//!
//! Drives the REAL loops (`trash::run`) through the REAL hcfs-client calls,
//! with no Tauri runtime:
//! - a folder of any size goes in batches as ONE item under an id this
//!   computer picked, with `more` on every call but the last and
//!   `continue_item` once an answer named the item, and closing calls are
//!   repeated while the server says `more`;
//! - an id that names an item which already closed starts a fresh item;
//! - restore in place follows `more` (through a `checking` phase) and sets a
//!   clashing item aside without holding the others back;
//! - keep both lists the item's files, plans them with hcfs-client and sends
//!   signed batches the server's own check accepts, until `more: false`;
//! - delete forever goes a hundred items a call, Empty asks again while
//!   `more`, the listing pages on the server's cursor;
//! - a server with Trash switched off answers a bare 404 that is never read
//!   as success.

use axum::Router;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use hcfs_client::client::{HcfsClient, HcfsClientConfig};
use hcfs_shared::network::{RestoreConflict, RestoreTrashRename};
use hcfs_shared::revision_id::RevisionId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri_project_lib::sync::trash::run::{
    FileToTrash, KeepBoth, delete_forever, empty, list_all, restore_as, restore_in_place, trash_files, trash_folder,
};

const OWNER: &str = "5Owner";
const HASH: &str = "0123456789abcdef";
type Answer = (StatusCode, axum::Json<serde_json::Value>);
/// One file of the keep-both item: its stored path and id.
type ItemFile = (String, [u8; 32]);

#[derive(Clone, Default)]
struct Mock {
    trash_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    restore_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    delete_bodies: Arc<Mutex<Vec<serde_json::Value>>>,
    list_queries: Arc<Mutex<Vec<HashMap<String, String>>>>,
    /// Closing calls that answer `more: true` before the folder is done.
    closing_more: Arc<Mutex<u32>>,
    /// Item ids that name an item which already closed.
    closed_items: Arc<Mutex<Vec<String>>>,
    /// In-place restore answers to give, in order, before `done`.
    restore_script: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Item whose in-place restore meets a live file.
    clashing_item: Arc<Mutex<Option<String>>>,
    /// The keep-both item's files still in Trash: (path, hash).
    item_files: Arc<Mutex<Vec<ItemFile>>>,
    empty_more: Arc<Mutex<u32>>,
    /// Trash switched off: every route answers a bare 404.
    off: Arc<Mutex<bool>>,
}

fn ok(value: serde_json::Value) -> Answer {
    (StatusCode::OK, axum::Json(serde_json::json!({ "Success": value })))
}

fn error(status: StatusCode, code: &str) -> Answer {
    (status, axum::Json(serde_json::json!({ "Error": { "error": code, "message": "x" } })))
}

fn off(m: &Mock) -> Option<Answer> {
    (*m.off.lock().unwrap()).then_some((StatusCode::NOT_FOUND, axum::Json(serde_json::Value::Null)))
}

async fn trash_files_route(State(m): State<Mock>, AxPath((ss58, hash)): AxPath<(String, String)>, body: axum::Json<serde_json::Value>) -> Answer {
    if let Some(answer) = off(&m) {
        return answer;
    }
    assert_eq!((ss58.as_str(), hash.as_str()), (OWNER, HASH));
    let body = body.0;
    m.trash_bodies.lock().unwrap().push(body.clone());
    let ids: Vec<String> = serde_json::from_value(body["file_ids"].clone()).unwrap_or_default();
    let item = body.get("item_id").and_then(|v| v.as_str()).map(str::to_string);
    if let Some(item) = &item
        && m.closed_items.lock().unwrap().contains(item)
    {
        return error(StatusCode::CONFLICT, "item_state");
    }
    let grouped = body.get("folder_path").is_some();
    let trashed: Vec<serde_json::Value> = ids
        .iter()
        .filter(|id| !id.starts_with("ff"))
        .map(|id| {
            let item = if grouped { item.clone().unwrap() } else { format!("item-{}", &id[..4]) };
            serde_json::json!({ "file_id": id, "status": "trashed", "item_id": item })
        })
        .collect();
    let errors: Vec<serde_json::Value> = ids
        .iter()
        .filter(|id| id.starts_with("ff"))
        .map(|id| serde_json::json!({ "file_id": id, "code": "conflict", "message": "x" }))
        .collect();
    let closing = grouped && body.get("more").and_then(serde_json::Value::as_bool) != Some(true);
    let more = closing && {
        let mut left = m.closing_more.lock().unwrap();
        let more = *left > 0;
        *left = left.saturating_sub(1);
        more
    };
    let quiet = body.get("quiet").and_then(serde_json::Value::as_bool) == Some(true);
    ok(serde_json::json!({
        "trashed": if quiet { Vec::new() } else { trashed.clone() },
        "errors": errors,
        "files_trashed": trashed.len(),
        "item_id": if grouped { item.map_or(serde_json::Value::Null, serde_json::Value::from) } else { serde_json::Value::Null },
        "more": more,
    }))
}

async fn list_route(State(m): State<Mock>, Query(q): Query<HashMap<String, String>>) -> Answer {
    if let Some(answer) = off(&m) {
        return answer;
    }
    let page = m.list_queries.lock().unwrap().len();
    m.list_queries.lock().unwrap().push(q);
    let item = |id: &str| {
        serde_json::json!({ "item_id": id, "kind": "file", "relative_path": format!("{id}.txt"), "file_name": format!("{id}.txt"),
            "path_hash": ([1u8; 32]), "encrypted_path": [2], "file_count": 1, "total_bytes": 5, "recording_count": 0,
            "trashed_at": 1_795_000_000, "purge_at": 1_797_592_000, "trashed_by": "5Member", "name_taken": false, "state": "ready" })
    };
    // Page two holds nothing a grant holder may see, and still has more.
    let (items, more) = match page {
        0 => (vec![item("a")], true),
        1 => (vec![], true),
        _ => (vec![item("b")], false),
    };
    ok(serde_json::json!({
        "items": items,
        "has_more": more,
        "next_after_trashed_at": if more { serde_json::json!(1_795_000_000 - page as i64) } else { serde_json::Value::Null },
        "next_after_item_id": if more { serde_json::json!(format!("cursor-{page}")) } else { serde_json::Value::Null },
        "totals": null,
        "trash_retention_days": 14,
    }))
}

async fn restore_route(State(m): State<Mock>, body: axum::Json<serde_json::Value>) -> Answer {
    if let Some(answer) = off(&m) {
        return answer;
    }
    let body = body.0;
    m.restore_bodies.lock().unwrap().push(body.clone());
    if let Some(rename) = body.get("rename") {
        let rename: RestoreTrashRename = serde_json::from_value(rename.clone()).unwrap();
        let item_id = body["item_id"].as_str().unwrap();
        // The server's own check: signed over the item and its stored path.
        if rename.verify_signature(item_id, "Trip").is_err() {
            return error(StatusCode::BAD_REQUEST, "invalid_signature");
        }
        let mut files = m.item_files.lock().unwrap();
        for entry in &rename.renames {
            let (path, _) = files
                .iter()
                .find(|(_, h)| *h == entry.old_path_hash)
                .cloned()
                .expect("a file of the item");
            let new_path = path.replacen("Trip", &rename.new_path, 1);
            assert_eq!(entry.new_path_hash, hcfs_crypto::compute_path_hash(&new_path), "a hash of the new path");
        }
        files.retain(|(_, h)| !rename.renames.iter().any(|r| r.old_path_hash == *h));
        let more = !files.is_empty();
        return ok(serde_json::json!({
            "files_restored": rename.renames.len(), "entries_restored": 0, "skipped": [],
            "items_restored": if more { vec![] } else { vec![item_id.to_string()] }, "more": more,
        }));
    }
    let ids: Vec<String> = serde_json::from_value(body["item_ids"].clone()).unwrap();
    if ids.iter().any(|id| id == "gone") {
        return error(StatusCode::NOT_FOUND, "item_not_found");
    }
    if let Some(clash) = m.clashing_item.lock().unwrap().clone()
        && ids.contains(&clash)
    {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({ "Conflict": { "error": "name_conflict", "message": "x", "item_id": clash, "conflicts": ["aa"] } })),
        );
    }
    let scripted = {
        let mut script = m.restore_script.lock().unwrap();
        (!script.is_empty()).then(|| script.remove(0))
    };
    ok(scripted
        .unwrap_or_else(|| serde_json::json!({ "files_restored": 10, "entries_restored": 0, "skipped": [], "items_restored": ids, "more": false })))
}

async fn item_files_route(State(m): State<Mock>, Query(q): Query<HashMap<String, String>>) -> Answer {
    let files = m.item_files.lock().unwrap().clone();
    let start = q
        .get("after_path_hash")
        .map_or(0, |after| files.iter().position(|(_, h)| hex::encode(h) == *after).unwrap() + 1);
    let limit: usize = q.get("limit").and_then(|l| l.parse().ok()).unwrap_or(50);
    let page: Vec<&ItemFile> = files.iter().skip(start).take(limit).collect();
    let more = start + page.len() < files.len();
    let rows: Vec<serde_json::Value> = page
        .iter()
        .map(|(path, hash)| {
            serde_json::json!({ "path_hash": hash, "salted_hash": ([0u8; 32]), "size_bytes": 1, "revision_seq": 1,
                "revision_id": ([9u8; 32]), "encrypted_path": [], "relative_path": path })
        })
        .collect();
    ok(serde_json::json!({
        "files": rows,
        "has_more": more,
        "next_after_path_hash": page.last().filter(|_| more).map(|(_, h)| hex::encode(h)),
    }))
}

async fn delete_route(State(m): State<Mock>, body: axum::Json<serde_json::Value>) -> Answer {
    if let Some(answer) = off(&m) {
        return answer;
    }
    let count = body.0["item_ids"].as_array().map_or(0, Vec::len);
    m.delete_bodies.lock().unwrap().push(body.0);
    ok(serde_json::json!({ "items_marked": count, "more": false }))
}

async fn empty_route(State(m): State<Mock>) -> Answer {
    if let Some(answer) = off(&m) {
        return answer;
    }
    let more = {
        let mut left = m.empty_more.lock().unwrap();
        let more = *left > 0;
        *left = left.saturating_sub(1);
        more
    };
    ok(serde_json::json!({ "items_marked": 100, "more": more }))
}

async fn start(mock: Mock) -> HcfsClient {
    let app = Router::new()
        .route("/v1/trash/{ss58}/{hash}", get(list_route))
        .route("/v1/trash/{ss58}/{hash}/files", post(trash_files_route))
        .route("/v1/trash/{ss58}/{hash}/restore", post(restore_route))
        .route("/v1/trash/{ss58}/{hash}/items/{item}/files", get(item_files_route))
        .route("/v1/trash/{ss58}/{hash}/delete", post(delete_route))
        .route("/v1/trash/{ss58}/{hash}/empty", post(empty_route))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    HcfsClient::new(HcfsClientConfig {
        base_url: format!("http://{addr}"),
        bearer_token: "token".into(),
        accept_invalid_certs: true,
        billing_bypass_token: None,
        ss58_address: OWNER.into(),
        folder_hash: HASH.into(),
        shared_drive_member: false,
        read_timeout_ms: None,
    })
    .unwrap()
}

fn files(n: usize, first: u8) -> Vec<FileToTrash> {
    (0..n)
        .map(|i| {
            let mut hash = [first; 32];
            hash[30] = (i >> 8) as u8;
            hash[31] = i as u8;
            FileToTrash {
                path_hash: hash,
                revision_id: RevisionId::from_bytes([7; 32]),
            }
        })
        .collect()
}

const ITEM: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn a_large_folder_goes_in_batches_as_one_item_under_its_own_id() {
    let mock = Mock::default();
    *mock.closing_more.lock().unwrap() = 2;
    let client = start(mock.clone()).await;
    let mut progress = Vec::new();
    let outcome = trash_folder(
        &client,
        OWNER,
        HASH,
        "Projects/Big",
        &files(2_500, 1),
        ITEM,
        |_| panic!("no new item"),
        |n| progress.push(n),
    )
    .await
    .unwrap();

    let bodies = mock.trash_bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 5, "three batches, then two more closing calls while the server says more");
    assert_eq!(
        bodies.iter().map(|b| b["file_ids"].as_array().map_or(0, Vec::len)).collect::<Vec<_>>(),
        vec![1000, 1000, 500, 0, 0]
    );
    assert!(
        bodies.iter().all(|b| b["folder_path"] == "Projects/Big" && b["item_id"] == ITEM),
        "one item, one id"
    );
    assert_eq!(
        bodies.iter().map(|b| b["more"].as_bool().unwrap_or(false)).collect::<Vec<_>>(),
        vec![true, true, false, false, false],
        "every call but the last of the batches says more"
    );
    assert!(bodies[0].get("continue_item").is_none(), "the first call opens the item");
    assert!(
        bodies[1..].iter().all(|b| b["continue_item"] == true),
        "every call after an answer named it continues"
    );
    assert!(bodies[..3].iter().all(|b| b["quiet"] == true));
    let first_id = bodies[0]["file_ids"][0].as_str().unwrap().to_string();
    assert_eq!(
        bodies[0]["expected_revision_ids"][&first_id][0], 7,
        "each file goes at the revision listed"
    );
    assert_eq!(progress, vec![1000, 2000, 2500]);
    assert_eq!(outcome.trashed, 2_500);
    assert_eq!(outcome.folder_item.as_deref(), Some(ITEM));
}

#[tokio::test]
async fn an_id_whose_item_already_closed_starts_a_fresh_item() {
    let mock = Mock::default();
    mock.closed_items.lock().unwrap().push(ITEM.into());
    let client = start(mock.clone()).await;
    let mut fresh = Vec::new();
    let outcome = trash_folder(&client, OWNER, HASH, "Big", &files(3, 1), ITEM, |id| fresh.push(id.to_string()), |_| {})
        .await
        .unwrap();
    assert_eq!(fresh.len(), 1, "the new id is handed back to be recorded");
    assert_ne!(fresh[0], ITEM);
    assert_eq!(fresh[0].len(), 32);
    assert_eq!(outcome.folder_item.as_deref(), Some(fresh[0].as_str()));
    let bodies = mock.trash_bodies.lock().unwrap().clone();
    assert_eq!(bodies.last().unwrap()["item_id"], fresh[0].as_str());
}

#[tokio::test]
async fn a_folder_of_empty_folders_is_one_closing_call() {
    let mock = Mock::default();
    let client = start(mock.clone()).await;
    let outcome = trash_folder(&client, OWNER, HASH, "Empty", &[], ITEM, |_| {}, |_| {}).await.unwrap();
    let bodies = mock.trash_bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["file_ids"], serde_json::json!([]));
    assert_eq!(bodies[0]["more"], false, "the only call closes the item, moving its empty folders");
    assert_eq!(outcome.folder_item.as_deref(), Some(ITEM));
}

#[tokio::test]
async fn loose_files_report_each_item_and_keep_a_changed_file() {
    let mock = Mock::default();
    let client = start(mock.clone()).await;
    let mut batch = files(2, 1);
    batch.extend(files(1, 0xff));
    let outcome = trash_files(&client, OWNER, HASH, &batch, |_| {}).await.unwrap();
    assert_eq!(outcome.trashed, 2);
    assert_eq!(outcome.kept, vec![(hex::encode(batch[2].path_hash), "conflict".to_string())]);
    assert_eq!(outcome.item_of_file.len(), 2);
    let body = &mock.trash_bodies.lock().unwrap()[0];
    assert!(
        body.get("folder_path").is_none() && body.get("item_id").is_none(),
        "each file is its own item"
    );
}

#[tokio::test]
async fn restore_follows_more_through_the_check_and_sets_a_clash_aside() {
    let mock = Mock::default();
    *mock.restore_script.lock().unwrap() = vec![
        serde_json::json!({ "files_restored": 0, "entries_restored": 0, "skipped": [], "items_restored": [], "more": true, "phase": "checking" }),
        serde_json::json!({ "files_restored": 5000, "entries_restored": 0, "skipped": [], "items_restored": [], "more": true }),
    ];
    *mock.clashing_item.lock().unwrap() = Some("taken".into());
    let client = start(mock.clone()).await;
    let mut progress = Vec::new();
    let answer = restore_in_place(&client, OWNER, HASH, &["a".into(), "taken".into()], RestoreConflict::Fail, |n| {
        progress.push(n);
    })
    .await
    .unwrap();
    assert!(answer.clashed.contains("taken"));
    assert!(answer.restored.contains("a") && !answer.restored.contains("taken"));
    let bodies = mock.restore_bodies.lock().unwrap().clone();
    assert_eq!(bodies[0]["item_ids"], serde_json::json!(["a", "taken"]));
    assert!(
        bodies[1..].iter().all(|b| b["item_ids"] == serde_json::json!(["a"])),
        "the others are asked again without it"
    );
    assert_eq!(bodies.len(), 4, "the clash, then checking, a batch and the end");
    assert_eq!(bodies[0]["on_conflict"], "fail");
    assert_eq!(progress, vec![0, 5000, 5010]);
}

#[tokio::test]
async fn an_item_gone_from_trash_reads_as_missing() {
    let mock = Mock::default();
    let client = start(mock).await;
    let answer = restore_in_place(&client, OWNER, HASH, &["gone".into()], RestoreConflict::Fail, |_| {})
        .await
        .unwrap();
    assert!(answer.missing.contains("gone"));
}

#[tokio::test]
async fn keep_both_plans_signs_and_sends_the_whole_item_in_batches() {
    let mock = Mock::default();
    *mock.item_files.lock().unwrap() = (0..2_500u32)
        .map(|i| {
            let path = format!("Trip/day{}/{i}.jpg", i % 3);
            let hash = hcfs_crypto::compute_path_hash(&path);
            (path, hash)
        })
        .collect();
    let client = start(mock.clone()).await;
    let key = hcfs_crypto::FileKey::from_bytes([3; 32]);
    let signing = ed25519_dalek_v3::SigningKey::from_bytes(&[4; 32]);
    let done = restore_as(&client, OWNER, HASH, ITEM, "Trip", "Trip (1)", &key, &signing).await.unwrap();
    assert_eq!(done, KeepBoth::Restored { files: 2_500 });
    let bodies = mock.restore_bodies.lock().unwrap().clone();
    assert_eq!(bodies.len(), 2, "2,500 files are two calls of up to 2,000");
    for body in &bodies {
        assert_eq!(body["item_id"], ITEM, "keep both names one item");
        assert!(body.get("item_ids").is_none_or(|ids| ids == &serde_json::json!([])));
        assert_eq!(body["rename"]["new_path"], "Trip (1)");
    }
    assert_eq!(bodies[0]["rename"]["renames"].as_array().unwrap().len(), 2000);
    assert_eq!(bodies[1]["rename"]["renames"].as_array().unwrap().len(), 500);
    let sealed: Vec<u8> = serde_json::from_value(bodies[0]["rename"]["renames"][0]["new_encrypted_path"].clone()).unwrap();
    let opened = String::from_utf8(hcfs_crypto::decrypt_small(&sealed, &key).unwrap()).unwrap();
    assert!(opened.starts_with("Trip (1)/day"), "the new path is sealed with the drive key: {opened}");
}

#[tokio::test]
async fn a_keep_both_signed_over_another_path_is_refused() {
    let mock = Mock::default();
    *mock.item_files.lock().unwrap() = vec![("Trip/a.jpg".into(), hcfs_crypto::compute_path_hash("Trip/a.jpg"))];
    let client = start(mock.clone()).await;
    let key = hcfs_crypto::FileKey::from_bytes([3; 32]);
    let signing = ed25519_dalek_v3::SigningKey::from_bytes(&[4; 32]);
    // Signed over another stored path, the server refuses it.
    let refused = restore_as(&client, OWNER, HASH, ITEM, "Elsewhere", "Trip (1)", &key, &signing).await;
    assert!(refused.is_err(), "a restore signed over the wrong path is refused, never restored");
}

#[tokio::test]
async fn delete_forever_goes_a_hundred_items_at_a_time() {
    let mock = Mock::default();
    let client = start(mock.clone()).await;
    let ids: Vec<String> = (0..250).map(|i| format!("i{i}")).collect();
    let mut progress = Vec::new();
    let marked = delete_forever(&client, OWNER, HASH, &ids, |n| progress.push(n)).await.unwrap();
    let bodies = mock.delete_bodies.lock().unwrap().clone();
    assert_eq!(
        bodies.iter().map(|b| b["item_ids"].as_array().unwrap().len()).collect::<Vec<_>>(),
        vec![100, 100, 50]
    );
    assert_eq!(progress, vec![100, 200, 250]);
    assert_eq!(marked, 250);
}

#[tokio::test]
async fn empty_asks_again_while_the_server_says_more() {
    let mock = Mock::default();
    *mock.empty_more.lock().unwrap() = 3;
    let client = start(mock).await;
    assert_eq!(empty(&client, OWNER, HASH).await.unwrap(), 400);
}

#[tokio::test]
async fn the_listing_pages_on_the_servers_cursor_past_an_empty_page() {
    let mock = Mock::default();
    let client = start(mock.clone()).await;
    let (items, retention) = list_all(&client, OWNER, HASH).await.unwrap();
    assert_eq!(items.iter().map(|i| i.item_id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
    assert_eq!(items[0].purge_at, 1_797_592_000, "each item says when it is deleted forever");
    assert_eq!(retention, 14, "the server's retention, never a hard-coded 30");
    let queries = mock.list_queries.lock().unwrap().clone();
    assert_eq!(queries.len(), 3, "an empty page that has more is not the end");
    assert_eq!(queries[0]["limit"], "200");
    assert!(!queries[0].contains_key("after_item_id"));
    assert_eq!(queries[2]["after_item_id"], "cursor-1", "the next page starts where the server said");
    assert_eq!(queries[2]["after_trashed_at"], "1794999999");
}

#[tokio::test]
async fn a_server_with_trash_off_is_never_read_as_success() {
    let mock = Mock::default();
    *mock.off.lock().unwrap() = true;
    let client = start(mock).await;
    let refusal = trash_files(&client, OWNER, HASH, &files(3, 1), |_| {}).await.unwrap_err();
    assert!(refusal.is_unavailable());
    assert_eq!(refusal.sentence(), "Trash isn't available yet.");
    assert!(
        restore_in_place(&client, OWNER, HASH, &["a".into()], RestoreConflict::Fail, |_| {})
            .await
            .unwrap_err()
            .is_unavailable()
    );
    assert!(empty(&client, OWNER, HASH).await.unwrap_err().is_unavailable());
}
