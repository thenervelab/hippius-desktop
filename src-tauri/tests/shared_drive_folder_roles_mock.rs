//! Folder roles (assumed until HCFS publishes them; see
//! `shared_drives::folder_roles`), against a mock axum server: the role
//! PATCH's shape and delegation, and listings whose folder grants omit the
//! role still parsing, with the grant read as a Viewer.

use axum::{
    Json, Router,
    extract::{Path, RawQuery},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch},
};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

use tauri_project_lib::error::AppError;
use tauri_project_lib::shared_drives::commands::{MintInvite, http_create_invite, http_list_members, http_list_memberships};
use tauri_project_lib::shared_drives::folder_roles::http_change_folder_grant_role;

const BEARER: &str = "test-bearer-token";

async fn serve(router: Router) -> String {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("serve");
    });
    format!("http://{addr}")
}

/// One recorded role PATCH: path member, raw query, JSON body.
type RoleCall = (String, Option<String>, serde_json::Value);

#[tokio::test]
async fn a_role_change_patches_the_grant_and_names_the_owner_when_delegated() {
    let calls: Arc<Mutex<Vec<RoleCall>>> = Arc::default();
    let rec = calls.clone();
    let base = serve(Router::new().route(
        "/v1/drives/{fh}/grants/{member}",
        patch(
            move |Path((_fh, member)): Path<(String, String)>, RawQuery(q): RawQuery, Json(b): Json<serde_json::Value>| async move {
                rec.lock().unwrap().push((member.clone(), q, b));
                if member == "5Gone" {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(serde_json::json!({"error":"not_found","message":"No such grant"})),
                    )
                        .into_response();
                }
                StatusCode::NO_CONTENT.into_response()
            },
        ),
    ))
    .await;
    let http = reqwest::Client::new();

    http_change_folder_grant_role(&http, &base, BEARER, "hash", "5Holder", "writer", Some("5Owner"))
        .await
        .expect("patch");
    http_change_folder_grant_role(&http, &base, BEARER, "hash", "5Holder", "manager", None)
        .await
        .expect("patch");
    let err = http_change_folder_grant_role(&http, &base, BEARER, "hash", "5Gone", "reader", None)
        .await
        .expect_err("gone");
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");

    let seen = calls.lock().unwrap();
    assert_eq!(seen[0].0, "5Holder");
    assert_eq!(seen[0].1.as_deref(), Some("owner=5Owner"));
    assert_eq!(seen[0].2, serde_json::json!({ "role": "writer" }));
    assert_eq!(seen[1].1, None, "an owner names nobody");
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
                            {"member_ss58": "5B", "path_prefix": "Clients/x", "created_at": "t", "role": "manager"}
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
    assert_eq!(members.folder_grants[1].role, "manager");
}

#[tokio::test]
async fn a_folder_invite_carries_the_chosen_role_and_uses() {
    let bodies: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let rec = bodies.clone();
    let base = serve(Router::new().route(
        "/v1/drive-invites",
        axum::routing::post(move |Json(b): Json<serde_json::Value>| async move {
            let prefix = b["path_prefix"].clone();
            rec.lock().unwrap().push(b);
            Json(serde_json::json!({ "invite_token": "tok", "path_prefix": prefix }))
        }),
    ))
    .await;
    http_create_invite(
        &reqwest::Client::new(),
        &base,
        BEARER,
        MintInvite {
            folder_hash: "hash",
            expires_in_secs: 3600,
            max_uses: 3,
            role: "writer",
            owner: Some("5Owner"),
            path_prefix: Some("Clients/ACME"),
        },
    )
    .await
    .expect("mint");
    let sent = bodies.lock().unwrap()[0].clone();
    assert_eq!(sent["role"], "writer");
    assert_eq!(sent["max_uses"], 3);
    assert_eq!(sent["path_prefix"], "Clients/ACME");
    assert_eq!(sent["owner_ss58"], "5Owner");
}
