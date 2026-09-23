//! Team-chat backend proxy (`chat::backend`) against an axum stand-in for
//! `api.hippius.com`.
//!
//! What this pins that the unit tests on the classifiers cannot:
//! - the requests carry the desktop's `Authorization: Token …` and nothing
//!   about the client but `Accept-Language`;
//! - query parameters are the ones the backend contract names (`q`, `pos`,
//!   `limit`) and the cursor goes back verbatim;
//! - the 503 / 429 / 403 / 404 / 410 answers become the typed outcomes the
//!   frontend branches on, while an unexpected status is an error;
//! - a media download sends no `Authorization`, and the byte cap is enforced
//!   both on a declared `Content-Length` and on a body that lies about it.
//!
//! No Tauri `AppHandle`, no SQLite, no live server.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tauri_project_lib::chat::backend::{
    AcceptInviteOutcome, ChatBackend, GIF_MAX_BYTES, GifFetch, InviteLinkOutcome, InvitePreviewOutcome, download_media,
};
use tauri_project_lib::error::AppError;
use tokio::net::TcpListener;

#[derive(Default)]
struct Seen {
    /// (path, query params, headers) of every request.
    requests: Vec<(String, HashMap<String, String>, HeaderMap)>,
    gif_status: u16,
    invite_status: u16,
    accept_status: u16,
    media_declared_length: Option<u64>,
    media_bytes: usize,
}

type Shared = Arc<Mutex<Seen>>;

fn record(s: &Shared, path: &str, q: HashMap<String, String>, headers: HeaderMap) {
    s.lock().unwrap().requests.push((path.to_string(), q, headers));
}

async fn gifs(State(s): State<Shared>, Path(which): Path<String>, Query(q): Query<HashMap<String, String>>, headers: HeaderMap) -> Response {
    record(&s, &format!("/api/chat/gifs/{which}/"), q.clone(), headers);
    let status = s.lock().unwrap().gif_status;
    match status {
        200 => Json(serde_json::json!({
            "results": [{
                "id": format!("{which}-{}", q.get("q").cloned().unwrap_or_default()),
                "title": "Wave",
                "preview": { "url": "https://cdn.example/p.gif", "width": 200, "height": 100 },
                "full": { "url": "https://cdn.example/f.gif", "width": 480, "height": 240, "size": 4096 },
                "mp4": null
            }],
            "next": if q.contains_key("pos") { serde_json::Value::Null } else { serde_json::json!("cur-2") },
            "meta": { "attribution": "Powered by GIPHY" }
        }))
        .into_response(),
        503 => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "code": "gifs_not_configured" })),
        )
            .into_response(),
        other => StatusCode::from_u16(other).unwrap().into_response(),
    }
}

async fn invites(State(s): State<Shared>, Path(space): Path<String>, headers: HeaderMap) -> Response {
    record(&s, &format!("/api/chat/workspaces/{space}/invites/"), HashMap::new(), headers);
    let status = s.lock().unwrap().invite_status;
    match status {
        201 => (
            StatusCode::CREATED,
            Json(serde_json::json!({
                "token": "tok_ABCDEFGH",
                "url": "https://console.hippius.com/chat/join/tok_ABCDEFGH",
                "expires_at": "2026-10-01T00:00:00Z",
                "max_uses": null,
                "uses": 0,
                "space_id": space
            })),
        )
            .into_response(),
        other => StatusCode::from_u16(other).unwrap().into_response(),
    }
}

async fn accept(State(s): State<Shared>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    record(&s, &format!("/api/chat/invites/{token}/accept/"), HashMap::new(), headers);
    let status = s.lock().unwrap().accept_status;
    match status {
        200 => Json(serde_json::json!({ "space_id": "!space:hippius.com", "room_ids": ["!general:hippius.com"] })).into_response(),
        other => StatusCode::from_u16(other).unwrap().into_response(),
    }
}

async fn preview(State(s): State<Shared>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    record(&s, &format!("/api/chat/invites/{token}/"), HashMap::new(), headers);
    let status = s.lock().unwrap().accept_status;
    match status {
        200 => Json(serde_json::json!({
            "space_id": "!space:hippius.com", "workspace_name": "Acme", "inviter_display_name": "Alice", "expires_at": "2026-10-01T00:00:00Z"
        }))
        .into_response(),
        other => StatusCode::from_u16(other).unwrap().into_response(),
    }
}

async fn media(State(s): State<Shared>, headers: HeaderMap) -> Response {
    record(&s, "/media/f.gif", HashMap::new(), headers);
    let (declared, size) = {
        let g = s.lock().unwrap();
        (g.media_declared_length, g.media_bytes)
    };
    // Streamed so hyper cannot check a (deliberately) lying Content-Length
    // against the body it knows the size of.
    // A lying declared length is paired with a stream that never finishes, so
    // the connection stays consistent from hyper's point of view and the
    // client has to act on the header alone (which is what is under test).
    let chunks: Vec<Result<Vec<u8>, std::io::Error>> = vec![Ok(vec![0x47u8; size])];
    let first = futures_util::stream::iter(chunks);
    let body = if declared.is_some() {
        Body::from_stream(futures_util::StreamExt::chain(first, futures_util::stream::pending()))
    } else {
        Body::from_stream(first)
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    resp.headers_mut().insert(header::CONTENT_TYPE, "image/gif".parse().unwrap());
    if let Some(declared) = declared {
        resp.headers_mut().insert(header::CONTENT_LENGTH, declared.to_string().parse().unwrap());
    }
    resp
}

async fn spawn() -> (String, Shared) {
    let shared: Shared = Arc::new(Mutex::new(Seen {
        gif_status: 200,
        invite_status: 201,
        accept_status: 200,
        ..Default::default()
    }));
    let app = Router::new()
        .route("/api/chat/gifs/{which}/", get(gifs))
        .route("/api/chat/workspaces/{space}/invites/", post(invites))
        .route("/api/chat/invites/{token}/accept/", post(accept))
        .route("/api/chat/invites/{token}/", get(preview))
        .route("/media/f.gif", get(media))
        .with_state(shared.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), shared)
}

fn backend(base: &str) -> ChatBackend {
    ChatBackend::new(reqwest::Client::new(), base, "desktop-api-token")
}

fn last(s: &Shared) -> (String, HashMap<String, String>, HeaderMap) {
    s.lock().unwrap().requests.last().cloned().unwrap()
}

#[tokio::test]
async fn gif_search_forwards_query_cursor_locale_and_token_only() {
    let (base, seen) = spawn().await;
    let b = backend(&base);

    let first = b.gifs_search("hello world", None, Some(12), Some("fr-FR")).await.unwrap();
    let (path, q, headers) = last(&seen);
    assert_eq!(path, "/api/chat/gifs/search/");
    assert_eq!(q.get("q").map(String::as_str), Some("hello world"));
    assert_eq!(q.get("limit").map(String::as_str), Some("12"));
    assert!(!q.contains_key("pos"));
    assert_eq!(headers.get(header::AUTHORIZATION).unwrap(), "Token desktop-api-token");
    assert_eq!(headers.get(header::ACCEPT_LANGUAGE).unwrap(), "fr-FR");
    assert!(headers.get(header::COOKIE).is_none());
    let GifFetch::Page(page) = first else { panic!("{first:?}") };
    assert_eq!(page.results[0].id, "search-hello world");
    assert_eq!(page.results[0].full.size, 4096);
    assert_eq!(page.next.as_deref(), Some("cur-2"));
    assert_eq!(page.attribution.as_deref(), Some("Powered by GIPHY"));

    // The cursor goes back verbatim as `pos`; the last page has no `next`.
    let second = b.gifs_search("hello world", page.next.as_deref(), None, None).await.unwrap();
    let (_, q, headers) = last(&seen);
    assert_eq!(q.get("pos").map(String::as_str), Some("cur-2"));
    assert_eq!(q.get("limit").map(String::as_str), Some("24"));
    assert!(headers.get(header::ACCEPT_LANGUAGE).is_none());
    assert!(matches!(second, GifFetch::Page(p) if p.next.is_none()));

    let featured = b.gifs_featured(None, Some(1), None).await.unwrap();
    let (path, q, _) = last(&seen);
    assert_eq!(path, "/api/chat/gifs/featured/");
    assert_eq!(q.get("limit").map(String::as_str), Some("1"));
    assert!(matches!(featured, GifFetch::Page(_)));
}

#[tokio::test]
async fn gif_503_is_disabled_429_is_throttled_and_other_statuses_are_errors() {
    let (base, seen) = spawn().await;
    let b = backend(&base);

    seen.lock().unwrap().gif_status = 503;
    assert_eq!(
        b.gifs_featured(None, Some(1), None).await.unwrap(),
        GifFetch::Disabled {
            code: Some("gifs_not_configured".into())
        }
    );

    seen.lock().unwrap().gif_status = 429;
    assert_eq!(b.gifs_search("x", None, None, None).await.unwrap(), GifFetch::Throttled);

    seen.lock().unwrap().gif_status = 401;
    assert!(matches!(
        b.gifs_search("x", None, None, None).await,
        Err(AppError::Api { status: 401, .. })
    ));
}

#[tokio::test]
async fn invite_link_outcomes_follow_the_status() {
    let (base, seen) = spawn().await;
    let b = backend(&base);

    let out = b.create_invite_link("!space:hippius.com").await.unwrap();
    let (path, _, headers) = last(&seen);
    assert_eq!(path, "/api/chat/workspaces/!space:hippius.com/invites/");
    assert_eq!(headers.get(header::AUTHORIZATION).unwrap(), "Token desktop-api-token");
    let InviteLinkOutcome::Link(link) = out else { panic!("{out:?}") };
    assert_eq!(link.token, "tok_ABCDEFGH");
    assert_eq!(link.space_id, "!space:hippius.com");

    seen.lock().unwrap().invite_status = 403;
    assert_eq!(b.create_invite_link("!space:hippius.com").await.unwrap(), InviteLinkOutcome::Forbidden);
    seen.lock().unwrap().invite_status = 404;
    assert_eq!(b.create_invite_link("!space:hippius.com").await.unwrap(), InviteLinkOutcome::Unavailable);
    seen.lock().unwrap().invite_status = 500;
    assert!(matches!(
        b.create_invite_link("!space:hippius.com").await,
        Err(AppError::Api { status: 500, .. })
    ));

    // Not a room id: refused before any request.
    let before = seen.lock().unwrap().requests.len();
    assert!(matches!(b.create_invite_link("general").await, Err(AppError::Validation(_))));
    assert_eq!(seen.lock().unwrap().requests.len(), before);
}

#[tokio::test]
async fn accept_and_preview_take_a_link_or_token_and_map_404_410() {
    let (base, seen) = spawn().await;
    let b = backend(&base);

    let out = b.accept_invite("https://console.hippius.com/chat/join/tok_ABCDEFGH?x=1").await.unwrap();
    let (path, _, _) = last(&seen);
    assert_eq!(path, "/api/chat/invites/tok_ABCDEFGH/accept/");
    assert_eq!(
        out,
        AcceptInviteOutcome::Accepted {
            space_id: "!space:hippius.com".into(),
            room_ids: vec!["!general:hippius.com".into()]
        }
    );

    let out = b.preview_invite("tok_ABCDEFGH").await.unwrap();
    let (path, _, _) = last(&seen);
    assert_eq!(path, "/api/chat/invites/tok_ABCDEFGH/");
    assert!(matches!(out, InvitePreviewOutcome::Preview(p) if p.workspace_name == "Acme" && p.inviter_display_name.as_deref() == Some("Alice")));

    seen.lock().unwrap().accept_status = 404;
    assert_eq!(b.accept_invite("tok_ABCDEFGH").await.unwrap(), AcceptInviteOutcome::Unknown);
    assert_eq!(b.preview_invite("tok_ABCDEFGH").await.unwrap(), InvitePreviewOutcome::Unknown);
    seen.lock().unwrap().accept_status = 410;
    assert_eq!(b.accept_invite("tok_ABCDEFGH").await.unwrap(), AcceptInviteOutcome::Expired);
    assert_eq!(b.preview_invite("tok_ABCDEFGH").await.unwrap(), InvitePreviewOutcome::Expired);

    // Garbage never reaches the network.
    let before = seen.lock().unwrap().requests.len();
    assert_eq!(b.accept_invite("not a token").await.unwrap(), AcceptInviteOutcome::Unknown);
    assert_eq!(b.preview_invite("").await.unwrap(), InvitePreviewOutcome::Unknown);
    assert_eq!(seen.lock().unwrap().requests.len(), before);
}

/// The media download is tested against a plain-HTTP mock only for the cap
/// and header behaviour; `download_media` itself refuses `http://`, so the
/// mock is reached through a test-only shim that relaxes just the scheme.
#[tokio::test]
async fn media_download_sends_no_credentials_and_enforces_the_cap_twice() {
    let (base, seen) = spawn().await;
    let client = reqwest::Client::new();
    let url = format!("{base}/media/f.gif");

    // The production entry point refuses the scheme outright.
    assert!(matches!(download_media(&client, &url, GIF_MAX_BYTES).await, Err(AppError::Validation(_))));
    assert!(seen.lock().unwrap().requests.is_empty(), "no request must leave on a refused scheme");

    // Declared length over the cap: refused before the body is read.
    seen.lock().unwrap().media_declared_length = Some(GIF_MAX_BYTES + 1);
    seen.lock().unwrap().media_bytes = 16;
    let err = tauri_project_lib::chat::backend::download_media_unchecked_scheme(&client, &url, GIF_MAX_BYTES)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("too large"), "{err}");

    // Body larger than the cap without an honest Content-Length: refused on the bytes received.
    seen.lock().unwrap().media_declared_length = None;
    seen.lock().unwrap().media_bytes = 2048;
    let err = tauri_project_lib::chat::backend::download_media_unchecked_scheme(&client, &url, 1024)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("too large"), "{err}");

    // Fits: bytes come back, and the request carried no token/cookie.
    seen.lock().unwrap().media_bytes = 512;
    let bytes = tauri_project_lib::chat::backend::download_media_unchecked_scheme(&client, &url, 1024)
        .await
        .unwrap();
    assert_eq!(bytes.len(), 512);
    let (_, _, headers) = last(&seen);
    assert!(headers.get(header::AUTHORIZATION).is_none());
    assert!(headers.get(header::COOKIE).is_none());
}
