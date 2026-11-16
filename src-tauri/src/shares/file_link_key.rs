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
//! either can hold, and keeps the share key beside the secret
//! ([`SqliteShareKeystore::keep_opened_share_key`]). Turning on an email gate
//! tries again first ([`keep_before_gate`]), so a failed GET at the mint is
//! not the last chance. A link minted on another device is opened on first
//! use, which fails for a gated or ended link: the owner wrap carries only the
//! link secret (hcfs#1262), and no owner route hands out the envelope.
//!
//! A `#sp=` link's secret is under its password, so its share key is never
//! opened or stored, as for a `#p=` link.

use hcfs_client::client::HcfsClient;
use hcfs_client::client::share::{ShareError, ShareKeystore, ShareSecret};
use tracing::warn;

use super::SqliteShareKeystore;

/// The share key behind `token`'s `#s=` link: the one kept beside its secret,
/// else opened through the link-key route (one anonymous GET) and then kept.
///
/// # Errors
///
/// [`ShareError::NotFound`] when nothing is kept and the server refuses the
/// envelope (an email gate, an ended link, a wrong secret); the keystore's
/// error if its read fails; otherwise the transport and crypto variants of
/// [`HcfsClient::open_file_link`]. A failure to keep a key that did open is
/// only logged.
pub(crate) async fn share_key(
    client: &HcfsClient,
    keystore: &SqliteShareKeystore,
    token: &str,
    link_secret: &[u8; 32],
) -> Result<[u8; 32], ShareError> {
    if let Some(kept) = keystore.opened_share_key(token)? {
        return Ok(kept);
    }
    let opened = client.open_file_link(token, link_secret).await?;
    let share_key = *opened.as_bytes();
    if let Err(e) = keystore.keep_opened_share_key(token, &share_key) {
        warn!(error = %e, "file link share key opened but not kept");
    }
    Ok(share_key)
}

/// After a file mint: open and keep the new link's share key when the mint
/// stored a `#s=` secret. Does nothing for any other secret, and never fails
/// the mint: the link is already live, and without a kept key its comments
/// are opened on first use instead (which fails once it has an email gate).
pub(crate) async fn keep_after_mint(client: &HcfsClient, keystore: &SqliteShareKeystore, token: &str) {
    let link_secret = match keystore.get(token) {
        Ok(Some(ShareSecret::FileLink(link_secret))) => link_secret,
        Ok(_) => return,
        Err(e) => {
            warn!(error = %e, "new file link's secret unreadable; its share key is not kept");
            return;
        }
    };
    if let Err(e) = share_key(client, keystore, token, &link_secret).await {
        warn!(error = %e, "new file link's share key not kept; it is fetched again before an email gate");
    }
}

/// Before an email gate goes on a `#s=` link: make sure its share key is kept,
/// since the gate ends the server handing it out. Done when the key is kept
/// or opens now, and when no key can be had anyway, so the gate costs nothing:
/// the server already refuses the envelope (gated, ended, or minted elsewhere
/// and never opened here), or the envelope does not open under this secret.
///
/// # Errors
///
/// A keystore failure, or a transport or server failure that left the key
/// unknown: the caller holds the gate back rather than lose the key.
pub(crate) async fn keep_before_gate(
    client: &HcfsClient,
    keystore: &SqliteShareKeystore,
    token: &str,
    link_secret: &[u8; 32],
) -> Result<(), ShareError> {
    match share_key(client, keystore, token, link_secret).await {
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

    /// The link-key route: the envelope while `open`, otherwise the bodiless
    /// 404 the server gives a gated or ended link. Counts requests.
    struct LinkKeyRoute {
        envelope: Vec<u8>,
        open: AtomicBool,
        hits: AtomicU32,
    }

    fn route(envelope: Vec<u8>) -> Arc<LinkKeyRoute> {
        Arc::new(LinkKeyRoute {
            envelope,
            open: AtomicBool::new(true),
            hits: AtomicU32::new(0),
        })
    }

    async fn serve(route: Arc<LinkKeyRoute>) -> HcfsClient {
        let router = Router::new().route(
            "/v1/shares/{token}/link-key",
            get(move |Path(token): Path<String>, headers: HeaderMap| {
                let route = Arc::clone(&route);
                async move {
                    route.hits.fetch_add(1, Ordering::SeqCst);
                    let proved = headers.contains_key(hcfs_shared::shares::FOLDER_LINK_PROOF_HEADER);
                    if token != TOKEN || !proved || !route.open.load(Ordering::SeqCst) {
                        return StatusCode::NOT_FOUND.into_response();
                    }
                    axum::Json(serde_json::json!({ "envelope": STANDARD.encode(&route.envelope) })).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        // Detached: the server lives until the test's runtime shuts down.
        tokio::spawn(async move { axum::serve(listener, router).await });
        HcfsClient::new(HcfsClientConfig {
            base_url: format!("http://{addr}"),
            ..HcfsClientConfig::default()
        })
        .expect("client")
    }

    async fn keystore() -> (TempDir, SqliteShareKeystore) {
        let dir = TempDir::new().expect("tempdir");
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", dir.path().join("k.db").display()))
            .expect("opts")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        (dir, SqliteShareKeystore::new(pool))
    }

    /// The reason the key is kept at mint: once the link has an email gate
    /// (or ends) the server refuses the envelope, and the owner still gets the
    /// link's share key from the one kept here, with no request.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_new_file_links_share_key_is_kept_and_outlives_the_link_key_route() {
        let (link_secret, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore) = keystore().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        keep_after_mint(&client, &keystore, TOKEN).await;
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), Some(SHARE_KEY));

        route.open.store(false, Ordering::SeqCst);
        let hits = route.hits.load(Ordering::SeqCst);
        assert_eq!(share_key(&client, &keystore, TOKEN, &link_secret).await.expect("kept"), SHARE_KEY);
        assert_eq!(route.hits.load(Ordering::SeqCst), hits, "a kept key costs no request");
    }

    /// A link minted elsewhere has no kept key: it opens on first use and is
    /// kept from then on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_file_link_minted_elsewhere_opens_on_first_use_and_is_kept() {
        let (link_secret, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore) = keystore().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        assert_eq!(share_key(&client, &keystore, TOKEN, &link_secret).await.expect("opens"), SHARE_KEY);
        assert_eq!(share_key(&client, &keystore, TOKEN, &link_secret).await.expect("kept"), SHARE_KEY);
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
        let (_dir, keystore) = keystore().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        let err = share_key(&client, &keystore, TOKEN, &link_secret).await.expect_err("refused");
        assert!(matches!(err, ShareError::NotFound), "{err:?}");
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), None);
    }

    /// Only a `#s=` mint opens anything: a `#k=` row is the key already, and a
    /// password link's share key is never opened or stored.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn other_secrets_open_nothing_after_a_mint() {
        let (_, envelope) = sealed_link();
        let route = route(envelope);
        let client = serve(Arc::clone(&route)).await;
        let (_dir, keystore) = keystore().await;
        keystore.put("tok-k", &ShareSecret::Public(SHARE_KEY)).expect("put");
        keystore.put("tok-sp", &ShareSecret::FileLinkPrivate(vec![1; 89])).expect("put");

        keep_after_mint(&client, &keystore, "tok-k").await;
        keep_after_mint(&client, &keystore, "tok-sp").await;
        keep_after_mint(&client, &keystore, "tok-none").await;
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
        let (_dir, keystore) = keystore().await;
        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("put");

        keep_before_gate(&client, &keystore, TOKEN, &link_secret).await.expect("kept");
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), Some(SHARE_KEY));

        keystore.put(TOKEN, &ShareSecret::FileLink(link_secret)).expect("clears the kept key");
        route.open.store(false, Ordering::SeqCst);
        keep_before_gate(&client, &keystore, TOKEN, &link_secret)
            .await
            .expect("nothing left to lose");

        let offline = HcfsClient::new(HcfsClientConfig {
            base_url: "http://127.0.0.1:9".into(),
            ..HcfsClientConfig::default()
        })
        .expect("client");
        assert!(
            keep_before_gate(&offline, &keystore, TOKEN, &link_secret).await.is_err(),
            "no answer holds the gate back"
        );

        // An envelope that does not open under the secret: no key to lose.
        route.open.store(true, Ordering::SeqCst);
        keep_before_gate(&client, &keystore, TOKEN, &[0xEE; 32])
            .await
            .expect("a wrong secret opens nothing");
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), None);
    }

    /// The kept key lives and dies with its row: only a `file_link` row takes
    /// one, a new secret for the token clears it, and forget removes it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_kept_key_follows_its_file_link_row() {
        let (_dir, keystore) = keystore().await;
        keystore.put("tok-sp", &ShareSecret::FileLinkPrivate(vec![1; 89])).expect("put");
        keystore.keep_opened_share_key("tok-sp", &SHARE_KEY).expect("no-op");
        assert_eq!(keystore.opened_share_key("tok-sp").expect("read"), None, "never for a password link");
        keystore.keep_opened_share_key("tok-none", &SHARE_KEY).expect("no-op");
        assert_eq!(keystore.opened_share_key("tok-none").expect("read"), None);

        keystore.put(TOKEN, &ShareSecret::FileLink([7; 32])).expect("put");
        keystore.keep_opened_share_key(TOKEN, &SHARE_KEY).expect("keep");
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), Some(SHARE_KEY));
        assert_eq!(
            keystore.get(TOKEN).expect("get"),
            Some(ShareSecret::FileLink([7; 32])),
            "the secret is untouched"
        );

        keystore.put(TOKEN, &ShareSecret::FileLink([8; 32])).expect("replace");
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), None, "a new secret clears the old key");

        keystore.keep_opened_share_key(TOKEN, &SHARE_KEY).expect("keep");
        keystore.forget(TOKEN).expect("forget");
        assert_eq!(keystore.opened_share_key(TOKEN).expect("read"), None);
    }
}
