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
use crate::sync::mnemonic::folder_hash;
use hcfs_shared::network::{NetworkResponse, SearchFileHit, SearchFilesResponse};
use serde::Deserialize;
use std::collections::HashMap;
use tracing::{debug, warn};

/// Default recent-upload count — matches the console's `LAST_UPLOADS_CARD_LIMIT`
/// and the limit the request specified (`limit=7`).
const DEFAULT_LIMIT: usize = 7;

/// Upper bound so a caller can't pull an unbounded slice through the palette.
/// The server itself caps at 10000; the palette never needs more than a
/// screenful.
const MAX_LIMIT: usize = 100;

/// Default result count for an active text search when the caller doesn't
/// specify a limit. Larger than [`DEFAULT_LIMIT`] (the empty-state recents
/// slice) because a query can legitimately match many files, but still bounded
/// by [`MAX_LIMIT`] — the palette scrolls, it never paginates.
const SEARCH_DEFAULT_LIMIT: usize = 50;

/// HTTP timeout for the recent-uploads fetch. Short — this backs an
/// interactive palette, not a bulk operation.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Strip every leading `/` from a sync-root-relative path, returning the
/// canonical identity key used to join a server "last uploads" row against the
/// live sync snapshot.
///
/// This MUST stay byte-for-byte identical to the frontend `normalizeRelPath`
/// (`app/lib/utils/relPath.ts`, `path.replace(/^\/+/, "")`): the FE dedups the
/// two independently-produced views of the same file by this key, so any drift
/// (e.g. switching to `strip_prefix('/')`, which removes only ONE slash)
/// silently splits one file into two rows again. The agreement is pinned by a
/// shared known-answer fixture (`tests/fixtures/path_normalization_cases.json`)
/// exercised from this module's tests AND from
/// `app/lib/__tests__/crossBoundaryContract.test.ts`.
///
/// `trim_start_matches('/')` removes the whole leading run (`"///a"` → `"a"`)
/// but nothing internal (`"/a//b"` → `"a//b"`); it borrows, so there is no
/// allocation here.
pub(crate) fn normalize_rel_path(path: &str) -> &str {
    path.trim_start_matches('/')
}

/// Map one `/search_files` hit onto the `UserFileEntry` shape the frontend
/// already knows how to render and preview.
///
/// `hash_to_drive` maps a drive's `folder_hash` to its `(local_label, path)`. A
/// hit is matched to a local drive by its UNIQUE `folder_hash` (not the
/// non-unique `folder_label` basename) — see the keying note in the body — so a
/// configured drive gets a real `source` path and the entry's local label for
/// preview/download resolution.
///
/// `sync_status` is the badge the Recent-Files / search UI renders. It is
/// deliberately conservative about `pending`, which the table renders as a
/// "Waiting in the sync queue" pill: `pending` is reserved for a *genuine*
/// queued-for-local-download state — the drive is configured on this device
/// but the file isn't on disk yet (e.g. it was uploaded from another device
/// into the same drive and the next cycle will pull it down). Every other
/// hit is `synced`:
///   - the file's drive isn't configured on this device at all (uploaded
///     under a removed/renamed label, or from a drive this device never
///     joined) — it lives only on the server, which is a settled state, NOT
///     something queued for transfer; and
///   - the drive IS configured and the file already exists on disk.
///
/// The previous logic stamped `pending` purely on "drive label not configured
/// here", which mislabeled stable server-only files as perpetually "waiting in
/// the sync queue" even though nothing was ever going to transfer them.
///
/// `path_exists` is injected (rather than calling [`std::path::Path::exists`]
/// inline) so the mapper stays a pure function the unit tests can drive
/// without touching the filesystem. The production caller passes a closure
/// backed by `Path::exists`.
///
/// Returns `None` for a hit with neither a plaintext relative path nor a file
/// name (a pre-backfill row we can neither display nor resolve), so callers
/// can `filter_map` it away.
fn map_search_hit_to_entry(
    hit: &SearchFileHit,
    hash_to_drive: &HashMap<String, (String, String)>,
    path_exists: &dyn Fn(&str) -> bool,
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
        .map(|s| normalize_rel_path(s).to_string());
    let file_name = hit.file.file_name.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let actual_file_name = match (rel_path, file_name) {
        (Some(rel), _) => rel,
        (None, Some(name)) => name.to_string(),
        (None, None) => return None,
    };

    let display_name = actual_file_name.rsplit('/').next().unwrap_or(&actual_file_name).to_string();

    // Resolve the local drive by the hit's UNIQUE `folder_hash`, NOT its
    // `folder_label`: the server reports `folder_label` as the basename, which
    // COLLIDES for two same-basename drives (e.g. haloce_mcc/tags +
    // halo2_mcc/tags → both "tags"). Keying on the label cross-attributed a
    // file to the wrong drive — wrong on-disk path, wrong pending/synced badge,
    // and (since the entry's `label` drives `download_remote_file`'s
    // `folder_hash` derivation on the FE) a cloud preview/download that targeted
    // the WRONG server folder. `folder_hash` is the unique per-drive identity.
    // Same bug class as the `get_sync_folders_with_stats` fix.
    let local = hash_to_drive.get(&hit.folder_hash);
    let local_path = local.map(|(_, path)| path).filter(|p| !p.is_empty());
    let source = match local_path {
        Some(path) => format!("{path}/{actual_file_name}"),
        None => String::new(),
    };
    // `pending` only when the drive is configured here AND the file isn't on
    // disk yet (a real download-queued state). Server-only files (label not
    // configured) and already-on-disk files are `synced`. See the fn doc for
    // why the old "label not configured ⇒ pending" rule was wrong.
    let sync_status = match local_path {
        Some(_) if !path_exists(&source) => "pending",
        _ => "synced",
    };

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
        // Hex of the 32-byte server path_hash — the file id the download path
        // (`download_remote_file` / `cache_remote_file`) needs to fetch this
        // file when it isn't on disk locally. Matches the console's
        // `id = hex(path_hash)`.
        file_id: hex::encode(hit.file.path_hash),
        source,
        miner_ids: Vec::new(),
        is_assigned: true,
        last_charged_at: last_charged_at_ms,
        is_folder: false,
        file_type: "private".to_string(),
        is_erasure_coded: false,
        main_req_hash: String::new(),
        sync_status: sync_status.to_string(),
        // The drive's LOCAL (unique) label when configured here — so the FE's
        // cloud download re-derives the correct `folder_hash` — else the
        // server's display basename for a folder not configured on this device.
        label: local.map_or_else(|| hit.folder_label.clone(), |(label, _)| label.clone()),
        file_count: None,
        deleted: false,
    })
}

// ─── Cross-folder text search ───────────────────────────────────────────────

/// Filter/sort inputs for [`search_files`], mirroring the web console's
/// `SearchFilesParams` (its `useSearchFiles` hook). Every field is optional;
/// the sidebar palette sends only `query` (and a `limit`). UI-semantic values
/// (sort column, file extension) are translated to the server's wire params by
/// [`build_search_query`], keeping that translation — the business logic — in
/// Rust rather than the frontend.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesParams {
    /// Free-text file-name query (`q`). Trimmed; omitted when blank.
    pub query: Option<String>,
    /// Restrict the search to one folder by its server folder hash.
    pub folder_hash: Option<String>,
    /// File extension with or without the leading dot (e.g. `pdf` / `.PDF`);
    /// normalised and sent as `file_type=.pdf`.
    pub file_extension: Option<String>,
    /// Inclusive plaintext-size bounds in bytes.
    pub size_min: Option<u64>,
    pub size_max: Option<u64>,
    /// Inclusive created-at bounds in Unix seconds.
    pub date_from: Option<i64>,
    pub date_to: Option<i64>,
    /// UI sort column: `name` | `size` | `date` (mapped to the server field).
    pub sort_by: Option<String>,
    /// `asc` | `desc`; anything else normalises to `desc`.
    pub sort_order: Option<String>,
    /// Pagination. Offset defaults to 0; limit defaults to
    /// [`SEARCH_DEFAULT_LIMIT`] and is clamped to `[1, MAX_LIMIT]`.
    pub offset: Option<usize>,
    pub limit: Option<usize>,
}

/// Translate a UI sort column to the server's `sort_by` field name. Mirrors
/// the console's `sortMap`; an unknown column falls back to `created_at` (the
/// console's default), so a stray value can never produce an invalid param.
fn map_sort_column(ui: &str) -> &'static str {
    match ui {
        "name" => "file_name",
        "size" => "size_bytes",
        _ => "created_at",
    }
}

/// Assemble the `/search_files` query-string pairs from [`SearchFilesParams`].
///
/// Pure and side-effect-free so it is exhaustively unit-testable; the caller
/// hands the result to `reqwest`'s `.query()`, which URL-encodes each value.
/// Only set fields contribute a pair (so a blank `query` adds no `q=`), exactly
/// matching the console's `buildSearchParams`. `offset` and `limit` are always
/// present because the server requires them.
fn build_search_query(params: &SearchFilesParams) -> Vec<(&'static str, String)> {
    let mut pairs: Vec<(&'static str, String)> = Vec::new();

    let trimmed = |opt: &Option<String>| -> Option<String> { opt.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string) };

    if let Some(q) = trimmed(&params.query) {
        pairs.push(("q", q));
    }
    if let Some(fh) = trimmed(&params.folder_hash) {
        pairs.push(("folder_hash", fh));
    }
    if let Some(ext) = trimmed(&params.file_extension) {
        // Normalise `PDF` / `.pdf` / `.PDF` → `.pdf`, matching the console's
        // `file_type=.${ext.toLowerCase()}`.
        let normalised = ext.trim_start_matches('.').to_lowercase();
        pairs.push(("file_type", format!(".{normalised}")));
    }
    if let Some(min) = params.size_min {
        pairs.push(("size_min", min.to_string()));
    }
    if let Some(max) = params.size_max {
        pairs.push(("size_max", max.to_string()));
    }
    if let Some(from) = params.date_from {
        pairs.push(("date_from", from.to_string()));
    }
    if let Some(to) = params.date_to {
        pairs.push(("date_to", to.to_string()));
    }
    if let Some(sb) = trimmed(&params.sort_by) {
        pairs.push(("sort_by", map_sort_column(&sb).to_string()));
    }
    if let Some(so) = trimmed(&params.sort_order) {
        let order = if so.eq_ignore_ascii_case("asc") { "asc" } else { "desc" };
        pairs.push(("sort_order", order.to_string()));
    }

    pairs.push(("offset", params.offset.unwrap_or(0).to_string()));
    let limit = params.limit.unwrap_or(SEARCH_DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    pairs.push(("limit", limit.to_string()));

    pairs
}

/// Shared HTTP + mapping core for the two `/search_files` callers
/// ([`get_recent_uploads`] and [`search_files`]). Resolves this account's
/// regional Arion base URL + bearer token, issues `GET /search_files/{ss58}`
/// with the supplied query pairs, parses the `SearchFilesResponse` envelope,
/// and maps every hit onto [`UserFileEntry`] (overlaying the local sync-root
/// map so previews/downloads resolve for drives configured on this device).
///
/// `query` is the already-assembled query-string; callers build it — recents
/// uses a fixed `created_at`/`desc` slice, search uses [`build_search_query`].
///
/// # Errors
///
/// - [`AppError::Auth`] when the account has no stored bearer token (logged out).
/// - [`AppError::Hcfs`] on a transport failure, a non-success HTTP status, an
///   unparseable body, or a server `Error`/`Conflict` envelope.
async fn fetch_search_files(state: &AppState, account_id: &str, query: &[(&'static str, String)]) -> Result<Vec<UserFileEntry>> {
    let pool = state.pool()?;

    // `server_url` is empty in auto-detect mode; `resolve_base_url` collapses
    // that to a concrete regional URL so reqwest doesn't reject a schemeless
    // builder (same contract the migration check relies on).
    let server_url = crate::sync::remote::get_server_url(pool, account_id).await?;
    let base = crate::sync::region::resolve_base_url(&server_url);
    let token = crate::auth::tokens::get_api_token(pool, account_id)
        .await?
        .ok_or_else(|| AppError::Auth("No authentication token found. Please log in again.".into()))?;

    // ss58 addresses are base58 (URL-safe), so they go into the path verbatim
    // — exactly as the console builds `/search_files/${ss58}`. The query pairs
    // go through `reqwest::Url::query_pairs_mut`, which percent-encodes the
    // (user-supplied) values just like the console's `URLSearchParams`. This
    // reqwest build doesn't expose `RequestBuilder::query`, so we assemble the
    // URL up front — the same approach `auth::oauth` uses.
    let mut url = reqwest::Url::parse(&format!("{base}/search_files/{account_id}", base = base.trim_end_matches('/')))
        .map_err(|e| AppError::Hcfs(format!("invalid search_files URL: {e}")))?;
    url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));

    debug!(account_id = %account_id, ?query, "Querying HCFS /search_files");

    let resp = state
        .api_client
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppError::Hcfs(format!("search_files request failed: {e}")))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        warn!(status = %status, "search_files request returned non-success");
        return Err(AppError::Hcfs(format!("search_files failed (status {status}): {body}")));
    }

    let parsed: SearchFilesResponse = serde_json::from_str(&body).map_err(|e| {
        warn!(status = %status, "search_files response did not parse: {e}");
        AppError::Hcfs(format!("search_files parse error: {e}"))
    })?;

    let result = match parsed {
        NetworkResponse::Success(result) => result,
        NetworkResponse::Conflict(c) => {
            return Err(AppError::Hcfs(format!("search_files conflict: {}", c.message)));
        }
        NetworkResponse::Error(e) => {
            return Err(AppError::Hcfs(format!("search_files error: {} ({})", e.message, e.error)));
        }
    };

    // Build label → local sync-root map so previews/downloads resolve for
    // drives configured on this device.
    let sync_paths = crate::sync::folders::get_all_sync_paths_or_warn(pool, account_id, "fetch_search_files").await;
    // Key by the UNIQUE folder_hash, not the local label, so server hits join to
    // the right drive even when two drives share a basename (see
    // map_search_hit_to_entry). Value carries the local label (for the FE
    // download path) + the on-disk root.
    let hash_to_drive: HashMap<String, (String, String)> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty() && !sp.label.is_empty())
        .map(|sp| (folder_hash(&sp.label), (sp.label.clone(), sp.path.clone())))
        .collect();

    // Real filesystem probe for the "configured drive but not yet downloaded"
    // pending case. The slice is small (interactive palette), so ≤ MAX_LIMIT
    // stats per call is negligible.
    let path_exists = |p: &str| std::path::Path::new(p).exists();
    let entries = result
        .files
        .iter()
        .filter_map(|hit| map_search_hit_to_entry(hit, &hash_to_drive, &path_exists))
        .collect();
    Ok(entries)
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
/// Propagates [`fetch_search_files`] errors ([`AppError::Auth`] / [`AppError::Hcfs`]).
#[tauri::command]
pub async fn get_recent_uploads(state: tauri::State<'_, AppState>, account_id: String, limit: Option<usize>) -> Result<Vec<UserFileEntry>> {
    // Uses the account's bearer token to query its uploads; authorize against
    // the session account.
    let account_id = state.require_session_account(&account_id)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    debug!(account_id = %account_id, limit, "Fetching recent uploads from HCFS server");

    let query = [
        ("sort_by", "created_at".to_string()),
        ("sort_order", "desc".to_string()),
        ("offset", "0".to_string()),
        ("limit", limit.to_string()),
    ];
    fetch_search_files(state.inner(), &account_id, &query).await
}

/// Cross-folder, account-wide file search backing the sidebar search palette.
///
/// Mirrors the web console's `GET /search_files/{ss58}` call (its
/// `useSearchFiles` hook): [`build_search_query`] assembles the same query
/// string from [`SearchFilesParams`], and the hits are mapped onto
/// [`UserFileEntry`]. Unlike the local `search_user_files_recursive` IPC — which
/// only walks this device's on-disk sync folders — this reaches the server, so
/// files uploaded from other devices, or under drives not configured here, are
/// found too. That is the fix for the "sidebar search only finds local files"
/// report: the palette now searches the cloud, like the web console.
///
/// # Errors
///
/// Propagates [`fetch_search_files`] errors ([`AppError::Auth`] / [`AppError::Hcfs`]).
#[tauri::command]
pub async fn search_files(state: tauri::State<'_, AppState>, account_id: String, params: SearchFilesParams) -> Result<Vec<UserFileEntry>> {
    // Uses the account's bearer token to search its files; authorize against
    // the session account.
    let account_id = state.require_session_account(&account_id)?;
    debug!(account_id = %account_id, ?params, "Cross-folder file search via HCFS /search_files");
    let query = build_search_query(&params);
    fetch_search_files(state.inner(), &account_id, &query).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::json;

    /// Build a `SearchFileHit` from the fields the mapper actually reads.
    /// Constructed via JSON so the test isn't coupled to every
    /// `RemoteFileEntry` field (most are `#[serde(default)]`); the 32-byte
    /// hash arrays are the only structurally-required extras.
    /// Full fixture: `folder_label` is the server's DISPLAY basename, while the
    /// hit's `folder_hash` is derived from `hash_label` — modeling production,
    /// where two same-basename drives share `folder_label` but have distinct
    /// `folder_hash`es derived from their unique local labels (`tags`/`tags-2`).
    fn hit_full(folder_label: &str, hash_label: &str, relative_path: Option<&str>, file_name: Option<&str>, created_at: i64, updated_at: i64) -> SearchFileHit {
        let mut value = json!({
            "folder_hash": folder_hash(hash_label),
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

    /// Common case: the server display label equals the drive's local label, so
    /// `folder_hash` derives from the same string.
    fn hit(folder_label: &str, relative_path: Option<&str>, file_name: Option<&str>, created_at: i64, updated_at: i64) -> SearchFileHit {
        hit_full(folder_label, folder_label, relative_path, file_name, created_at, updated_at)
    }

    /// Build the production `hash_to_drive` map: `folder_hash(label) → (label, path)`.
    fn drive_map(pairs: &[(&str, &str)]) -> HashMap<String, (String, String)> {
        pairs
            .iter()
            .map(|(l, p)| (folder_hash(l), ((*l).to_string(), (*p).to_string())))
            .collect()
    }

    /// Test predicate that reports every path as present on disk.
    fn on_disk(_p: &str) -> bool {
        true
    }
    /// Test predicate that reports every path as absent from disk.
    fn off_disk(_p: &str) -> bool {
        false
    }

    #[test]
    fn maps_local_drive_hit_on_disk_as_synced() {
        let map = drive_map(&[("Docs", "/home/me/Docs")]);
        let entry = map_search_hit_to_entry(
            &hit("Docs", Some("Work/report.pdf"), Some("report.pdf"), 1_700_000_000, 1_700_000_005),
            &map,
            &on_disk,
        )
        .expect("local hit maps");

        assert_eq!(entry.actual_file_name, "Work/report.pdf");
        assert_eq!(entry.name, "report.pdf"); // basename, not the full path
        assert_eq!(entry.label, "Docs");
        assert_eq!(entry.source, "/home/me/Docs/Work/report.pdf");
        // Drive configured here AND file present on disk → settled.
        assert_eq!(entry.sync_status, "synced");
        assert_eq!(entry.size, 2048);
        // Seconds → milliseconds.
        assert_eq!(entry.created_at, 1_700_000_000_000);
        assert_eq!(entry.last_charged_at, 1_700_000_005_000);
        assert_eq!(entry.arion_hash, "Qm123");
        assert!(!entry.is_folder);
        // file_id is the hex of the 32-byte path_hash (all zeros in the
        // fixture) — the id the download path needs for a non-synced file.
        assert_eq!(entry.file_id, "0".repeat(64));
    }

    /// A configured drive whose file isn't on disk yet is the ONE genuine
    /// `pending` case (uploaded from another device; this device will pull it
    /// down on the next cycle).
    #[test]
    fn marks_configured_drive_pending_when_file_absent_on_disk() {
        let map = drive_map(&[("Docs", "/home/me/Docs")]);
        let entry = map_search_hit_to_entry(
            &hit("Docs", Some("Work/report.pdf"), Some("report.pdf"), 1_700_000_000, 0),
            &map,
            &off_disk,
        )
        .expect("local hit maps");

        assert_eq!(entry.source, "/home/me/Docs/Work/report.pdf");
        assert_eq!(entry.sync_status, "pending");
    }

    /// Regression for the reported bug: a server file whose drive label is NOT
    /// configured on this device (uploaded from another device / under an
    /// old/removed label) is `synced`, not a perpetual misleading `pending`
    /// "waiting in the sync queue" pill. Nothing is queued for it locally.
    #[test]
    fn marks_non_local_drive_synced_with_empty_source() {
        let map = drive_map(&[("Docs", "/home/me/Docs")]);
        let entry = map_search_hit_to_entry(
            &hit("OtherDevice", Some("a/b.txt"), Some("b.txt"), 1_700_000_000, 0),
            &map,
            // `off_disk` proves the empty source short-circuits to synced
            // regardless of the on-disk probe (source is "" so it never runs).
            &off_disk,
        )
        .expect("non-local hit still maps");

        assert_eq!(entry.source, "");
        assert_eq!(entry.sync_status, "synced");
        // updated_at == 0 falls back to created_at for last_charged_at.
        assert_eq!(entry.last_charged_at, 1_700_000_000_000);
    }

    /// Same-basename collision regression: two local drives share the basename
    /// `tags` (local labels `tags` / `tags-2`), so the server reports BOTH under
    /// `folder_label = "tags"`. A hit belonging to the SECOND drive (its
    /// `folder_hash` derives from `tags-2`) must resolve to THAT drive's path +
    /// local label — not be cross-attributed to the first `tags` drive. Keying
    /// on `folder_label` (the old bug) would always pick the first.
    #[test]
    fn same_basename_hit_resolves_by_folder_hash_not_label() {
        let map = drive_map(&[
            ("tags", "/Users/me/haloce_mcc/tags"),
            ("tags-2", "/Users/me/halo2_mcc/tags"),
        ]);
        // Server display label is the basename "tags"; the hit truly belongs to
        // the tags-2 drive (folder_hash derived from "tags-2").
        let entry = map_search_hit_to_entry(
            &hit_full("tags", "tags-2", Some("ui/x.bitmap"), Some("x.bitmap"), 1, 1),
            &map,
            &on_disk,
        )
        .expect("same-basename hit maps");

        assert_eq!(entry.label, "tags-2", "must use the matched drive's LOCAL label");
        assert_eq!(
            entry.source, "/Users/me/halo2_mcc/tags/ui/x.bitmap",
            "must join onto the tags-2 root, not the colliding tags root",
        );
        assert_eq!(entry.sync_status, "synced");
    }

    #[test]
    fn falls_back_to_file_name_when_relative_path_absent() {
        let entry = map_search_hit_to_entry(&hit("Docs", None, Some("loose.png"), 1, 1), &drive_map(&[]), &on_disk).expect("file_name-only hit maps");
        assert_eq!(entry.actual_file_name, "loose.png");
        assert_eq!(entry.name, "loose.png");
    }

    #[test]
    fn strips_leading_slash_from_relative_path() {
        let map = drive_map(&[("Docs", "/root")]);
        let entry = map_search_hit_to_entry(&hit("Docs", Some("/x/y.txt"), None, 1, 1), &map, &on_disk).expect("leading-slash hit maps");
        assert_eq!(entry.actual_file_name, "x/y.txt");
        assert_eq!(entry.source, "/root/x/y.txt");
    }

    #[test]
    fn skips_pre_backfill_rows_with_no_name_or_path() {
        assert!(map_search_hit_to_entry(&hit("Docs", None, None, 1, 1), &drive_map(&[]), &on_disk).is_none());
    }

    // ── build_search_query ──────────────────────────────────────────────

    /// Find the value for a query key, asserting it appears at most once.
    fn query_value<'a>(pairs: &'a [(&'static str, String)], key: &str) -> Option<&'a str> {
        let mut found: Option<&'a str> = None;
        for (k, v) in pairs {
            if *k == key {
                assert!(found.is_none(), "duplicate query key: {key}");
                found = Some(v.as_str());
            }
        }
        found
    }

    #[test]
    fn empty_params_only_set_offset_and_limit() {
        let pairs = build_search_query(&SearchFilesParams::default());
        assert_eq!(query_value(&pairs, "offset"), Some("0"));
        assert_eq!(query_value(&pairs, "limit"), Some(SEARCH_DEFAULT_LIMIT.to_string().as_str()));
        // No optional pairs leak through when nothing is provided.
        for key in ["q", "folder_hash", "file_type", "size_min", "sort_by", "sort_order"] {
            assert_eq!(query_value(&pairs, key), None, "unexpected {key}");
        }
    }

    #[test]
    fn query_is_trimmed_and_blank_is_omitted() {
        let pairs = build_search_query(&SearchFilesParams {
            query: Some("  report  ".into()),
            ..Default::default()
        });
        assert_eq!(query_value(&pairs, "q"), Some("report"));

        let blank = build_search_query(&SearchFilesParams {
            query: Some("   ".into()),
            ..Default::default()
        });
        assert_eq!(query_value(&blank, "q"), None);
    }

    #[test]
    fn file_extension_normalises_to_lowercase_with_dot() {
        for input in [".PDF", "PDF", "pdf", ".pdf"] {
            let pairs = build_search_query(&SearchFilesParams {
                file_extension: Some(input.into()),
                ..Default::default()
            });
            assert_eq!(query_value(&pairs, "file_type"), Some(".pdf"), "input {input}");
        }
    }

    #[test]
    fn sort_by_maps_ui_columns_with_safe_fallback() {
        for (ui, wire) in [
            ("name", "file_name"),
            ("size", "size_bytes"),
            ("date", "created_at"),
            ("anything-else", "created_at"),
        ] {
            let pairs = build_search_query(&SearchFilesParams {
                sort_by: Some(ui.into()),
                ..Default::default()
            });
            assert_eq!(query_value(&pairs, "sort_by"), Some(wire), "ui {ui}");
        }
    }

    #[test]
    fn sort_order_normalises_to_asc_or_desc() {
        let asc = build_search_query(&SearchFilesParams {
            sort_order: Some("ASC".into()),
            ..Default::default()
        });
        assert_eq!(query_value(&asc, "sort_order"), Some("asc"));

        let other = build_search_query(&SearchFilesParams {
            sort_order: Some("nonsense".into()),
            ..Default::default()
        });
        assert_eq!(query_value(&other, "sort_order"), Some("desc"));
    }

    #[test]
    fn limit_is_clamped_and_offset_passes_through() {
        let zero = build_search_query(&SearchFilesParams {
            limit: Some(0),
            ..Default::default()
        });
        assert_eq!(query_value(&zero, "limit"), Some("1"));

        let huge = build_search_query(&SearchFilesParams {
            limit: Some(99_999),
            ..Default::default()
        });
        assert_eq!(query_value(&huge, "limit"), Some(MAX_LIMIT.to_string().as_str()));

        let off = build_search_query(&SearchFilesParams {
            offset: Some(25),
            ..Default::default()
        });
        assert_eq!(query_value(&off, "offset"), Some("25"));
    }

    #[test]
    fn size_and_date_bounds_are_passed_through() {
        let pairs = build_search_query(&SearchFilesParams {
            size_min: Some(100),
            size_max: Some(2_000),
            date_from: Some(1_700_000_000),
            date_to: Some(1_700_100_000),
            folder_hash: Some("abc123".into()),
            ..Default::default()
        });
        assert_eq!(query_value(&pairs, "size_min"), Some("100"));
        assert_eq!(query_value(&pairs, "size_max"), Some("2000"));
        assert_eq!(query_value(&pairs, "date_from"), Some("1700000000"));
        assert_eq!(query_value(&pairs, "date_to"), Some("1700100000"));
        assert_eq!(query_value(&pairs, "folder_hash"), Some("abc123"));
    }

    // --- cross-boundary drift pin: `normalize_rel_path` must stay byte-for-byte
    //     identical to the FE `normalizeRelPath` (app/lib/utils/relPath.ts). The
    //     SAME JSON fixture drives this Rust test and the vitest test
    //     `app/lib/__tests__/crossBoundaryContract.test.ts`, so a change to
    //     either side's leading-slash handling fails its own CI job. ---

    #[derive(Deserialize)]
    struct PathCase {
        input: String,
        expected: String,
        note: String,
    }

    #[test]
    fn normalize_rel_path_matches_shared_fixture() {
        let cases: Vec<PathCase> = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/path_normalization_cases.json"
        )))
        .expect("path_normalization_cases.json is valid JSON");
        assert!(!cases.is_empty(), "fixture must carry cases");
        for case in &cases {
            assert_eq!(normalize_rel_path(&case.input), case.expected, "normalize_rel_path({:?}) — {}", case.input, case.note);
        }
    }

    proptest! {
        /// The two post-conditions the cross-boundary dedup key relies on:
        /// idempotence (re-normalizing is a no-op) and that no result keeps a
        /// leading slash — so the server key and the FE key can never diverge
        /// by an un-stripped prefix. The input alphabet includes `/` and space
        /// so the shrinker can probe the leading-run and non-slash boundaries.
        #[test]
        fn normalize_rel_path_is_idempotent_and_unprefixed(s in "[/ a-z]{0,16}") {
            let once = normalize_rel_path(&s).to_string();
            prop_assert_eq!(normalize_rel_path(&once), once.as_str());
            prop_assert!(!once.starts_with('/'));
        }
    }
}
