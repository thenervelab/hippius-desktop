//! Folder listing: flat (`list_sync_folder`) and grouped/overlay
//! (`list_sync_folder_grouped`). Owns `FileEntry` and the Finder name ordering.

use super::dir_stats::dir_stats_recursive;
use super::pathops::{ensure_within, is_engine_hidden_name};
use super::synced_state::synced_paths_and_excludes_for_label;
use crate::auth::account_key::account_key;
use crate::error::Result;
use hcfs_client::engine::types::SyncedFileInfo;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tracing::{info, warn};

type PreloadedSynced = (Option<HashMap<String, SyncedFileInfo>>, Vec<String>);

#[derive(Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: Option<u64>,
    /// Sync status: "synced", "pending", "excluded", or "unknown"
    pub sync_status: String,
    /// Hex-encoded path_hash from the synced state (empty if not synced yet)
    pub arion_hash: String,
    /// Arion CID from storage backend (empty if not available)
    pub arion_cid: String,
    /// For folders: total number of files (not directories) recursively inside.
    /// For files: 0.
    pub file_count: u64,
    /// Server-side timestamp: when the file was first uploaded (Unix seconds).
    /// 0 when not available (file not yet synced).
    pub uploaded_at: i64,
    /// Server-side timestamp: when the file was last updated (Unix seconds).
    /// 0 when not available (file not yet synced).
    pub updated_at: i64,
}

/// List contents of sync folder.
///
/// Thin wrapper around [`list_sync_folder_inner`] that unwraps `state` —
/// callers inside Rust (notably [`list_sync_folder_grouped`]) should hit the
/// inner helper directly to avoid going through the Tauri command plumbing.
#[tauri::command]
pub async fn list_sync_folder(
    state: tauri::State<'_, crate::app_state::AppState>,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<Vec<FileEntry>> {
    list_sync_folder_inner(&state, sync_path, subfolder, label).await
}

async fn list_sync_folder_inner(
    state: &crate::app_state::AppState,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<Vec<FileEntry>> {
    list_sync_folder_inner_with(state, sync_path, subfolder, label, None).await
}

async fn list_sync_folder_inner_with(
    state: &crate::app_state::AppState,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
    preloaded: Option<PreloadedSynced>,
) -> Result<Vec<FileEntry>> {
    let base = PathBuf::from(&sync_path);
    let target = match subfolder {
        Some(ref sub) => base.join(sub),
        None => base.clone(),
    };

    // Return empty list if directory doesn't exist yet (e.g. sync still initializing after login)
    if !tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    // Validate subfolder stays within sync_path. Canonicalize is
    // blocking — hop off the runtime so a nested listing cannot stall
    // other IPC.
    if subfolder.is_some() {
        let parent = base.clone();
        let child = target.clone();
        tokio::task::spawn_blocking(move || ensure_within(&parent, &child))
            .await
            .map_err(|e| crate::error::AppError::Other(format!("ensure_within task panicked: {e}")))??;
    }

    // Load synced paths AND exclusion patterns in a single drives-map
    // lock + single per-drive lock. Previously these were two separate
    // acquisitions (synced_paths_for_label, then a `.lock().await` on
    // the same outer mutex for excludes) which serialized listings
    // behind any in-flight sync that held the outer lock.
    //
    // `preloaded` lets `list_sync_folder_grouped_inner` load the map once
    // and reuse it for the server-only overlay instead of a second
    // `synced_paths_for_label` call.
    let (synced_set, excluded_patterns) = match preloaded {
        Some(pair) => pair,
        None => match label {
            Some(ref l) => synced_paths_and_excludes_for_label(&state.sync, l).await,
            None => (None, Vec::new()),
        },
    };
    let exclude_rules = super::exclude_match::rules_from_patterns(&excluded_patterns);

    let mut entries = Vec::new();
    // A read_dir failure is an I/O fault → Io (#[from]).
    let mut dir = tokio::fs::read_dir(&target).await?;

    while let Some(entry) = dir.next_entry().await? {
        let os_name = entry.file_name();
        // Same `to_str()`-gated dot rule as the engine. Listing a UTF-8
        // hidden file would pin it Pending forever (H-063) — the engine
        // never uploads `.env.qa`. A lossy `.` check would hide a
        // non-UTF-8 name the engine does upload.
        if is_engine_hidden_name(&os_name) {
            continue;
        }
        let name = os_name.to_string_lossy().to_string();

        let meta = entry.metadata().await?;
        let is_folder = meta.is_dir();

        // Remove and skip failed download artifacts (`downloaded_<hex>`) and
        // 0-byte encrypted-name stubs (`file_<hex>`) left by decryption
        // failures. Deleting on sight closes the gap between sync cycles
        // where post-sync cleanup hasn't run yet.
        if !is_folder {
            if hcfs_client::engine::classify::is_failed_download_artifact(&name).is_some() {
                let path = entry.path();
                info!(artifact = %name, "Removing failed download artifact on list");
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    warn!(artifact = %name, error = %e, "Failed to remove failed-download artifact on list — it will be retried on the next listing");
                }
                continue;
            }
            if hcfs_client::engine::classify::is_encrypted_name_stub(&name).is_some() && meta.len() == 0 {
                let path = entry.path();
                info!(stub = %name, "Removing 0-byte encrypted-name stub on list");
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    warn!(stub = %name, error = %e, "Failed to remove 0-byte stub on list — it will be retried on the next listing");
                }
                continue;
            }
        }

        // Build relative path matching hcfs-client convention:
        // BLAKE3 is computed over relative_path.to_string_lossy()
        let relative_path = match subfolder {
            Some(ref sub) => format!("{sub}/{name}"),
            None => name.clone(),
        };

        // Folders don't have server-side entries — their children do.
        // Match engine globs (`*.bin` → foo.bin and dir/foo.bin), not exact
        // path equality — that left glob-excluded files Pending on Drive.
        let is_excluded = super::exclude_match::path_is_excluded(&exclude_rules, &relative_path, is_folder);
        let (sync_status, info) = if is_excluded {
            ("excluded", None)
        } else if is_folder {
            ("synced", None)
        } else {
            match &synced_set {
                Some(map) => match map.get(&relative_path) {
                    Some(i) => ("synced", Some(i)),
                    None => ("pending", None),
                },
                None => ("unknown", None),
            }
        };

        // Folder row numbers are billed: dir_stats omits excluded children
        // (H-110) even though H-045 keeps those files as visible rows.
        // `is_counted_for_label_stats` also omits them, so File No and the
        // folder row stay one number. `base`, not `target`: the patterns
        // are drive-relative.
        //
        // An excluded folder gets no walk at all (H-045 drops that row).
        // Walking `node_modules/` for a number nothing bills is wasted.
        let (size, file_count) = if !is_folder {
            (meta.len(), 0)
        } else if is_excluded {
            (0, 0)
        } else {
            let excludes = super::dir_stats::DirStatsExcludes {
                root: &base,
                patterns: &excluded_patterns,
            };
            dir_stats_recursive(&target.join(&name), Some(&excludes)).await
        };

        entries.push(FileEntry {
            name,
            is_folder,
            size,
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            sync_status: sync_status.to_string(),
            arion_hash: info.map_or_else(String::new, hcfs_client::engine::types::SyncedFileInfo::path_hash_hex),
            arion_cid: info.map_or_else(String::new, |i| i.arion_cid.to_string()),
            file_count,
            uploaded_at: info.map_or(0, |i| i.uploaded_at),
            updated_at: info.map_or(0, |i| i.updated_at),
        });
    }

    Ok(entries)
}

/// Response for [`list_sync_folder_grouped`].
///
/// The frontend renders `folders` and `files` as two separate sections at the
/// current navigation level. `pending_backfill` gates an informational banner
/// that tells the user the server-side rel-path index is still being populated
/// — until it clears, nested directories a device hasn't downloaded yet won't
/// appear server-side-only (they only show once their on-disk copy arrives).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupedListing {
    pub folders: Vec<FileEntry>,
    pub files: Vec<FileEntry>,
    /// `true` iff `sync_paths.relative_paths_backfilled_at` is NULL for this
    /// drive. Signals to the FE that the grouped view may omit subfolders
    /// that only exist server-side on another device.
    pub pending_backfill: bool,
}

/// Render one level of the sync-folder hierarchy, overlaying on-disk entries
/// with server-registered rel-paths from `synced_paths_for_label`.
///
/// Fixes the "subfolder shows as empty / console is flat" bug: `list_sync_folder`
/// reads only from disk, so on a device that hasn't downloaded the subfolder
/// yet the tree appears empty even when the server side has every file. This
/// command treats the union of (on-disk children + server rel-paths that start
/// with `subfolder + "/"`) as authoritative and groups by the first path
/// component. The "console shows flat" symptom falls out because callers now
/// receive the group structure directly instead of flattening `get_user_files`.
///
/// `pending_backfill` is read from `sync_paths.relative_paths_backfilled_at` —
/// NULL = the one-shot backfill hasn't yet posted rel-paths for legacy rows to
/// the server, so server-only entries won't yet appear. Once set, the FE can
/// hide the "still indexing" banner.
#[tauri::command]
pub async fn list_sync_folder_grouped(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<GroupedListing> {
    let account_id = state.require_session_account(&account_id)?;
    list_sync_folder_grouped_inner(&state, account_id, sync_path, subfolder, label).await
}

/// Compare two file/folder names using macOS Finder ordering rules, which
/// match `NSString.localizedStandardCompare`:
///   1. Case-insensitive
///   2. Natural number ordering ("9" < "10", "2025" < "2026")
///   3. Primary category order: punctuation/symbols < digits < letters
///
/// This keeps `_backup` before `2025_rennsport` before `InstantUpload`,
/// matching what the user sees in Finder when sorted by name.
///
/// Implementation: normalize each name so that every non-alphanumeric char
/// becomes `'\x01'` (which sorts before all digits and letters), and
/// lowercase all letters, then compare the resulting strings with natural
/// number ordering (digit runs compared numerically, not lexicographically).
fn macos_name_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn normalize_char(c: char) -> char {
        if c.is_ascii_digit() {
            c
        } else if let Some(lower) = c.to_lowercase().next() {
            if lower.is_alphabetic() { lower } else { '\x01' }
        } else {
            '\x01'
        }
    }

    // Walk both normalized strings simultaneously, comparing digit runs
    // numerically and all other characters by value.
    let mut ai = a.chars().map(normalize_char).peekable();
    let mut bi = b.chars().map(normalize_char).peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    // Natural-sort the two digit runs by numeric value, comparing
                    // them as digit *sequences* rather than parsing into an
                    // integer: a 20+ digit run is a legal filename that overflows
                    // any fixed-width integer. The earlier u64 parse saturated
                    // every over-long run to the same u64::MAX, so two *distinct*
                    // huge runs compared Equal — a non-total order, which
                    // `slice::sort_by` documents as "May panic if `compare` does
                    // not implement a total order" (std slice sort_by). Sequence
                    // comparison stays a genuine total order with no overflow.
                    //
                    // Skip leading zeros first so "007" == "7" (numeric
                    // equality); then the run with more significant digits is the
                    // larger number, and for equal lengths the first differing
                    // digit decides.
                    while ai.peek() == Some(&'0') {
                        ai.next();
                    }
                    while bi.peek() == Some(&'0') {
                        bi.next();
                    }
                    let mut run_order = std::cmp::Ordering::Equal;
                    loop {
                        let ad = ai.peek().copied().filter(char::is_ascii_digit);
                        let bd = bi.peek().copied().filter(char::is_ascii_digit);
                        match (ad, bd) {
                            (Some(da), Some(db)) => {
                                ai.next();
                                bi.next();
                                // First differing digit at equal length decides;
                                // hold it until we know both runs are equal-length.
                                if run_order == std::cmp::Ordering::Equal {
                                    run_order = da.cmp(&db);
                                }
                            }
                            // A remaining significant digit means the longer —
                            // hence numerically larger — run.
                            (Some(_), None) => return std::cmp::Ordering::Greater,
                            (None, Some(_)) => return std::cmp::Ordering::Less,
                            (None, None) => break,
                        }
                    }
                    match run_order {
                        std::cmp::Ordering::Equal => continue,
                        ord => return ord,
                    }
                }
                ai.next();
                bi.next();
                match ac.cmp(&bc) {
                    std::cmp::Ordering::Equal => {}
                    ord => return ord,
                }
            }
        }
    }
}

/// Pure helper for [`list_sync_folder_grouped`], exposed for integration tests
/// so they can drive it against a hand-assembled [`AppState`] without going
/// through the Tauri command layer.
// Sat just under the 100-line limit before the tree was rustfmt'd; reflowing
// long lines pushed it to 103 without changing a single statement. Splitting it
// is a real refactor and does not belong in a formatting-only change — tracked
// as a follow-up rather than smuggled in here.
#[allow(clippy::too_many_lines, reason = "formatting-only line growth; extraction tracked separately")]
pub async fn list_sync_folder_grouped_inner(
    state: &crate::app_state::AppState,
    account_id: String,
    sync_path: String,
    subfolder: Option<String>,
    label: Option<String>,
) -> Result<GroupedListing> {
    // 1. On-disk entries (same rules as `list_sync_folder`). Reusing the
    // inner helper keeps the exclude/sync-status/file-count logic in one
    // place; a missing subfolder returns `Vec::new()` from there and we
    // overlay server entries below.
    // One map load for both the on-disk listing and the server-only overlay.
    let (synced_set, excluded_patterns) = match &label {
        Some(l) => synced_paths_and_excludes_for_label(&state.sync, l).await,
        None => (None, Vec::new()),
    };
    let exclude_rules = super::exclude_match::rules_from_patterns(&excluded_patterns);
    let disk_entries = list_sync_folder_inner_with(
        state,
        sync_path.clone(),
        subfolder.clone(),
        label.clone(),
        Some((synced_set.clone(), excluded_patterns)),
    )
    .await?;

    // 3. Build the overlay. Normalise the subfolder prefix to always end in
    // `/` so `rel.starts_with(prefix)` doesn't match a sibling whose name
    // happens to share a prefix (e.g. subfolder="docs" and rel="docs2/x").
    let prefix = match subfolder.as_deref() {
        Some("") | None => String::new(),
        Some(s) => format!("{}/", s.trim_end_matches('/')),
    };
    let mut seen_names: std::collections::HashSet<String> = disk_entries.iter().map(|e| e.name.clone()).collect();
    let mut server_only_files: Vec<FileEntry> = Vec::new();
    // (file_count, first-info) for each server-only folder at this level.
    let mut server_only_folders: HashMap<String, u64> = HashMap::new();

    if let Some(map) = &synced_set {
        for (rel, info) in map {
            if !rel.starts_with(&prefix) {
                continue;
            }
            let remainder = &rel[prefix.len()..];
            if remainder.is_empty() {
                continue;
            }
            // Nested excluded paths still contribute nothing: that is what
            // stops `vendor/node_modules/a.js` from conjuring a `vendor`
            // folder. A *direct* excluded file stays as a row (H-045).
            let file_excluded = super::exclude_match::path_is_excluded(&exclude_rules, rel, false);
            match remainder.split_once('/') {
                Some((first_component, _rest)) => {
                    if file_excluded {
                        continue;
                    }
                    // Server-known subfolder at this level. Skip if already on
                    // disk (the on-disk entry's `file_count` is authoritative
                    // for this device's view of the subfolder).
                    // `prefix` is already `""` or `"<sub>/"`, so this is the
                    // drive-relative path the exclude rules are matched on.
                    let folder_rel = format!("{prefix}{first_component}");
                    if !seen_names.contains(first_component) && !super::exclude_match::path_is_excluded(&exclude_rules, &folder_rel, true) {
                        *server_only_folders.entry(first_component.to_string()).or_insert(0) += 1;
                    }
                }
                None => {
                    if !seen_names.contains(remainder) {
                        server_only_files.push(FileEntry {
                            name: remainder.to_string(),
                            is_folder: false,
                            size: 0,
                            modified: None,
                            sync_status: if file_excluded { "excluded".to_string() } else { "pending".to_string() },
                            arion_hash: info.path_hash_hex(),
                            arion_cid: info.arion_cid.to_string(),
                            file_count: 0,
                            uploaded_at: info.uploaded_at,
                            updated_at: info.updated_at,
                        });
                        seen_names.insert(remainder.to_string());
                    }
                }
            }
        }
    }

    // 4. Assemble final `folders` + `files` from disk_entries plus server-only
    // additions. Partition disk entries by `is_folder`; append server-only
    // folders (with aggregated file counts) and server-only files.
    let mut folders: Vec<FileEntry> = Vec::new();
    let mut files: Vec<FileEntry> = Vec::new();
    for entry in disk_entries {
        // Excluded folders stay off Drive (a `node_modules/` row that
        // opens into thousands of excluded children is not useful).
        // Excluded *files* stay, tagged `excluded` (H-045): silent drop
        // with no badge was the bug. Billed File No still omits them.
        if entry.sync_status == "excluded" && entry.is_folder {
            continue;
        }
        if entry.is_folder {
            folders.push(entry);
        } else {
            files.push(entry);
        }
    }
    for (name, file_count) in server_only_folders {
        // Record the name so the empty-folder overlay (step 4b) dedups against
        // a folder already shown here from a server-only file's PARENT. Without
        // this, a folder that has both a server-only descendant file AND a
        // `folder_entries_local` row would be pushed twice — the file-derived
        // row with its real count, plus a duplicate pending(0) from the cache.
        seen_names.insert(name.clone());
        folders.push(FileEntry {
            name,
            is_folder: true,
            size: 0,
            modified: None,
            sync_status: "pending".to_string(),
            arion_hash: String::new(),
            arion_cid: String::new(),
            file_count,
            uploaded_at: 0,
            updated_at: 0,
        });
    }
    files.extend(server_only_files);

    // 4b. Empty-folder overlay. `folder_entries_local` (Task 1.11) is this
    // device's cache of registered directories — including EMPTY ones, which
    // leave no file in the rel-path index (it's keyed by file `path_hash`) and
    // so never reach `server_only_folders`. Add each cached directory that is a
    // direct child of `subfolder`, grouped by the same first-path-component
    // rule used above, and dedup via `seen_names` so a folder already shown
    // (from disk or a file's parent) is never doubled. Owner-scoped so a second
    // account's cache can't leak in. This is what makes empty folders appear in
    // the desktop listing, matching the web console's `/browse` UNION.
    let owner = account_key(&account_id);
    if let Some(l) = &label
        && let Ok(pool) = state.pool()
    {
        let level_dir = subfolder
            .as_deref()
            .filter(|s| !s.is_empty())
            .map_or_else(|| PathBuf::from(&sync_path), |s| PathBuf::from(&sync_path).join(s));
        for entry in cache_only_folder_candidates(pool, &owner, l, &prefix, &level_dir).await {
            // An excluded folder must not come back through the cache. The
            // on-disk copy is already dropped above, and `seen_names` only
            // covers folders that exist locally — a `node_modules/` rule on a
            // drive whose tree was registered from another device would
            // otherwise reappear here as a pending folder the engine never
            // syncs.
            if super::exclude_match::path_is_excluded(&exclude_rules, &format!("{prefix}{}", entry.name), true) {
                continue;
            }
            // `HashSet::insert` returns false when the name is already shown
            // (from disk or a file's parent) — the dedup-by-name the task
            // requires, so an on-disk folder is never doubled by its cache row.
            if seen_names.insert(entry.name.clone()) {
                folders.push(entry);
            }
        }
    }

    // Sort both lists to match macOS Finder name ordering:
    // punctuation/symbols first, then digits, then letters, with natural
    // number ordering within digit runs.
    folders.sort_by(|a, b| macos_name_cmp(&a.name, &b.name));
    files.sort_by(|a, b| macos_name_cmp(&a.name, &b.name));

    // 5. Backfill flag. NULL on `relative_paths_backfilled_at` ⇒ pending.
    // Any DB error — missing row, pool not ready — surfaces as
    // `pending_backfill=false`: we'd rather miss the banner than block the
    // listing. The backfill task itself is the source of truth and will
    // flip the flag once it completes.
    let pending_backfill = if let Some(l) = &label {
        match state.pool() {
            Ok(pool) => !crate::sync::relative_path_backfill::is_backfilled(pool, &owner, l).await.unwrap_or(true),
            Err(_) => false,
        }
    } else {
        false
    };

    Ok(GroupedListing {
        folders,
        files,
        pending_backfill,
    })
}

/// Build the direct-child folders implied by the `folder_entries_local` cache
/// (Task 1.11) for one listing level, ready to overlay onto the grouped view.
///
/// `folder_entries_local` is this device's cache of registered directories —
/// including EMPTY ones that leave no file in the rel-path index, so they never
/// reach `server_only_folders`. This is the source that makes empty folders
/// appear, matching the web console's `/browse` UNION.
///
/// Each cached directory rel-path is grouped by the first path component under
/// `prefix` (the same rule the file overlay uses). One [`FileEntry`] is emitted
/// per DISTINCT direct-child name (deduped internally so cache rows `a` and
/// `a/b` yield `a` once). The caller is responsible for the final dedup against
/// names already shown from disk / files.
///
/// `sync_status` is `synced` when the directory is materialized on disk at this
/// level (`level_dir/<name>` exists), else `pending` — registered on another
/// device or not yet downloaded here, mirroring the not-yet-synced convention
/// `server_only_folders` uses.
///
/// The read is `owner`-scoped (the cross-account-leak guard the cache table's
/// composite PK was designed around) and degrades to an empty overlay on any DB
/// error: the listing still renders from disk + the rel-path index, the same
/// "miss the overlay rather than block the listing" trade-off `pending_backfill`
/// makes.
fn exclusive_prefix_end(prefix: &str) -> Option<String> {
    if prefix.is_empty() {
        return None;
    }
    let mut bytes = prefix.as_bytes().to_vec();
    for i in (0..bytes.len()).rev() {
        if bytes[i] < 0xFF {
            bytes[i] += 1;
            bytes.truncate(i + 1);
            return Some(String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()));
        }
    }
    None
}

async fn folder_entries_for_level(
    pool: &sqlx::sqlite::SqlitePool,
    owner: &str,
    label: &str,
    prefix: &str,
) -> std::result::Result<Vec<String>, sqlx::Error> {
    if let Some(end) = exclusive_prefix_end(prefix) {
        sqlx::query_scalar::<_, String>(
            "SELECT relative_path FROM folder_entries_local
              WHERE owner = ? AND label = ?
                AND relative_path >= ? AND relative_path < ?",
        )
        .bind(owner)
        .bind(label)
        .bind(prefix)
        .bind(end)
        .fetch_all(pool)
        .await
    } else {
        sqlx::query_scalar::<_, String>("SELECT relative_path FROM folder_entries_local WHERE owner = ? AND label = ?")
            .bind(owner)
            .bind(label)
            .fetch_all(pool)
            .await
    }
}

async fn cache_only_folder_candidates(
    pool: &sqlx::sqlite::SqlitePool,
    owner: &str,
    label: &str,
    prefix: &str,
    level_dir: &std::path::Path,
) -> Vec<FileEntry> {
    // Degrade to an empty overlay on a read failure — the overlay is additive
    // and must never block the listing — but log it: a persistent failure
    // (corrupt/locked DB) would otherwise be indistinguishable from "no empty
    // folders" with no diagnostic trail.
    let rel_paths: Vec<String> = match folder_entries_for_level(pool, owner, label, prefix).await {
        Ok(rows) => rows,
        Err(e) => {
            warn!(owner = %owner, label = %label, error = %e, "folder_entries_local read failed; empty-folder overlay skipped this listing");
            Vec::new()
        }
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    for rel in rel_paths {
        if !rel.starts_with(prefix) {
            continue;
        }
        let remainder = &rel[prefix.len()..];
        let first_component = match remainder.split_once('/') {
            Some((first, _rest)) => first,
            None => remainder,
        };
        if first_component.is_empty() || !seen.insert(first_component.to_string()) {
            continue;
        }
        names.push(first_component.to_string());
    }

    // Child count is the listing width, not the drive. One blocking
    // pass so we do not hop to the kernel per overlay name on the
    // runtime thread.
    let level = level_dir.to_path_buf();
    let names_for_stat = names.clone();
    let on_disk: HashSet<String> = tokio::task::spawn_blocking(move || names_for_stat.into_iter().filter(|name| level.join(name).is_dir()).collect())
        .await
        .unwrap_or_default();

    names
        .into_iter()
        .map(|name| {
            let synced = on_disk.contains(&name);
            FileEntry {
                name,
                is_folder: true,
                size: 0,
                modified: None,
                sync_status: if synced { "synced" } else { "pending" }.to_string(),
                arion_hash: String::new(),
                arion_cid: String::new(),
                file_count: 0,
                uploaded_at: 0,
                updated_at: 0,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// Wire-contract pin for the `GroupedListing` / `FileEntry` pair returned by
    /// `list_sync_folder_grouped` and read by `use-nested-folder-listing.ts`. The
    /// casing is a DELIBERATE split the FE depends on: `GroupedListing` is
    /// `rename_all = "camelCase"` (`pendingBackfill`) but its inner `FileEntry` is
    /// plain snake_case (`is_folder`/`arion_hash`/`sync_status`). A "consistency"
    /// refactor adding `rename_all` to `FileEntry` would make every entry read
    /// `undefined` for those keys — collapsing folders to files and dropping sync
    /// status — with no compile error. This locks both halves. AUDIT gap M3.
    #[test]
    fn grouped_listing_pins_mixed_case_wire() {
        use std::collections::BTreeSet;

        let child = FileEntry {
            name: "child.txt".to_string(),
            is_folder: false,
            size: 10,
            modified: Some(1),
            sync_status: "synced".to_string(),
            arion_hash: "Qm".to_string(),
            arion_cid: "cid".to_string(),
            file_count: 0,
            uploaded_at: 2,
            updated_at: 3,
        };
        let file_keys: BTreeSet<String> = serde_json::to_value(&child)
            .expect("serialize FileEntry")
            .as_object()
            .expect("object")
            .keys()
            .cloned()
            .collect();
        let expected_file: BTreeSet<String> = [
            "name",
            "is_folder",
            "size",
            "modified",
            "sync_status",
            "arion_hash",
            "arion_cid",
            "file_count",
            "uploaded_at",
            "updated_at",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        assert_eq!(
            expected_file, file_keys,
            "FileEntry must stay snake_case — FE use-nested-folder-listing reads is_folder/arion_hash/sync_status"
        );

        let listing = GroupedListing {
            folders: vec![],
            files: vec![child],
            pending_backfill: true,
        };
        let outer = serde_json::to_value(&listing).expect("serialize GroupedListing");
        let outer_keys: BTreeSet<String> = outer.as_object().expect("object").keys().cloned().collect();
        let expected_outer: BTreeSet<String> = ["folders", "files", "pendingBackfill"].into_iter().map(String::from).collect();
        assert_eq!(
            expected_outer, outer_keys,
            "GroupedListing outer keys drifted — FE reads pendingBackfill (camelCase)"
        );
        // The inner FileEntry stays snake_case even nested inside the camelCase outer.
        assert_eq!(outer["files"][0]["is_folder"], false, "nested FileEntry must keep snake_case is_folder");
    }

    /// Verifies that `macos_name_cmp` produces the same ordering as macOS
    /// Finder when sorting by name: symbols/punctuation < digits < letters,
    /// with natural (not lexicographic) number ordering.
    #[test]
    fn macos_name_cmp_matches_finder_order() {
        let mut names = vec![
            "wordpress",
            "2025_rennsport",
            "_notes",
            "InstantUpload",
            "_backup",
            "Photos",
            "2026_rennsport",
            "__bittensor",
            "mogmachine.memory",
            "portugal",
        ];
        names.sort_by(|a, b| macos_name_cmp(a, b));

        // Expected order matches macOS Finder:
        // underscore-prefixed → digits → letters (case-insensitive)
        assert_eq!(
            names,
            vec![
                "__bittensor",
                "_backup",
                "_notes",
                "2025_rennsport",
                "2026_rennsport",
                "InstantUpload",
                "mogmachine.memory",
                "Photos",
                "portugal",
                "wordpress",
            ]
        );
    }

    #[test]
    fn macos_name_cmp_natural_number_ordering() {
        let mut names = vec!["file10", "file2", "file1", "file20", "file9"];
        names.sort_by(|a, b| macos_name_cmp(a, b));
        assert_eq!(names, vec!["file1", "file2", "file9", "file10", "file20"]);
    }

    #[test]
    fn macos_name_cmp_case_insensitive() {
        let mut names = vec!["Zebra", "apple", "Mango", "banana"];
        names.sort_by(|a, b| macos_name_cmp(a, b));
        assert_eq!(names, vec!["apple", "banana", "Mango", "Zebra"]);
    }

    #[test]
    fn macos_name_cmp_handles_overflowing_digit_runs() {
        // Digit runs longer than 20 chars overflow u64 (39 chars overflow u128):
        // the comparator must neither panic nor lose its total order. It compares
        // runs as digit sequences, so two *distinct* over-long runs order by
        // magnitude instead of both collapsing to a saturated MAX.
        let huge9 = format!("file{}", "9".repeat(30));
        let huge8 = format!("file{}", "8".repeat(30));

        // Equal-length runs: the larger leading digit wins (9… > 8…). The old
        // u64-saturating comparator wrongly returned Equal here, making the order
        // non-total — `slice::sort_by`'s documented "May panic" territory.
        assert_eq!(macos_name_cmp(&huge9, &huge8), std::cmp::Ordering::Greater);
        assert_eq!(macos_name_cmp(&huge8, &huge9), std::cmp::Ordering::Less);
        // Identical over-long runs still compare Equal.
        assert_eq!(macos_name_cmp(&huge9, &huge9), std::cmp::Ordering::Equal);
        // More significant digits is the larger number even with smaller digits:
        // 31 ones (≥ 10^30) outranks 30 nines (< 10^30).
        let longer = format!("file{}", "1".repeat(31));
        assert_eq!(macos_name_cmp(&longer, &huge9), std::cmp::Ordering::Greater);
        // An over-long run still orders after a small number.
        assert_eq!(macos_name_cmp(&huge9, "file2"), std::cmp::Ordering::Greater);
        // Leading zeros are not significant: "007" == "7" within a run.
        assert_eq!(macos_name_cmp("file007", "file7"), std::cmp::Ordering::Equal);

        // A full sort containing over-long runs completes without panic and is
        // correctly ordered by magnitude.
        let mut names = vec![huge9.as_str(), "file2", "file1", "file10", huge8.as_str()];
        names.sort_by(|a, b| macos_name_cmp(a, b));
        assert_eq!(names, vec!["file1", "file2", "file10", huge8.as_str(), huge9.as_str()]);
    }

    #[test]
    fn exclusive_prefix_end_bounds_children_and_not_siblings() {
        assert!(exclusive_prefix_end("").is_none());
        let end = exclusive_prefix_end("Photos/").expect("bound");
        assert_eq!(end, "Photos0");
        let cafe = exclusive_prefix_end("café/").expect("unicode bound");
        assert_eq!(cafe, "café0");

        // Same predicate the SQLite range uses (`>= prefix AND < end`).
        let in_range = |path: &str, prefix: &str, bound: &str| path >= prefix && path < bound;
        assert!(in_range("Photos/a", "Photos/", &end));
        assert!(in_range("Photos/zzzz", "Photos/", &end));
        assert!(!in_range("Photos0", "Photos/", &end));
        assert!(!in_range("Photos2", "Photos/", &end));
        assert!(!in_range("Photot", "Photos/", &end));
        assert!(in_range("café/x", "café/", &cafe));
    }

    proptest! {
        // `macos_name_cmp` feeds `slice::sort_by`, which documents "May panic if
        // `compare` does not implement a total order". These properties pin the
        // total-order contract the old u64-saturating comparator broke for 20+
        // digit runs.

        // Antisymmetry: cmp(a, b) is always the reverse of cmp(b, a).
        #[test]
        fn macos_name_cmp_is_antisymmetric(a in "[0-9A-Za-z._-]{0,30}", b in "[0-9A-Za-z._-]{0,30}") {
            prop_assert_eq!(macos_name_cmp(&a, &b), macos_name_cmp(&b, &a).reverse());
        }

        // Reflexivity: every name compares Equal to itself.
        #[test]
        fn macos_name_cmp_is_reflexive(a in "[0-9A-Za-z._-]{0,30}") {
            prop_assert_eq!(macos_name_cmp(&a, &a), std::cmp::Ordering::Equal);
        }

        // Digit runs order by true numeric value whenever the run fits in u128 —
        // the oracle is plain integer comparison, so this is not a tautology.
        #[test]
        fn macos_name_cmp_digit_runs_match_numeric(x in any::<u128>(), y in any::<u128>()) {
            prop_assert_eq!(macos_name_cmp(&x.to_string(), &y.to_string()), x.cmp(&y));
        }

        // A sort over arbitrarily long digit runs (well past u64/u128) completes
        // without panic and yields a non-decreasing sequence under the
        // comparator — only possible if the comparator is a genuine total order.
        #[test]
        fn macos_name_cmp_sorts_long_digit_runs_total(mut names in proptest::collection::vec("[0-9]{0,40}", 0..15)) {
            names.sort_by(|a, b| macos_name_cmp(a, b));
            for pair in names.windows(2) {
                prop_assert_ne!(macos_name_cmp(&pair[0], &pair[1]), std::cmp::Ordering::Greater);
            }
        }
    }
}
