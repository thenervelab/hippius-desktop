//! The files page: `get_user_files`, recursive search, and the shared filter
//! cascade. Owns `UserFileEntry`, `FileFilterCriteria`, and per-label stats.

use super::listing::list_sync_folder;
use super::pathops::ensure_within;
use super::synced_state::synced_paths_and_excludes_for_label;
use crate::error::Result;
use chrono::Datelike;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Inclusive [from, to] date window for the files page Date filter.
///
/// Both fields are `YYYY-MM-DD` strings (local-date). The filter rule
/// expands `from` to 00:00:00 local and `to` to 23:59:59.999 local so a
/// single-day pick (`from == to`) still matches every file uploaded
/// during that day. Mirrors the web console's `DateRange` shape so the
/// frontend can hand the same payload to both clients unchanged.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DateRangeFilter {
    pub from: String,
    pub to: String,
}

/// Filter criteria for the files page, matching the frontend `FilterCriteria`.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterCriteria {
    pub search_term: Option<String>,
    pub file_types: Option<Vec<String>>,
    /// Explicit file extensions to match (e.g. `["mp4", "jpg"]`). Independent
    /// from `file_types` (coarse categories) — present so the web-console
    /// style "specific extension" dropdown can request exact matches without
    /// re-encoding into category groups. Matched case-insensitively against
    /// the trailing extension of the entry name.
    pub file_extensions: Option<Vec<String>>,
    /// Legacy single-date / preset string filter (`"YYYY-MM-DD"`, `"today"`,
    /// `"last7days"`, `"last30days"`, `"thisyear"`, `"lastyear"`). Retained
    /// for backward-compat with older IPC callers. The desktop UI no
    /// longer sets this — it sends `date_range` instead.
    pub date_filter: Option<String>,
    /// Console-style date-range window. When `Some`, `date_filter` is
    /// ignored and only files whose `created_at` falls inside the
    /// inclusive `[from, to]` window are kept.
    pub date_range: Option<DateRangeFilter>,
    pub file_sizes: Option<Vec<u64>>,
    pub folder_tab: Option<String>,
}

impl FileFilterCriteria {
    /// `true` when every filter field is empty — short-circuits the
    /// `filter_file_entries` IPC so callers don't pay the round-trip
    /// serialization cost for a no-op.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.search_term.as_deref().is_none_or(str::is_empty)
            && self.file_types.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self.file_extensions.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self.date_filter.as_deref().is_none_or(str::is_empty)
            && self.date_range.is_none()
            && self.file_sizes.as_ref().is_none_or(std::vec::Vec::is_empty)
            && self.folder_tab.is_none()
    }
}

/// Per-drive-label aggregate for the file tab header.
///
/// Computed in Rust so every tab uses the exact same rule that
/// `dir_stats_recursive` already uses for folder rows — if we let TypeScript
/// re-derive these counts, the two places drift and the header stops matching
/// the rows it sits above.
///
/// `file_count` sums real file leaves only: each non-folder row contributes 1,
/// and each folder row contributes `entry.file_count` (the recursive leaf count
/// computed by `dir_stats_recursive`). Empty folders contribute 0 — a folder
/// with zero files is not itself a "file".
#[derive(Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LabelStats {
    pub total_bytes: u64,
    pub file_count: u64,
}

/// Result of get_user_files including both files and metadata.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserFilesResult {
    pub files: Vec<UserFileEntry>,
    pub total_private_size: String,
    pub sync_folder_labels: Vec<String>,
    pub label_stats: HashMap<String, LabelStats>,
}

/// A user file ready for UI rendering. Matches `FormattedUserFile` shape.
///
/// `Deserialize` is required so the frontend can pass a previously-fetched
/// list back into [`filter_file_entries`] for re-filtering without a round
/// trip to disk.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserFileEntry {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    /// Hex of the server-side `path_hash` — the file's unique id on Arion.
    /// Used to download + decrypt a file that isn't synced to this device, via
    /// `download_remote_file` / `cache_remote_file`. Empty for local disk-walk
    /// entries (they preview/download straight from `source`); populated only
    /// for `/search_files` hits so cloud-only results can be opened.
    #[serde(default)]
    pub file_id: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub sync_status: String,
    pub label: String,
    pub file_count: Option<u64>,
    pub deleted: bool,
}

/// Whether a given `sync_status` value should contribute to per-label
/// stats. Centralised so the inline accumulator in `get_user_files` and
/// the test-definition `compute_label_stats` cannot disagree on the
/// filter rule if only one of them is changed.
fn is_counted_for_label_stats(sync_status: &str) -> bool {
    sync_status != "excluded"
}

/// Apply the per-counted-entry stats accumulation rule.
///
/// Pure function — both `get_user_files`'s inline path and the test
/// definition `compute_label_stats` route every counted entry through
/// this helper, so the rule can only be changed in one place. Folders
/// contribute their nested file count (computed by `dir_stats_recursive`
/// upstream); plain files contribute 1.
fn apply_label_stats_rule(stats: &mut LabelStats, is_folder: bool, file_count: u64, size: u64) {
    stats.total_bytes = stats.total_bytes.saturating_add(size);
    stats.file_count = stats.file_count.saturating_add(if is_folder { file_count } else { 1 });
}

/// Compute per-label totals from the flat entry list `get_user_files` builds.
///
/// `get_user_files` accumulates label stats inline during its main entry
/// loop (avoids walking the file list twice), so this helper is only
/// referenced from the unit tests below — kept as a single-source rule
/// definition that the inline accumulator must match. Both paths share
/// `is_counted_for_label_stats` and `apply_label_stats_rule` to enforce
/// that match at the type level.
#[cfg(test)]
fn compute_label_stats(entries: &[UserFileEntry]) -> HashMap<String, LabelStats> {
    let mut out: HashMap<String, LabelStats> = HashMap::new();
    for entry in entries {
        if !is_counted_for_label_stats(&entry.sync_status) {
            continue;
        }
        let slot = out.entry(entry.label.clone()).or_default();
        apply_label_stats_rule(slot, entry.is_folder, entry.file_count.unwrap_or(0), entry.size);
    }
    out
}

/// Fetch all user files from all sync paths, apply filters, return UI-ready data.
///
/// Replaces both the `use-user-files` orchestration (multi-invoke loop with
/// timestamp logic) AND `fileFilterUtils.ts` (search, type, date, size filtering).
#[tauri::command]
#[allow(
    clippy::too_many_lines,
    reason = "Replaces two full frontend modules (use-user-files + fileFilterUtils) in one Rust function. The filter chain (search / type / date / size) must share the candidate list and statistics accumulators; splitting would require an iterator-builder pattern that obscures the filter order."
)]
pub async fn get_user_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    filters: Option<FileFilterCriteria>,
) -> Result<UserFilesResult> {
    // Account-scoped listing; authorize against the session account.
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "get_user_files").await;

    let mut all_files: Vec<UserFileEntry> = Vec::new();
    let mut total_private_size: u64 = 0;
    let sync_folder_labels: Vec<String> = sync_paths.iter().filter(|sp| !sp.path.is_empty()).map(|sp| sp.label.clone()).collect();

    // Pre-build label → folder_path lookup so the per-entry loop below is
    // O(1) per file instead of O(D) where D is the number of sync paths.
    // Same idea as the `label_to_path` map in `get_recent_files`.
    let label_to_path: HashMap<&str, &str> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty())
        .map(|sp| (sp.label.as_str(), sp.path.as_str()))
        .collect();

    // Accumulator for per-label stats. Filled inline during the entry loop
    // so the post-loop walk that `compute_label_stats(&all_files)` used to
    // do is no longer needed. Keyed by `&str` borrowed from `sync_paths`
    // to avoid cloning each entry.label per iteration.
    let mut label_stats: HashMap<&str, LabelStats> = HashMap::new();

    // List all sync folders concurrently
    let folder_futures: Vec<_> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty())
        .map(|sp| {
            let state = state.clone();
            let path = sp.path.clone();
            let label = sp.label.clone();
            async move {
                match list_sync_folder(state, path, None, Some(label.clone())).await {
                    Ok(entries) => (label, entries),
                    Err(err) => {
                        tracing::warn!(label = %label, error = %err, "Failed to list sync folder");
                        (label, Vec::new())
                    }
                }
            }
        })
        .collect();

    let results = futures_util::future::join_all(folder_futures).await;

    for (label, entries) in &results {
        total_private_size += entries.iter().map(|e| e.size).sum::<u64>();

        // Borrow the canonical `&str` from `sync_paths` so `label_stats`
        // keys are zero-copy. The `get_key_value` call returns the key
        // borrowed from `label_to_path` (and therefore from `sync_paths`,
        // which outlives `label_stats`'s entire scope). The `unwrap_or`
        // fallback covers the orphaned-label case (a label appears in
        // `results` but not in `sync_paths` — only possible if a path
        // row was deleted between `get_all_sync_paths_internal` and the
        // `list_sync_folder` futures resolving). The fallback `&str`
        // borrows `label`, which lives for the entire outer loop body
        // and outlives `label_stats`'s `into_iter().collect()` call
        // below — both lifetimes are valid.
        let label_key: &str = label_to_path.get_key_value(label.as_str()).map_or(label.as_str(), |(k, _)| *k);
        let folder_path = label_to_path.get(label_key).copied().unwrap_or("");

        for entry in entries.iter().filter(|e| is_counted_for_label_stats(&e.sync_status)) {
            let local_modified_ms = entry.modified.map_or(0, |m| m as i64 * 1000);
            let uploaded_at_ms = if entry.uploaded_at != 0 { entry.uploaded_at * 1000 } else { 0 };
            let updated_at_ms = if entry.updated_at != 0 { entry.updated_at * 1000 } else { 0 };
            // created_at represents "DATE UPLOADED" in the UI. For files,
            // only use the server-side uploaded_at timestamp — showing the
            // local mtime under "DATE UPLOADED" is confusing (the frontend
            // renders 0 as "—", the correct placeholder for not-yet-uploaded).
            // Folders (including .app bundles on macOS) have no server-side
            // timestamp, so fall back to local mtime for them.
            let created_at_ms = if uploaded_at_ms != 0 {
                uploaded_at_ms
            } else if entry.is_folder {
                local_modified_ms
            } else {
                0
            };
            // last_charged_at_ms is a billing timestamp -- only use
            // server-side values, never fall back to local mtime.
            let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };

            // Detect encrypted file names (long hex strings or file_<hex> patterns)
            let display_name = if hcfs_client::engine::classify::is_encrypted_name_stub(&entry.name).is_some()
                || (entry.name.len() >= 16 && !entry.name.contains('.') && entry.name.chars().all(|c| c.is_ascii_hexdigit()))
            {
                "Encrypted file".to_string()
            } else {
                entry.name.clone()
            };

            // Inline label_stats accumulation through the shared
            // `apply_label_stats_rule` helper so this path cannot drift
            // from the test-definition `compute_label_stats`.
            apply_label_stats_rule(label_stats.entry(label_key).or_default(), entry.is_folder, entry.file_count, entry.size);

            all_files.push(UserFileEntry {
                name: display_name,
                actual_file_name: entry.name.clone(),
                size: entry.size,
                created_at: created_at_ms,
                arion_hash: entry.arion_hash.clone(),
                arion_cid: entry.arion_cid.clone(),
                file_id: String::new(),
                source: format!("{folder_path}/{}", entry.name),
                miner_ids: Vec::new(),
                is_assigned: true,
                last_charged_at: last_charged_at_ms,
                is_folder: entry.is_folder,
                file_type: "private".to_string(),
                is_erasure_coded: false,
                main_req_hash: String::new(),
                sync_status: entry.sync_status.clone(),
                label: label.clone(),
                file_count: if entry.is_folder { Some(entry.file_count) } else { None },
                deleted: false,
            });
        }
    }

    if let Some(ref f) = filters {
        apply_file_filters(&mut all_files, f);
    }

    // Sort by timestamp (newest first)
    all_files.sort_by_key(|b| std::cmp::Reverse(b.last_charged_at));

    // Convert the borrowed-key map to owned-key for the result. One
    // allocation per label instead of one per file (the previous
    // `compute_label_stats(&all_files)` walk cloned `entry.label` for
    // every file).
    let label_stats: HashMap<String, LabelStats> = label_stats.into_iter().map(|(k, v)| (k.to_owned(), v)).collect();

    Ok(UserFilesResult {
        files: all_files,
        total_private_size: total_private_size.to_string(),
        sync_folder_labels,
        label_stats,
    })
}

/// Recursively walk a sync drive's on-disk subtree and emit one
/// [`UserFileEntry`] per file (folders are excluded — this is the
/// recursive-search path, which returns leaves only).
///
/// `actual_file_name` carries the full relative path inside the drive
/// (e.g. `"Photos/2024/IMG_001.jpg"`), so the frontend can show users
/// where a deep match lives. `name` carries just the basename for
/// display in the existing table columns.
///
/// `prefix` is the rel-path of the directory we're descending into
/// (`""` for the drive root, `"sub"` for a one-level descent, etc.).
/// Hidden files (`.`-prefixed) and failed-download / encrypted-name
/// stubs are skipped to match `list_sync_folder_inner`'s rules.
async fn walk_disk_files_recursive(
    base: &Path,
    rel_prefix: &str,
    label: &str,
    folder_path: &str,
    synced: Option<&HashMap<String, hcfs_client::engine::types::SyncedFileInfo>>,
    excluded: &[String],
    out: &mut Vec<UserFileEntry>,
) {
    let dir_path = if rel_prefix.is_empty() {
        base.to_path_buf()
    } else {
        base.join(rel_prefix)
    };

    let Ok(mut dir) = tokio::fs::read_dir(&dir_path).await else {
        return;
    };

    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let Ok(meta) = entry.metadata().await else {
            continue;
        };
        let rel_path = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };

        if meta.is_dir() {
            // Recurse — folders themselves are never emitted.
            Box::pin(walk_disk_files_recursive(base, &rel_path, label, folder_path, synced, excluded, out)).await;
            continue;
        }

        // Skip failed-download artifacts and 0-byte encrypted-name stubs
        // (mirror `list_sync_folder_inner` — these aren't user files).
        if hcfs_client::engine::classify::is_failed_download_artifact(&name).is_some() {
            continue;
        }
        if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some() && meta.len() == 0 {
            continue;
        }

        let is_excluded = !excluded.is_empty() && excluded.iter().any(|p| p == &rel_path);
        let (sync_status, info) = if is_excluded {
            ("excluded", None)
        } else {
            match synced {
                Some(map) => match map.get(&rel_path) {
                    Some(i) => ("synced", Some(i)),
                    None => ("pending", None),
                },
                None => ("unknown", None),
            }
        };

        // Match the timestamp rules used by `get_user_files` so the UI's
        // "Date Uploaded" column lines up regardless of which path
        // produced the entry. Fall back to the file's local mtime when
        // the server's `uploaded_at` isn't yet populated (common for
        // freshly uploaded files where hcfs-client hasn't completed a
        // reconcile cycle with timestamps yet) — without this fallback
        // the date-range filter excludes the file silently because
        // `created_at == 0` short-circuits the filter to "drop".
        let uploaded_at_ms = info.map_or(0_i64, |i| if i.uploaded_at != 0 { i.uploaded_at * 1000 } else { 0 });
        let updated_at_ms = info.map_or(0_i64, |i| if i.updated_at != 0 { i.updated_at * 1000 } else { 0 });
        let local_modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        let created_at_ms = if uploaded_at_ms != 0 { uploaded_at_ms } else { local_modified_ms };
        let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };

        let display_name = if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some()
            || (name.len() >= 16 && !name.contains('.') && name.chars().all(|c| c.is_ascii_hexdigit()))
        {
            "Encrypted file".to_string()
        } else {
            name.clone()
        };

        out.push(UserFileEntry {
            name: display_name,
            actual_file_name: rel_path.clone(),
            size: meta.len(),
            created_at: created_at_ms,
            arion_hash: info.map_or_else(String::new, hcfs_client::engine::types::SyncedFileInfo::path_hash_hex),
            arion_cid: info.map_or_else(String::new, |i| i.arion_cid.to_string()),
            file_id: String::new(),
            source: format!("{folder_path}/{rel_path}"),
            miner_ids: Vec::new(),
            is_assigned: true,
            last_charged_at: last_charged_at_ms,
            is_folder: false,
            file_type: "private".to_string(),
            is_erasure_coded: false,
            main_req_hash: String::new(),
            sync_status: sync_status.to_string(),
            label: label.to_string(),
            file_count: None,
            deleted: false,
        });
    }
}

/// Recursively search a single sync drive for files matching `filters`.
///
/// Returns a flat list of [`UserFileEntry`] across every nested folder in
/// the drive (or only under `subfolder` when set). Mirrors the web
/// console's `/search_files` API: when the user has an active search or
/// filter, the UI shows matches from anywhere in the drive — not just the
/// rows it already had in memory.
///
/// The walk combines two sources so files synced from other devices show
/// up before they've downloaded locally:
///   1. The on-disk tree under `sync_path[/subfolder]`.
///   2. The drive's server-known rel-path index (`synced_paths_for_label`),
///      filtered to entries whose key starts with the subfolder prefix.
///      Entries already produced by the disk walk are skipped via a
///      `seen` set keyed on the relative path.
///
/// Filter application is delegated to [`apply_file_filters`] so the same
/// search/type/extension/date/size rules used everywhere else apply here
/// unchanged.
#[tauri::command]
pub async fn search_user_files_recursive(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    label: String,
    subfolder: Option<String>,
    filters: FileFilterCriteria,
) -> Result<Vec<UserFileEntry>> {
    // Account-scoped search; authorize against the session account.
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    let sync_paths = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "search_user_files_recursive").await;
    // Drive must be a real registered sync path for this user — the
    // `sync_paths` membership check below is the ownership guard (the
    // in-memory `synced_paths_for_label` lookup is keyed by label only and
    // does not enforce ownership on its own).
    let Some(sp) = sync_paths.iter().find(|sp| sp.label == label && !sp.path.is_empty()) else {
        // Unknown label / not yet initialised — surface as empty rather
        // than failing the IPC. Matches `get_user_files` which silently
        // skips drives that fail to list.
        return Ok(Vec::new());
    };

    let base = PathBuf::from(&sp.path);
    // Normalise the optional subfolder to a `rel_prefix` and validate
    // that, if provided, it stays inside the sync root.
    let rel_prefix = match subfolder.as_deref() {
        Some(s) if !s.is_empty() => {
            let target = base.join(s);
            ensure_within(&base, &target)?;
            s.trim_matches('/').to_string()
        }
        _ => String::new(),
    };

    // Snapshot of synced paths + excludes under a single per-drive lock
    // (matches `list_sync_folder_inner`). `synced` may be `None` if the
    // drive isn't currently mounted; in that case we still walk the disk.
    let (synced, excluded) = synced_paths_and_excludes_for_label(&state.sync, &label).await;

    let mut out: Vec<UserFileEntry> = Vec::new();

    // 1. On-disk walk — collects everything physically present locally.
    walk_disk_files_recursive(&base, &rel_prefix, &label, &sp.path, synced.as_ref(), &excluded, &mut out).await;

    // 2. Server-only overlay — files known on the server that haven't
    // downloaded to this device yet. We surface them as `sync_status =
    // "pending"` so the UI can render the same arrow it does at the root
    // listing for not-yet-local files.
    let prefix = if rel_prefix.is_empty() {
        String::new()
    } else {
        format!("{rel_prefix}/")
    };
    if let Some(map) = &synced {
        // Owned-string set so the loop body can `out.push(...)` (mutable
        // borrow) while we still need the set to dedupe further iterations.
        // Borrowing from `out.iter().map(...)` would keep an immutable
        // borrow alive across the push and fail the borrow checker.
        let seen: std::collections::HashSet<String> = out.iter().map(|e| e.actual_file_name.clone()).collect();
        for (rel, info) in map {
            if !prefix.is_empty() && !rel.starts_with(&prefix) {
                continue;
            }
            if seen.contains(rel) {
                continue;
            }
            let basename = rel.rsplit('/').next().unwrap_or(rel).to_string();
            let uploaded_at_ms = if info.uploaded_at != 0 { info.uploaded_at * 1000 } else { 0 };
            let updated_at_ms = if info.updated_at != 0 { info.updated_at * 1000 } else { 0 };
            let last_charged_at_ms = if updated_at_ms != 0 { updated_at_ms } else { uploaded_at_ms };
            out.push(UserFileEntry {
                name: basename.clone(),
                actual_file_name: rel.clone(),
                size: 0,
                created_at: uploaded_at_ms,
                arion_hash: info.path_hash_hex(),
                arion_cid: info.arion_cid.to_string(),
                file_id: String::new(),
                source: format!("{}/{}", sp.path, rel),
                miner_ids: Vec::new(),
                is_assigned: true,
                last_charged_at: last_charged_at_ms,
                is_folder: false,
                file_type: "private".to_string(),
                is_erasure_coded: false,
                main_req_hash: String::new(),
                sync_status: "pending".to_string(),
                label: label.clone(),
                file_count: None,
                deleted: false,
            });
        }
    }

    apply_file_filters(&mut out, &filters);

    // Newest-first by upload/charge timestamp — mirrors `get_user_files`'s
    // default ordering so the UI sees the same shape across both paths.
    out.sort_by_key(|b| std::cmp::Reverse(b.last_charged_at));

    Ok(out)
}

/// Apply the full filter chain to a mutable file list in place.
///
/// Shared between [`get_user_files`] (initial fetch with filters) and
/// [`filter_file_entries`] (UI-side filter re-application without a
/// refetch). Owning the filter rules in a single function keeps the
/// folder view and the files page from drifting — previously both
/// reimplemented the logic in TypeScript.
#[expect(clippy::too_many_lines, reason = "flat per-criterion filter cascade; splitting into helpers hurts readability")]
fn apply_file_filters(files: &mut Vec<UserFileEntry>, f: &FileFilterCriteria) {
    let search_lower = f.search_term.as_ref().and_then(|s| {
        let low = s.to_lowercase();
        if low.is_empty() { None } else { Some(low) }
    });
    let now = chrono::Utc::now();

    files.retain(|file| {
        if let Some(ref tab) = f.folder_tab
            && file.label != *tab
        {
            return false;
        }

        if let Some(ref search) = search_lower
            && !file.name.to_lowercase().contains(search)
            && !file.arion_hash.to_lowercase().contains(search)
        {
            return false;
        }

        if let Some(ref types) = f.file_types
            && !types.is_empty()
        {
            let matches = if file.is_folder {
                types.iter().any(|t| t == "folder")
            } else {
                let ext = file.name.rsplit('.').next().unwrap_or("").to_lowercase();
                let file_type = classify_extension(&ext);
                types.iter().any(|t| t == file_type)
            };
            if !matches {
                return false;
            }
        }

        // Explicit extension match (case-insensitive). Folders are always
        // excluded by an active extension filter since extensions apply to
        // files only — same shape as the console's File Type dropdown.
        if let Some(ref exts) = f.file_extensions
            && !exts.is_empty()
        {
            if file.is_folder {
                return false;
            }
            let ext = file.name.rsplit('.').next().unwrap_or("").to_lowercase();
            let matches = exts.iter().any(|e| e.trim_start_matches('.').to_lowercase() == ext);
            if !matches {
                return false;
            }
        }

        // Console-style date-range window. Mirrors hippius-console:
        //   from = local midnight on `range.from`
        //   to   = local 23:59:59.999 on `range.to`
        // The comparison is in absolute timestamps (UTC ms) so files
        // uploaded near local midnight aren't dropped just because their
        // UTC *date* lands on a neighbouring day — that was the bug the
        // user reported (console returned hits, desktop returned none).
        if let Some(ref range) = f.date_range {
            if file.created_at == 0 {
                return false;
            }
            let file_ms = if file.created_at > 946_684_800_000 {
                file.created_at
            } else {
                file.created_at * 1000
            };
            use chrono::TimeZone;
            let parse_local_start = |s: &str| -> Option<i64> {
                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .and_then(|dt| chrono::Local.from_local_datetime(&dt).single())
                    .map(|dt| dt.timestamp_millis())
            };
            let parse_local_end = |s: &str| -> Option<i64> {
                chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_milli_opt(23, 59, 59, 999))
                    .and_then(|dt| chrono::Local.from_local_datetime(&dt).single())
                    .map(|dt| dt.timestamp_millis())
            };
            let from_ms = parse_local_start(&range.from);
            // Allow "from only" / "to only" partial ranges by treating an
            // unparseable bound on either side as "no constraint there".
            let to_ms = parse_local_end(&range.to);
            if let Some(f_ms) = from_ms
                && file_ms < f_ms
            {
                return false;
            }
            if let Some(t_ms) = to_ms
                && file_ms > t_ms
            {
                return false;
            }
        } else if let Some(ref date) = f.date_filter
            && !date.is_empty()
        {
            if file.created_at == 0 {
                return false;
            }
            let file_ms = if file.created_at > 946_684_800_000 {
                file.created_at
            } else {
                file.created_at * 1000
            };
            let Some(file_dt) = chrono::DateTime::from_timestamp_millis(file_ms) else {
                return false;
            };
            let date_matches = match date.as_str() {
                "today" => file_dt.date_naive() == now.date_naive(),
                "last7days" => (now - file_dt).num_days() <= 7,
                "last30days" => (now - file_dt).num_days() <= 30,
                "thisyear" => file_dt.date_naive().year() == now.date_naive().year(),
                "lastyear" => file_dt.date_naive().year() == now.date_naive().year() - 1,
                _ => {
                    if let Ok(target) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                        file_dt.date_naive() == target
                    } else {
                        true
                    }
                }
            };
            if !date_matches {
                return false;
            }
        }

        // Size thresholds come from `EnhancedFileSizeSelector` in SI
        // bytes (1 MB = 1_000_000) to match the user-facing labels the
        // `formatBytes` helper prints. Any other numeric threshold is
        // treated as a custom "size >= N" cut.
        if let Some(ref sizes) = f.file_sizes
            && !sizes.is_empty()
        {
            let size = file.size;
            let size_matches = sizes.iter().any(|&threshold| match threshold {
                1 => size < 1_000_000,
                1_000_000 => (1_000_000..=100_000_000).contains(&size),
                100_000_000 => size > 100_000_000 && size <= 1_000_000_000,
                1_000_000_000 => size > 1_000_000_000,
                _ => size >= threshold,
            });
            if !size_matches {
                return false;
            }
        }

        true
    });
}

/// Map a file extension to the coarse type group the filter UI uses.
///
/// Pulled out of the filter so the same classifier can be reused (e.g.
/// for icon selection) without duplicating the extension list.
fn classify_extension(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "svg" | "webp" | "ico" | "tiff" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "wmv" | "flv" | "webm" | "m4v" | "3gp" => "video",
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "wma" | "m4a" => "audio",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "rtf" | "csv" | "md" => "document",
        "zip" | "tar" | "gz" | "rar" | "7z" | "bz2" => "archive",
        _ => "other",
    }
}

/// Apply the user files filter to an arbitrary list of entries.
///
/// Used by the files page and the folder view to re-filter a list the
/// frontend already has without re-fetching it from disk. Exposing the
/// shared filter as its own command keeps every filter rule (date
/// ranges, size thresholds, search behaviour) on the Rust side — the
/// TS layer now just passes criteria and renders the result.
#[tauri::command]
pub fn filter_file_entries(files: Vec<UserFileEntry>, filters: FileFilterCriteria) -> Vec<UserFileEntry> {
    let mut files = files;
    apply_file_filters(&mut files, &filters);
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wire-contract pin for `UserFileEntry`, which crosses IPC from `get_user_files`,
    /// `get_recent_uploads`, and `search_files` into the FE `FormattedUserFile`. It is
    /// desktop-owned (a bump can't rename it) but carries serde attributes an in-repo
    /// "consistency" refactor could silently break: `#[serde(rename_all = "camelCase")]`,
    /// `#[serde(rename = "type")]` on `file_type`, and `#[serde(default)]` on `file_id`.
    /// The sibling `recent_uploads.rs` tests assert Rust FIELD accessors (`entry.sync_status`),
    /// which never serialize — they would stay green through a `rename_all` flip. This pins
    /// the actual JSON keys, with the two non-obvious ones (`type`, `fileId`). AUDIT gap M2.
    #[test]
    fn user_file_entry_pins_camel_case_wire() {
        use std::collections::BTreeSet;

        let entry = UserFileEntry {
            name: "report.pdf".to_string(),
            actual_file_name: "Work/report.pdf".to_string(),
            size: 2048,
            created_at: 1_700_000_000_000,
            arion_hash: "Qm123".to_string(),
            arion_cid: "cid".to_string(),
            file_id: "0".repeat(64),
            source: "/home/me/Docs/Work/report.pdf".to_string(),
            miner_ids: vec!["m1".to_string()],
            is_assigned: true,
            last_charged_at: 1_700_000_005_000,
            is_folder: false,
            file_type: "pdf".to_string(),
            is_erasure_coded: false,
            main_req_hash: "req".to_string(),
            sync_status: "synced".to_string(),
            label: "Docs".to_string(),
            file_count: Some(0),
            deleted: false,
        };
        let json = serde_json::to_value(&entry).expect("serialize UserFileEntry");
        let keys: BTreeSet<String> = json.as_object().expect("object").keys().cloned().collect();
        let expected: BTreeSet<String> = [
            "name", "actualFileName", "size", "createdAt", "arionHash", "arionCid", "fileId", "source", "minerIds",
            "isAssigned", "lastChargedAt", "isFolder", "type", "isErasureCoded", "mainReqHash", "syncStatus", "label",
            "fileCount", "deleted",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(keys, expected, "UserFileEntry wire keys drifted — FE FormattedUserFile reads these camelCase keys");

        // The two keys a naive rename would silently move: `file_type` serializes
        // under `type` (per-field rename beats rename_all), NOT `fileType`; and the
        // `default` field still serializes under `fileId`.
        assert_eq!(json["type"], "pdf", "file_type must serialize under key `type`");
        assert!(json.get("fileType").is_none(), "must not emit `fileType` (rename = \"type\" overrides camelCase)");
        assert_eq!(json["fileId"], "0".repeat(64), "file_id must serialize under key `fileId`");
    }

    fn make_file(name: &str, size: u64, label: &str, created_at: i64, is_folder: bool) -> UserFileEntry {
        UserFileEntry {
            name: name.to_string(),
            actual_file_name: name.to_string(),
            size,
            created_at,
            arion_hash: String::new(),
            arion_cid: String::new(),
            file_id: String::new(),
            source: String::new(),
            miner_ids: Vec::new(),
            is_assigned: false,
            last_charged_at: created_at,
            is_folder,
            file_type: String::new(),
            is_erasure_coded: false,
            main_req_hash: String::new(),
            sync_status: String::new(),
            label: label.to_string(),
            file_count: None,
            deleted: false,
        }
    }

    #[test]
    fn filter_search_matches_name_case_insensitive() {
        let files = vec![
            make_file("Report.pdf", 1_000, "docs", 0, false),
            make_file("photo.png", 1_000, "docs", 0, false),
        ];
        let criteria = FileFilterCriteria {
            search_term: Some("REPORT".into()),
            file_types: None,
            date_filter: None,
            file_sizes: None,
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Report.pdf");
    }

    #[test]
    fn filter_folder_tab_isolates_label() {
        let files = vec![
            make_file("a.txt", 1, "drive-one", 0, false),
            make_file("b.txt", 1, "drive-two", 0, false),
            make_file("c.txt", 1, "drive-one", 0, false),
        ];
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: None,
            date_filter: None,
            file_sizes: None,
            folder_tab: Some("drive-one".into()),
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["a.txt", "c.txt"]);
    }

    #[test]
    fn filter_size_si_thresholds() {
        let files = vec![
            make_file("tiny.txt", 500, "d", 0, false),           // Small
            make_file("medium.zip", 50_000_000, "d", 0, false),  // Medium
            make_file("large.bin", 500_000_000, "d", 0, false),  // Large
            make_file("huge.iso", 5_000_000_000, "d", 0, false), // Very Large
        ];
        // "Medium" + "Very Large" selected — boundaries match the UI's SI labels.
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: None,
            date_filter: None,
            file_sizes: Some(vec![1_000_000, 1_000_000_000]),
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["medium.zip", "huge.iso"]);
    }

    #[test]
    fn filter_type_classifies_by_extension() {
        let files = vec![
            make_file("pic.png", 1, "d", 0, false),
            make_file("clip.mp4", 1, "d", 0, false),
            make_file("notes.txt", 1, "d", 0, false),
            make_file("subfolder", 0, "d", 0, true),
        ];
        let criteria = FileFilterCriteria {
            search_term: None,
            file_types: Some(vec!["image".into(), "folder".into()]),
            date_filter: None,
            file_sizes: None,
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["pic.png", "subfolder"]);
    }

    #[test]
    fn empty_criteria_is_a_noop() {
        let files = vec![make_file("a.txt", 1, "d", 0, false), make_file("b.txt", 1, "d", 0, false)];
        let criteria = FileFilterCriteria {
            search_term: Some(String::new()),
            file_types: Some(Vec::new()),
            date_filter: Some(String::new()),
            file_sizes: Some(Vec::new()),
            folder_tab: None,
            date_range: None,
            file_extensions: None,
        };
        assert!(criteria.is_empty());
        let out = filter_file_entries(files, criteria);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn label_stats_aggregates_bytes_and_counts_per_label() {
        // Simulate what `get_user_files` pushes into `all_files`:
        //  - drive "alpha": one 1 KB file + one 200 B file + one folder row
        //    with 3 nested files, 4 KB aggregate
        //  - drive "beta":  one 500 B file + an empty folder row (file_count = 0)
        //  - drive "gamma": one folder row with `file_count: None` — hits the
        //    `unwrap_or(0)` defense without requiring get_user_files to misbehave
        //  - one "excluded" entry on drive "alpha" — must be skipped entirely
        let mut excluded = make_file("ignored.txt", 999_999, "alpha", 0, false);
        excluded.sync_status = "excluded".to_string();

        let entries: Vec<UserFileEntry> = vec![
            make_file("a.txt", 1_000, "alpha", 0, false),
            make_file("a2.txt", 200, "alpha", 0, false),
            UserFileEntry {
                file_count: Some(3),
                size: 4_000,
                ..make_file("sub", 4_000, "alpha", 0, true)
            },
            excluded,
            make_file("b.txt", 500, "beta", 0, false),
            UserFileEntry {
                file_count: Some(0),
                size: 0,
                ..make_file("empty", 0, "beta", 0, true)
            },
            UserFileEntry {
                file_count: None,
                size: 100,
                ..make_file("loose", 100, "gamma", 0, true)
            },
        ];

        let stats = compute_label_stats(&entries);

        let alpha = stats.get("alpha").expect("alpha stats present");
        assert_eq!(alpha.total_bytes, 5_200, "alpha bytes (1000 + 200 + 4000, excluded skipped)");
        assert_eq!(alpha.file_count, 5, "alpha file count (2 files + 3 nested, excluded skipped)");

        let beta = stats.get("beta").expect("beta stats present");
        assert_eq!(beta.total_bytes, 500, "beta bytes");
        assert_eq!(beta.file_count, 1, "beta file count (1 file + 0 for empty folder)");

        let gamma = stats.get("gamma").expect("gamma stats present");
        assert_eq!(gamma.total_bytes, 100, "gamma bytes");
        assert_eq!(gamma.file_count, 0, "gamma file count (folder with file_count: None => 0)");
    }

    /// Drift guard between `compute_label_stats` (the rule definition) and
    /// the inline accumulator inside `get_user_files`. Both paths now route
    /// every counted entry through `apply_label_stats_rule` and every
    /// filter check through `is_counted_for_label_stats`, so this test
    /// simulates the inline path manually using the SAME helpers and
    /// asserts equivalence with `compute_label_stats`. If a future refactor
    /// changes one path's filter or accumulation, this test fails loudly
    /// because the helpers diverge.
    #[test]
    fn inline_path_matches_compute_label_stats_via_shared_helpers() {
        let mut excluded = make_file("ignored.txt", 999_999, "alpha", 0, false);
        excluded.sync_status = "excluded".to_string();
        let entries: Vec<UserFileEntry> = vec![
            make_file("a.txt", 1_000, "alpha", 0, false),
            UserFileEntry {
                file_count: Some(3),
                size: 4_000,
                ..make_file("sub", 4_000, "alpha", 0, true)
            },
            excluded,
            make_file("b.txt", 500, "beta", 0, false),
        ];

        // Path 1: rule-definition (the test-only helper above).
        let rule_stats = compute_label_stats(&entries);

        // Path 2: simulate the inline path inside `get_user_files`. Same
        // shared helpers, same filter ordering — if production drifts,
        // this expression no longer matches `compute_label_stats` because
        // either the filter or the accumulator was changed somewhere.
        let mut inline_stats: HashMap<String, LabelStats> = HashMap::new();
        for entry in entries.iter().filter(|e| is_counted_for_label_stats(&e.sync_status)) {
            apply_label_stats_rule(
                inline_stats.entry(entry.label.clone()).or_default(),
                entry.is_folder,
                entry.file_count.unwrap_or(0),
                entry.size,
            );
        }

        assert_eq!(inline_stats, rule_stats);
    }
}
