//! Recent-files view (`get_recent_files`) and its bounded synced-metadata
//! lookup. Per-drive synced-tree reads shared with other pages live in the
//! `synced_state` leaf.

use crate::error::Result;
use hcfs_client::drive::ExcludeRules;
use hcfs_client::engine::manager::DriveManager;
use hcfs_client::engine::runner::SyncRunner;
use hcfs_client::engine::types::{SyncActivityAction, SyncedFileInfo, build_synced_paths_from_state};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

/// Return sync metadata (arion hashes, CIDs, timestamps) for all synced
/// files across all drives. Used internally by `get_user_files` to look
/// up arion hashes without needing to list every subfolder from disk.
/// Acquire each drive's synced-paths map. Same cache-first rule as
/// [`super::synced_state::synced_paths_for_label`]: a warm cache is the
/// source of truth; `load_sync_state` is miss-only. Reloading disk
/// when the lock is free would clobber DATE UPLOADED / pending vs
/// synced for the next Files listing.
async fn collect_label_maps(sync: &SyncRunner) -> Vec<(String, HashMap<String, SyncedFileInfo>)> {
    let drive_arcs: Vec<(String, std::sync::Arc<tokio::sync::Mutex<DriveManager>>)> = match sync.drives.try_lock() {
        Ok(guard) => guard.iter().map(|(k, slot)| (k.clone(), slot.manager.clone())).collect(),
        Err(_) => Vec::new(),
    };
    if drive_arcs.is_empty() {
        return match sync.synced_paths_cache.lock() {
            Ok(cache) => cache.iter().map(|(l, m)| (l.clone(), m.clone())).collect(),
            Err(_) => Vec::new(),
        };
    }
    let mut out = Vec::new();
    for (label, arc) in &drive_arcs {
        if let Some(cached) = sync.get_cached_synced_paths(label) {
            out.push((label.clone(), cached));
            continue;
        }
        let Ok(manager) = arc.try_lock() else {
            continue;
        };
        if let Ok(st) = manager.load_sync_state().await {
            let paths = build_synced_paths_from_state(&st);
            sync.update_synced_paths_cache(label, paths.clone());
            out.push((label.clone(), paths));
        }
    }
    out
}

/// Per-drive exclude rules for the recent-files filter.
///
/// Same lock discipline as [`collect_label_maps`]: copy Arcs out of the
/// outer map, `try_lock` each manager, skip a drive whose lock is held.
/// A missed exclude set means that drive's activity rows stay visible —
/// fail-open, never block the feed.
async fn collect_label_exclude_rules(sync: &SyncRunner) -> HashMap<String, ExcludeRules> {
    let drive_arcs: Vec<(String, Arc<TokioMutex<DriveManager>>)> = match sync.drives.try_lock() {
        Ok(guard) => guard.iter().map(|(k, slot)| (k.clone(), slot.manager.clone())).collect(),
        Err(_) => Vec::new(),
    };
    let mut out = HashMap::new();
    for (label, arc) in &drive_arcs {
        let Ok(manager) = arc.try_lock() else {
            continue;
        };
        let patterns = manager.list_exclude_patterns();
        if patterns.is_empty() {
            continue;
        }
        out.insert(label.clone(), super::exclude_match::rules_from_patterns(&patterns));
    }
    out
}

/// Bounded variant of the synced-paths walk for the recent-files view.
///
/// A whole-corpus walk would materialize metadata (and several string/hash
/// allocations) for EVERY synced file across all drives, even though
/// `get_recent_files` only ever looks up at most `limit` (~50) keys.
/// This allocates a `MetadataBundle` only for keys in `wanted`, so the
/// per-row cost (hex-encoding the 32-byte hash, cloning the CID) is paid for
/// the activity window, not the whole corpus. Pure (no `SyncRunner`) so the
/// allocation bound is unit-testable.
fn bundles_for_wanted_keys(
    label_maps: Vec<(String, HashMap<String, SyncedFileInfo>)>,
    wanted: &std::collections::HashSet<String>,
) -> HashMap<String, MetadataBundle> {
    let mut out = HashMap::with_capacity(wanted.len());
    for (label, paths) in label_maps {
        for (rel_path, info) in paths {
            let key = format!("{rel_path}::{label}");
            if !wanted.contains(&key) {
                continue;
            }
            out.insert(
                key,
                MetadataBundle {
                    arion_hash: info.path_hash_hex(),
                    arion_cid: info.arion_cid.to_string(),
                    uploaded_at: info.uploaded_at,
                    updated_at: info.updated_at,
                },
            );
        }
    }
    out
}

/// A recent file ready for UI rendering. Matches the frontend `FormattedUserFile`
/// shape so the hook can pass it through without transformation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub actual_file_name: String,
    pub size: u64,
    pub created_at: i64,
    pub arion_hash: String,
    pub arion_cid: String,
    pub source: String,
    pub miner_ids: Vec<String>,
    pub is_assigned: bool,
    pub last_charged_at: i64,
    pub file_hash: String,
    pub is_folder: bool,
    #[serde(rename = "type")]
    pub file_type: String,
    pub is_erasure_coded: bool,
    pub main_req_hash: String,
    pub label: String,
}

/// Bundled per-file metadata from synced paths, used to enrich recent file entries.
/// Keyed by `"filename::label"` in the lookup map.
struct MetadataBundle {
    arion_hash: String,
    arion_cid: String,
    uploaded_at: i64,
    updated_at: i64,
}

/// Fetch recent files by joining sync activity, sync paths, and file metadata.
///
/// This replaces the 130-line orchestration in `use-recent-files/index.ts`.
/// All data joining, filtering, deduplication, and sorting happens in Rust.
#[tauri::command]
pub async fn get_recent_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    account_id: String,
    limit: Option<usize>,
) -> Result<Vec<RecentFile>> {
    // Account-scoped listing; authorize against the session account.
    let account_id = state.require_session_account(&account_id)?;
    let sync = &state.sync;
    let pool = state.pool()?;

    // 1. Get sync activity items
    let items = sync.get_sync_activity(limit, None);
    if items.is_empty() {
        return Ok(Vec::new());
    }

    // 2. Get sync paths → build label→path lookup
    let sync_paths = crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "get_recent_files").await;
    let label_to_path: HashMap<String, String> = sync_paths
        .iter()
        .filter(|sp| !sp.path.is_empty() && !sp.label.is_empty())
        .map(|sp| (sp.label.clone(), sp.path.clone()))
        .collect();

    // 3. Filter deleted files FIRST so the metadata lookup below is bounded by
    //    the (<= limit) surviving activity rows, not the whole synced corpus.
    let deleted_names: std::collections::HashSet<String> = items
        .iter()
        .filter(|item| item.action == SyncActivityAction::Deleted)
        .map(|item| format!("{}::{}", item.file_name, item.label))
        .collect();

    // Drop rows whose rel-path matches that drive's exclude rules. The
    // activity log is left intact — this is a read-time filter so a
    // glob like `*.bin` does not keep a Drive-dropped file on Overview.
    let exclude_rules = collect_label_exclude_rules(sync).await;

    let non_deleted: Vec<_> = items
        .iter()
        .filter(|item| {
            item.action != SyncActivityAction::Deleted
                && !deleted_names.contains(&format!("{}::{}", item.file_name, item.label))
                && !super::exclude_match::recent_rel_path_is_excluded(exclude_rules.get(item.label.as_ref()), item.file_name.as_ref())
        })
        .collect();

    if non_deleted.is_empty() {
        return Ok(Vec::new());
    }

    // 4. Look up synced metadata for ONLY the surviving keys. Allocation scales
    //    with the activity window, not the total number of synced files.
    let wanted: std::collections::HashSet<String> = non_deleted.iter().map(|item| format!("{}::{}", item.file_name, item.label)).collect();
    let label_maps = collect_label_maps(&state.sync).await;
    let mut meta_map = bundles_for_wanted_keys(label_maps, &wanted);

    // 5. Map to RecentFile with path resolution and timestamp priority
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for item in &non_deleted {
        // Deduplicate by actualFileName + label (reuse key for meta_map lookup)
        let key = format!("{}::{}", item.file_name, item.label);
        if !seen.insert(key.clone()) {
            continue;
        }

        let sync_folder_path = label_to_path.get(item.label.as_ref());
        let source = match sync_folder_path {
            Some(path) if !item.file_name.is_empty() => format!("{path}/{}", item.file_name),
            _ => String::new(),
        };
        let display_name = item.file_name.rsplit('/').next().unwrap_or(&item.file_name).to_string();
        let display_name = if display_name.is_empty() { "Unknown".to_string() } else { display_name };

        let bundle = meta_map.remove(&key);
        let (arion_hash, arion_cid, uploaded_at_sec, updated_at_sec) = match bundle {
            Some(b) => (b.arion_hash, b.arion_cid, b.uploaded_at, b.updated_at),
            None => (String::new(), String::new(), 0, 0),
        };

        let activity_ms = if item.timestamp != 0 { item.timestamp * 1000 } else { now_ms };
        let created_at_ms = if uploaded_at_sec != 0 { uploaded_at_sec * 1000 } else { activity_ms };
        let last_charged_at_ms = if updated_at_sec != 0 {
            updated_at_sec * 1000
        } else if uploaded_at_sec != 0 {
            uploaded_at_sec * 1000
        } else {
            activity_ms
        };

        let file_type = {
            let mut chars = item.action.as_str().chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        };

        result.push(RecentFile {
            name: display_name,
            actual_file_name: item.file_name.to_string(),
            size: item.size_bytes,
            created_at: created_at_ms,
            arion_hash,
            arion_cid,
            source,
            miner_ids: Vec::new(),
            is_assigned: true,
            last_charged_at: last_charged_at_ms,
            file_hash: String::new(),
            is_folder: false,
            file_type,
            is_erasure_coded: false,
            main_req_hash: String::new(),
            label: item.label.to_string(),
        });
    }

    // 6. Sort by timestamp (newest first)
    result.sort_by_key(|b| std::cmp::Reverse(b.last_charged_at));

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The bounded lookup must allocate a `MetadataBundle` only for keys in the
    /// `wanted` set, regardless of how large the synced corpus is. Seeds 1000
    /// synced files but asks for 3 keys (2 present, 1 absent) and asserts the
    /// result holds exactly the 2 present-and-wanted entries — not 1000.
    #[test]
    fn bundles_for_wanted_keys_allocates_only_for_wanted() {
        use std::collections::HashSet;
        use std::sync::Arc;

        let mut corpus: HashMap<String, SyncedFileInfo> = HashMap::new();
        for i in 0..1000 {
            corpus.insert(
                format!("file{i}.txt"),
                SyncedFileInfo {
                    path_hash: [0u8; 32],
                    arion_cid: Arc::from("cid"),
                    uploaded_at: 1,
                    updated_at: 2,
                },
            );
        }
        let label_maps = vec![("drive".to_string(), corpus)];

        let wanted: HashSet<String> = ["file3.txt::drive", "file7.txt::drive", "missing.txt::drive"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();

        let out = bundles_for_wanted_keys(label_maps, &wanted);

        assert_eq!(out.len(), 2, "only present-and-wanted keys produce bundles, not the whole corpus");
        assert!(out.contains_key("file3.txt::drive"));
        assert!(out.contains_key("file7.txt::drive"));
        assert!(!out.contains_key("missing.txt::drive"), "a wanted-but-absent key must not appear");
    }

    /// An empty wanted set yields an empty map — the recent-files path returns
    /// early on no surviving activity, but the helper must be safe regardless.
    #[test]
    fn bundles_for_wanted_keys_empty_wanted_is_empty() {
        use std::collections::HashSet;
        use std::sync::Arc;
        let mut corpus: HashMap<String, SyncedFileInfo> = HashMap::new();
        corpus.insert(
            "a.txt".to_string(),
            SyncedFileInfo {
                path_hash: [1u8; 32],
                arion_cid: Arc::from("x"),
                uploaded_at: 0,
                updated_at: 0,
            },
        );
        let out = bundles_for_wanted_keys(vec![("d".to_string(), corpus)], &HashSet::new());
        assert!(out.is_empty());
    }

    /// The recent feed must drop glob matches through the shared matcher, not
    /// by deleting activity history. `*.bin` hides `foo.bin` / `dir/foo.bin`
    /// and leaves `foo.bin.bak`.
    #[test]
    fn recent_feed_omits_glob_excluded_rel_paths() {
        use super::super::exclude_match::{recent_rel_path_is_excluded, rules_from_patterns};

        let rules = rules_from_patterns(&["*.bin".to_string()]);
        assert!(recent_rel_path_is_excluded(Some(&rules), "foo.bin"));
        assert!(recent_rel_path_is_excluded(Some(&rules), "dir/foo.bin"));
        assert!(!recent_rel_path_is_excluded(Some(&rules), "foo.bin.bak"));
        assert!(!recent_rel_path_is_excluded(None, "foo.bin"));
    }
}
