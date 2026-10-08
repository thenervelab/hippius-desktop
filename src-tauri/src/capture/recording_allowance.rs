//! The free plan's recording allowance: 25 recordings in the captures drive.
//!
//! Screenshots are never counted and sharing is never limited; paid plans
//! have no count at all. The limit is enforced when a recording STARTS: a
//! known limited plan that already has [`FREE_RECORDING_LIMIT`] recordings
//! is refused before anything records ([`require_can_start`], the one gate
//! every start path calls). Nothing is recorded and then held back.
//!
//! # What is counted
//!
//! The recordings in the account's own captures drive ("Hippius Captures",
//! `naming::CAPTURES_DIR_NAME`, or the label `capture::destination` keeps for
//! it), read from the HCFS SERVER's listing of that drive, the same listing
//! the remote-folder browser reads (`list_remote_folder_files_inner`). So a
//! recording uploaded from the web console, another computer or an older
//! build counts, and one deleted anywhere stops counting. A recording is a
//! video named the way the app names one ([`is_recording_name`]); every
//! other file in the drive, screenshots included, is ignored.
//!
//! The count is cached per account for [`COUNT_TTL`] so pressing Record does
//! not wait on a full listing each time. A recording this app has just
//! delivered counts at once ([`note_delivered`]) even before its upload shows
//! in the listing, and a completed sync or a delete in the drive drops the
//! cached listing ([`invalidate_label`]), so the next start reads it again.
//!
//! # Failing open
//!
//! Like the length cap (`capture::allowance`), the limit fails open: an
//! unknown plan, or a count that cannot be read (offline, listing timed out),
//! never blocks a recording. Only a KNOWN limited plan with a KNOWN count at
//! the limit does.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hcfs_client::drive::remote::RemoteFileInfo;

use super::allowance::RecordingTier;
use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};

/// Recordings a limited plan can have in its captures drive.
pub const FREE_RECORDING_LIMIT: usize = 25;

/// The plans whose recordings are counted. Free only. To limit another plan
/// too, give it its own tier in `allowance::resolve_recording_tier` and add
/// it here; nothing else reads who is limited.
pub const LIMITED_TIERS: &[RecordingTier] = &[RecordingTier::Free];

/// The refusal's title and body, shown by the app's limit dialog.
pub const LIMIT_TITLE: &str = "You've used your 25 free recordings";
pub const LIMIT_BODY: &str = "Upgrade your plan to record more, or delete an older recording.";

/// How long a listed count answers before the server is asked again.
pub const COUNT_TTL: Duration = Duration::from_secs(30);

/// How long a start waits for the listing before it fails open.
pub const COUNT_WITHIN: Duration = Duration::from_secs(5);

/// How long a recording this app delivered counts on its own, while its
/// upload may not be in the server's listing yet.
pub const PENDING_FOR: Duration = Duration::from_mins(10);

/// Video extensions a recording can have.
const RECORDING_EXTENSIONS: [&str; 3] = ["mp4", "webm", "mov"];

/// Whether `tier` counts recordings.
#[must_use]
pub fn is_limited(tier: RecordingTier) -> bool {
    LIMITED_TIERS.contains(&tier)
}

/// Whether `name` (a file's basename) is a recording the app made:
/// `Recording YYYY-MM-DD at HH.MM.SS.mp4` (or `.webm` / `.mov`), with an
/// optional ` (N)` before the extension for a second file of the same name.
/// Screenshots and any other video are not.
#[must_use]
pub fn is_recording_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if !RECORDING_EXTENSIONS.iter().any(|v| ext.eq_ignore_ascii_case(v)) {
        return false;
    }
    let stem = strip_copy_suffix(stem);
    let Some(rest) = stem.strip_prefix("Recording ") else {
        return false;
    };
    let Some((date, time)) = rest.split_once(" at ") else {
        return false;
    };
    shaped_like(date, "dddd-dd-dd") && shaped_like(time, "dd.dd.dd")
}

/// `stem` without a trailing ` (N)`, N one or more digits.
fn strip_copy_suffix(stem: &str) -> &str {
    let Some(open) = stem.strip_suffix(')').and_then(|s| s.rfind(" (").map(|i| (s, i))) else {
        return stem;
    };
    let (inner, at) = open;
    let digits = &inner[at + 2..];
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        &stem[..at]
    } else {
        stem
    }
}

/// `value` matches `pattern`, where `d` is any ASCII digit and every other
/// character must be itself.
fn shaped_like(value: &str, pattern: &str) -> bool {
    value.len() == pattern.len()
        && value.bytes().zip(pattern.bytes()).all(|(v, p)| match p {
            b'd' => v.is_ascii_digit(),
            other => v == other,
        })
}

/// The recordings in a drive's server listing, by their path in the drive,
/// so the same name in two folders is two recordings.
#[must_use]
pub fn recording_paths(files: &[RemoteFileInfo]) -> HashSet<String> {
    files.iter().filter(|f| is_recording_name(&f.name)).map(|f| f.path.clone()).collect()
}

/// What starting a recording comes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartVerdict {
    Allowed,
    /// A known limited plan with a known count at or past the limit.
    LimitReached,
}

/// Refuse only a KNOWN limited plan with a KNOWN count at the limit. An
/// unknown plan or an unreadable count fails open.
#[must_use]
pub fn decide_start(tier: Option<RecordingTier>, counted: Option<usize>) -> StartVerdict {
    match (tier, counted) {
        (Some(tier), Some(n)) if is_limited(tier) && n >= FREE_RECORDING_LIMIT => StartVerdict::LimitReached,
        _ => StartVerdict::Allowed,
    }
}

// ── The count cache ─────────────────────────────────────────────────────────

/// One account's count: the last listing, and recordings delivered since
/// that may not be in it yet.
#[derive(Debug, Default)]
struct Counted {
    /// The captures drive's label and the recordings its listing held, and when.
    listed: Option<(String, HashSet<String>, Instant)>,
    /// Paths of recordings this app delivered, and when.
    pending: Vec<(String, Instant)>,
}

/// Per-account counts, keyed by `account_key`.
#[derive(Debug, Default)]
pub struct CountCache {
    accounts: Mutex<HashMap<String, Counted>>,
}

impl CountCache {
    fn with<R>(&self, f: impl FnOnce(&mut HashMap<String, Counted>) -> R) -> R {
        f(&mut self.accounts.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// The count for `account` while its listing is fresh, else `None`.
    pub fn fresh(&self, account: &str, now: Instant) -> Option<usize> {
        self.with(|all| {
            let counted = all.get_mut(account)?;
            counted.pending.retain(|(_, at)| now.saturating_duration_since(*at) < PENDING_FOR);
            let (_, listed, at) = counted.listed.as_ref()?;
            (now.saturating_duration_since(*at) < COUNT_TTL).then(|| total(listed, &counted.pending))
        })
    }

    /// Keep a listing of `label`'s recordings for `account`; returns the count.
    pub fn store(&self, account: &str, label: &str, listed: HashSet<String>, now: Instant) -> usize {
        self.with(|all| {
            let counted = all.entry(account.to_string()).or_default();
            // A delivered recording the listing now holds needs no pending row.
            counted
                .pending
                .retain(|(path, at)| !listed.contains(path) && now.saturating_duration_since(*at) < PENDING_FOR);
            let n = total(&listed, &counted.pending);
            counted.listed = Some((label.to_string(), listed, now));
            n
        })
    }

    /// A recording at `path` was just delivered to the captures drive.
    pub fn note_delivered(&self, account: &str, path: &str, now: Instant) {
        self.with(|all| {
            let counted = all.entry(account.to_string()).or_default();
            if !counted.pending.iter().any(|(p, _)| p == path) {
                counted.pending.push((path.to_string(), now));
            }
        });
    }

    /// Drop every listing of `label`: it changed (a sync cycle, a delete).
    pub fn invalidate_label(&self, label: &str) {
        self.with(|all| {
            for counted in all.values_mut() {
                if counted.listed.as_ref().is_some_and(|(l, _, _)| l == label) {
                    counted.listed = None;
                }
            }
        });
    }

    /// Forget everything (sign-out).
    pub fn clear(&self) {
        self.with(HashMap::clear);
    }
}

/// The listed recordings plus the delivered ones the listing does not hold.
fn total(listed: &HashSet<String>, pending: &[(String, Instant)]) -> usize {
    listed.len() + pending.iter().filter(|(p, _)| !listed.contains(p)).count()
}

fn account_key(account_id: &str) -> String {
    crate::auth::account_key::account_key(account_id)
}

/// The account's own captures drive: the one `destination` keeps when it is
/// the account's own, else the default name, which is the drive's label on
/// another computer or in the console.
async fn captures_label(state: &AppState, account_id: &str) -> Result<String> {
    let stored = super::destination::load(state.pool()?, account_id).await?;
    Ok(stored
        .filter(|d| d.owner_ss58.is_none())
        .map_or_else(|| super::naming::CAPTURES_DIR_NAME.to_string(), |d| d.label))
}

/// The recordings in the account's captures drive: the cached count while
/// fresh, else a new server listing. `None` when it cannot be read, which
/// the gate reads as "allowed".
pub async fn recording_count(state: &AppState, account_id: &str) -> Option<usize> {
    let key = account_key(account_id);
    if let Some(n) = state.capture.recording_counts.fresh(&key, Instant::now()) {
        return Some(n);
    }
    let label = match captures_label(state, account_id).await {
        Ok(label) => label,
        Err(e) => {
            tracing::warn!(error = %e, "recording count: captures drive unknown; not limiting");
            return None;
        }
    };
    let listing = tokio::time::timeout(
        COUNT_WITHIN,
        crate::sync::remote::list_remote_folder_files_inner(state, account_id, &label),
    )
    .await;
    match listing {
        Ok(Ok(files)) => Some(
            state
                .capture
                .recording_counts
                .store(&key, &label, recording_paths(&files), Instant::now()),
        ),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "recording count: captures drive not listed; not limiting");
            None
        }
        Err(_) => {
            tracing::warn!("recording count: the captures drive listing took too long; not limiting");
            None
        }
    }
}

/// A recording was delivered to `destination`: it counts from now on, even
/// before the server lists it.
pub async fn note_delivered(state: &AppState, account_id: &str, destination: &super::destination::CaptureDestination, file_name: &str) {
    if !is_recording_name(file_name) || destination.owner_ss58.is_some() {
        return;
    }
    if captures_label(state, account_id).await.is_ok_and(|label| label == destination.label) {
        state
            .capture
            .recording_counts
            .note_delivered(&account_key(account_id), &destination.rel_path(file_name), Instant::now());
    }
}

/// The drive `label` changed (a sync cycle completed, files were deleted):
/// its count is read again on the next start.
pub fn invalidate_label(state: &AppState, label: &str) {
    state.capture.recording_counts.invalidate_label(label);
}

/// Forget every count (the signed-in account changed).
pub fn clear(state: &AppState) {
    state.capture.recording_counts.clear();
}

/// THE gate for starting a recording. Every start path (the bar's Record, the
/// record shortcut, the tray's and menus' Record, Restart) calls this before
/// anything records, so a refusal costs the user nothing.
///
/// The plan is read cheaply first (the last verdict kept); a paid plan never
/// waits on a listing. A count at the limit is confirmed against a fresh plan
/// read, so an upgrade a moment ago is honoured.
pub async fn check_start(state: &AppState) -> StartVerdict {
    let (Ok(account), Ok(account_id)) = (state.current_session_account(), state.current_account_id()) else {
        return StartVerdict::Allowed;
    };
    let quick = state.capture.recording_tiers.last_known(state.pool().ok(), account.as_str()).await;
    if quick.is_some_and(|tier| !is_limited(tier)) {
        return StartVerdict::Allowed;
    }
    let counted = recording_count(state, &account_id).await;
    // Under the limit (or unreadable) is allowed on any plan: no plan read.
    if counted.is_none_or(|n| n < FREE_RECORDING_LIMIT) {
        return StartVerdict::Allowed;
    }
    let tier = super::allowance::recording_tier(state, &account).await;
    let verdict = decide_start(tier, counted);
    if verdict == StartVerdict::LimitReached {
        tracing::info!(counted = ?counted, "recording refused: the free plan's recordings are used up");
    }
    verdict
}

/// [`check_start`] as the refusal every start command returns.
///
/// # Errors
///
/// [`NotReadyKind::RecordingLimitReached`] when the limit is reached.
pub async fn require_can_start(state: &AppState) -> Result<()> {
    match check_start(state).await {
        StartVerdict::Allowed => Ok(()),
        StartVerdict::LimitReached => Err(AppError::NotReady(NotReadyKind::RecordingLimitReached)),
    }
}

/// Fill the count ahead of a Record press (the capture bar just opened), so
/// the press itself does not wait on the listing. Only for a plan that could
/// be limited.
pub async fn warm(state: &AppState) {
    let (Ok(account), Ok(account_id)) = (state.current_session_account(), state.current_account_id()) else {
        return;
    };
    let quick = state.capture.recording_tiers.last_known(state.pool().ok(), account.as_str()).await;
    if quick.is_none_or(is_limited) {
        let _ = recording_count(state, &account_id).await;
    }
}

/// Whether a file at `path` can never be picked up by the sync engine of any
/// drive rooted at `drive_roots`: it is outside every one of them, or inside
/// through a hidden (dot) folder, which the engine never walks. The recorder
/// writes only where this holds (`commands::begin_recording`), so a file
/// still being written is never uploaded half done.
#[must_use]
pub fn unsynced_by_every_drive(path: &Path, drive_roots: &[PathBuf]) -> bool {
    drive_roots.iter().all(|root| match path.strip_prefix(root) {
        Err(_) => true,
        Ok(inside) => inside.components().any(|c| match c {
            std::path::Component::Normal(name) => name.to_string_lossy().starts_with('.'),
            _ => false,
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed(names: &[&str]) -> Vec<RemoteFileInfo> {
        names
            .iter()
            .enumerate()
            .map(|(i, path)| RemoteFileInfo {
                file_id: format!("{i:064x}"),
                path: (*path).to_string(),
                name: path.rsplit('/').next().unwrap_or(path).to_string(),
                size_bytes: 1,
                arion_hash: None,
                created_at: 0,
                updated_at: 0,
                salted_hash: String::new(),
                revision_seq: 1,
                revision_id: String::new(),
            })
            .collect()
    }

    #[test]
    fn a_recording_is_named_the_way_the_app_names_one() {
        for name in [
            "Recording 2026-09-22 at 09.00.05.mp4",
            "Recording 2026-09-22 at 09.00.05.webm",
            "Recording 2026-09-22 at 09.00.05.mov",
            "Recording 2026-09-22 at 09.00.05.MP4",
            "Recording 2026-09-22 at 09.00.05 (2).mp4",
            "Recording 2026-09-22 at 09.00.05 (13).mov",
        ] {
            assert!(is_recording_name(name), "{name}");
        }
        // The app's own name for a fresh recording is one.
        let fresh = super::super::naming::capture_file_name(
            super::super::session::CaptureKind::Recording,
            chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap(),
        );
        assert!(is_recording_name(&fresh), "{fresh}");
    }

    #[test]
    fn screenshots_and_other_videos_are_not_recordings() {
        for name in [
            "Screenshot 2026-09-22 at 09.00.05.png",
            "Recording 2026-09-22 at 09.00.05.png",
            "Recording 2026-09-22 at 09.00.05.mkv",
            "holiday.mp4",
            "My Recording 2026-09-22 at 09.00.05.mp4",
            "Recording 2026-09-22 at 09.00.05 copy.mp4",
            "Recording 2026-09-22 at 09.00.05 ().mp4",
            "Recording 2026-09-22 at 09.00.05 (x).mp4",
            "Recording 2026-9-22 at 09.00.05.mp4",
            "Recording 2026-09-22 at 09:00:05.mp4",
            "Recording 2026-09-22 09.00.05.mp4",
            "Recording.mp4",
            "Recording 2026-09-22 at 09.00.05",
        ] {
            assert!(!is_recording_name(name), "{name}");
        }
    }

    /// The count from a server listing: recordings anywhere in the drive,
    /// a " (2)" copy included; screenshots and other files never.
    #[test]
    fn the_count_comes_from_the_drive_listing() {
        let files = listed(&[
            "Recording 2026-09-22 at 09.00.05.mp4",
            "Recording 2026-09-22 at 09.00.05 (2).mp4",
            "Screenshot 2026-09-22 at 09.00.05.png",
            "notes.txt",
            "holiday.mp4",
            "Old/Recording 2025-01-01 at 10.00.00.webm",
            // Same name in another folder is another recording.
            "Old/Recording 2026-09-22 at 09.00.05.mp4",
        ]);
        assert_eq!(recording_paths(&files).len(), 4);
        assert!(recording_paths(&listed(&[])).is_empty());
    }

    #[test]
    fn only_a_known_limited_plan_with_a_known_count_at_the_limit_is_refused() {
        let free = Some(RecordingTier::Free);
        assert_eq!(decide_start(free, Some(0)), StartVerdict::Allowed);
        assert_eq!(
            decide_start(free, Some(FREE_RECORDING_LIMIT - 1)),
            StartVerdict::Allowed,
            "the 25th recording may start"
        );
        assert_eq!(
            decide_start(free, Some(FREE_RECORDING_LIMIT)),
            StartVerdict::LimitReached,
            "the 26th may not"
        );
        assert_eq!(decide_start(free, Some(40)), StartVerdict::LimitReached);
        assert_eq!(
            decide_start(Some(RecordingTier::Paid), Some(500)),
            StartVerdict::Allowed,
            "paid plans have no count"
        );
        assert_eq!(decide_start(None, Some(500)), StartVerdict::Allowed, "an unknown plan fails open");
        assert_eq!(decide_start(free, None), StartVerdict::Allowed, "an unreadable count fails open");
    }

    #[test]
    fn only_the_free_plan_is_limited() {
        assert!(is_limited(RecordingTier::Free));
        assert!(!is_limited(RecordingTier::Paid));
    }

    fn set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| (*p).to_string()).collect()
    }

    #[test]
    fn a_listing_answers_for_its_ttl_then_is_read_again() {
        let cache = CountCache::default();
        let t0 = Instant::now();
        assert_eq!(cache.fresh("a", t0), None, "nothing listed yet");
        assert_eq!(cache.store("a", "Hippius Captures", set(&["r1", "r2"]), t0), 2);
        assert_eq!(cache.fresh("a", t0 + Duration::from_secs(29)), Some(2));
        assert_eq!(cache.fresh("a", t0 + COUNT_TTL), None, "stale after the TTL");
        assert_eq!(cache.fresh("b", t0), None, "per account");
    }

    /// A recording just delivered counts before the server lists it, and
    /// only once after it does.
    #[test]
    fn a_delivered_recording_counts_at_once_and_only_once() {
        let cache = CountCache::default();
        let t0 = Instant::now();
        cache.store("a", "Hippius Captures", set(&["r1"]), t0);
        cache.note_delivered("a", "r2", t0);
        cache.note_delivered("a", "r2", t0);
        assert_eq!(cache.fresh("a", t0), Some(2));
        // The next listing holds it.
        assert_eq!(cache.store("a", "Hippius Captures", set(&["r1", "r2"]), t0 + COUNT_TTL), 2);
        // Delivered with nothing listed yet: it still counts once listed.
        let other = CountCache::default();
        other.note_delivered("a", "r9", t0);
        assert_eq!(other.store("a", "Hippius Captures", set(&[]), t0), 1);
        // A pending row that never shows up expires.
        assert_eq!(other.store("a", "Hippius Captures", set(&[]), t0 + PENDING_FOR), 0);
    }

    /// A completed sync or a delete in the captures drive drops its listing;
    /// another drive's does not.
    #[test]
    fn a_change_in_the_drive_drops_its_listing() {
        let cache = CountCache::default();
        let t0 = Instant::now();
        cache.store("a", "Hippius Captures", set(&["r1"]), t0);
        cache.invalidate_label("Work");
        assert_eq!(cache.fresh("a", t0), Some(1));
        cache.invalidate_label("Hippius Captures");
        assert_eq!(cache.fresh("a", t0), None);
        cache.store("a", "Hippius Captures", set(&["r1"]), t0);
        cache.clear();
        assert_eq!(cache.fresh("a", t0), None);
    }

    /// The refusal is structured so the app shows its dialog, and says the
    /// same as the dialog.
    #[test]
    fn the_refusal_is_the_limit_dialog() {
        let json = serde_json::to_value(AppError::NotReady(NotReadyKind::RecordingLimitReached)).unwrap();
        assert_eq!(json["subkind"], "RECORDING_LIMIT_REACHED");
        assert_eq!(json["message"], format!("{LIMIT_TITLE} {LIMIT_BODY}"));
        assert!(LIMIT_TITLE.contains(&FREE_RECORDING_LIMIT.to_string()));
    }

    /// The recorder writes under `~/.hippius`: hidden, so no drive's engine
    /// ever walks it, even a drive that is the whole home folder.
    #[test]
    fn the_recorder_never_writes_where_a_drive_syncs() {
        let home = PathBuf::from("/Users/a");
        let tmp = home.join(".hippius").join("capture-tmp");
        let drives = [home.clone(), home.join("Documents/Hippius Captures"), PathBuf::from("/Volumes/X")];
        assert!(unsynced_by_every_drive(&tmp, &drives));
        // The captures folder itself, or any visible folder in a drive, is not.
        assert!(!unsynced_by_every_drive(&home.join("Documents/Hippius Captures/tmp"), &drives));
        assert!(!unsynced_by_every_drive(&home.join("Movies"), std::slice::from_ref(&home)));
        assert!(unsynced_by_every_drive(&home.join("Movies"), &[]));
    }

    /// The real temp root is somewhere no drive syncs.
    #[test]
    fn the_capture_temp_root_is_a_hidden_app_folder() {
        let _home = crate::test_helpers::HOME_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let home = dirs::home_dir().unwrap();
        let root = super::super::screenshot::capture_tmp_root().unwrap();
        assert!(root.starts_with(home.join(".hippius")), "{}", root.display());
        assert!(unsynced_by_every_drive(&root, std::slice::from_ref(&home)), "{}", root.display());
    }
}
