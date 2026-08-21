//! Account-scoped HCFS client builder for the share endpoints.
//!
//! Drive operations (`sync`, `add_file`, ...) build a per-label client
//! via `sync::remote::build_client` because the request signature
//! includes a `folder_hash` derived from the label. The share endpoints
//! are owner-scoped — they identify the caller from the bearer token
//! alone — so we build a label-less client here. Reusing
//! `build_client` would force every share command to invent a fake
//! label and pollute logs with a meaningless `folder_hash`; this helper
//! keeps the share path honest about what it actually needs.

use crate::auth::tokens::get_api_token;
use crate::error::{AppError, Result};
use sqlx::sqlite::SqlitePool;

/// Build an `HcfsClient` for owner-scoped (non-drive) endpoints.
///
/// `folder_hash` in the resulting config is the empty string — share
/// endpoints don't reference it, and forcing an arbitrary value would
/// only hide bugs if a future code path mistakenly routed a drive
/// request through this client.
pub(crate) async fn build_account_client(pool: &SqlitePool, account_id: &str) -> Result<hcfs_client::client::HcfsClient> {
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let bearer_token = get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;
    // Structurally own/account-scoped (empty folder hash — the share
    // endpoints identify the caller from the bearer token alone), so the
    // identity is constructed directly rather than resolver-supplied.
    let config = crate::sync::config::build_hcfs_config(&server_url, &bearer_token, &crate::sync::identity::DriveIdentity::own(account_id, ""));
    hcfs_client::client::HcfsClient::new(config).map_err(|e| AppError::Hcfs(format!("Failed to create HCFS client: {e}")))
}
