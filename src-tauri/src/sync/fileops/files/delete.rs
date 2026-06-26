//! Batch file/folder deletion.

use super::pathops::{derive_relative_name, ensure_within};
use crate::error::Result;
use hcfs_client::engine::runner::trigger_sync;
use hcfs_client::engine::types::{SyncActivityAction, SyncActivityItem};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::AppHandle;
use tracing::{info, warn};

/// Request to delete a single file, used by the `delete_files` batch command.
#[derive(Deserialize)]
pub struct FileDeleteRequest {
    pub name: String,
    pub source: Option<String>,
    pub label: Option<String>,
    pub size: u64,
}

/// Per-file error from a batch delete.
#[derive(Serialize)]
pub struct FileDeleteError {
    pub name: String,
    pub error: String,
}

/// Result of a batch file deletion.
#[derive(Serialize)]
pub struct DeleteFilesResult {
    pub deleted: u32,
    pub failed: Vec<FileDeleteError>,
}

/// Delete multiple files in one call, resolving paths internally.
///
/// For each file: resolves sync_path + relative_name via label/source,
/// calls the existing `remove_file` logic, and aggregates results.
/// Triggers sync once at the end. Replaces the per-file loop that was
/// in `use-delete-file/index.tsx`.
#[tauri::command]
pub async fn delete_files(
    state: tauri::State<'_, crate::app_state::AppState>,
    app: AppHandle,
    account_id: String,
    files: Vec<FileDeleteRequest>,
) -> Result<DeleteFilesResult> {
    // Deletes files under the account's drives; authorize against the session.
    let account_id = state.require_session_account(&account_id)?;
    let pool = state.pool()?;
    // Resolve every drive's label→path ONCE (a single query) instead of one
    // (often two, via the default fallback) SELECT per file in the batch.
    let label_to_path: std::collections::HashMap<String, String> =
        crate::sync::folders::get_all_sync_paths_or_warn(pool, &account_id, "delete_files")
            .await
            .into_iter()
            .map(|sp| (sp.label, sp.path))
            .collect();
    let default_path = label_to_path.get("default").cloned();

    let mut deleted = 0u32;
    let mut failed = Vec::new();

    for file in &files {
        // Resolve the drive root. An explicitly-named label MUST exist — never
        // fall back to the default drive (audit H-3: under the old fallback a
        // delete aimed at a removed/renamed drive retargeted the default drive
        // and `remove_dir_all` recursively deleted a same-named entry there).
        // Mirrors `resolve_rename_root`; only a label-less entry uses default.
        let resolved = match file.label.as_deref() {
            Some(l) => label_to_path.get(l).cloned(),
            None => default_path.clone(),
        };
        let Some(sync_path) = resolved else {
            let error = if file.label.is_some() {
                "This file's sync folder is no longer configured on this device"
            } else {
                "No sync folder is configured for this file"
            };
            failed.push(FileDeleteError {
                name: file.name.clone(),
                error: error.into(),
            });
            continue;
        };

        let relative_name = derive_relative_name(&sync_path, file.source.as_deref(), &file.name);

        let parent = Path::new(&sync_path);
        let target = parent.join(&relative_name);
        match ensure_within(parent, &target) {
            Ok(target) => {
                let size_bytes = if target.is_dir() {
                    0
                } else {
                    tokio::fs::metadata(&target).await.map_or(0, |m| m.len())
                };

                let remove_result = if target.is_dir() {
                    tokio::fs::remove_dir_all(&target).await
                } else if target.exists() {
                    tokio::fs::remove_file(&target).await
                } else {
                    Ok(())
                };

                match remove_result {
                    Ok(()) => {
                        if let Some(lbl) = &file.label {
                            state.sync.update_state(lbl, |st| {
                                st.add_activity(SyncActivityItem {
                                    file_name: std::sync::Arc::from(relative_name.as_str()),
                                    action: SyncActivityAction::Deleted,
                                    timestamp: chrono::Utc::now().timestamp(),
                                    size_bytes,
                                    label: std::sync::Arc::from(lbl.as_str()),
                                });
                            });
                        }
                        deleted += 1;
                    }
                    Err(e) => {
                        warn!(file = %file.name, error = %e, "Failed to delete file");
                        failed.push(FileDeleteError {
                            name: file.name.clone(),
                            error: e.to_string(),
                        });
                    }
                }
            }
            Err(e) => {
                failed.push(FileDeleteError {
                    name: file.name.clone(),
                    error: e.to_string(),
                });
            }
        }
    }

    // Trigger sync so server picks up the deletions
    {
        use tauri::Manager;
        let s = app.state::<crate::app_state::AppState>().sync.clone();
        let _ = trigger_sync(&s).await;
    }

    info!(deleted, failed = failed.len(), "Batch delete completed");
    Ok(DeleteFilesResult { deleted, failed })
}
