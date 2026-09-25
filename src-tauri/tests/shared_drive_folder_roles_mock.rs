//! Folder invites and folder roles (HCFS #475; see
//! `shared_drives::folder_roles`), against a mock axum server: what a folder
//! mint sends, how each refusal comes back as a structured "coming soon"
//! kind, that a server which ignores the folder never yields a usable
//! whole-drive invite, and listings whose grants omit the role still parsing.

use axum::{
    Json, Router,
    extract::Path,
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::error::{AppError, NotReadyKind};
use tauri_project_lib::shared_drives::commands::{
    EmailInviteBody, MintInvite, ReplacedFolderGrants, http_create_invite, http_email_invite, http_list_members, http_list_memberships,
    http_replace_folder_grants,
};

const BEARER: &str = "test-bearer-token";

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    format!("http://{addr}")
}

fn folder_mint<'a>(role: &'a str, path_prefix: Option<&'a str>) -> MintInvite<'a> {
    MintInvite {
        folder_hash: "hash",
        expires_in_secs: 3600,
        max_uses: 1,
        role,
        path_prefix,
    }
}

/// A server that answers every mint with `400 bad_request <message>`.
async fn refusing(message: &'static str) -> String {
    serve(Router::new().route(
        "/v1/drive-invites",
        post(move || async move {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "bad_request", "message": message })),
            )
        }),
    ))
    .await
}

#[tokio::test]
async fn a_folder_invite_is_single_use_and_carries_the_folder_and_role() {
    let bodies: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = bodies.clone();
    let base = serve(Router::new().route(
        "/v1/drive-invites",
        post(move |Json(b): Json<serde_json::Value>| async move {
            let prefix = b["path_prefix"].clone();
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "invite_token": "tok", "path_prefix": prefix }))
        }),
    ))
    .await;
    http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("writer", Some("Clients/ACME")))
        .await
        .expect("mint");
    let sent = bodies.lock().unwrap()[0].clone();
    assert_eq!(sent["role"], "writer");
    assert_eq!(sent["max_uses"], 1);
    assert_eq!(sent["path_prefix"], "Clients/ACME");
    assert!(
        sent.get("owner_ss58").is_none_or(serde_json::Value::is_null),
        "only the owner mints, so nobody is named"
    );
}

#[tokio::test]
async fn folder_grants_off_reads_as_folder_sharing_coming_soon() {
    let base = refusing("folder invites are not enabled").await;
    let err = http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("reader", Some("Clients")))
        .await
        .expect_err("refused");
    assert!(matches!(err, AppError::NotReady(NotReadyKind::FolderInvitesUnavailable)), "{err:?}");
}

#[tokio::test]
async fn an_editor_folder_invite_refused_reads_as_editor_coming_soon() {
    // #475's wording, and the older server's for the same request.
    for message in ["writer folder invites are not enabled", "a folder invite is always a reader invite"] {
        let base = refusing(message).await;
        let err = http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("writer", Some("Clients")))
            .await
            .expect_err("refused");
        assert!(
            matches!(err, AppError::NotReady(NotReadyKind::FolderEditorInvitesUnavailable)),
            "{message}: {err:?}"
        );
    }
}

#[tokio::test]
async fn a_whole_drive_mint_never_reads_folder_refusals() {
    // The same words on a DRIVE mint are not a folder refusal.
    let base = refusing("folder invites are not enabled").await;
    let err = http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("reader", None))
        .await
        .expect_err("refused");
    assert!(matches!(err, AppError::Hcfs(_)), "{err:?}");
}

#[tokio::test]
async fn the_plan_gate_still_reads_as_not_entitled_on_a_folder_mint() {
    let base = serve(Router::new().route(
        "/v1/drive-invites",
        post(|| async {
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "error": "shared_drives_not_entitled",
                    "message": "Shared drives need a Plus, Max, or Scale plan"
                })),
            )
        }),
    ))
    .await;
    let err = http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("reader", Some("Clients")))
        .await
        .expect_err("refused");
    assert!(matches!(err, AppError::NotReady(NotReadyKind::SharedDrivesNotEntitled)), "{err:?}");
}

/// A server that ignores `path_prefix` mints a WHOLE-DRIVE invite. That token
/// must never come back, and the stray invite is revoked on the spot.
#[tokio::test]
async fn a_mint_without_the_folder_echo_is_revoked_and_refused() {
    let revoked: Arc<Mutex<Vec<String>>> = Arc::default();
    let rec = revoked.clone();
    let base = serve(
        Router::new()
            .route(
                "/v1/drive-invites",
                post(|| async { Json(serde_json::json!({ "invite_token": "whole-drive-token", "invite_id": "inv1" })) }),
            )
            .route(
                "/v1/drives/{fh}/invites/{id}",
                delete(move |Path((_fh, id)): Path<(String, String)>| async move {
                    rec.lock().unwrap().push(id);
                    StatusCode::NO_CONTENT.into_response()
                }),
            ),
    )
    .await;
    let err = http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("reader", Some("Clients")))
        .await
        .expect_err("a whole-drive invite is not a folder invite");
    assert!(matches!(err, AppError::NotReady(NotReadyKind::FolderInvitesUnavailable)), "{err:?}");
    assert_eq!(*revoked.lock().unwrap(), ["inv1"], "the stray whole-drive invite is revoked");
}

#[tokio::test]
async fn an_empty_folder_is_refused_without_a_request() {
    let hits: Arc<Mutex<u32>> = Arc::default();
    let rec = hits.clone();
    let base = serve(Router::new().route(
        "/v1/drive-invites",
        post(move || async move {
            *rec.lock().unwrap() += 1;
            Json(serde_json::json!({ "invite_token": "tok" }))
        }),
    ))
    .await;
    for empty in ["", "/"] {
        let err = http_create_invite(&reqwest::Client::new(), &base, BEARER, folder_mint("reader", Some(empty)))
            .await
            .expect_err("no folder");
        assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    }
    assert_eq!(*hits.lock().unwrap(), 0, "nothing reaches the server");
}

#[tokio::test]
async fn a_mailed_folder_invite_refused_reads_as_folder_email_coming_soon() {
    let base = serve(Router::new().route(
        "/v1/drive-invites/email",
        post(|| async {
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "bad_request",
                    "message": "folder invites cannot be mailed yet; mint a link instead"
                })),
            )
        }),
    ))
    .await;
    let err = http_email_invite(
        &reqwest::Client::new(),
        &base,
        BEARER,
        &EmailInviteBody {
            folder_hash: "hash",
            email: "a@example.com",
            role: "reader",
            expires_in_secs: 86_400,
            path_prefix: Some("Clients"),
        },
    )
    .await
    .expect_err("refused");
    assert!(matches!(err, AppError::NotReady(NotReadyKind::FolderEmailInvitesUnavailable)), "{err:?}");
}

#[tokio::test]
async fn listings_whose_grants_omit_the_role_still_parse_as_viewers() {
    let base = serve(
        Router::new()
            .route(
                "/v1/drive-memberships",
                get(|| async {
                    Json(serde_json::json!({
                        "memberships": [],
                        "folder_grants": [{
                            "owner_ss58": "5Owner", "folder_hash": "hash", "display_label": "Team",
                            "path_prefix": "Clients", "grant_blob": "", "created_at": "t"
                        }]
                    }))
                }),
            )
            .route(
                "/v1/drives/{fh}/members",
                get(|| async {
                    Json(serde_json::json!({
                        "members": [],
                        "folder_grants": [
                            {"member_ss58": "5A", "path_prefix": "Clients", "created_at": "t", "member_name": "Ada"},
                            {"member_ss58": "5B", "path_prefix": "Clients/x", "created_at": "t", "role": "writer"}
                        ]
                    }))
                }),
            ),
    )
    .await;
    let http = reqwest::Client::new();

    let mine = http_list_memberships(&http, &base, BEARER).await.expect("memberships parse");
    assert_eq!(mine.folder_grants[0].role, "reader");

    let members = http_list_members(&http, &base, BEARER, "hash", None).await.expect("members parse");
    assert_eq!(members.folder_grants[0].role, "reader");
    assert_eq!(members.folder_grants[0].member_name.as_deref(), Some("Ada"));
    assert_eq!(members.folder_grants[1].role, "writer");
}

/// Adding a folder to a holder sends the role for the ADDED folders and reads
/// back the role the server stored for each folder, in the prefixes' order.
#[tokio::test]
async fn adding_a_folder_sends_its_role_and_reads_back_each_stored_role() {
    let bodies: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::default();
    let rec = bodies.clone();
    let base = serve(Router::new().route(
        "/v1/drives/{hash}/grants/{member}",
        put(
            move |Path((_hash, member)): Path<(String, String)>, Json(b): Json<serde_json::Value>| async move {
                rec.lock().unwrap().push((member.clone(), b));
                Json(serde_json::json!({
                    "member_ss58": member,
                    "path_prefixes": ["Clients/ACME", "Work"],
                    "roles": ["reader", "writer"],
                }))
            },
        ),
    ))
    .await;
    let resp = http_replace_folder_grants(
        &reqwest::Client::new(),
        &base,
        BEARER,
        "hash",
        "5Holder",
        &["Clients/ACME".to_string(), "Work".to_string()],
        Some("writer"),
    )
    .await
    .expect("replace");
    let (member, sent) = bodies.lock().unwrap()[0].clone();
    assert_eq!(member, "5Holder");
    assert_eq!(sent["role"], "writer");
    assert_eq!(sent["path_prefixes"], serde_json::json!(["Clients/ACME", "Work"]));

    let replaced: ReplacedFolderGrants = resp.into();
    assert_eq!(replaced.path_prefixes, ["Clients/ACME", "Work"]);
    assert_eq!(replaced.roles, ["reader", "writer"], "an existing folder kept its role");
}

/// No role means the server's default (Viewer); the field is not sent at all.
#[tokio::test]
async fn narrowing_folders_sends_no_role() {
    let bodies: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = bodies.clone();
    let base = serve(Router::new().route(
        "/v1/drives/{hash}/grants/{member}",
        put(move |Json(b): Json<serde_json::Value>| async move {
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "member_ss58": "5Holder", "path_prefixes": ["Work"], "roles": ["writer"] }))
        }),
    ))
    .await;
    http_replace_folder_grants(&reqwest::Client::new(), &base, BEARER, "hash", "5Holder", &["Work".to_string()], None)
        .await
        .expect("replace");
    assert!(bodies.lock().unwrap()[0].get("role").is_none());
}

/// An Editor folder while the server has writer grants off is the Editor
/// coming-soon kind, and folder grants off is folder sharing coming soon.
#[tokio::test]
async fn a_refused_folder_replace_reads_as_coming_soon() {
    for (message, want_editor) in [("writer folder grants are not enabled", true), ("folder grants are not enabled", false)] {
        let base = serve(Router::new().route(
            "/v1/drives/{hash}/grants/{member}",
            put(move || async move {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({ "error": "bad_request", "message": message })),
                )
            }),
        ))
        .await;
        let err = http_replace_folder_grants(
            &reqwest::Client::new(),
            &base,
            BEARER,
            "hash",
            "5Holder",
            &["Work".to_string()],
            Some("writer"),
        )
        .await
        .expect_err("refused");
        let got = match err {
            AppError::NotReady(NotReadyKind::FolderEditorInvitesUnavailable) => true,
            AppError::NotReady(NotReadyKind::FolderInvitesUnavailable) => false,
            other => panic!("{message}: unexpected {other:?}"),
        };
        assert_eq!(got, want_editor, "{message}");
    }
}
