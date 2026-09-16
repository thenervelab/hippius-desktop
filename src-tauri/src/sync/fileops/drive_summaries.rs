//! Account-wide upload summaries, read straight from hcfs-server.
//!
//! Two endpoints behind two commands: what KINDS of files the account holds
//! (`/get_file_type_summary`) and WHICH CLIENT uploaded them
//! (`/get_source_summary`). Both are read-only counters the server already
//! keeps, and both are what the console's Drive breakdown charts render.
//!
//! These go over plain HTTP with the account's bearer token, the same way
//! `recent_uploads::fetch_search_files` reaches `/search_files`, rather than
//! through `hcfs-client`. The client crate is the sync/drive protocol, and it
//! exposes neither endpoint; a summary counter needs none of what it
//! provides. Keeping to the established HTTP path is what makes this
//! reachable without a pinned-rev bump.

use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::app_state::AppState;
use crate::error::{AppError, Result};

const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Counts per coarse file category. Every field is always present: an account
/// with no files gets a 200 of zeros, not a 404.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FileTypeSummary {
    pub image: u64,
    pub video: u64,
    pub audio: u64,
    pub document: u64,
    pub pdf: u64,
    pub archive: u64,
    pub code: u64,
    pub other: u64,
}

/// Per-client upload counts and their plaintext byte totals.
///
/// The uploading client declares itself on the manifest; the server's
/// taxonomy is closed, so anything it does not recognise lands in `other`.
/// That bucket therefore mixes files uploaded before source tracking existed,
/// clients that declare nothing, and the S3 to HCFS migration worker.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceSummary {
    pub desktop: u64,
    pub desktop_bytes: u64,
    pub console: u64,
    pub console_bytes: u64,
    pub mobile: u64,
    pub mobile_bytes: u64,
    pub other: u64,
    pub other_bytes: u64,
}

/// The server wraps both payloads in the same `{ "Success": ... }` envelope
/// `/search_files` uses.
#[derive(Deserialize)]
enum SummaryEnvelope<T> {
    Success(T),
    Error(EnvelopeError),
}

#[derive(Deserialize)]
struct EnvelopeError {
    #[serde(default)]
    error: String,
    #[serde(default)]
    message: String,
}

/// One GET against an account-scoped summary path, returning `T`.
///
/// Shared by both commands so the auth, the regional base-URL resolution and
/// the envelope handling cannot drift between them.
async fn fetch_summary<T>(state: &AppState, account_id: &str, path: &str) -> Result<T>
where
    T: serde::de::DeserializeOwned,
{
    let pool = state.pool()?;
    // `server_url` is empty in auto-detect mode; `resolve_base_url` collapses
    // that to a concrete regional URL so reqwest does not reject a schemeless
    // builder. Same contract `/search_files` relies on.
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let base = crate::sync::region::resolve_base_url(&server_url);
    let token = crate::auth::tokens::get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;

    // ss58 addresses are base58 and therefore URL-safe, so the address goes
    // into the path verbatim, exactly as the console builds these.
    let url = format!("{base}/{path}/{account_id}", base = base.trim_end_matches('/'));
    debug!(account_id = %account_id, path, "Querying HCFS summary");

    let resp = state
        .api_client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("{path} request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        warn!(status = %status, path, "summary request returned non-success");
        return Err(AppError::Hcfs(format!("{path} failed (status {status}): {body}")));
    }

    match serde_json::from_str::<SummaryEnvelope<T>>(&body) {
        Ok(SummaryEnvelope::Success(value)) => Ok(value),
        Ok(SummaryEnvelope::Error(e)) => Err(AppError::Hcfs(format!("{path} error: {} ({})", e.message, e.error))),
        // Some deployments answer with the bare object rather than the
        // envelope. Accepting both keeps this working across that difference
        // instead of failing on a payload that carries exactly what is wanted.
        Err(envelope_err) => serde_json::from_str::<T>(&body).map_err(|e| {
            warn!(status = %status, path, "summary response did not parse: {e} (envelope: {envelope_err})");
            AppError::Hcfs(format!("{path} parse error: {e}"))
        }),
    }
}

/// How many files of each kind the account holds.
#[tauri::command]
pub async fn get_file_type_summary(state: tauri::State<'_, AppState>, account_id: String) -> Result<FileTypeSummary> {
    let account_id = state.require_session_account(&account_id)?;
    fetch_summary(state.inner(), &account_id, "get_file_type_summary").await
}

/// Which client uploaded them, by count and by bytes.
#[tauri::command]
pub async fn get_source_summary(state: tauri::State<'_, AppState>, account_id: String) -> Result<SourceSummary> {
    let account_id = state.require_session_account(&account_id)?;
    fetch_summary(state.inner(), &account_id, "get_source_summary").await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_success_envelope() {
        let body = r#"{"Success":{"ss58_address":"5Abc","image":3,"video":1,"audio":0,
            "document":7,"pdf":2,"archive":0,"code":11,"other":4}}"#;
        let parsed: SummaryEnvelope<FileTypeSummary> = serde_json::from_str(body).unwrap();
        let SummaryEnvelope::Success(summary) = parsed else {
            panic!("expected Success");
        };
        assert_eq!(summary.image, 3);
        assert_eq!(summary.code, 11);
        // Unknown fields (ss58_address) must not fail the parse.
        assert_eq!(summary.other, 4);
    }

    #[test]
    fn a_missing_counter_reads_as_zero_not_an_error() {
        // The server may omit a category it has never seen; a chart with a
        // hole in it is worse than one with a zero.
        let parsed: FileTypeSummary = serde_json::from_str(r#"{"image":2}"#).unwrap();
        assert_eq!(parsed.image, 2);
        assert_eq!(parsed.video, 0);
        assert_eq!(parsed.other, 0);
    }

    #[test]
    fn source_summary_carries_counts_and_bytes() {
        let body = r#"{"desktop":10,"desktop_bytes":2048,"console":3,"console_bytes":512,
            "mobile":0,"mobile_bytes":0,"other":1,"other_bytes":64}"#;
        let parsed: SourceSummary = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.desktop, 10);
        assert_eq!(parsed.desktop_bytes, 2048);
        assert_eq!(parsed.other_bytes, 64);
    }
}
