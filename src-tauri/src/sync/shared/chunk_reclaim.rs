//! Reclaim disk from abandoned upload-chunk staging directories.
//!
//! Every upload stages a full encrypted copy of the file under
//! `~/.hippius/drives/<account>/<folder>/temp/upload_<file_id>/` before a byte
//! leaves the machine. hcfs-client removes that directory when the upload
//! finalises, but on **any other exit** — network error, 5xx, a finalize that
//! timed out, or a cancel from pause/stop/logout/the stall watchdog — it keeps
//! the chunks deliberately, as a re-encryption cache for the next attempt.
//!
//! That retention has no ceiling and, in practice, no reaper:
//!
//! - The orphan prune keys on the `file_id` being absent from the local, remote
//!   AND synced trees. A file still on disk awaiting upload is *by definition*
//!   in `local`; a file whose finalize timed out but landed server-side is in
//!   `remote` + `synced`. Both are structurally immune.
//! - The age prune keys on `manifest.encrypted_at`, which is re-stamped on every
//!   re-encryption — a file that fails and re-encrypts each cycle refreshes its
//!   own clock forever.
//! - Both run only *inside* a sync cycle, so a paused drive, a stopped sync, or
//!   a closed app reclaims nothing at all.
//!
//! The failure mode is self-reinforcing: once free space runs low every
//! encryption fails `check_disk_space`, which is a keep-the-chunks error, so the
//! cache can only grow. A user reported 176 GB across 1315 staging directories
//! after two days of syncing, having started with 200 GB free.
//!
//! This module is the desktop-side reclaim, deliberately independent of the
//! pinned hcfs-client so existing users get their space back without a dep bump.
//! It walks every drive's `temp/` on this machine — including drives whose
//! `sync_paths` row is long gone, whose chunks nothing else would ever visit.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tracing::{info, warn};

/// Directory-name prefix hcfs-client gives an upload staging directory
/// (`upload_<file_id_hex>`).
const UPLOAD_DIR_PREFIX: &str = "upload_";

/// Written atomically by hcfs-client *after* every chunk is on disk, so its
/// presence is what distinguishes "encryption finished" from "died partway".
const MANIFEST_NAME: &str = "manifest.json";

/// Age past which a staging directory is treated as abandoned rather than
/// mid-flight.
///
/// Set to hcfs-server's upload-session TTL (`UPLOAD_SESSION_TTL_HOURS` = 24h,
/// `hcfs-server/src/handlers/session.rs`) because that is where the expensive
/// half of the cache stops paying: the session is gone, so a resume must create
/// a new one and re-upload every chunk no matter what is staged locally.
///
/// **Deleting is not free, and it is worth being exact about why.** This is an
/// ENCRYPTION cache, not a session cache. `UploadChunkManifest::validate_cache`
/// checks only the plaintext salted hash and the chunk file sizes — nothing
/// about the server session — so even a stale directory still lets
/// `upload_file_standalone` take its "skipping re-encryption" branch against a
/// brand-new session. What expiry forfeits is exactly that: the file is
/// encrypted and written out in full again.
///
/// The trade is deliberate. A directory that has not completed in 24h is
/// overwhelmingly abandoned rather than in flight, the re-upload was already
/// unavoidable by then, and one re-encryption is a far smaller cost than an
/// unbounded staging area. hcfs-client's own gate is 48h; the extra day buys a
/// re-encryption saving on a file that is almost certainly never coming back.
pub(crate) const RESUMABLE_MAX_AGE_SECS: u64 = 24 * 60 * 60;

/// Aggregate ceiling for staged chunks across ALL drives.
///
/// This is the backstop that makes "the sync engine filled my disk" impossible
/// rather than merely unlikely. Unlike the age rule it *can* discard resumable
/// work, so it is sized to hold a healthy backlog — several large files mid-
/// flight — and only bites when retention has clearly run away.
pub(crate) const CHUNK_CACHE_BUDGET_BYTES: u64 = 10 * 1024 * 1024 * 1024;

/// One `upload_<file_id>` staging directory as found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StagedUpload {
    pub(crate) path: PathBuf,
    /// `encrypted_at` from the manifest, or `None` when there is no readable
    /// manifest — encryption never finished, so there is nothing to resume.
    /// An unparseable manifest reads as `None` on purpose: hcfs-client's own
    /// `UploadChunkManifest::load` would fail on it too and treat the directory
    /// as incomplete, and the two must not disagree about what is live.
    pub(crate) encrypted_at: Option<u64>,
    pub(crate) size_bytes: u64,
}

/// Why a staging directory was selected for deletion. Carried through to the
/// log line so an operator can tell a routine expiry from budget pressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReclaimReason {
    /// No readable manifest: encryption died partway, nothing can resume.
    Incomplete,
    /// Past the server's session TTL, so its re-upload was already unavoidable
    /// and only the re-encryption saving is forfeited. See
    /// [`RESUMABLE_MAX_AGE_SECS`].
    Expired,
    /// Still resumable, but the cache is over budget and this was the oldest.
    OverBudget,
}

impl ReclaimReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::Incomplete => "incomplete",
            Self::Expired => "expired",
            Self::OverBudget => "over-budget",
        }
    }
}

/// What a reclaim pass freed. Returned rather than only logged so the caller
/// can report it and so the once-per-process wiring has something to cache.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReclaimSummary {
    pub removed_dirs: usize,
    pub reclaimed_bytes: u64,
}

/// Decide which staging directories to delete. Pure: no clock, no filesystem.
///
/// Directories are considered oldest-first, so budget eviction sheds the
/// least-recently staged work — the least likely to still be mid-resume.
pub(crate) fn plan_reclaim(mut staged: Vec<StagedUpload>, now_secs: u64, max_age_secs: u64, budget_bytes: u64) -> Vec<(PathBuf, ReclaimReason)> {
    // `None` sorts before `Some`, so manifest-less directories lead. The path
    // tiebreak keeps the plan deterministic for a given set regardless of the
    // order `read_dir` happened to hand entries back in.
    staged.sort_by(|a, b| a.encrypted_at.cmp(&b.encrypted_at).then_with(|| a.path.cmp(&b.path)));

    let mut plan = Vec::new();
    let mut survivors: Vec<&StagedUpload> = Vec::new();
    let mut retained_bytes: u64 = 0;

    for entry in &staged {
        match entry.encrypted_at {
            None => plan.push((entry.path.clone(), ReclaimReason::Incomplete)),
            // `saturating_sub` so a manifest stamped in the future (clock skew,
            // a restored backup) reads as age 0 and is kept, never as wildly
            // expired. Same choice hcfs-client's own age gate makes.
            Some(at) if now_secs.saturating_sub(at) > max_age_secs => {
                plan.push((entry.path.clone(), ReclaimReason::Expired));
            }
            Some(_) => {
                retained_bytes = retained_bytes.saturating_add(entry.size_bytes);
                survivors.push(entry);
            }
        }
    }

    let mut idx = 0;
    while retained_bytes > budget_bytes && idx < survivors.len() {
        let entry = survivors[idx];
        retained_bytes = retained_bytes.saturating_sub(entry.size_bytes);
        plan.push((entry.path.clone(), ReclaimReason::OverBudget));
        idx += 1;
    }

    plan
}

/// Read one `upload_<id>` directory into a [`StagedUpload`].
///
/// The size is a shallow sum: hcfs-client writes the chunk files and the
/// manifest flat into this directory, with no nesting, so one `read_dir` is the
/// whole picture. Unreadable entries contribute 0 rather than aborting the scan
/// — under-counting one directory only makes the budget rule more conservative,
/// while bailing out would strand every other directory behind it.
fn read_staged(path: PathBuf) -> StagedUpload {
    let mut size_bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(&path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata()
                && meta.is_file()
            {
                size_bytes = size_bytes.saturating_add(meta.len());
            }
        }
    }

    let encrypted_at = std::fs::read(path.join(MANIFEST_NAME))
        .ok()
        .and_then(|raw| serde_json::from_slice::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("encrypted_at").and_then(serde_json::Value::as_u64));

    StagedUpload {
        path,
        encrypted_at,
        size_bytes,
    }
}

/// Collect every `upload_*` staging directory directly under one drive's
/// `temp/`. Non-`upload_` entries (download state files, decrypt temps) belong
/// to hcfs-client's other pruners and are left strictly alone.
fn scan_temp_dir(temp_dir: &Path) -> Vec<StagedUpload> {
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| name.starts_with(UPLOAD_DIR_PREFIX)) && entry.path().is_dir())
        .map(|entry| read_staged(entry.path()))
        .collect()
}

/// Every `<account>/<folder>/temp` under `~/.hippius/drives`.
///
/// Enumerated from the filesystem rather than from `sync_paths` on purpose: a
/// drive removed before this fix shipped left its staging directories behind
/// with no row pointing at them, and those are exactly the bytes no other code
/// path can still reach.
fn all_temp_dirs(drives_root: &Path) -> Vec<PathBuf> {
    let Ok(accounts) = std::fs::read_dir(drives_root) else {
        return Vec::new();
    };

    let mut dirs = Vec::new();
    for account in accounts.flatten() {
        let account_path = account.path();

        // Pre-migration builds staged chunks one level up, at `<account>/temp`.
        // `run_migration`'s Legacy-B branch COPIES that tree into the per-folder
        // config dir and never deletes the source, so those bytes sit there
        // duplicated with no row, no pruner and no other code path pointing at
        // them — the most stranded category there is.
        let account_temp = account_path.join("temp");
        if account_temp.is_dir() {
            dirs.push(account_temp);
        }

        let Ok(folders) = std::fs::read_dir(&account_path) else {
            continue;
        };
        for folder in folders.flatten() {
            let temp = folder.path().join("temp");
            if temp.is_dir() {
                dirs.push(temp);
            }
        }
    }
    dirs
}

/// Scan every drive, plan against one shared budget, delete. Blocking.
fn reclaim_under(drives_root: &Path, now_secs: u64) -> ReclaimSummary {
    let staged: Vec<StagedUpload> = all_temp_dirs(drives_root).iter().flat_map(|temp| scan_temp_dir(temp)).collect();

    if staged.is_empty() {
        return ReclaimSummary::default();
    }

    // Sizes are indexed before the plan consumes `staged` so the summary can
    // report bytes actually freed without re-stat'ing directories we deleted.
    let sizes: std::collections::HashMap<PathBuf, u64> = staged.iter().map(|s| (s.path.clone(), s.size_bytes)).collect();

    let plan = plan_reclaim(staged, now_secs, RESUMABLE_MAX_AGE_SECS, CHUNK_CACHE_BUDGET_BYTES);

    let mut summary = ReclaimSummary::default();
    for (path, reason) in plan {
        match std::fs::remove_dir_all(&path) {
            Ok(()) => {
                summary.removed_dirs += 1;
                summary.reclaimed_bytes = summary.reclaimed_bytes.saturating_add(sizes.get(&path).copied().unwrap_or(0));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            // Logged, never fatal: one undeletable directory (a permission
            // problem, a Windows lock) must not stop the pass from freeing the
            // rest, and the next launch retries it.
            Err(e) => warn!(
                path = %path.display(),
                reason = reason.as_str(),
                error = %e,
                "Failed to reclaim staged upload chunks",
            ),
        }
    }

    summary
}

/// Reclaim abandoned staging directories across every drive on this machine.
///
/// Runs exactly once per process, before the first drive initialises — see the
/// `OnceCell` in `AppState`. That ordering is what makes the budget rule safe
/// without tracking liveness: at first init nothing is uploading, so no
/// directory this pass can delete is one an in-flight upload is reading.
pub(crate) async fn reclaim_startup() -> ReclaimSummary {
    let Some(home) = dirs::home_dir() else {
        return ReclaimSummary::default();
    };
    let drives_root = home.join(".hippius").join("drives");

    let now_secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let summary = tokio::task::spawn_blocking(move || reclaim_under(&drives_root, now_secs))
        .await
        .unwrap_or_else(|e| {
            warn!(error = %e, "Upload-chunk reclaim task failed");
            ReclaimSummary::default()
        });

    if summary.removed_dirs > 0 {
        info!(
            removed_dirs = summary.removed_dirs,
            reclaimed_bytes = summary.reclaimed_bytes,
            "Reclaimed abandoned upload chunk directories",
        );
    }

    summary
}

/// Drop a removed drive's entire staging area. Blocking core of
/// [`clear_staged_upload_chunks`]; call that from async code.
fn remove_staging_tree(temp_dir: &Path) {
    match std::fs::remove_dir_all(temp_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => warn!(
            path = %temp_dir.display(),
            error = %e,
            "Failed to clear staged upload chunks on remove_drive",
        ),
    }
}

/// Drop a removed drive's entire staging area.
///
/// Called beside `clear_persisted_sync_state` on `remove_drive`: the drive is
/// gone, so every staged chunk under it is unreachable by definition and the
/// age and budget rules would only delay freeing it. Best-effort, like the
/// baseline wipe next to it — the startup pass is the backstop.
///
/// Runs on the blocking pool. On the failure shape this whole module exists for
/// the tree holds tens of GB across thousands of 8 MiB files, and unlinking that
/// many inline would stall a Tokio worker — and the IPC response the user is
/// waiting on — for seconds. `clear_persisted_sync_state` next to it is two
/// `unlink`s, so it is not a precedent for staying inline.
pub(crate) async fn clear_staged_upload_chunks(temp_dir: PathBuf) {
    if let Err(e) = tokio::task::spawn_blocking(move || remove_staging_tree(&temp_dir)).await {
        warn!(error = %e, "Staged-chunk clear task failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 60 * 60;
    const NOW: u64 = 1_000 * HOUR;

    fn staged(name: &str, encrypted_at: Option<u64>, size_bytes: u64) -> StagedUpload {
        StagedUpload {
            path: PathBuf::from(format!("/tmp/temp/upload_{name}")),
            encrypted_at,
            size_bytes,
        }
    }

    fn reasons(plan: &[(PathBuf, ReclaimReason)], name: &str) -> Option<ReclaimReason> {
        plan.iter().find(|(p, _)| p.ends_with(format!("upload_{name}"))).map(|(_, r)| *r)
    }

    #[test]
    fn a_manifest_less_directory_is_always_reclaimed() {
        // Encryption died partway: there is no ciphertext to resume from, so
        // age and budget are both irrelevant.
        let plan = plan_reclaim(vec![staged("a", None, 1)], NOW, RESUMABLE_MAX_AGE_SECS, u64::MAX);

        assert_eq!(reasons(&plan, "a"), Some(ReclaimReason::Incomplete));
    }

    #[test]
    fn a_directory_past_the_session_ttl_is_reclaimed_and_a_fresh_one_is_kept() {
        let plan = plan_reclaim(
            vec![staged("old", Some(NOW - 25 * HOUR), 1), staged("fresh", Some(NOW - 23 * HOUR), 1)],
            NOW,
            RESUMABLE_MAX_AGE_SECS,
            u64::MAX,
        );

        assert_eq!(reasons(&plan, "old"), Some(ReclaimReason::Expired));
        assert_eq!(reasons(&plan, "fresh"), None);
    }

    #[test]
    fn a_future_stamped_manifest_is_kept_rather_than_read_as_expired() {
        // Clock skew or a restored backup must not look like extreme age.
        let plan = plan_reclaim(vec![staged("skewed", Some(NOW + 100 * HOUR), 1)], NOW, RESUMABLE_MAX_AGE_SECS, u64::MAX);

        assert!(plan.is_empty(), "future stamp must not be treated as expired");
    }

    #[test]
    fn budget_eviction_sheds_oldest_first_and_stops_once_under() {
        // 6 units staged against a 3-unit budget: dropping the two oldest gets
        // it to 3, so the newest must survive untouched.
        let plan = plan_reclaim(
            vec![
                staged("newest", Some(NOW - HOUR), 3),
                staged("oldest", Some(NOW - 3 * HOUR), 2),
                staged("middle", Some(NOW - 2 * HOUR), 1),
            ],
            NOW,
            RESUMABLE_MAX_AGE_SECS,
            3,
        );

        assert_eq!(reasons(&plan, "oldest"), Some(ReclaimReason::OverBudget));
        assert_eq!(reasons(&plan, "middle"), Some(ReclaimReason::OverBudget));
        assert_eq!(reasons(&plan, "newest"), None, "eviction must stop at budget");
    }

    #[test]
    fn a_cache_within_budget_is_left_entirely_alone() {
        // The steady state for every healthy user: nothing expired, nothing
        // over budget, so a resumable upload keeps its chunks.
        let plan = plan_reclaim(
            vec![staged("a", Some(NOW - HOUR), 5), staged("b", Some(NOW - 2 * HOUR), 5)],
            NOW,
            RESUMABLE_MAX_AGE_SECS,
            10,
        );

        assert!(plan.is_empty(), "in-budget resumable chunks must be preserved");
    }

    #[test]
    fn expired_bytes_are_not_counted_against_the_budget() {
        // The expired entry is deleted for free, so the two survivors fit and
        // must not be evicted on its account.
        let plan = plan_reclaim(
            vec![
                staged("expired", Some(NOW - 30 * HOUR), 100),
                staged("a", Some(NOW - HOUR), 5),
                staged("b", Some(NOW - 2 * HOUR), 5),
            ],
            NOW,
            RESUMABLE_MAX_AGE_SECS,
            10,
        );

        assert_eq!(reasons(&plan, "expired"), Some(ReclaimReason::Expired));
        assert_eq!(reasons(&plan, "a"), None);
        assert_eq!(reasons(&plan, "b"), None);
    }

    // ── filesystem layer ──────────────────────────────────────────────────

    /// Build `<root>/drives/<account>/<folder>/temp/upload_<name>` holding
    /// `size` bytes of chunk, plus a manifest when `encrypted_at` is given.
    fn write_staged_dir(root: &Path, folder: &str, name: &str, at: Option<u64>, size: usize) {
        let dir = root.join("drives").join("acct").join(folder).join("temp").join(format!("upload_{name}"));
        std::fs::create_dir_all(&dir).expect("create staging dir");
        std::fs::write(dir.join("chunk_0"), vec![0u8; size]).expect("write chunk");
        if let Some(at) = at {
            let manifest = serde_json::json!({ "encrypted_at": at, "chunk_count": 1 });
            std::fs::write(dir.join(MANIFEST_NAME), manifest.to_string()).expect("write manifest");
        }
    }

    #[test]
    fn reclaim_frees_stranded_directories_across_drives_and_keeps_live_ones() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        write_staged_dir(root, "folder-a", "expired", Some(NOW - 30 * HOUR), 64);
        write_staged_dir(root, "folder-a", "incomplete", None, 64);
        write_staged_dir(root, "folder-b", "live", Some(NOW - HOUR), 64);

        let summary = reclaim_under(&root.join("drives"), NOW);

        assert_eq!(summary.removed_dirs, 2);
        assert!(
            summary.reclaimed_bytes >= 128,
            "expected both 64-byte chunks counted, got {}",
            summary.reclaimed_bytes
        );

        let temp_a = root.join("drives/acct/folder-a/temp");
        assert!(!temp_a.join("upload_expired").exists());
        assert!(!temp_a.join("upload_incomplete").exists());
        assert!(
            root.join("drives/acct/folder-b/temp/upload_live").exists(),
            "a resumable in-budget directory must survive",
        );
    }

    #[test]
    fn reclaim_ignores_non_upload_entries_owned_by_the_other_pruners() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let temp = root.join("drives/acct/folder-a/temp");
        std::fs::create_dir_all(&temp).expect("create temp");

        // hcfs-client's download-resume state and decrypt temps live here too.
        std::fs::write(temp.join("download_abc.state"), b"{}").expect("write state");
        std::fs::create_dir_all(temp.join("not_an_upload")).expect("create dir");

        let summary = reclaim_under(&root.join("drives"), NOW);

        assert_eq!(summary.removed_dirs, 0);
        assert!(temp.join("download_abc.state").exists());
        assert!(temp.join("not_an_upload").exists());
    }

    #[test]
    fn an_unparseable_manifest_reads_as_incomplete() {
        // hcfs-client's own loader would reject it and prune, so we must agree.
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("upload_broken");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::write(dir.join(MANIFEST_NAME), b"not json").expect("write manifest");

        assert_eq!(read_staged(dir).encrypted_at, None);
    }

    #[test]
    fn clearing_a_removed_drive_wipes_its_whole_staging_area() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        write_staged_dir(root, "folder-a", "live", Some(NOW), 64);
        let temp = root.join("drives/acct/folder-a/temp");

        remove_staging_tree(&temp);

        assert!(!temp.exists(), "remove_drive must not leave chunks behind");
        // Idempotent: the startup pass may already have taken it.
        remove_staging_tree(&temp);
    }

    /// Pre-migration builds staged chunks at `<account>/temp`, and Legacy-B
    /// migration COPIES that tree down into the per-folder config dir without
    /// deleting the source. Those duplicated bytes have no `sync_paths` row and
    /// no engine-side pruner pointing at them, so if this scan misses them
    /// nothing on the machine will ever free them.
    #[test]
    fn reclaim_reaches_the_legacy_account_level_staging_area() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();

        let legacy = root.join("drives/acct/temp/upload_legacy");
        std::fs::create_dir_all(&legacy).expect("create legacy staging dir");
        std::fs::write(legacy.join("chunk_0"), vec![0u8; 64]).expect("write chunk");

        let summary = reclaim_under(&root.join("drives"), NOW);

        assert_eq!(summary.removed_dirs, 1, "the account-level temp/ must be scanned too");
        assert!(!legacy.exists());
    }
}
