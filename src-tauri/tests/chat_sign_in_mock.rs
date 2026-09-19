//! Team-chat OIDC sign-in against a mock issuer + homeserver.
//!
//! Drives the real `chat::sign_in` flow — discovery, auth metadata, dynamic
//! registration, loopback listener, PKCE code exchange, `/whoami`, session
//! assembly, refresh — with an axum server standing in for
//! matrix-authentication-service and the homeserver. The "browser" is a
//! reqwest client following the authorize redirect to the loopback port.
//!
//! What this pins that unit tests cannot:
//! - the registered redirect URI is port-less and the per-flow one carries
//!   the ephemeral port (RFC 8252 loopback matching, the reason the desktop
//!   can use `http://127.0.0.1` at all);
//! - the code exchange sends the SAME `redirect_uri` the authorize leg used
//!   and a `code_verifier` whose S256 hash equals the advertised challenge;
//! - a server that binds the token to a different device than requested is
//!   rejected (the crypto stores are keyed by device id);
//! - `invalid_grant` on refresh is surfaced as a typed OAuth error.
//!
//! No Tauri `AppHandle`, no keyring, no live server.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    Form, Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect},
    routing::{get, post},
};
use serde::Deserialize;
use tauri_project_lib::chat::sign_in::{
    self, AuthMetadata, BeginParams, REGISTERED_REDIRECT_URI, TokenError, code_challenge, discover_base_url, fetch_auth_metadata, refresh_grant,
    register_client,
};
use tokio::net::TcpListener;

#[derive(Default)]
struct Issuer {
    base: String,
    registrations: Vec<serde_json::Value>,
    /// code → (client_id, redirect_uri, code_challenge)
    codes: HashMap<String, (String, String, String)>,
    /// access token → device id the token is bound to
    tokens: HashMap<String, String>,
    exchanges: Vec<HashMap<String, String>>,
    /// Device id `/whoami` reports; `None` echoes the scope's device.
    whoami_device_override: Option<String>,
    refresh_valid: bool,
}

type Shared = Arc<Mutex<Issuer>>;

async fn well_known(State(s): State<Shared>) -> Json<serde_json::Value> {
    let base = s.lock().unwrap().base.clone();
    Json(serde_json::json!({ "m.homeserver": { "base_url": base } }))
}

async fn auth_metadata(State(s): State<Shared>) -> Json<AuthMetadata> {
    let base = s.lock().unwrap().base.clone();
    Json(AuthMetadata {
        issuer: format!("{base}/"),
        authorization_endpoint: format!("{base}/authorize"),
        token_endpoint: format!("{base}/oauth2/token"),
        registration_endpoint: Some(format!("{base}/oauth2/registration")),
        revocation_endpoint: Some(format!("{base}/oauth2/revoke")),
        account_management_uri: None,
    })
}

async fn registration(State(s): State<Shared>, Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    // MAS rejects custom schemes and non-loopback hosts for native clients.
    let uris = body["redirect_uris"].as_array().cloned().unwrap_or_default();
    let ok = uris.iter().all(|u| u.as_str().is_some_and(|u| u == REGISTERED_REDIRECT_URI));
    if !ok || body["application_type"] != "native" || body["token_endpoint_auth_method"] != "none" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error":"invalid_redirect_uri","error_description":"redirect_uri is not using a valid domain"})),
        );
    }
    let mut st = s.lock().unwrap();
    st.registrations.push(body);
    let id = format!("CLIENT{}", st.registrations.len());
    (StatusCode::CREATED, Json(serde_json::json!({ "client_id": id })))
}

#[derive(Deserialize)]
struct AuthorizeQuery {
    response_type: String,
    client_id: String,
    redirect_uri: String,
    scope: String,
    state: String,
    code_challenge: String,
    code_challenge_method: String,
}

/// The consent page, collapsed: validate and bounce straight back with a code.
async fn authorize(State(s): State<Shared>, Query(q): Query<AuthorizeQuery>) -> impl IntoResponse {
    assert_eq!(q.response_type, "code");
    assert_eq!(q.code_challenge_method, "S256");
    // RFC 8252 §7.3: loopback redirect matches ignoring the port.
    let uri = reqwest::Url::parse(&q.redirect_uri).unwrap();
    assert_eq!(uri.host_str(), Some("127.0.0.1"));
    assert_eq!(uri.path(), "/chat/callback");
    assert!(uri.port().is_some(), "per-flow redirect must carry the ephemeral port");
    let device = q
        .scope
        .split(' ')
        .find_map(|sc| sc.strip_prefix("urn:matrix:client:device:"))
        .expect("device scope")
        .to_string();
    let code = format!("code-for-{device}");
    s.lock()
        .unwrap()
        .codes
        .insert(code.clone(), (q.client_id, q.redirect_uri.clone(), q.code_challenge));
    let target = format!("{}?code={code}&state={}", q.redirect_uri, q.state);
    Redirect::to(&target)
}

async fn token(State(s): State<Shared>, Form(form): Form<HashMap<String, String>>) -> impl IntoResponse {
    let mut st = s.lock().unwrap();
    st.exchanges.push(form.clone());
    match form.get("grant_type").map(String::as_str) {
        Some("authorization_code") => {
            let Some((client_id, redirect_uri, challenge)) = st.codes.remove(form.get("code").map_or("", String::as_str)) else {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error":"invalid_grant","error_description":"unknown code"})),
                );
            };
            if form.get("client_id") != Some(&client_id) {
                return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error":"invalid_client"})));
            }
            if form.get("redirect_uri") != Some(&redirect_uri) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error":"invalid_grant","error_description":"redirect_uri mismatch"})),
                );
            }
            if form.get("code_verifier").map(|v| code_challenge(v)) != Some(challenge) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error":"invalid_grant","error_description":"pkce mismatch"})),
                );
            }
            let device = form["code"].trim_start_matches("code-for-").to_string();
            let access = format!("mat_{device}");
            st.tokens.insert(access.clone(), device);
            st.refresh_valid = true;
            (
                StatusCode::OK,
                Json(serde_json::json!({"access_token": access, "refresh_token": "mar_1", "expires_in": 300, "token_type": "Bearer"})),
            )
        }
        Some("refresh_token") => {
            if !st.refresh_valid || form.get("refresh_token").map(String::as_str) != Some("mar_1") {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error":"invalid_grant","error_description":"refresh token revoked"})),
                );
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({"access_token": "mat_refreshed", "refresh_token": "mar_2", "expires_in": 300})),
            )
        }
        _ => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"unsupported_grant_type"}))),
    }
}

async fn whoami(State(s): State<Shared>, headers: HeaderMap) -> impl IntoResponse {
    let st = s.lock().unwrap();
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let Some(device) = st.tokens.get(bearer) else {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"errcode":"M_UNKNOWN_TOKEN"})));
    };
    let device = st.whoami_device_override.clone().unwrap_or_else(|| device.clone());
    (
        StatusCode::OK,
        Json(serde_json::json!({"user_id": "@alice:hippius.com", "device_id": device})),
    )
}

async fn spawn_issuer() -> (String, Shared) {
    let shared: Shared = Arc::new(Mutex::new(Issuer {
        refresh_valid: false,
        ..Default::default()
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    shared.lock().unwrap().base.clone_from(&base);
    let app = Router::new()
        .route("/.well-known/matrix/client", get(well_known))
        .route("/_matrix/client/v1/auth_metadata", get(auth_metadata))
        .route("/oauth2/registration", post(registration))
        .route("/authorize", get(authorize))
        .route("/oauth2/token", post(token))
        .route("/_matrix/client/v3/account/whoami", get(whoami))
        .with_state(shared.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base, shared)
}

/// A browser that follows redirects (MAS → loopback) like a real one.
fn browser() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .unwrap()
}

#[tokio::test]
async fn full_sign_in_round_trip_through_loopback() {
    let (base, issuer) = spawn_issuer().await;
    let http = reqwest::Client::new();

    // Discovery + metadata + registration exactly as the command does them.
    let discovered = discover_base_url(&http, &base).await;
    assert_eq!(discovered, base, "well-known must win over the fallback");
    let metadata = fetch_auth_metadata(&http, &discovered).await.unwrap();
    let client_id = register_client(&http, &metadata).await.unwrap();
    assert_eq!(client_id, "CLIENT1");
    {
        let st = issuer.lock().unwrap();
        let reg = &st.registrations[0];
        assert_eq!(reg["redirect_uris"], serde_json::json!(["http://127.0.0.1/chat/callback"]));
        assert_eq!(reg["client_name"], "Hippius Desktop");
        assert_eq!(reg["grant_types"], serde_json::json!(["authorization_code", "refresh_token"]));
    }

    let (begun, pending) = sign_in::begin(BeginParams {
        http: &http,
        base_url: discovered.clone(),
        metadata: metadata.clone(),
        client_id: client_id.clone(),
    })
    .await
    .unwrap();
    let device_id = pending.device_id.clone();
    let redirect_uri = pending.redirect_uri.clone();
    assert!(redirect_uri.starts_with("http://127.0.0.1:") && redirect_uri.ends_with("/chat/callback"));

    // The browser leg, concurrent with the waiting flow.
    let b = browser();
    let url = begun.authorize_url.clone();
    let browser_leg = tokio::spawn(async move {
        let resp = b.get(url).send().await.unwrap();
        assert_eq!(resp.status(), 200);
        assert!(resp.text().await.unwrap().contains("Signed in to Hippius chat"));
    });

    let session = sign_in::complete(&http, pending, Duration::from_secs(10)).await.unwrap();
    browser_leg.await.unwrap();

    assert_eq!(session.user_id, "@alice:hippius.com");
    assert_eq!(session.device_id, device_id);
    assert_eq!(session.client_id, "CLIENT1");
    assert_eq!(session.base_url, base);
    assert_eq!(session.issuer, format!("{base}/"));
    assert_eq!(session.access_token, format!("mat_{device_id}"));
    assert_eq!(session.refresh_token.as_deref(), Some("mar_1"));
    assert!(session.expires_at.is_some());

    let st = issuer.lock().unwrap();
    let exchange = &st.exchanges[0];
    assert_eq!(exchange["grant_type"], "authorization_code");
    assert_eq!(
        exchange["redirect_uri"], redirect_uri,
        "exchange must echo the per-flow (ported) redirect"
    );
    assert_eq!(exchange["client_id"], "CLIENT1");
    assert!(exchange.contains_key("code_verifier"));
}

#[tokio::test]
async fn device_bound_to_another_id_is_refused() {
    let (base, issuer) = spawn_issuer().await;
    issuer.lock().unwrap().whoami_device_override = Some("SOMEONEELSE".into());
    let http = reqwest::Client::new();
    let metadata = fetch_auth_metadata(&http, &base).await.unwrap();
    let client_id = register_client(&http, &metadata).await.unwrap();
    let (begun, pending) = sign_in::begin(BeginParams {
        http: &http,
        base_url: base.clone(),
        metadata,
        client_id,
    })
    .await
    .unwrap();
    let b = browser();
    tokio::spawn(async move {
        let _ = b.get(begun.authorize_url).send().await;
    });
    let err = sign_in::complete(&http, pending, Duration::from_secs(10)).await.unwrap_err();
    assert!(err.to_string().contains("bound the session to device"), "{err}");
}

#[tokio::test]
async fn user_denial_at_the_issuer_surfaces_as_refused() {
    let (base, _issuer) = spawn_issuer().await;
    let http = reqwest::Client::new();
    let metadata = fetch_auth_metadata(&http, &base).await.unwrap();
    let (begun, pending) = sign_in::begin(BeginParams {
        http: &http,
        base_url: base,
        metadata,
        client_id: "CLIENT1".into(),
    })
    .await
    .unwrap();
    // Simulate the issuer redirecting with an error instead of a code.
    let parsed = reqwest::Url::parse(&begun.authorize_url).unwrap();
    let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
    let denial = format!(
        "{}?error=access_denied&error_description=User+declined&state={}",
        q["redirect_uri"], q["state"]
    );
    tokio::spawn(async move {
        let _ = reqwest::get(denial).await;
    });
    let err = sign_in::complete(&http, pending, Duration::from_secs(10)).await.unwrap_err();
    assert!(err.to_string().contains("access_denied"), "{err}");
}

#[tokio::test]
async fn cancelled_flow_frees_the_port_and_complete_times_out_cleanly() {
    let (base, _issuer) = spawn_issuer().await;
    let http = reqwest::Client::new();
    let metadata = fetch_auth_metadata(&http, &base).await.unwrap();
    let (_begun, pending) = sign_in::begin(BeginParams {
        http: &http,
        base_url: base,
        metadata,
        client_id: "CLIENT1".into(),
    })
    .await
    .unwrap();
    let redirect = pending.redirect_uri.clone();
    // Nobody comes back: a short timeout ends the wait with a typed error.
    let err = sign_in::complete(&http, pending, Duration::from_millis(200)).await.unwrap_err();
    assert!(err.to_string().contains("timed out"), "{err}");
    // Dropping the flow aborted the listener; the port no longer answers.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(reqwest::Client::new().get(redirect).timeout(Duration::from_secs(1)).send().await.is_err());
}

#[tokio::test]
async fn refresh_rotates_and_a_dead_refresh_token_is_invalid_grant() {
    let (base, issuer) = spawn_issuer().await;
    let http = reqwest::Client::new();
    let metadata = fetch_auth_metadata(&http, &base).await.unwrap();
    issuer.lock().unwrap().refresh_valid = true;
    let t = refresh_grant(&http, &metadata.token_endpoint, "CLIENT1", "mar_1").await.unwrap();
    assert_eq!(t.access_token, "mat_refreshed");
    assert_eq!(t.refresh_token.as_deref(), Some("mar_2"));

    issuer.lock().unwrap().refresh_valid = false;
    match refresh_grant(&http, &metadata.token_endpoint, "CLIENT1", "mar_1").await {
        Err(TokenError::OAuth { error, .. }) => assert_eq!(error, "invalid_grant"),
        other => panic!("expected invalid_grant, got {other:?}"),
    }
}

#[tokio::test]
async fn discovery_falls_back_when_well_known_is_absent() {
    // A bare listener with no routes: 404 on well-known.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, Router::new()).await.unwrap() });
    let http = reqwest::Client::new();
    assert_eq!(
        discover_base_url(&http, &base).await,
        tauri_project_lib::chat::config::CHAT_FALLBACK_BASE_URL
    );
}
