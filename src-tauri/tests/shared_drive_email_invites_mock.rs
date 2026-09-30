//! Emailed drive invites (hcfs #459), owner/manager side, against a mock
//! axum server: the mint body, the three error mappings the dialog words
//! differently, the listing's mailed-invite fields, and the seal-back PUT's
//! outcomes. The crypto itself is pinned by the KAT in
//! `shared_drives::invite_key`.

use axum::{
    Json, Router,
    extract::{Path, RawQuery},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::error::{AppError, NotReadyKind};
use tauri_project_lib::shared_drives::commands::{
    EmailInviteBody, SealKeyPut, http_email_invite, http_list_invites, http_put_account_invite_key, http_put_sealed_key, resolve_email_invite,
};

const BEARER: &str = "test-bearer-token";
const HASH: &str = "0123456789abcdef";

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    format!("http://{addr}")
}

fn body<'a>(email: &'a str, owner: Option<&'a str>) -> EmailInviteBody<'a> {
    EmailInviteBody {
        folder_hash: HASH,
        email,
        role: "writer",
        expires_in_secs: 7 * 24 * 3600,
        owner_ss58: owner,
        path_prefix: None,
    }
}

#[tokio::test]
async fn email_mint_sends_the_fields_and_returns_the_id() {
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = seen.clone();
    let base = serve(Router::new().route(
        "/v1/drive-invites/email",
        post(move |headers: HeaderMap, Json(b): Json<serde_json::Value>| async move {
            assert_eq!(headers.get("authorization").unwrap(), &format!("Bearer {BEARER}"));
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "invite_id": "abc123" }))
        }),
    ))
    .await;

    let minted = http_email_invite(&reqwest::Client::new(), &base, BEARER, &body("ada@example.com", Some("5Owner")))
        .await
        .expect("mint");
    assert_eq!(minted.invite_id, "abc123");
    assert_eq!(minted.recipient_key, None, "a server that predates pre-sealing names no key");

    let sent = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent["folder_hash"], HASH);
    assert_eq!(sent["email"], "ada@example.com");
    assert_eq!(sent["role"], "writer");
    assert_eq!(sent["expires_in_secs"], 7 * 24 * 3600);
    assert_eq!(sent["owner_ss58"], "5Owner", "a manager names the owner");
    assert!(sent.get("max_uses").is_none(), "a mailed invite is single use; no max_uses");
    assert!(sent.get("path_prefix").is_none(), "no folder unless asked");
}

/// A Manager invitation (hcfs #521), resolved by the same policy the command
/// uses and sent by a delegated Manager: role `manager`, a lifetime of one
/// day rather than the seven-day default the server would refuse, the owner
/// named, and no `max_uses` (the server makes it single use).
#[tokio::test]
async fn a_manager_email_mint_is_sent_within_the_manager_day() {
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = seen.clone();
    let base = serve(Router::new().route(
        "/v1/drive-invites/email",
        post(move |Json(b): Json<serde_json::Value>| async move {
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "invite_id": "mgr1" }))
        }),
    ))
    .await;

    let policy = resolve_email_invite("ada@example.com", Some("manager".into()), None, false).expect("manager policy");
    let body = EmailInviteBody {
        folder_hash: HASH,
        email: &policy.email,
        role: &policy.role,
        expires_in_secs: policy.expires_in_secs,
        owner_ss58: Some("5Owner"),
        path_prefix: None,
    };
    let minted = http_email_invite(&reqwest::Client::new(), &base, BEARER, &body).await.expect("mint");
    assert_eq!(minted.invite_id, "mgr1");

    let sent = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!(sent["role"], "manager");
    assert_eq!(sent["expires_in_secs"], 24 * 3600, "over a day is a 400 for a Manager");
    assert_eq!(sent["owner_ss58"], "5Owner");
    assert!(sent.get("max_uses").is_none(), "the server fixes a mailed invite at one use");
    assert!(sent.get("path_prefix").is_none(), "a Manager invite is whole-drive");
}

/// A server from before mailed Manager invites refuses with a plain 400 and
/// sends nothing; the error says to send a link rather than echo the refusal.
#[tokio::test]
async fn an_old_server_refusing_a_manager_email_says_to_send_a_link() {
    let err = failing(
        StatusCode::BAD_REQUEST,
        // Byte for byte what hcfs main sent before #521.
        serde_json::json!({
            "error": "bad_request",
            "message": "manager invites must be sent as a link, not by email; \
                        invite as a writer and change the role after they join",
        }),
        None,
    )
    .await;
    match err {
        AppError::Validation(msg) => assert!(msg.contains("Send a Manager link"), "{msg}"),
        other => panic!("expected a worded refusal, got {other:?}"),
    }
}

/// The mint names the key to pre-seal to, and echoes a folder invite's
/// folder; both are what the pre-seal is decided on.
#[tokio::test]
async fn a_mint_reads_the_key_to_preseal_to_and_the_folder_echo() {
    let base = serve(Router::new().route(
        "/v1/drive-invites/email",
        post(|| async {
            Json(serde_json::json!({
                "invite_id": "abc123",
                "path_prefix": "Clients",
                "recipient_key": "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ+xnTzf3/pe20=",
            }))
        }),
    ))
    .await;

    let minted = http_email_invite(&reqwest::Client::new(), &base, BEARER, &body("ada@example.com", None))
        .await
        .expect("mint");

    assert_eq!(minted.path_prefix.as_deref(), Some("Clients"));
    assert_eq!(minted.recipient_key.as_deref(), Some("E75P6uryBMf9M1j8nAByGIHRdCeBKCJ+xnTzf3/pe20="));
}

#[tokio::test]
async fn an_owner_mint_names_nobody() {
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = seen.clone();
    let base = serve(Router::new().route(
        "/v1/drive-invites/email",
        post(move |Json(b): Json<serde_json::Value>| async move {
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "invite_id": "x" }))
        }),
    ))
    .await;
    http_email_invite(&reqwest::Client::new(), &base, BEARER, &body("ada@example.com", None))
        .await
        .expect("mint");
    assert!(seen.lock().unwrap()[0].get("owner_ss58").is_none());
}

async fn failing(status: StatusCode, json: serde_json::Value, retry_after: Option<&'static str>) -> AppError {
    let base = serve(Router::new().route(
        "/v1/drive-invites/email",
        post(move || async move {
            let mut resp = (status, Json(json)).into_response();
            if let Some(v) = retry_after {
                resp.headers_mut().insert("retry-after", v.parse().unwrap());
            }
            resp
        }),
    ))
    .await;
    http_email_invite(&reqwest::Client::new(), &base, BEARER, &body("ada@example.com", None))
        .await
        .expect_err("must fail")
}

#[tokio::test]
async fn no_mail_service_hides_the_option() {
    let err = failing(
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({"error": "email_invites_unavailable", "message": "no mail"}),
        None,
    )
    .await;
    assert!(matches!(err, AppError::NotReady(NotReadyKind::EmailInvitesUnavailable)), "got {err:?}");
}

#[tokio::test]
async fn rate_limit_says_how_long_to_wait() {
    let err = failing(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({"error": "rate_limited", "message": "slow down", "retry_after_secs": 125}),
        None,
    )
    .await;
    match err {
        AppError::NotReady(NotReadyKind::RateLimited { message }) => {
            assert_eq!(message, "Too many invites sent recently. Try again in 3 minutes.");
        }
        other => panic!("expected RateLimited, got {other:?}"),
    }

    // The header is the fallback when the body carries no figure, and the
    // server's reason says which limit was hit.
    let err = failing(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({
            "error": "rate_limited",
            "message": "You have sent too many invitations to this address in the last day",
        }),
        Some("86400"),
    )
    .await;
    match err {
        AppError::NotReady(NotReadyKind::RateLimited { message }) => {
            assert_eq!(message, "You've sent too many invites to this address today. Try again in 24h.");
        }
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

#[tokio::test]
async fn a_failed_send_says_try_again() {
    let err = failing(
        StatusCode::BAD_GATEWAY,
        serde_json::json!({"error": "mail_send_failed", "message": "smtp down"}),
        None,
    )
    .await;
    match err {
        AppError::Validation(msg) => assert!(msg.contains("Try again"), "{msg}"),
        other => panic!("expected Validation, got {other:?}"),
    }
}

#[tokio::test]
async fn the_listing_carries_the_mailed_invite_fields() {
    let base = serve(Router::new().route(
        "/v1/drives/{fh}/invites",
        get(|| async {
            Json(serde_json::json!({ "invites": [{
                "invite_id": "i1", "role": "writer", "minted_by": "5Owner",
                "expires_at": "2126-01-01T00:00:00Z", "max_uses": 1, "use_count": 0,
                "revoked": false, "valid": true, "created_at": "2026-01-01T00:00:00Z",
                "recipient_email": "ada@example.com", "email_status": "awaiting_seal",
                "requester_ss58": "5Ada", "requester_pubkey": "e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM="
            }, {
                "invite_id": "i2", "role": "reader", "minted_by": "5Owner",
                "expires_at": "2126-01-01T00:00:00Z", "max_uses": 5, "use_count": 0,
                "revoked": false, "valid": true, "created_at": "2026-01-01T00:00:00Z"
            }]}))
        }),
    ))
    .await;
    let rows = http_list_invites(&reqwest::Client::new(), &base, BEARER, HASH, None).await.expect("list");
    assert_eq!(rows[0].recipient_email.as_deref(), Some("ada@example.com"));
    assert_eq!(rows[0].email_status.as_deref(), Some("awaiting_seal"));
    assert_eq!(rows[0].requester_pubkey.as_deref(), Some("e06Qm75//kTEZaIgA31gjuNYl9Me+XLwf3SJLLD3PxM="));
    assert_eq!(rows[1].email_status, None, "a link invite carries no mailed fields");

    // The public key is for the approve path only; it never crosses IPC.
    let wire = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(wire["recipientEmail"], "ada@example.com");
    assert_eq!(wire["emailStatus"], "awaiting_seal");
    assert!(wire.get("requesterPubkey").is_none());
}

/// One recorded seal-back PUT: invite id, raw query, JSON body.
type SealCall = (String, Option<String>, serde_json::Value);

#[tokio::test]
async fn seal_back_outcomes() {
    let queries: Arc<Mutex<Vec<SealCall>>> = Arc::default();
    let rec = queries.clone();
    let base = serve(Router::new().route(
        "/v1/drives/{fh}/invites/{id}/sealed-key",
        put(
            move |Path((_fh, id)): Path<(String, String)>, RawQuery(q): RawQuery, Json(b): Json<serde_json::Value>| async move {
                rec.lock().unwrap().push((id.clone(), q, b));
                match id.as_str() {
                    "ok" => StatusCode::NO_CONTENT.into_response(),
                    "dup" => (StatusCode::CONFLICT, Json(serde_json::json!({"error":"already_sealed","message":"x"}))).into_response(),
                    "stale" => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"not_found","message":"x"}))).into_response(),
                    _ => StatusCode::NOT_FOUND.into_response(),
                }
            },
        ),
    ))
    .await;
    let http = reqwest::Client::new();
    let put = |id: &'static str, owner: Option<&'static str>| {
        let http = http.clone();
        let base = base.clone();
        async move { http_put_sealed_key(&http, &base, BEARER, HASH, id, "blob", "pubkey", owner).await }
    };

    assert_eq!(put("ok", Some("5Owner")).await.unwrap(), SealKeyPut::Sealed);
    assert_eq!(put("dup", None).await.unwrap(), SealKeyPut::AlreadySealed);
    assert_eq!(put("stale", None).await.unwrap(), SealKeyPut::Stale);
    assert!(put("bare", None).await.is_err(), "a bare 404 is a feature-off server, not a stale row");

    let seen = queries.lock().unwrap();
    assert_eq!(seen[0].1.as_deref(), Some("owner=5Owner"), "delegated seal names the owner");
    assert_eq!(seen[0].2["sealed_key"], "blob");
    assert_eq!(seen[0].2["sealed_for"], "pubkey", "sealed_for echoes the exact requester key");
    assert_eq!(seen[1].1, None);
}

/// The account's invite key goes up as the public half only, to the
/// account-level route, under the user's bearer.
#[tokio::test]
async fn publishing_the_invite_key_puts_the_public_half() {
    let seen: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = seen.clone();
    let base = serve(Router::new().route(
        "/v1/account/invite-key",
        put(move |headers: HeaderMap, Json(b): Json<serde_json::Value>| async move {
            assert_eq!(headers.get("authorization").unwrap(), &format!("Bearer {BEARER}"));
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "status": "ok" }))
        }),
    ))
    .await;

    http_put_account_invite_key(&reqwest::Client::new(), &base, BEARER, "PUBKEY")
        .await
        .expect("publish");

    assert_eq!(seen.lock().unwrap().as_slice(), [serde_json::json!({ "pubkey": "PUBKEY" })]);
}

/// A refusal is an error, so the auto-seal task retries next pass rather
/// than remembering a publish that never landed.
#[tokio::test]
async fn a_refused_publish_is_an_error() {
    let base = serve(Router::new().route(
        "/v1/account/invite-key",
        put(|| async {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "bad_request", "message": "pubkey is not a usable X25519 public key" })),
            )
        }),
    ))
    .await;

    assert!(
        http_put_account_invite_key(&reqwest::Client::new(), &base, BEARER, "PUBKEY")
            .await
            .is_err()
    );
}
