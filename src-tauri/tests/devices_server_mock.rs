//! Devices against a stand-in for hcfs-server's `/v1/devices` and
//! `/search_files` routes.
//!
//! Drives the REAL round this computer runs every minute
//! (`devices::registration::run_round`) with an in-memory SQLite, and the
//! real calls behind Settings › Devices and the file details panel, with no
//! Tauri runtime. The rounds pin the rules that decide whether a person is
//! signed out: only a clean, fully readable list is acted on, a device
//! missing after an explicit sign-in is reconnected rather than read as
//! unlinked, a missing device is read twice before anyone is signed out,
//! and no device is ever adopted by name.

use axum::Router;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri_project_lib::devices::api::DevicesApi;
use tauri_project_lib::devices::file_details::{FileSourceDetails, lookup};
use tauri_project_lib::devices::registration::{Round, run_round};
use tauri_project_lib::devices::store;

const ME: &str = "5Me";
const SAVED: &str = "0123456789abcdef0123456789abcdef";
const OTHER: &str = "fedcba9876543210fedcba9876543210";
const NEW: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Clone, Default)]
struct Mock {
    /// Each GET answers the next of these, then the last one for good.
    lists: Arc<Mutex<Vec<(StatusCode, String)>>>,
    gets: Arc<Mutex<u32>>,
    creates: Arc<Mutex<Vec<serde_json::Value>>>,
    create_answer: Arc<Mutex<Option<(StatusCode, serde_json::Value)>>>,
    reconnects: Arc<Mutex<Vec<String>>>,
    reconnect_status: Arc<Mutex<StatusCode>>,
    renames: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    deletes: Arc<Mutex<Vec<String>>>,
    delete_status: Arc<Mutex<StatusCode>>,
    search: Arc<Mutex<serde_json::Value>>,
    searches: Arc<Mutex<Vec<HashMap<String, String>>>>,
}

fn device(id: &str, name: &str, created: i64) -> serde_json::Value {
    serde_json::json!({ "device_id": id, "platform": "linux", "name": name, "created_at": created,
                        "last_active_at": created, "camera_uploads_backup_id": null })
}

fn listing(devices: &[serde_json::Value]) -> (StatusCode, String) {
    (StatusCode::OK, serde_json::json!({ "devices": devices }).to_string())
}

async fn list(State(m): State<Mock>) -> (StatusCode, String) {
    *m.gets.lock().unwrap() += 1;
    let mut lists = m.lists.lock().unwrap();
    if lists.len() > 1 { lists.remove(0) } else { lists[0].clone() }
}

async fn create(State(m): State<Mock>, body: axum::Json<serde_json::Value>) -> (StatusCode, axum::Json<serde_json::Value>) {
    m.creates.lock().unwrap().push(body.0.clone());
    if let Some(answer) = m.create_answer.lock().unwrap().clone() {
        return (answer.0, axum::Json(answer.1));
    }
    (StatusCode::CREATED, axum::Json(device(NEW, body.0["name"].as_str().unwrap(), 9)))
}

async fn reconnect(State(m): State<Mock>, AxPath(id): AxPath<String>) -> (StatusCode, axum::Json<serde_json::Value>) {
    m.reconnects.lock().unwrap().push(id.clone());
    let status = *m.reconnect_status.lock().unwrap();
    if status == StatusCode::OK {
        (status, axum::Json(device(&id, "Old name", 1)))
    } else {
        (status, axum::Json(serde_json::json!({ "error": "not_found", "message": "x" })))
    }
}

async fn rename(State(m): State<Mock>, AxPath(id): AxPath<String>, body: axum::Json<serde_json::Value>) -> axum::Json<serde_json::Value> {
    m.renames.lock().unwrap().push((id.clone(), body.0.clone()));
    axum::Json(device(&id, body.0["name"].as_str().unwrap(), 1))
}

async fn unlink(State(m): State<Mock>, AxPath(id): AxPath<String>) -> StatusCode {
    m.deletes.lock().unwrap().push(id);
    *m.delete_status.lock().unwrap()
}

async fn search(State(m): State<Mock>, AxPath(owner): AxPath<String>, Query(q): Query<HashMap<String, String>>) -> axum::Json<serde_json::Value> {
    assert_eq!(owner, "5Owner");
    m.searches.lock().unwrap().push(q);
    axum::Json(m.search.lock().unwrap().clone())
}

async fn serve(mock: Mock) -> DevicesApi {
    *mock.reconnect_status.lock().unwrap() = StatusCode::OK;
    *mock.delete_status.lock().unwrap() = StatusCode::NO_CONTENT;
    let app = Router::new()
        .route("/v1/devices", get(list).post(create))
        .route("/v1/devices/{id}", patch(rename).delete(unlink))
        .route("/v1/devices/{id}/reconnect", post(reconnect))
        .route("/search_files/{owner}", get(search))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    DevicesApi {
        http: reqwest::Client::new(),
        base_url: format!("http://{addr}"),
        bearer: "token".into(),
    }
}

async fn pool() -> sqlx::SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query(store::CREATE_TABLE).execute(&pool).await.unwrap();
    pool
}

async fn round(api: &DevicesApi, pool: &sqlx::SqlitePool) -> Round {
    run_round(api, pool, ME, "Desk", "linux").await
}

#[tokio::test]
async fn a_new_computer_registers_once_and_never_adopts_a_device_by_name() {
    let mock = Mock::default();
    // Another computer on the account already carries this computer's name.
    *mock.lists.lock().unwrap() = vec![listing(&[device(OTHER, "Desk", 1)])];
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    assert_eq!(round(&api, &pool).await, Round::Registered);
    assert_eq!(
        *mock.creates.lock().unwrap(),
        vec![serde_json::json!({ "platform": "linux", "name": "Desk" })]
    );
    let saved = store::load(&pool, ME).await.unwrap();
    assert_eq!(saved.device_id.as_deref(), Some(NEW));
    assert!(saved.confirmed);

    // Listed from now on: linked, nothing more is created.
    *mock.lists.lock().unwrap() = vec![listing(&[device(OTHER, "Desk", 1), device(NEW, "Desk", 9)])];
    assert_eq!(round(&api, &pool).await, Round::Linked);
    assert_eq!(mock.creates.lock().unwrap().len(), 1);
    assert!(mock.renames.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_renamed_computer_renames_its_device() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[device(SAVED, "Old name", 1)])];
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    store::save_linked(&pool, ME, SAVED).await.unwrap();
    assert_eq!(round(&api, &pool).await, Round::Linked);
    assert_eq!(
        *mock.renames.lock().unwrap(),
        vec![(SAVED.to_string(), serde_json::json!({ "name": "Desk" }))]
    );
}

#[tokio::test]
async fn an_unlinked_computer_is_read_twice_then_signed_out_and_nothing_is_created() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[device(OTHER, "Phone", 1)])];
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    store::save_linked(&pool, ME, SAVED).await.unwrap();
    assert_eq!(round(&api, &pool).await, Round::Unlinked);
    assert_eq!(*mock.gets.lock().unwrap(), 2, "the list is read again before signing out");
    assert!(mock.creates.lock().unwrap().is_empty());
    assert!(mock.reconnects.lock().unwrap().is_empty());
    // The row is kept, so the next sign-in reconnects the same device.
    assert_eq!(store::load(&pool, ME).await.unwrap().device_id.as_deref(), Some(SAVED));
}

#[tokio::test]
async fn one_odd_list_does_not_sign_anyone_out() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[]), listing(&[device(SAVED, "Desk", 1)])];
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    store::save_linked(&pool, ME, SAVED).await.unwrap();
    assert_eq!(round(&api, &pool).await, Round::Linked);
}

#[tokio::test]
async fn after_a_sign_in_a_missing_device_is_reconnected() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[])];
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    store::save_linked(&pool, ME, SAVED).await.unwrap();
    store::mark_reconnect_pending(&pool, ME).await.unwrap();
    assert_eq!(round(&api, &pool).await, Round::Reconnected);
    assert_eq!(*mock.reconnects.lock().unwrap(), vec![SAVED.to_string()]);
    let saved = store::load(&pool, ME).await.unwrap();
    assert!(saved.confirmed && !saved.reconnect_pending);
    // The reconnected device takes this computer's name.
    assert_eq!(mock.renames.lock().unwrap()[0].1, serde_json::json!({ "name": "Desk" }));
    assert!(mock.creates.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_device_gone_for_good_is_replaced_by_a_new_one() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[])];
    let api = serve(mock.clone()).await;
    *mock.reconnect_status.lock().unwrap() = StatusCode::NOT_FOUND;
    let pool = pool().await;
    store::save_linked(&pool, ME, SAVED).await.unwrap();
    store::mark_reconnect_pending(&pool, ME).await.unwrap();
    assert_eq!(round(&api, &pool).await, Round::Registered);
    assert_eq!(store::load(&pool, ME).await.unwrap().device_id.as_deref(), Some(NEW));
}

#[tokio::test]
async fn a_device_never_seen_linked_is_replaced_not_mourned() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[])];
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    sqlx::query("INSERT INTO device_registration (owner, device_id, confirmed, reconnect_pending) VALUES (?, ?, 0, 0)")
        .bind(tauri_project_lib::auth::account_key::account_key(ME))
        .bind(SAVED)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(round(&api, &pool).await, Round::Registered);
}

#[tokio::test]
async fn anything_but_a_clean_readable_list_does_nothing() {
    let unreadable = [
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"internal_error","message":"x"}"#.to_string(),
        ),
        (StatusCode::OK, r#"{"devices": "nope"}"#.to_string()),
        (StatusCode::OK, "<html>".to_string()),
        // One malformed entry spoils the list rather than shortening it.
        (
            StatusCode::OK,
            serde_json::json!({ "devices": [device(OTHER, "Phone", 1), { "device_id": SAVED, "platform": "linux" }] }).to_string(),
        ),
        (StatusCode::ACCEPTED, serde_json::json!({ "devices": [] }).to_string()),
    ];
    for answer in unreadable {
        let mock = Mock::default();
        *mock.lists.lock().unwrap() = vec![answer.clone()];
        let api = serve(mock.clone()).await;
        let linked = pool().await;
        store::save_linked(&linked, ME, SAVED).await.unwrap();
        assert_eq!(round(&api, &linked).await, Round::Skipped, "{answer:?}");
        assert!(mock.creates.lock().unwrap().is_empty());
        // And a fresh computer does not register on one either.
        let fresh = pool().await;
        assert_eq!(round(&api, &fresh).await, Round::Skipped);
        assert!(mock.creates.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn a_full_account_stops_registering() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[])];
    *mock.create_answer.lock().unwrap() = Some((StatusCode::CONFLICT, serde_json::json!({ "error": "device_limit", "message": "x" })));
    let api = serve(mock.clone()).await;
    let pool = pool().await;
    assert_eq!(round(&api, &pool).await, Round::Stop);
    assert_eq!(store::load(&pool, ME).await.unwrap().device_id, None);
    // Any other refusal just waits for the next round.
    *mock.create_answer.lock().unwrap() = Some((
        StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({ "error": "internal_error", "message": "x" }),
    ));
    assert_eq!(round(&api, &pool).await, Round::Skipped);
}

#[tokio::test]
async fn unlinking_another_device_is_done_even_when_it_is_already_gone() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[])];
    let api = serve(mock.clone()).await;
    api.unlink(OTHER).await.unwrap();
    *mock.delete_status.lock().unwrap() = StatusCode::NOT_FOUND;
    api.unlink(OTHER).await.unwrap();
    *mock.delete_status.lock().unwrap() = StatusCode::INTERNAL_SERVER_ERROR;
    assert!(api.unlink(OTHER).await.is_err());
    assert_eq!(mock.deletes.lock().unwrap().len(), 3);
}

const NOW: i64 = 1_790_000_000;

fn hit(path_hash: u8, extra: serde_json::Value) -> serde_json::Value {
    let mut hit = serde_json::json!({ "folder_hash": "0123456789abcdef", "folder_label": "Phone", "path_hash": vec![path_hash; 32],
                                      "file_name": "IMG_0001.HEIC" });
    for (k, v) in extra.as_object().unwrap() {
        hit[k] = v.clone();
    }
    serde_json::json!({ "Success": { "files": [hit], "total_count": 1, "has_more": false, "offset": 0, "limit": 25 } })
}

#[tokio::test]
async fn file_details_come_from_the_checked_hit_and_the_device_list() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[device(OTHER, "Pixel 8", 1), device(SAVED, "Pixel 8", 2)])];
    *mock.search.lock().unwrap() = hit(
        7,
        serde_json::json!({ "source_taken_at": 1_700_000_000, "source_modified_at": 100, "device_id": SAVED,
                            "source_metadata": { "camera_make": "Apple", "camera_model": "iPhone 15 Pro", "iso": 100 } }),
    );
    let api = serve(mock.clone()).await;
    let id = hex::encode([7u8; 32]);
    let details = lookup(&api.http, &api.base_url, "token", "5Owner", "0123456789abcdef", &id, NOW).await;
    assert_eq!(details.taken_at, Some(1_700_000_000));
    assert_eq!(details.modified_at, None, "a 1970 date is not shown");
    assert_eq!(details.camera.as_deref(), Some("Apple iPhone 15 Pro"));
    assert_eq!(
        details.uploaded_from.as_deref(),
        Some("Pixel 8 (2)"),
        "the same label Settings › Devices shows"
    );
    let q = mock.searches.lock().unwrap()[0].clone();
    assert_eq!(q["folder_hash"], "0123456789abcdef");
    assert_eq!(q["file_id"], id);
    assert_eq!(q["include_source_metadata"], "true");
}

#[tokio::test]
async fn an_older_servers_ordinary_search_shows_nothing_extra() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[])];
    *mock.search.lock().unwrap() = hit(8, serde_json::json!({ "source_taken_at": 1_700_000_000, "device_id": SAVED }));
    let api = serve(mock.clone()).await;
    let details = lookup(
        &api.http,
        &api.base_url,
        "token",
        "5Owner",
        "0123456789abcdef",
        &hex::encode([7u8; 32]),
        NOW,
    )
    .await;
    assert_eq!(details, FileSourceDetails::default());
    assert_eq!(*mock.gets.lock().unwrap(), 0, "no device lookup for a hit that is not the file");
}

#[tokio::test]
async fn a_removed_or_unknown_device_is_not_named() {
    let mock = Mock::default();
    *mock.lists.lock().unwrap() = vec![listing(&[device(OTHER, "Pixel 8", 1)])];
    *mock.search.lock().unwrap() = hit(7, serde_json::json!({ "device_id": SAVED }));
    let api = serve(mock.clone()).await;
    let details = lookup(
        &api.http,
        &api.base_url,
        "token",
        "5Owner",
        "0123456789abcdef",
        &hex::encode([7u8; 32]),
        NOW,
    )
    .await;
    assert_eq!(details.uploaded_from, None);
}
