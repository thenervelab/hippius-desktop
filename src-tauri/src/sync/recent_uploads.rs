//! Server-backed "last uploads" for the sidebar search palette.
//!
//! When the search box is empty the palette shows the account's most recent
//! uploads. `get_recent_files` (the home view's source) reads this device's
//! in-memory sync-activity log, which is empty on a fresh launch — that was
//! the "no last uploads" bug. This command instead asks the HCFS server for
//! the authoritative recent slice via the *same* endpoint the web console's
//! "Last Uploads" uses:
//!
//! ```text
//! GET {arion}/search_files/{ss58}?sort_by=created_at&sort_order=desc&offset=0&limit=N
//! Authorization: Bearer <token>
//! ```
//!
//! It is the same endpoint the cross-folder search hits — only the params
//! differ (no `q`, sorted by `created_at desc`). Hits are mapped onto the
//! `UserFileEntry` shape the local cross-drive search already returns, so the
//! frontend renders and previews them through one code path.
//!
//! The bearer-token + region-resolution plumbing mirrors the desktop's other
//! one-shot Arion calls (`sync::migration::fetch_migration_summary`): the
//! `HcfsClient` is reserved for sync, so direct `reqwest` calls resolve a
//! concrete regional URL via [`crate::sync::region::resolve_base_url`].

use crate::app_state::AppState;
use crate::error::{AppError, Result};
use crate::sync::files::UserFileEntry;
use hcfs_shared::network::{NetworkResponse, SearchFileHit, SearchFilesResponse};
use std::collections::HashMap;
use tracing::{debug, warn};

/// Default recent-upload count — matches the console's `LAST_UPLOADS_CARD_LIMIT`
/// and the limit the request specified (`limit=7`).
const DEFAULT_LIMIT: usize = 7;

/// Upper bound so a caller can't pull an unbounded slice through the palette.
/// The server itself caps at 10000; the palette never needs more than a
/// screenful.
const MAX_LIMIT: usize = 100;

/// HTTP timeout for the recent-uploads fetch. Short — this backs an
/// interactive palette, not a bulk operation.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Map one `/search_files` hit onto the `UserFileEntry` shape the frontend
/// already knows how to render and preview.
///
/// `label_to_path` maps a drive label to its local sync-root path. A hit
/// whose `folder_label` is configured on this device gets a real `source`
/// path and `synced` status, so preview/download resolve locally. A hit for
/// a drive not configured here (e.g. uploaded from another device) gets an
/// empty `source` and `pending` status — mirroring the server-overlay rows
/// `search_user_files_recursive` produces.
///
/// Returns `None` for a hit with neither a plaintext relative path nor a file
/// name (a pre-backfill row we can neither display nor resolve), so callers
/// can `filter_map` it away.
fn map_search_hit_to_entry(
    hit: &SearchFileHit,
    label_to_path: &HashMap<String, String>,
) -> Option<UserFileEntry> {
    // Prefer the plaintext relative path — it carries the full in-folder path
    // the FE needs to resolve the file for preview/download. The server stores
    // it with a leading slash on some rows; strip it so it joins cleanly onto
    // the local sync root.
    let rel_path = hit
        .file
        .relative_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_start_matches('/').to_string());
    let file_name = hit
        .file
        .file_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let actual_file_name = match (rel_path, file_name) {
        (Some(rel), _) => rel,
        (None, Some(name)) => name.to_string(),
        (None, None) => return None,
    };

    let display_name = actual_file_name
        .rsplit('/')
        .next()
        .unwrap_or(&actual_file_name)
        .to_string();

    let local_path = label_to_path.get(&hit.folder_label);
    let source = match local_path {
        Some(path) if !path.is_empty() => format!("{path}/{actual_file_name}"),
        _ => String::new(),
    };
    // Drive configured locally → treat as synced so the FE attempts a normal
    // preview/download; otherwise it's a server-only row.
    let sync_status = if local_path.is_some() { "synced" } else { "pending" };

    // The server reports timestamps in Unix *seconds*; `UserFileEntry`
    // (matching the disk-walk path) carries *milliseconds*.
    let created_at_ms = hit.file.created_at.saturating_mul(1000);
    let last_charged_at_ms = if hit.file.updated_at != 0 {
        hit.file.updated_at.saturating_mul(1000)
    } else {
        created_at_ms
    };

    Some(UserFileEntry {
        name: display_name,
        actual_file_name,
        size: hit.file.size_bytes,
        created_at: created_at_ms,
        arion_hash: hit.file.arion_hash.clone().unwrap_or_default(),
        arion_cid: String::new(),
        source,
        miner_ids: Vec::new(),
        is_assigned: true,
        last_charged_at: last_charged_at_ms,
        is_folder: false,
        file_type: "private".to_string(),
        is_erasure_coded: false,
        main_req_hash: String::new(),
        sync_status: sync_status.to_string(),
        label: hit.folder_label.clone(),
        file_count: None,
        deleted: false,
    })
}

/// Fetch the account's most recent uploads from the HCFS server.
///
/// Calls `GET {base}/search_files/{ss58}?sort_by=created_at&sort_order=desc
/// &offset=0&limit={limit}` with the account's bearer token, then maps each
/// hit onto [`UserFileEntry`]. `limit` defaults to [`DEFAULT_LIMIT`] and is
/// clamped to `[1, MAX_LIMIT]`. Results arrive pre-sorted/-limited from the
/// server; unusable pre-backfill rows are dropped, so the returned vec may be
/// shorter than `limit`.
///
/// # Errors
///
/// - [`AppError::Auth`] when the account has no stored bearer token (logged out).
/// - [`AppError::Hcfs`] on a transport failure, a non-success HTTP status, an
///   unparseable body, or a server `Error`/`Conflict` envelope.
#[tauri::command]
pub async fn get_recent_uploads(
    state: tauri::State<'_, AppState>,
    account_id: String,
    limit: Option<usize>,
) -> Result<Vec<UserFileEntry>> {
    let pool = state.pool()?;

    // `server_url` is empty in auto-detect mode; `resolve_base_url` collapses
    // that to a concrete regional URL so reqwest doesn't reject a schemeless
    // builder (same contract the migration check relies on).
    let server_url = crate::sync::remote::get_server_url(pool, &account_id).await?;
    let base = crate::sync::region::resolve_base_url(&server_url);
    let token = crate::auth::tokens::get_api_token(pool, &account_id)
        .await
        .map_err(AppError::Other)?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;

    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    // ss58 addresses are base58 (URL-safe), so they go into the path verbatim
    // — exactly as the console builds `/search_files/${ss58}`.
    let url = format!(
        "{base}/search_files/{account_id}?sort_by=created_at&sort_order=desc&offset=0&limit={limit}",
        base = base.trim_end_matches('/'),
    );

    debug!(account_id = %account_id, limit, "Fetching recent uploads from HCFS server");

    let resp = state
        .api_client
        .get(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("recent uploads request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        warn!(status = %status, "recent uploads request returned non-success");
        return Err(AppError::Hcfs(format!("recent uploads failed (status {status}): {body}")));
    }

    let parsed: SearchFilesResponse = serde_json::from_str(&body).map_err(|e| {
        warn!(status = %status, "recent uploads response did not parse: {e}");
        AppError::Hcfs(format!("recent uploads parse error: {e}"))
    })?;

    let result = match parsed {
        NetworkResponse::Success(result) => result,
        NetworkResponse::Conflict(c) => {
            return Err(AppError::Hcfs(format!("recent uploads conflict: {}", c.message)));
        }
        NetworkResponse::Error(e) => {
            return Err(AppError::Hcfs(format!("recent uploads error: {} ({})", e.message, e.error)));
        }
    };

    // Build label → local sync-root map so previews/downloads resolve for
    // drives configured on this device.
    let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id)
        .await
        .unwrap_or_default();
    let label_to_path: HashMap<String, String> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty() && !sp.label.is_empty())
        .map(|sp| (sp.label.clone(), sp.path.clone()))
        .collect();

    let entries = result
        .files
        .iter()
        .filter_map(|hit| map_search_hit_to_entry(hit, &label_to_path))
        .collect();
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Build a `SearchFileHit` from the fields the mapper actually reads.
    /// Constructed via JSON so the test isn't coupled to every
    /// `RemoteFileEntry` field (most are `#[serde(default)]`); the 32-byte
    /// hash arrays are the only structurally-required extras.
    fn hit(
        folder_label: &str,
        relative_path: Option<&str>,
        file_name: Option<&str>,
        created_at: i64,
        updated_at: i64,
    ) -> SearchFileHit {
        let mut value = json!({
            "folder_hash": "fh",
            "folder_label": folder_label,
            "path_hash": vec![0u8; 32],
            "salted_hash": vec![0u8; 32],
            "size_bytes": 2048u64,
            "revision_seq": 1u64,
            "revision_id": vec![0u8; 32],
            "arion_hash": "Qm123",
            "created_at": created_at,
            "updated_at": updated_at,
        });
        if let Some(rel) = relative_path {
            value["relative_path"] = json!(rel);
        }
        if let Some(name) = file_name {
            value["file_name"] = json!(name);
        }
        serde_json::from_value(value).expect("hit fixture must deserialize")
    }

    fn label_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(l, p)| ((*l).to_string(), (*p).to_string())).collect()
    }

    #[test]
    fn maps_local_drive_hit_with_source_and_synced_status() {
        let map = label_map(&[("Docs", "/home/me/Docs")]);
        let entry = map_search_hit_to_entry(
            &hit("Docs", Some("Work/report.pdf"), Some("report.pdf"), 1_700_000_000, 1_700_000_005),
            &map,
        )
        .expect("local hit maps");

        assert_eq!(entry.actual_file_name, "Work/report.pdf");
        assert_eq!(entry.name, "report.pdf"); // basename, not the full path
        assert_eq!(entry.label, "Docs");
        assert_eq!(entry.source, "/home/me/Docs/Work/report.pdf");
        assert_eq!(entry.sync_status, "synced");
        assert_eq!(entry.size, 2048);
        // Seconds → milliseconds.
        assert_eq!(entry.created_at, 1_700_000_000_000);
        assert_eq!(entry.last_charged_at, 1_700_000_005_000);
        assert_eq!(entry.arion_hash, "Qm123");
        assert!(!entry.is_folder);
    }

    #[test]
    fn marks_non_local_drive_pending_with_empty_source() {
        let map = label_map(&[("Docs", "/home/me/Docs")]);
        let entry = map_search_hit_to_entry(
            &hit("OtherDevice", Some("a/b.txt"), Some("b.txt"), 1_700_000_000, 0),
            &map,
        )
        .expect("non-local hit still maps");

        assert_eq!(entry.source, "");
        assert_eq!(entry.sync_status, "pending");
        // updated_at == 0 falls back to created_at for last_charged_at.
        assert_eq!(entry.last_charged_at, 1_700_000_000_000);
    }

    #[test]
    fn falls_back_to_file_name_when_relative_path_absent() {
        let entry =
            map_search_hit_to_entry(&hit("Docs", None, Some("loose.png"), 1, 1), &label_map(&[]))
                .expect("file_name-only hit maps");
        assert_eq!(entry.actual_file_name, "loose.png");
        assert_eq!(entry.name, "loose.png");
    }

    #[test]
    fn strips_leading_slash_from_relative_path() {
        let map = label_map(&[("Docs", "/root")]);
        let entry = map_search_hit_to_entry(&hit("Docs", Some("/x/y.txt"), None, 1, 1), &map)
            .expect("leading-slash hit maps");
        assert_eq!(entry.actual_file_name, "x/y.txt");
        assert_eq!(entry.source, "/root/x/y.txt");
    }

    #[test]
    fn skips_pre_backfill_rows_with_no_name_or_path() {
        assert!(map_search_hit_to_entry(&hit("Docs", None, None, 1, 1), &label_map(&[])).is_none());
    }
}
