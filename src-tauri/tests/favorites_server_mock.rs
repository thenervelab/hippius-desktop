//! Starred against a stand-in for hcfs-server's favorites routes.
//!
//! Drives the REAL request and paging code (`sync::favorites::api`, the
//! batch in `set_many`) with no Tauri runtime: a star names a file, a folder
//! or a whole drive in the owner's namespace, a dropped answer is asked
//! again, the 1,000-star cap has its own sentence, a batch never has more
//! than four stars in flight, the listing pages by what each page held and
//! stops at six pages, and an older server's 404 reads as "not available",
//! never as an empty Starred.

use axum::Router;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, put};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri_project_lib::sync::favorites::api::{FavoritesApi, Listing};
use tauri_project_lib::sync::favorites::wire::{FULL_SENTENCE, StarItem};
use tauri_project_lib::sync::favorites::{ResolvedStar, StarKind, StarTarget, set_many};

const OWNER: &str = "5Owner";
const HASH: &str = "0123456789abcdef";

/// One PUT the mock received: `(owner, folder_hash, body, bearer)`.
type Put = (String, String, serde_json::Value, String);

#[derive(Clone, Default)]
struct Mock {
    puts: Arc<Mutex<Vec<Put>>>,
    /// Answer this many PUTs with a 503 first.
    fail_first: Arc<Mutex<u32>>,
    in_flight: Arc<AtomicUsize>,
    max_in_flight: Arc<AtomicUsize>,
    offsets: Arc<Mutex<Vec<u64>>>,
    /// Items the account has starred, paged as one sequence.
    stars: Arc<Mutex<u64>>,
    /// Always say there is more (to test the page cap).
    endless: Arc<Mutex<bool>>,
    /// The route is not mounted.
    old_server: Arc<Mutex<bool>>,
}

async fn set(
    State(m): State<Mock>,
    AxPath((owner, hash)): AxPath<(String, String)>,
    headers: HeaderMap,
    body: axum::Json<serde_json::Value>,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    let now = m.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
    m.max_in_flight.fetch_max(now, Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    m.in_flight.fetch_sub(1, Ordering::SeqCst);
    let bearer = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    m.puts.lock().unwrap().push((owner, hash, body.0.clone(), bearer));
    {
        let mut left = m.fail_first.lock().unwrap();
        if *left > 0 {
            *left -= 1;
            return (StatusCode::SERVICE_UNAVAILABLE, axum::Json(serde_json::Value::Null));
        }
    }
    let id = body.0["item"]["file_id"].as_str().unwrap_or_default();
    if id.starts_with("ff") && body.0["favorite"] == true {
        return (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({ "Error": { "error": "favorites_full", "message": "x" } })),
        );
    }
    if id.starts_with("ee") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({ "Error": { "error": "not_found", "message": "x" } })),
        );
    }
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": { "favorite": body.0["favorite"] } })),
    )
}

async fn list(
    State(m): State<Mock>,
    AxPath(ss58): AxPath<String>,
    Query(q): Query<HashMap<String, String>>,
) -> (StatusCode, axum::Json<serde_json::Value>) {
    if *m.old_server.lock().unwrap() {
        return (StatusCode::NOT_FOUND, axum::Json(serde_json::Value::Null));
    }
    assert_eq!(ss58, OWNER);
    let offset: u64 = q["offset"].parse().unwrap();
    let limit: u64 = q["limit"].parse().unwrap();
    assert_eq!(limit, 200);
    m.offsets.lock().unwrap().push(offset);
    let total = *m.stars.lock().unwrap();
    // 2 drives, 3 folders, the rest files, as one sequence.
    let (mut drives, mut folders, mut files) = (Vec::new(), Vec::new(), Vec::new());
    let end = (offset + limit).min(total);
    for i in offset..end {
        if i < 2 {
            drives.push(serde_json::json!({ "owner_ss58": OWNER, "folder_hash": format!("{i:016x}"), "label": format!("Drive {i}") }));
        } else if i < 5 {
            folders.push(serde_json::json!({ "owner_ss58": OWNER, "folder_hash": HASH, "path": format!("F{i}"), "name": format!("F{i}") }));
        } else {
            files.push(
                serde_json::json!({ "owner_ss58": OWNER, "folder_hash": HASH, "file_id": format!("{i:064x}"),
                                            "file_name": format!("{i}.txt"), "relative_path": format!("{i}.txt") }),
            );
        }
    }
    let has_more = *m.endless.lock().unwrap() || end < total;
    (
        StatusCode::OK,
        axum::Json(serde_json::json!({ "Success": {
            "ss58_address": OWNER, "drives": drives, "folders": folders, "files": files,
            "total_count": total, "has_more": has_more, "offset": offset, "limit": limit
        } })),
    )
}

async fn serve(mock: Mock) -> FavoritesApi {
    let app = Router::new()
        .route("/favorites/{owner}/{hash}", put(set))
        .route("/favorites/{ss58}", get(list))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    FavoritesApi {
        http: reqwest::Client::new(),
        base_url: format!("http://{addr}"),
        bearer: "token".into(),
    }
}

#[tokio::test]
async fn a_star_names_a_file_a_folder_or_a_drive_in_the_owners_namespace() {
    let mock = Mock::default();
    let api = serve(mock.clone()).await;
    let id = "ab".repeat(32);
    assert!(api.set(OWNER, HASH, &StarItem::File(id.clone()), true).await.unwrap());
    assert!(!api.set(OWNER, HASH, &StarItem::Path("A/B".into()), false).await.unwrap());
    assert!(api.set(OWNER, HASH, &StarItem::Path(String::new()), true).await.unwrap());
    let puts = mock.puts.lock().unwrap().clone();
    assert_eq!(puts.len(), 3);
    for (owner, hash, _, bearer) in &puts {
        assert_eq!((owner.as_str(), hash.as_str(), bearer.as_str()), (OWNER, HASH, "Bearer token"));
    }
    assert_eq!(puts[0].2, serde_json::json!({ "item": { "file_id": id }, "favorite": true }));
    assert_eq!(puts[1].2, serde_json::json!({ "item": { "path": "A/B" }, "favorite": false }));
    assert_eq!(puts[2].2, serde_json::json!({ "item": { "path": "" }, "favorite": true }));
}

#[tokio::test]
async fn a_dropped_answer_is_asked_again() {
    let mock = Mock::default();
    *mock.fail_first.lock().unwrap() = 1;
    let api = serve(mock.clone()).await;
    assert!(api.set(OWNER, HASH, &StarItem::Path("A".into()), true).await.unwrap());
    assert_eq!(mock.puts.lock().unwrap().len(), 2);
}

fn file_target(name: &str, id: &str) -> (StarTarget, Option<ResolvedStar>) {
    let target = StarTarget {
        kind: StarKind::File,
        name: name.into(),
        label: None,
        owner_ss58: Some(OWNER.into()),
        folder_hash: Some(HASH.into()),
        file_id: Some(id.into()),
        path: None,
    };
    let resolved = ResolvedStar {
        owner: OWNER.into(),
        folder_hash: HASH.into(),
        item: StarItem::File(id.into()),
    };
    (target, Some(resolved))
}

#[tokio::test]
async fn a_batch_sends_four_at_a_time_and_answers_once() {
    let mock = Mock::default();
    let api = serve(mock.clone()).await;
    let mut targets = Vec::new();
    let mut resolved = Vec::new();
    for i in 0..10u8 {
        let (t, r) = file_target(&format!("{i}.pdf"), &format!("{i:02x}").repeat(32));
        targets.push(t);
        resolved.push(r);
    }
    // One the server cannot find, one over the cap, one that never resolved.
    let (t, r) = file_target("gone.pdf", &"ee".repeat(32));
    targets.push(t);
    resolved.push(r);
    let (t, r) = file_target("full.pdf", &"ff".repeat(32));
    targets.push(t);
    resolved.push(r);
    let (mut t, _) = file_target("nowhere.pdf", "x");
    t.owner_ss58 = None;
    targets.push(t);
    resolved.push(None);

    let result = set_many(&api, &targets, &resolved, true).await;
    assert_eq!(result.done.len(), 10);
    assert!(result.done.iter().all(|d| d.favorite));
    assert_eq!(result.done[0].key, format!("{OWNER}|{HASH}|f:{}", "00".repeat(32)));
    let failed: Vec<_> = result.failed.iter().map(|f| (f.name.as_str(), f.error.as_str())).collect();
    assert_eq!(
        failed,
        vec![
            ("gone.pdf", "Couldn't star \"gone.pdf\". Try again."),
            ("full.pdf", FULL_SENTENCE),
            ("nowhere.pdf", "Couldn't star \"nowhere.pdf\". Try again."),
        ]
    );
    assert!(result.full);
    assert_eq!(result.failed[2].key, None);
    assert_eq!(mock.puts.lock().unwrap().len(), 12, "the unresolved item is never sent");
    let max = mock.max_in_flight.load(Ordering::SeqCst);
    assert!((2..=4).contains(&max), "at most four stars in flight, got {max}");
}

#[tokio::test]
async fn unstarring_a_batch_never_reports_the_cap() {
    let mock = Mock::default();
    let api = serve(mock).await;
    let (t, r) = file_target("full.pdf", &"ff".repeat(32));
    let result = set_many(&api, &[t], &[r], false).await;
    assert_eq!(result.done.len(), 1);
    assert!(!result.full);
}

#[tokio::test]
async fn the_listing_pages_by_what_each_page_held() {
    let mock = Mock::default();
    *mock.stars.lock().unwrap() = 450;
    let api = serve(mock.clone()).await;
    let Listing::Pages(pages) = api.list_all(OWNER).await.unwrap() else {
        panic!("expected pages");
    };
    assert_eq!(*mock.offsets.lock().unwrap(), vec![0, 200, 400]);
    let total: usize = pages.iter().map(|p| p.drives.len() + p.folders.len() + p.files.len()).sum();
    assert_eq!(total, 450);
    assert_eq!((pages[0].drives.len(), pages[0].folders.len()), (2, 3));
}

#[tokio::test]
async fn the_listing_stops_at_six_pages_and_on_an_empty_page() {
    let mock = Mock::default();
    *mock.stars.lock().unwrap() = 5_000;
    *mock.endless.lock().unwrap() = true;
    let api = serve(mock.clone()).await;
    let Listing::Pages(pages) = api.list_all(OWNER).await.unwrap() else {
        panic!("expected pages");
    };
    assert_eq!(pages.len(), 6);
    assert_eq!(*mock.offsets.lock().unwrap(), vec![0, 200, 400, 600, 800, 1000]);

    let mock = Mock::default();
    *mock.endless.lock().unwrap() = true;
    let api = serve(mock.clone()).await;
    let Listing::Pages(pages) = api.list_all(OWNER).await.unwrap() else {
        panic!("expected pages");
    };
    assert_eq!(pages.len(), 1, "an empty page ends the walk even when has_more says otherwise");
}

#[tokio::test]
async fn an_older_server_has_no_starred_rather_than_an_empty_one() {
    let mock = Mock::default();
    *mock.old_server.lock().unwrap() = true;
    let api = serve(mock).await;
    assert!(matches!(api.list_all(OWNER).await.unwrap(), Listing::Unavailable));
}
