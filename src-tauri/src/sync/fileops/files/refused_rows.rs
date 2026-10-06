//! A drive's saved refusals, as one listing reads them.
//!
//! hcfs reports a refusal (`FileFailureKind::Refused`: a path collision, an
//! unreadable file, no room for a download) once per revision, so the live
//! progress row that paints a file "failed" is gone after that cycle while
//! the file still does not sync. The `sync_file_failures` row is what
//! remembers it, so the listing reads the drive's refused paths once and
//! keeps those rows failed.
//!
//! A refusal whose file is gone from both disk and server can never clear
//! by syncing, so the listing that notices it drops the row (see
//! [`RefusedRows::forget_vanished`]).

use std::collections::{HashMap, HashSet};

use hcfs_client::engine::types::SyncedFileInfo;
use hcfs_client::sync::SyncState;
use tracing::warn;

/// The relative paths a drive has a saved refusal for.
#[derive(Debug, Default)]
pub(super) struct RefusedRows {
    /// Drive-relative paths, in hcfs's form (`/`-separated).
    paths: HashSet<String>,
    /// Where the rows live, for dropping vanished ones; `None` when they
    /// were not read from a database.
    store: Option<RowStore>,
}

/// The drive's rows in `sync_file_failures`.
#[derive(Debug)]
struct RowStore {
    /// The app database.
    pool: sqlx::SqlitePool,
    /// The account key the rows are scoped to.
    owner: String,
    /// The drive.
    label: String,
}

impl RefusedRows {
    /// Reads the drive's refused paths. Empty when there is no drive, no
    /// signed-in account or no database: the listing then shows what the
    /// sync engine reports, as before. A failed read is logged and also
    /// reads as empty; a refusal is a badge, never a reason to fail the
    /// whole listing.
    pub(super) async fn load(state: &crate::app_state::AppState, label: Option<&str>) -> Self {
        let (Some(label), Ok(account_id), Ok(pool)) = (label, state.current_account_id(), state.pool()) else {
            return Self::default();
        };
        let owner = crate::auth::account_key::account_key(&account_id);
        match crate::sync::failure_repo::list_refused_paths(pool, &owner, label).await {
            Ok(paths) => Self {
                paths,
                store: Some(RowStore {
                    pool: pool.clone(),
                    owner,
                    label: label.to_string(),
                }),
            },
            Err(e) => {
                warn!(label = %label, error = %e, "could not read saved refusals; listing shows live status only");
                Self::default()
            }
        }
    }

    /// The status a file row shows: `failed` when the drive has a saved
    /// refusal for it, `status` otherwise. Hidden and excluded rows keep
    /// theirs: they say why hcfs does not sync the file at all.
    pub(super) fn status_for(&self, relative_path: &str, status: &'static str) -> &'static str {
        let is_sync_status = matches!(status, "synced" | "pending" | "unknown");
        if is_sync_status && self.paths.contains(relative_path) {
            "failed"
        } else {
            status
        }
    }

    /// This level's refused paths whose file is not on disk. `prefix` is
    /// the level's drive-relative prefix (`""` or `"sub/"`); `on_disk` the
    /// names the level's directory holds.
    pub(super) fn missing_at_level(&self, prefix: &str, on_disk: &HashSet<String>) -> Vec<String> {
        self.paths
            .iter()
            .filter(|path| {
                path.strip_prefix(prefix)
                    .is_some_and(|name| !name.contains('/') && !on_disk.contains(name))
            })
            .cloned()
            .collect()
    }

    /// Drops the saved refusals among `missing` (not on disk) whose file the
    /// server no longer has either: nothing will ever sync such a file, so
    /// its row would stay failed forever.
    ///
    /// The server side is the synced map plus the remote tree of hcfs's
    /// state, the files a file id hashes to exactly as hcfs's scan hashes a
    /// path. Without the state the server side is unknown and nothing is
    /// dropped: a refused download is on the server only, and dropping it
    /// would lose its reason. A failed delete is logged; the next listing
    /// tries again.
    pub(super) async fn forget_vanished(&self, missing: Vec<String>, synced: Option<&HashMap<String, SyncedFileInfo>>, state: Option<&SyncState>) {
        let (Some(store), Some(state)) = (&self.store, state) else {
            return;
        };
        let on_server = |path: &str| {
            let id: [u8; 32] = blake3::hash(path.as_bytes()).into();
            synced.is_some_and(|synced| synced.contains_key(path)) || state.remote.files.contains_key(&id)
        };
        for path in missing.iter().filter(|path| !on_server(path)) {
            if let Err(e) = crate::sync::failure_repo::clear_failure(&store.pool, &store.owner, &store.label, path).await {
                warn!(label = %store.label, error = %e, "could not drop a refusal whose file is gone");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn rows_in_db(paths: &[&str]) -> RefusedRows {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        let refused = crate::sync::projection::events::FileFailureKindPayload::Refused { reason: "r".to_string() };
        for path in paths {
            crate::sync::failure_repo::upsert_failure(&pool, "o", "d", path, path, &refused, 1)
                .await
                .unwrap();
        }
        RefusedRows {
            paths: paths.iter().map(ToString::to_string).collect(),
            store: Some(RowStore {
                pool,
                owner: "o".to_string(),
                label: "d".to_string(),
            }),
        }
    }

    async fn saved(rows: &RefusedRows) -> HashSet<String> {
        let store = rows.store.as_ref().unwrap();
        crate::sync::failure_repo::list_refused_paths(&store.pool, &store.owner, &store.label)
            .await
            .unwrap()
    }

    fn remote_has(state: &mut SyncState, rel: &str) {
        let id: [u8; 32] = blake3::hash(rel.as_bytes()).into();
        state.remote.files.insert(
            id,
            hcfs_client::drive::FileMetadata {
                path_hash: id,
                salted_hash: [0; 32],
                size_bytes: 0,
                revision_seq: 0,
                revision_id: [0; 32],
                encryption_nonce: [0; 24],
            },
        );
    }

    #[test]
    fn only_this_levels_refusals_missing_from_disk_are_candidates() {
        let rows = RefusedRows {
            paths: HashSet::from(["a.txt", "here.txt", "sub/b.txt", "sub/deeper/c.txt"].map(String::from)),
            store: None,
        };
        let on_disk = HashSet::from(["here.txt".to_string()]);

        let mut root = rows.missing_at_level("", &on_disk);
        root.sort();
        assert_eq!(root, vec!["a.txt"]);
        assert_eq!(rows.missing_at_level("sub/", &HashSet::new()), vec!["sub/b.txt"]);
    }

    /// A refused row whose file is on neither side can never clear on its
    /// own (nothing will sync it), so the listing drops it. A refused
    /// download is on the server only, and must stay.
    #[tokio::test]
    async fn a_refusal_gone_from_disk_and_server_is_forgotten() {
        let rows = rows_in_db(&["gone.txt", "download.mov", "synced.txt"]).await;
        let mut state = SyncState::default();
        remote_has(&mut state, "download.mov");
        let synced = HashMap::from([(
            "synced.txt".to_string(),
            SyncedFileInfo {
                path_hash: [1; 32],
                arion_cid: std::sync::Arc::from(""),
                uploaded_at: 0,
                updated_at: 0,
            },
        )]);

        let candidates = vec!["gone.txt".to_string(), "download.mov".to_string(), "synced.txt".to_string()];
        rows.forget_vanished(candidates, Some(&synced), Some(&state)).await;

        assert_eq!(saved(&rows).await, HashSet::from(["download.mov", "synced.txt"].map(String::from)));
    }

    /// Without the drive's state the server side is unknown, so nothing is
    /// dropped: a refused download would otherwise lose its reason.
    #[tokio::test]
    async fn without_the_state_nothing_is_forgotten() {
        let rows = rows_in_db(&["gone.txt"]).await;

        rows.forget_vanished(vec!["gone.txt".to_string()], None, None).await;

        assert_eq!(saved(&rows).await, HashSet::from(["gone.txt".to_string()]));
    }

    #[test]
    fn a_refusal_marks_a_sync_status_failed_and_leaves_the_rest() {
        let rows = RefusedRows {
            paths: HashSet::from(["a/b.txt".to_string()]),
            store: None,
        };

        for status in ["synced", "pending", "unknown"] {
            assert_eq!(rows.status_for("a/b.txt", status), "failed", "{status}");
        }
        assert_eq!(rows.status_for("a/b.txt", "hidden"), "hidden");
        assert_eq!(rows.status_for("a/b.txt", "excluded"), "excluded");
        assert_eq!(rows.status_for("b.txt", "synced"), "synced", "exact path, not a basename");
    }
}
