//! The share key behind a link-secret file link (`#s=`, thenervelab/hcfs#1253).
//!
//! A `#k=` link's keystore row is the share key itself, which the owner's
//! comment key derives from (`shares::insights`). A `#s=` row holds only the
//! link secret: the share key is sealed in an envelope the server hands out at
//! `GET /v1/shares/{token}/link-key` to whoever proves the secret
//! ([`HcfsClient::open_file_link`]), the way a recipient opens the link.
//!
//! That route answers its bodiless 404 once the link has an email gate (the
//! owner's bearer does not pass the gate) or has ended, which is exactly when
//! the owner still reads the link's comments and verified viewer emails. So
//! each mint opens the envelope once, right after the link exists and before
//! either can hold, and keeps the share key in its own table
//! ([`FileLinkKeys`], `share_file_link_key`), never in the keystore, whose
//! rows rebuild URLs. Turning on an email gate tries again first
//! ([`keep_before_gate`]), so a failed GET at the mint is not the last chance.
//!
//! A kept key lives exactly as long as its keystore secret: the keystore's
//! `put` and `forget` delete it. Revoking a link forgets its secret (hcfs-client
//! `revoke_share`), so a revoked `#s=` link's comments become unreadable here,
//! as a revoked `#k=` link's do; an expired link keeps both.
//!
//! A link minted on another device has no kept key here, only the link secret
//! its owner wrap carries. It is opened on first use: through `link-key`, and
//! when that refuses (an email gate), through the owner's own route,
//! `GET /v1/shares/{token}/owner-link-key` ([`OwnerRoute`]), which takes the
//! owner's bearer in place of a viewer pass plus the same proof, and answers
//! the same envelope. The key is then kept, so the next read is local. An
//! ended link is refused by both routes, as is a server without the owner
//! route.
//!
//! A `#sp=` link's secret is under its password, so its share key is never
//! opened or stored, as for a `#p=` link.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hcfs_client::client::HcfsClient;
use hcfs_client::client::folder_link::{folder_link_fetch_proof, open_folder_link_envelope};
use hcfs_client::client::share::{ShareError, ShareKeystore, ShareSecret};
use hcfs_shared::shares::FOLDER_LINK_PROOF_HEADER;
use serde::Deserialize;
use sqlx::sqlite::SqlitePool;
use tracing::warn;

use super::SqliteShareKeystore;
use super::insights::{Api, REQUEST_TIMEOUT};

/// The kept share keys of `#s=` links, by token (`share_file_link_key`).
/// Read only for the comment key; no URL is ever built from one.
#[derive(Clone, Debug)]
pub(crate) struct FileLinkKeys {
    pool: SqlitePool,
}

impl FileLinkKeys {
    pub(crate) fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The share key kept for `token`, if any.
    pub(crate) async fn get(&self, token: &str) -> Result<Option<[u8; 32]>, ShareError> {
        let stored: Option<Vec<u8>> = sqlx::query_scalar("SELECT share_key FROM share_file_link_key WHERE share_token = ?")
            .bind(token)
            .fetch_optional(&self.pool)
            .await
            .map_err(keys_db)?;
        stored
            .map(|bytes| <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| keys_db("kept share key is not 32 bytes")))
            .transpose()
    }

    /// Keep `share_key` for `token`, only while the keystore still holds
    /// `link_secret` for it as a `file_link` row. So a password link's share
    /// key is never stored, and a key opened under a secret that has since
    /// been replaced or forgotten is dropped rather than paired with the new
    /// one.
    pub(crate) async fn keep(&self, token: &str, link_secret: &[u8; 32], share_key: &[u8; 32]) -> Result<(), ShareError> {
        sqlx::query(
            "INSERT INTO share_file_link_key (share_token, share_key) \
             SELECT ?1, ?2 WHERE EXISTS ( \
                 SELECT 1 FROM share_keystore \
                 WHERE share_token = ?1 AND secret_kind = 'file_link' AND share_key = ?3) \
             ON CONFLICT(share_token) DO UPDATE SET share_key = excluded.share_key",
        )
        .bind(token)
        .bind(share_key.as_slice())
        .bind(link_secret.as_slice())
        .execute(&self.pool)
        .await
        .map(|_| ())
        .map_err(keys_db)
    }
}

fn keys_db(e: impl std::fmt::Display) -> ShareError {
    ShareError::Keystore(format!("share_file_link_key: {e}"))
}

/// The owner's way to a link's envelope: the server and the owner's bearer.
/// Asked only once `link-key` refuses, so a link without a gate costs the
/// same one anonymous GET as before.
pub(crate) struct OwnerRoute<'a> {
    pub(crate) http: &'a reqwest::Client,
    pub(crate) api: &'a Api,
}

/// Body of a `200` from either link-key route.
#[derive(Deserialize)]
struct EnvelopeWire {
    /// Standard base64 of the envelope.
    envelope: String,
}

/// `GET /v1/shares/{token}/owner-link-key`: the owner's bearer and the link
/// proof, answered with the envelope `link-key` would give, gate or no gate.
///
/// # Errors
///
/// [`ShareError::NotFound`] for the route's bodiless 404 (an ended link,
/// another account's link, a `#k=` link, a wrong secret, or a server without
/// the route) and for a token that is not one path segment;
/// [`ShareError::Crypto`] when the envelope does not open under the secret;
/// otherwise [`ShareError::Network`] or [`ShareError::Server`].
async fn open_as_owner(owner: &OwnerRoute<'_>, token: &str, link_secret: &[u8; 32]) -> Result<[u8; 32], ShareError> {
    let url = owner.api.share_url(token, "/owner-link-key").map_err(|_| ShareError::NotFound)?;
    let resp = owner
        .http
        .get(url)
        .bearer_auth(&owner.api.bearer)
        .header(FOLDER_LINK_PROOF_HEADER, folder_link_fetch_proof(link_secret))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        // The URL carries the token, which is a capability: never in an error.
        .map_err(|e| ShareError::Network(e.without_url().to_string()))?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(ShareError::NotFound);
    }
    let bad_answer = |message: &str| ShareError::Server {
        status: status.as_u16(),
        message: format!("owner link key: {message}"),
    };
    if !status.is_success() {
        return Err(bad_answer("refused"));
    }
    let wire: EnvelopeWire = resp.json().await.map_err(|_| bad_answer("not the envelope"))?;
    // A body that is not base64 is the server's fault, not a wrong secret.
    let envelope = STANDARD
        .decode(wire.envelope)
        .map_err(|_| bad_answer("envelope is not standard base64"))?;
    let share_key = open_folder_link_envelope(link_secret, &envelope)?;
    Ok(*share_key.as_bytes())
}

/// The share key behind `token`'s `#s=` link: the one kept, else opened
/// through the link-key route (one anonymous GET), else, when that route
/// refuses and `owner` is given, through the owner's route; then kept.
///
/// # Errors
///
/// [`ShareError::NotFound`] when nothing is kept and every route asked
/// refuses the envelope (an ended link, a wrong secret; an email gate when
/// no `owner` is given); the table's error if its read fails; otherwise the
/// transport and crypto variants of either route. A failure to keep a key
/// that did open is only logged.
pub(crate) async fn share_key(
    client: &HcfsClient,
    owner: Option<&OwnerRoute<'_>>,
    keys: &FileLinkKeys,
    token: &str,
    link_secret: &[u8; 32],
) -> Result<[u8; 32], ShareError> {
    if let Some(kept) = keys.get(token).await? {
        return Ok(kept);
    }
    let share_key = match client.open_file_link(token, link_secret).await {
        Ok(opened) => *opened.as_bytes(),
        // The recipient route refuses a gated link to everyone without a
        // viewer pass, its owner included; the owner's route does not.
        Err(ShareError::NotFound) => match owner {
            Some(owner) => open_as_owner(owner, token, link_secret).await?,
            None => return Err(ShareError::NotFound),
        },
        Err(e) => return Err(e),
    };
    if let Err(e) = keys.keep(token, link_secret, &share_key).await {
        warn!(error = %e, "file link share key opened but not kept");
    }
    Ok(share_key)
}

/// After a file mint: open and keep the new link's share key when the mint
/// stored a `#s=` secret. Does nothing for any other secret, and never fails
/// the mint: the link is already live, and without a kept key its share key
/// is fetched again before an email gate or on first use.
pub(crate) async fn keep_after_mint(client: &HcfsClient, keystore: &SqliteShareKeystore, keys: &FileLinkKeys, token: &str) {
    let link_secret = match keystore.get(token) {
        Ok(Some(ShareSecret::FileLink(link_secret))) => link_secret,
        Ok(_) => return,
        Err(e) => {
            warn!(error = %e, "new file link's secret unreadable; its share key is not kept");
            return;
        }
    };
    // A link this new has no gate yet: the anonymous route is enough.
    if let Err(e) = share_key(client, None, keys, token, &link_secret).await {
        warn!(error = %e, "new file link's share key not kept; it is fetched again before an email gate");
    }
}

/// Before an email gate goes on a `#s=` link: make sure its share key is kept,
/// since the gate ends the server handing it out. Done when the key is kept
/// or opens now, and when no key can be had anyway, so the gate costs nothing:
/// the server already refuses the envelope (ended, or a server without the
/// owner route over a gated link), or the envelope does not open under this
/// secret. A link already gated, made on another device, opens through the
/// owner route here.
///
/// # Errors
///
/// A table failure, or a transport or server failure that left the key
/// unknown: the caller holds the gate back rather than lose the key.
pub(crate) async fn keep_before_gate(
    client: &HcfsClient,
    owner: Option<&OwnerRoute<'_>>,
    keys: &FileLinkKeys,
    token: &str,
    link_secret: &[u8; 32],
) -> Result<(), ShareError> {
    match share_key(client, owner, keys, token, link_secret).await {
        Ok(_) | Err(ShareError::NotFound | ShareError::Crypto(_)) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::extract::Path;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use hcfs_client::client::HcfsClientConfig;
    use hcfs_client::client::folder_link::{FolderLinkMint, mint_folder_link};
    use hcfs_crypto::FileKey;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use tempfile::TempDir;

    const TOKEN: &str = "abcdefghijabcdefghijab";
    const SHARE_KEY: [u8; 32] = [0x42; 32];
    /// A valid BIP-39 phrase, the account's in the owner wrap test.
    const TEST_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    /// The file link envelope is the folder link envelope (hcfs-client
    /// `file_link` module docs), so `mint_folder_link` seals one the way
    /// `create_share` does: the share key under a fresh link secret.
    fn sealed_link() -> ([u8; 32], Vec<u8>) {
        let FolderLinkMint { secret, link_envelope, .. } = mint_folder_link(&FileKey::from_bytes(SHARE_KEY), None).expect("mint");
        let ShareSecret::FolderLink(link_secret) = secret else {
            panic!("a passwordless mint keeps a public link secret");
        };
        (link_secret, link_envelope)
    }

    /// The owner's bearer the owner route accepts.
    const OWNER_BEARER: &str = "owner-bearer";

    /// The two link-key routes. `link-key`: the envelope while `open`,
    /// otherwise the bodiless 404 the server gives a gated or ended link.
    /// `owner-link-key`: the envelope (or `owner_envelope` when set) to the
    /// owner's bearer with the right proof while `owner_open`, a bodiless 404
    /// otherwise, or `owner_status` when set. Counts requests to each.
    struct LinkKeyRoute {
        envelope: Vec<u8>,
        /// `x-hippius-link-proof` the link's secret gives.
        proof: String,
        open: AtomicBool,
        hits: AtomicU32,
        owner_open: AtomicBool,
        owner_envelope: std::sync::Mutex<Option<Vec<u8>>>,
        owner_status: std::sync::Mutex<Option<StatusCode>>,
        owner_hits: AtomicU32,
    }

    fn route_for(link_secret: &[u8; 32], envelope: Vec<u8>) -> Arc<LinkKeyRoute> {
        Arc::new(LinkKeyRoute {
            envelope,
            proof: folder_link_fetch_proof(link_secret),
            open: AtomicBool::new(true),
            hits: AtomicU32::new(0),
            owner_open: AtomicBool::new(true),
            owner_envelope: std::sync::Mutex::new(None),
            owner_status: std::sync::Mutex::new(None),
            owner_hits: AtomicU32::new(0),
        })
    }

    fn route(envelope: Vec<u8>) -> Arc<LinkKeyRoute> {
        route_for(&[0; 32], envelope)
    }

    fn envelope_answer(envelope: &[u8]) -> axum::response::Response {
        axum::Json(serde_json::json!({ "envelope": STANDARD.encode(envelope) })).into_response()
    }

    /// The server's base URL and an `HcfsClient` against it.
    async fn serve_at(route: Arc<LinkKeyRoute>) -> (String, HcfsClient) {
        let anonymous = Arc::clone(&route);
        let router = Router::new()
            .route(
                "/v1/shares/{token}/link-key",
                get(move |Path(token): Path<String>, headers: HeaderMap| {
                    let route = Arc::clone(&anonymous);
                    async move {
                        route.hits.fetch_add(1, Ordering::SeqCst);
                        let proved = headers.contains_key(hcfs_shared::shares::FOLDER_LINK_PROOF_HEADER);
                        if token != TOKEN || !proved || !route.open.load(Ordering::SeqCst) {
                            return StatusCode::NOT_FOUND.into_response();
                        }
                        envelope_answer(&route.envelope)
                    }
                }),
            )
            .route(
                "/v1/shares/{token}/owner-link-key",
                get(move |Path(token): Path<String>, headers: HeaderMap| {
                    let route = Arc::clone(&route);
                    async move {
                        route.owner_hits.fetch_add(1, Ordering::SeqCst);
                        if let Some(status) = *route.owner_status.lock().unwrap() {
                            return status.into_response();
                        }
                        let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
                        let owner = header("authorization").as_deref() == Some(&format!("Bearer {OWNER_BEARER}"));
                        let proved = header(hcfs_shared::shares::FOLDER_LINK_PROOF_HEADER).as_deref() == Some(route.proof.as_str());
                        if token != TOKEN || !owner || !proved || !route.owner_open.load(Ordering::SeqCst) {
                            return StatusCode::NOT_FOUND.into_response();
                        }
                        let envelope = route.owner_envelope.lock().unwrap().clone().unwrap_or_else(|| route.envelope.clone());
                        envelope_answer(&envelope)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        // Detached: the server lives until the test's runtime shuts down.
        tokio::spawn(async move { axum::serve(listener, router).await });
        let base = format!("http://{addr}");
        let client = HcfsClient::new(HcfsClientConfig {
            base_url: base.clone(),
            ..HcfsClientConfig::default()
        })
        .expect("client");
        (base, client)
    }

    async fn serve(route: Arc<LinkKeyRoute>) -> HcfsClient {
        serve_at(route).await.1
    }

    async fn stores() -> (TempDir, SqliteShareKeystore, FileLinkKeys) {
        let dir = TempDir::new().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", dir.path().join("k.db").display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        (dir, SqliteShareKeystore::new(pool.clone()), FileLinkKeys::new(pool))
    }

    /// The reason the key is kept at mint: once the link has an email gate
    /// (or ends) the server refuses the envelope, and the owner still gets the
    /// link's share key from the one kept here, with no request.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_new_file_links_share_key_is_kept_and_outlives_the_link_key_route() {
        let (link_secret, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        keep_after_mint(&client, &keystore, &keys, TOKEN).await;
        assert_eq!(keys.get(TOKEN).await.expect("read"), Some(SHARE_KEY));

        route.open.store(false, Ordering::SeqCst);
        let hits = route.hits.load(Ordering::SeqCst);
        assert_eq!(share_key(&client, None, &keys, TOKEN, &link_secret).await.expect("kept"), SHARE_KEY);
        assert_eq!(route.hits.load(Ordering::SeqCst), hits, "a kept key costs no request");
    }

    /// A link minted elsewhere has no kept key: it opens on first use and is
    /// kept from then on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_link_minted_elsewhere_opens_on_first_use_and_is_kept() {
        let (link_secret, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        assert_eq!(share_key(&client, None, &keys, TOKEN, &link_secret).await.expect("opens"), SHARE_KEY);
        assert_eq!(share_key(&client, None, &keys, TOKEN, &link_secret).await.expect("kept"), SHARE_KEY);
        assert_eq!(route.hits.load(Ordering::SeqCst), 1);
    }

    /// With no kept key and a refused envelope there is no share key, and
    /// nothing is kept.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_gated_link_with_no_kept_key_has_no_share_key() {
        let (link_secret, envelope) = sealed_link();
        let route = route(envelope);
        route.open.store(false, Ordering::SeqCst);
        let client = serve(route).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        let err = share_key(&client, None, &keys, TOKEN, &link_secret).await.expect_err("refused");
        assert!(matches!(err, ShareError::NotFound), "{err:?}");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None);
    }

    /// The case this route exists for: a gated link made on another device.
    /// This device has only the link secret, from the owner wrap (a
    /// `link_public` wrap, flag 0x04, opened with the account's phrase), and
    /// `link-key` refuses it to the owner. The owner route opens it, the key
    /// is kept so the next read costs no request, and the comment key from it
    /// opens a viewer's email, which passes the server's `email_check`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_gated_link_made_elsewhere_opens_through_the_owner_route_and_its_emails_check() {
        use crate::shares::comment_crypto::{CommentKey, Purpose, email_check, open_viewer_email, seal_with_nonce};
        use crate::shares::owner_wrap::{derive_wrap_key, open_file_link_secret, seal_file_link_secret_with_key};

        const OWNER: &str = "5DSQAMowner";
        let (link_secret, envelope) = sealed_link();
        // The device that minted the link left its secret on the server,
        // sealed for the owner. This one opens it with the same phrase.
        let wrap_key = derive_wrap_key(TEST_PHRASE).expect("wrap key");
        let wrap = seal_file_link_secret_with_key(&wrap_key, OWNER, TOKEN, &link_secret).expect("wrap");
        let from_wrap = *open_file_link_secret(&derive_wrap_key(TEST_PHRASE).expect("wrap key"), OWNER, TOKEN, &wrap).expect("opens");
        assert_eq!(from_wrap, link_secret);

        let route = route_for(&from_wrap, envelope);
        route.open.store(false, Ordering::SeqCst);
        let (base, client) = serve_at(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(from_wrap)).expect("hydrated");
        let (http, api) = (reqwest::Client::new(), Api::new(&base, OWNER_BEARER));
        let owner = OwnerRoute { http: &http, api: &api };

        let share_key = share_key(&client, Some(&owner), &keys, TOKEN, &from_wrap).await.expect("owner route");
        assert_eq!(share_key, SHARE_KEY);
        assert_eq!(keys.get(TOKEN).await.expect("read"), Some(SHARE_KEY), "kept");
        assert_eq!(
            super::share_key(&client, Some(&owner), &keys, TOKEN, &from_wrap).await.expect("kept"),
            SHARE_KEY
        );
        assert_eq!(route.hits.load(Ordering::SeqCst), 1);
        assert_eq!(route.owner_hits.load(Ordering::SeqCst), 1, "the kept key costs no request");

        let email = "ada@example.com";
        let nonce = [9u8; 12];
        let ct = seal_with_nonce(&CommentKey::derive(&share_key), TOKEN, Purpose::ViewerEmail, &nonce, email.as_bytes()).expect("seal");
        let opened = open_viewer_email(
            &CommentKey::derive(&share_key),
            TOKEN,
            &STANDARD.encode(nonce),
            &STANDARD.encode(ct),
            &STANDARD.encode(email_check(TOKEN, email)),
        );
        assert_eq!(opened.as_deref(), Some(email));
    }

    /// A link both routes refuse (ended, or a server without the owner
    /// route): the same `NotFound` as before, so Insights says the key can no
    /// longer be fetched, and nothing is kept.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_link_both_routes_refuse_has_no_share_key() {
        let (link_secret, envelope) = sealed_link();
        let route = route_for(&link_secret, envelope);
        route.open.store(false, Ordering::SeqCst);
        route.owner_open.store(false, Ordering::SeqCst);
        let (base, client) = serve_at(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");
        let (http, api) = (reqwest::Client::new(), Api::new(&base, OWNER_BEARER));
        let owner = OwnerRoute { http: &http, api: &api };

        let err = share_key(&client, Some(&owner), &keys, TOKEN, &link_secret).await.expect_err("refused");
        assert!(matches!(err, ShareError::NotFound), "{err:?}");
        assert_eq!(route.owner_hits.load(Ordering::SeqCst), 1);
        assert_eq!(keys.get(TOKEN).await.expect("read"), None);
        // Insights words it as before.
        assert_eq!(
            crate::shares::insights::file_link_key_refusal(&err),
            crate::shares::insights::KeyUnavailable::NotFetchable
        );
    }

    /// An envelope that does not open under the link's secret is refused,
    /// never kept as a share key.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_wrong_envelope_from_the_owner_route_is_refused() {
        let (link_secret, envelope) = sealed_link();
        let (_, someone_elses) = sealed_link();
        let route = route_for(&link_secret, envelope);
        route.open.store(false, Ordering::SeqCst);
        *route.owner_envelope.lock().unwrap() = Some(someone_elses);
        let (base, client) = serve_at(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");
        let (http, api) = (reqwest::Client::new(), Api::new(&base, OWNER_BEARER));
        let owner = OwnerRoute { http: &http, api: &api };

        let err = share_key(&client, Some(&owner), &keys, TOKEN, &link_secret)
            .await
            .expect_err("wrong envelope");
        assert!(matches!(err, ShareError::Crypto(_)), "{err:?}");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None);
    }

    /// The owner route is asked only once `link-key` refuses, and a server
    /// error from it is not a verdict: the gate is held back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_owner_route_is_a_fallback_and_its_errors_are_not_verdicts() {
        let (link_secret, envelope) = sealed_link();
        let route = route_for(&link_secret, envelope);
        let (base, client) = serve_at(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");
        let (http, api) = (reqwest::Client::new(), Api::new(&base, OWNER_BEARER));
        let owner = OwnerRoute { http: &http, api: &api };

        assert_eq!(
            share_key(&client, Some(&owner), &keys, TOKEN, &link_secret).await.expect("anonymous"),
            SHARE_KEY
        );
        assert_eq!(route.owner_hits.load(Ordering::SeqCst), 0, "an ungated link needs no owner request");

        // Already gated, made elsewhere: the gate's save keeps the key first.
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("clears the kept key");
        route.open.store(false, Ordering::SeqCst);
        keep_before_gate(&client, Some(&owner), &keys, TOKEN, &link_secret).await.expect("kept");
        assert_eq!(keys.get(TOKEN).await.expect("read"), Some(SHARE_KEY));

        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("clears the kept key");
        *route.owner_status.lock().unwrap() = Some(StatusCode::INTERNAL_SERVER_ERROR);
        let err = share_key(&client, Some(&owner), &keys, TOKEN, &link_secret)
            .await
            .expect_err("server error");
        assert!(matches!(err, ShareError::Server { status: 500, .. }), "{err:?}");
        assert!(
            keep_before_gate(&client, Some(&owner), &keys, TOKEN, &link_secret).await.is_err(),
            "no verdict holds the gate back"
        );
    }

    /// Only a `#s=` mint opens anything: a `#k=` row is the key already, and a
    /// password link's share key is never opened or stored.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn other_secrets_open_nothing_after_a_mint() {
        let (_, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put("tok-k", &ShareSecret::Public(SHARE_KEY)).expect("put");
        keystore.put("tok-sp", &ShareSecret::FileLinkPrivate(vec![1; 89])).expect("put");

        keep_after_mint(&client, &keystore, &keys, "tok-k").await;
        keep_after_mint(&client, &keystore, &keys, "tok-sp").await;
        keep_after_mint(&client, &keystore, &keys, "tok-none").await;
        assert_eq!(route.hits.load(Ordering::SeqCst), 0);
    }

    /// A gate goes on only once the share key is kept, or once there is no
    /// key left to lose: a failed GET at the mint gets a second chance here,
    /// and a failure that leaves the key unknown holds the gate back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_email_gate_waits_for_the_share_key() {
        let (link_secret, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore, keys) = stores().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        keep_before_gate(&client, None, &keys, TOKEN, &link_secret).await.expect("kept");
        assert_eq!(keys.get(TOKEN).await.expect("read"), Some(SHARE_KEY));

        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("clears the kept key");
        route.open.store(false, Ordering::SeqCst);
        keep_before_gate(&client, None, &keys, TOKEN, &link_secret)
            .await
            .expect("nothing left to lose");

        let offline = HcfsClient::new(HcfsClientConfig {
            base_url: "http://127.0.0.1:9".into(),
            ..HcfsClientConfig::default()
        })
        .expect("client");
        assert!(
            keep_before_gate(&offline, None, &keys, TOKEN, &link_secret).await.is_err(),
            "no answer holds the gate back"
        );

        // An envelope that does not open under the secret: no key to lose.
        route.open.store(true, Ordering::SeqCst);
        keep_before_gate(&client, None, &keys, TOKEN, &[0xEE; 32])
            .await
            .expect("a wrong secret opens nothing");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None);
    }

    /// The kept key lives and dies with its row: only a `file_link` row takes
    /// one, a new secret for the token clears it, and forget removes it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_kept_key_follows_its_file_link_row() {
        let (_dir, keystore, keys) = stores().await;
        keystore.put("tok-sp", &ShareSecret::FileLinkPrivate(vec![1; 89])).expect("put");
        keys.keep("tok-sp", &[1; 32], &SHARE_KEY).await.expect("no-op");
        assert_eq!(keys.get("tok-sp").await.expect("read"), None, "never for a password link");
        keys.keep("tok-none", &[1; 32], &SHARE_KEY).await.expect("no-op");
        assert_eq!(keys.get("tok-none").await.expect("read"), None);

        keystore.put(TOKEN, &ShareSecret::FileLink([7; 32])).expect("put");
        keys.keep(TOKEN, &[7; 32], &SHARE_KEY).await.expect("keep");
        assert_eq!(keys.get(TOKEN).await.expect("read"), Some(SHARE_KEY));
        assert_eq!(
            keystore.get(TOKEN).expect("get"),
            Some(ShareSecret::FileLink([7; 32])),
            "the secret is untouched"
        );

        keystore.put(TOKEN, &ShareSecret::FileLink([8; 32])).expect("replace");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None, "a new secret clears the old key");
        keys.keep(TOKEN, &[7; 32], &SHARE_KEY).await.expect("no-op");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None, "a key opened under the old secret is dropped");

        keys.keep(TOKEN, &[8; 32], &SHARE_KEY).await.expect("keep");
        keystore.put(TOKEN, &ShareSecret::Public(SHARE_KEY)).expect("now a #k= link");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None, "another kind clears it");

        keystore.put(TOKEN, &ShareSecret::FileLink([8; 32])).expect("put");
        keys.keep(TOKEN, &[8; 32], &SHARE_KEY).await.expect("keep");
        keystore.forget(TOKEN).expect("forget");
        assert_eq!(keys.get(TOKEN).await.expect("read"), None, "revoke forgets it");
    }
}
