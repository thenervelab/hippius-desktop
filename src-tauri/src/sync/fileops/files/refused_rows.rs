//! A drive's saved refusals, as one listing reads them.
//!
//! hcfs reports a refusal (`FileFailureKind::Refused`: a path collision, an
//! unreadable file, no room for a download) once per revision, so the live
//! progress row that paints a file "failed" is gone after that cycle while
//! the file still does not sync. The `sync_file_failures` row is what
//! remembers it, so the listing reads the drive's refused paths once and
//! keeps those rows failed.

use std::collections::HashSet;

use tracing::warn;

/// The relative paths a drive has a saved refusal for.
#[derive(Debug, Default)]
pub(super) struct RefusedRows {
    /// Drive-relative paths, in hcfs's form (`/`-separated).
    paths: HashSet<String>,
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
            Ok(paths) => Self { paths },
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_marks_a_sync_status_failed_and_leaves_the_rest() {
        let rows = RefusedRows {
            paths: HashSet::from(["a/b.txt".to_string()]),
        };

        for status in ["synced", "pending", "unknown"] {
            assert_eq!(rows.status_for("a/b.txt", status), "failed", "{status}");
        }
        assert_eq!(rows.status_for("a/b.txt", "hidden"), "hidden");
        assert_eq!(rows.status_for("a/b.txt", "excluded"), "excluded");
        assert_eq!(rows.status_for("b.txt", "synced"), "synced", "exact path, not a basename");
    }
}
