//! The free plan's recording allowance: 25 recordings in the captures drives.
//!
//! Screenshots are never counted and sharing is never limited; paid plans
//! have no count at all. The limit is enforced when a recording STARTS: a
//! limited plan that already has [`FREE_RECORDING_LIMIT`] recordings is
//! refused before anything records ([`require_can_start`], the one gate
//! every start path calls). Nothing is recorded and then held back.
//!
//! # What is counted
//!
//! Every video in ALL of the account's own captures drives, read from the
//! HCFS SERVER's listing of each, the same listing the remote-folder browser
//! reads (`list_remote_folder_files_inner`). A captures drive is one the
//! server holds whose key label is the default's ("Hippius Captures",
//! `naming::CAPTURES_DIR_NAME`, or "Hippius Captures-2" and so on, as moving
//! the folder or another computer names it), or one this machine has ever
//! kept captures in (`destination::own_capture_labels`). So moving the
//! captures folder does not start the count again, a recording uploaded from
//! the web console, another computer or an older build counts, and one
//! deleted anywhere stops counting.
//!
//! # Found by folder hash, never by the listed name
//!
//! A drive has two names. Its key label is fixed when the drive is made: the
//! server keeps the drive under `folder_hash(label)` and its files are
//! encrypted with a key derived from that label. The name the server's
//! folder list shows is the drive's folder name on the computer that
//! registered it (`spawn_folder_registration`), so a captures drive keyed
//! "Hippius Captures" is listed as `hippius-captures` by default, or as any
//! folder the user picked. A drive is therefore matched by its folder hash
//! against the hashes of the key labels a captures drive can have
//! ([`captures_drives`]), and listed by that key label. Matching the listed
//! name missed every captures drive in a folder not literally called
//! "Hippius Captures", and a drive merely named like one was counted.
//!
//! Captures filed in a folder of another drive (the user picked a folder in
//! their main drive, `destination::own_capture_folders`) count only the
//! videos under that folder, never the rest of that drive. That drive is
//! found the same way, by the hash of the key label this machine filed the
//! captures under ([`captures_folders`]).
//!
//! A recording is ANY video file ([`is_video_name`]: `.mp4`, `.webm`,
//! `.mov`), whatever its name and in any folder of the drive, so renaming a
//! recording does not free a slot. Every other file, screenshots included,
//! is ignored.
//!
//! The count is cached per account for [`COUNT_TTL`] so pressing Record does
//! not wait on a full listing each time. A recording this app has just
//! delivered counts at once ([`note_delivered`]) even before its upload shows
//! in the listing, and a completed sync or a delete in the drive drops the
//! cached listing ([`invalidate_label`]), so the next start reads it again.
//!
//! # Never on an unknown plan or count
//!
//! The plan is the capture session's read (`allowance::session_tier`): one
//! that could not be read refuses the recording with a Retry, as every
//! capture is refused then. A limited plan whose count cannot be read
//! (offline, a listing that failed or timed out) is refused with a Retry
//! too ([`NotReadyKind::RecordingCountUnavailable`]), never let through. A
//! paid plan never waits on a listing.

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

/// A recording kept on this computer because the free plan has no room to
/// upload it (Retry, one kept while no folder was chosen, one an earlier run
/// quit on): the card's line, with Upgrade and Retry beside it.
pub const LIMIT_KEPT: &str =
    "You've used your 25 free recordings, so this one is kept on this computer. Upgrade, or delete an older recording and retry.";
/// The notification for waiting recordings kept back the same way.
pub const LIMIT_KEPT_NOTICE: &str = "You've used your 25 free recordings. Upgrade, or delete an older recording, to upload the rest.";

/// The refusal when a Free plan's recordings could not be counted
/// (`RecordingCountUnavailable`).
pub const COUNT_UNAVAILABLE: &str = "We couldn't check how many free recordings you've used. Check your connection and try again.";

/// How long a listed count answers before the server is asked again.
pub const COUNT_TTL: Duration = Duration::from_secs(30);

/// How long a start waits for the listing before it refuses with a Retry.
pub const COUNT_WITHIN: Duration = Duration::from_secs(5);

/// How long a recording this app delivered counts on its own, while its
/// upload may not be in the server's listing yet.
pub const PENDING_FOR: Duration = Duration::from_mins(10);

/// Video extensions a recording can have. Every file with one counts.
const RECORDING_EXTENSIONS: [&str; 3] = ["mp4", "webm", "mov"];

/// Whether `tier` counts recordings.
#[must_use]
pub fn is_limited(tier: RecordingTier) -> bool {
    LIMITED_TIERS.contains(&tier)
}

/// Whether `name` (a file's basename) is a video, which counts as a
/// recording whatever it is called.
#[must_use]
pub fn is_video_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && RECORDING_EXTENSIONS.iter().any(|v| ext.eq_ignore_ascii_case(v)))
}

/// The highest numbered default key label looked for by hash: "Hippius
/// Captures-2" through "Hippius Captures-99". A drive past it still counts
/// when the folder list shows its key label ([`captures_drives`]).
pub const NUMBERED_CAPTURES_LABELS: u32 = 99;

/// Whether `label` is a key label a captures drive has by default:
/// `Hippius Captures`, or `Hippius Captures-N` when that label was taken
/// (`sync::drive::paths::generate_unique_label_internal`).
#[must_use]
pub fn is_default_captures_label(label: &str) -> bool {
    let base = super::naming::CAPTURES_DIR_NAME;
    label == base
        || label
            .strip_prefix(base)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// A drive's folder hash as the server lists it, in the form
/// `mnemonic::folder_hash` derives it (lowercase hex).
fn listed_hash(hash: &str) -> String {
    hash.trim().to_ascii_lowercase()
}

/// Folder hash to key label for every default captures key label
/// ([`NUMBERED_CAPTURES_LABELS`]), computed once.
fn default_captures_hashes() -> &'static HashMap<String, String> {
    static HASHES: std::sync::OnceLock<HashMap<String, String>> = std::sync::OnceLock::new();
    HASHES.get_or_init(|| {
        let base = super::naming::CAPTURES_DIR_NAME;
        std::iter::once(base.to_string())
            .chain((2..=NUMBERED_CAPTURES_LABELS).map(|n| format!("{base}-{n}")))
            .map(|label| (crate::sync::mnemonic::folder_hash(&label), label))
            .collect()
    })
}

/// The captures drives among the drives the server holds (`on_server`, each
/// as `(listed name, folder hash)`), by KEY label: a drive whose folder hash
/// is a default captures key label's, or the hash of a drive this machine
/// kept captures in (`known`, key labels). The listed name never decides it
/// (see the module docs), except that a drive listed under a default key
/// label past [`NUMBERED_CAPTURES_LABELS`] counts when its hash is that
/// label's. Sorted, each once.
#[must_use]
pub fn captures_drives<'a>(known: &[String], on_server: impl IntoIterator<Item = (&'a str, &'a str)>) -> Vec<String> {
    let defaults = default_captures_hashes();
    let known: HashMap<String, &String> = known.iter().map(|label| (crate::sync::mnemonic::folder_hash(label), label)).collect();
    let mut labels: Vec<String> = on_server
        .into_iter()
        .filter_map(|(name, hash)| {
            let hash = listed_hash(hash);
            if let Some(label) = defaults.get(&hash).or_else(|| known.get(&hash).copied()) {
                return Some(label.clone());
            }
            (is_default_captures_label(name) && crate::sync::mnemonic::folder_hash(name) == hash).then(|| name.to_string())
        })
        .collect();
    labels.sort();
    labels.dedup();
    labels
}

/// The folders inside other drives captures were filed in, among the drives
/// the server holds (`on_server`, each as `(listed name, folder hash)`),
/// leaving out any drive already counted whole (`whole`, from
/// [`captures_drives`]). A folder's drive is found by the hash of the key
/// label it was filed under, never by the name the drive is listed as.
/// Sorted, each once.
#[must_use]
pub fn captures_folders<'a>(
    whole: &[String],
    folders: &[super::destination::CaptureFolder],
    on_server: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Vec<super::destination::CaptureFolder> {
    let on_server: HashSet<String> = on_server.into_iter().map(|(_, hash)| listed_hash(hash)).collect();
    let mut kept: Vec<super::destination::CaptureFolder> = folders
        .iter()
        .filter(|f| on_server.contains(&crate::sync::mnemonic::folder_hash(&f.label)) && !whole.contains(&f.label))
        .cloned()
        .collect();
    kept.sort_by(|a, b| (&a.label, &a.folder).cmp(&(&b.label, &b.folder)));
    kept.dedup();
    kept
}

/// The recordings under `folder` of drive `label`'s server listing only
/// (a captures folder inside another drive), keyed like [`recording_paths`].
#[must_use]
pub fn recording_paths_in(label: &str, folder: &str, files: &[RemoteFileInfo]) -> HashSet<String> {
    files
        .iter()
        .filter(|f| is_video_name(&f.name) && crate::sync::recent_uploads::in_capture_folder(&f.path, folder))
        .map(|f| counted_path(label, &f.path))
        .collect()
}

/// The recordings in drive `label`'s server listing, by drive and path, so
/// the same name in two folders or two drives is two recordings.
#[must_use]
pub fn recording_paths(label: &str, files: &[RemoteFileInfo]) -> HashSet<String> {
    files
        .iter()
        .filter(|f| is_video_name(&f.name))
        .map(|f| counted_path(label, &f.path))
        .collect()
}

/// How a recording is keyed in the count: its drive and its path in it.
fn counted_path(label: &str, path: &str) -> String {
    format!("{label}/{path}")
}

/// What starting a recording comes to, once the plan is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartVerdict {
    Allowed,
    /// A limited plan with a count at or past the limit.
    LimitReached,
    /// A limited plan whose count could not be read: refused with a Retry.
    CountUnavailable,
}

/// A paid plan always starts; a limited one only with a count it has read
/// that is under the limit.
#[must_use]
pub fn decide_start(tier: RecordingTier, counted: Option<usize>) -> StartVerdict {
    if !is_limited(tier) {
        return StartVerdict::Allowed;
    }
    match counted {
        None => StartVerdict::CountUnavailable,
        Some(n) if n >= FREE_RECORDING_LIMIT => StartVerdict::LimitReached,
        Some(_) => StartVerdict::Allowed,
    }
}

// ── The count cache ─────────────────────────────────────────────────────────

/// One account's count: the last listing, and recordings delivered since
/// that may not be in it yet.
#[derive(Debug, Default)]
struct Counted {
    /// The captures drives' labels and the recordings their listings held, and when.
    listed: Option<(Vec<String>, HashSet<String>, Instant)>,
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

    /// Keep a listing of the recordings in `labels` for `account`; returns the count.
    pub fn store(&self, account: &str, labels: &[String], listed: HashSet<String>, now: Instant) -> usize {
        self.with(|all| {
            let counted = all.entry(account.to_string()).or_default();
            // A delivered recording the listing now holds needs no pending row.
            counted
                .pending
                .retain(|(path, at)| !listed.contains(path) && now.saturating_duration_since(*at) < PENDING_FOR);
            let n = total(&listed, &counted.pending);
            counted.listed = Some((labels.to_vec(), listed, now));
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
                if counted.listed.as_ref().is_some_and(|(labels, _, _)| labels.iter().any(|l| l == label)) {
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

/// The account's own captures drives on the server ([`captures_drives`]),
/// and the captures folders inside its other drives ([`captures_folders`]),
/// both by key label, which is what `list_remote_folder_files_inner` derives
/// the drive's hash and key from.
async fn captures_labels(state: &AppState, account_id: &str) -> Result<(Vec<String>, Vec<super::destination::CaptureFolder>)> {
    let pool = state.pool()?;
    let known = super::destination::own_capture_labels(pool, account_id).await?;
    let folders = super::destination::own_capture_folders(pool, account_id).await?;
    let on_server = crate::sync::folders::list_remote_folders_internal(pool, account_id).await?;
    let listed = || on_server.iter().map(|f| (f.label.as_str(), f.folder_hash.as_str()));
    let whole = captures_drives(&known, listed());
    let folders = captures_folders(&whole, &folders, listed());
    Ok((whole, folders))
}

/// The recordings in every listed captures drive and captures folder, or
/// the first failure. Returns every drive read, for [`invalidate_label`].
async fn list_recordings(state: &AppState, account_id: &str) -> Result<(Vec<String>, HashSet<String>)> {
    let (whole, folders) = captures_labels(state, account_id).await?;
    let mut labels = whole.clone();
    for f in &folders {
        if !labels.contains(&f.label) {
            labels.push(f.label.clone());
        }
    }
    let listings = futures_util::future::join_all(
        labels
            .iter()
            .map(|label| crate::sync::remote::list_remote_folder_files_inner(state, account_id, label)),
    )
    .await;
    let mut recordings = HashSet::new();
    for (label, listing) in labels.iter().zip(listings) {
        let listing = listing?;
        if whole.contains(label) {
            recordings.extend(recording_paths(label, &listing));
        } else {
            for f in folders.iter().filter(|f| &f.label == label) {
                recordings.extend(recording_paths_in(label, &f.folder, &listing));
            }
        }
    }
    Ok((labels, recordings))
}

/// The recordings in the account's captures drives: the cached count while
/// fresh, else new server listings. `None` when any of them cannot be read,
/// which the gate refuses with a Retry for a limited plan.
pub async fn recording_count(state: &AppState, account_id: &str) -> Option<usize> {
    let key = account_key(account_id);
    if let Some(n) = state.capture.recording_counts.fresh(&key, Instant::now()) {
        return Some(n);
    }
    match tokio::time::timeout(COUNT_WITHIN, list_recordings(state, account_id)).await {
        Ok(Ok((labels, recordings))) => Some(state.capture.recording_counts.store(&key, &labels, recordings, Instant::now())),
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "recording count: captures drives not listed");
            None
        }
        Err(_) => {
            tracing::warn!("recording count: the captures drives listing took too long");
            None
        }
    }
}

/// A recording was delivered to `destination`: it counts from now on, even
/// before the server lists it.
pub async fn note_delivered(state: &AppState, account_id: &str, destination: &super::destination::CaptureDestination, file_name: &str) {
    if !is_video_name(file_name) || destination.owner_ss58.is_some() {
        return;
    }
    let Ok(pool) = state.pool() else {
        return;
    };
    let known = super::destination::own_capture_labels(pool, account_id).await.unwrap_or_default();
    let rel_path = destination.rel_path(file_name);
    let in_folder = || async {
        super::destination::own_capture_folders(pool, account_id)
            .await
            .unwrap_or_default()
            .iter()
            .any(|f| f.label == destination.label && crate::sync::recent_uploads::in_capture_folder(&rel_path, &f.folder))
    };
    if is_default_captures_label(&destination.label) || known.contains(&destination.label) || in_folder().await {
        state
            .capture
            .recording_counts
            .note_delivered(&account_key(account_id), &counted_path(&destination.label, &rel_path), Instant::now());
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
/// The plan is the capture session's read (`allowance::session_tier`,
/// waited for if still under way); a paid plan never waits on a listing.
///
/// # Errors
///
/// The plan's refusals (`CapturePlanUnavailable`, `CaptureNoDrivePlan`);
/// [`NotReadyKind::RecordingLimitReached`] at the limit;
/// [`NotReadyKind::RecordingCountUnavailable`] when a limited plan's count
/// cannot be read.
pub async fn require_can_start(state: &AppState) -> Result<()> {
    let tier = super::allowance::session_tier(state).await?;
    let counted = if is_limited(tier) {
        let account_id = state.current_account_id()?;
        with_waiting(recording_count(state, &account_id).await, waiting_here(state, &account_id).await)
    } else {
        None
    };
    match decide_start(tier, counted) {
        StartVerdict::Allowed => Ok(()),
        StartVerdict::LimitReached => {
            tracing::info!(counted = ?counted, "recording refused: the free plan's recordings are used up");
            Err(AppError::NotReady(NotReadyKind::RecordingLimitReached))
        }
        StartVerdict::CountUnavailable => {
            tracing::info!("recording refused: the free plan's recordings could not be counted");
            Err(AppError::NotReady(NotReadyKind::RecordingCountUnavailable))
        }
    }
}

/// Fill the count ahead of a Record press (the capture bar just opened), so
/// the press itself does not wait on the listing. Only for a limited plan,
/// once the session's plan read says so.
pub async fn warm(state: &AppState) {
    let Ok(account_id) = state.current_account_id() else {
        return;
    };
    if super::allowance::session_tier(state).await.is_ok_and(is_limited) {
        let _ = recording_count(state, &account_id).await;
    }
}

/// What the free plan's notice says before a capture (the capture bar and
/// the Captures page): captures carry a watermark, recordings stop at
/// `max_recording_mins`, and `used` of `limit` recordings are used.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreePlanNotice {
    /// Recordings counted so far, at most `limit`; `None` when the count
    /// cannot be read, and the notice leaves the count out.
    pub used: Option<usize>,
    pub limit: usize,
    pub max_recording_mins: u64,
}

/// The notice for a known limited plan, `None` for any other (a paid plan,
/// or a plan that cannot be read: nothing is said that may not hold).
#[must_use]
pub fn free_plan_notice(tier: Option<RecordingTier>, counted: Option<usize>) -> Option<FreePlanNotice> {
    let tier = tier.filter(|t| is_limited(*t))?;
    Some(FreePlanNotice {
        used: counted.map(|n| n.min(FREE_RECORDING_LIMIT)),
        limit: FREE_RECORDING_LIMIT,
        max_recording_mins: tier.max_recording().map_or(0, |d| d.as_secs() / 60),
    })
}

/// [`free_plan_notice`] for the signed-in account, and the count only for a
/// limited plan. During a capture the plan is that capture's read (so the
/// bar never says more than the gate decides); otherwise a fresh one.
pub async fn current_free_plan_notice(state: &AppState) -> Option<FreePlanNotice> {
    let (Ok(account), Ok(account_id)) = (state.current_session_account(), state.current_account_id()) else {
        return None;
    };
    let tier = if state.capture.current() == super::session::CapturePhase::Idle {
        super::allowance::recording_tier(state, &account).await.ok()?
    } else {
        super::allowance::session_tier(state).await.ok()?
    };
    if !is_limited(tier) {
        return None;
    }
    let counted = with_waiting(recording_count(state, &account_id).await, waiting_here(state, &account_id).await);
    free_plan_notice(Some(tier), counted)
}

/// The recordings the server lists (`counted`) and the ones waiting on this
/// computer to upload, which will count once they do: unknown when the
/// listing is.
#[must_use]
pub fn with_waiting(counted: Option<usize>, waiting: usize) -> Option<usize> {
    counted.map(|n| n + waiting)
}

/// Recordings of this account that are on this computer and upload later:
/// in Hippius's waiting folder (taken before a captures folder was chosen,
/// "Not now"), in a chosen folder whose drive is not added yet, and failed
/// or interrupted uploads waiting for Retry. Each will count once it
/// uploads, so the gate counts them now: otherwise "Not now" and Retry let a
/// free account record past its limit.
pub async fn waiting_here(state: &AppState, account_id: &str) -> usize {
    let dirs = match state.pool() {
        Ok(pool) => super::setup::waiting_dirs(pool, account_id).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let root = super::screenshot::capture_tmp_root().ok();
    let account = account_key(account_id);
    tokio::task::spawn_blocking(move || {
        dirs.iter().map(|d| super::setup::waiting_recordings_in(d)).sum::<usize>()
            + root.map_or(0, |r| super::kept_failed::waiting_recordings(&r, &account))
    })
    .await
    .unwrap_or(0)
}

/// How many waiting recordings may go into the captures drive now (where
/// they upload): no limit on a plan without one, or one that cannot be read
/// (the server still gates storage); the room left on a limited plan; none
/// while its count cannot be read.
pub async fn room_for_waiting(state: &AppState, account_id: &str) -> Option<usize> {
    let account = state.current_session_account().ok()?;
    let tier = super::allowance::recording_tier(state, &account).await.ok()?;
    if !is_limited(tier) {
        return None;
    }
    Some(
        recording_count(state, account_id)
            .await
            .map_or(0, |n| FREE_RECORDING_LIMIT.saturating_sub(n)),
    )
}

/// Whether a free plan's recording may upload to `destination` now: checked
/// before every delivery, since a recording that waited (Retry, "Not now",
/// an earlier run that quit) was allowed to start long before.
///
/// # Errors
///
/// [`NotReadyKind::RecordingLimitReached`] when the plan has no room left;
/// [`NotReadyKind::RecordingCountUnavailable`] when its recordings cannot
/// be counted. Either way the file stays on this computer for Retry.
pub async fn require_room_to_upload(
    state: &AppState,
    account_id: &str,
    destination: &super::destination::CaptureDestination,
    file_name: &str,
) -> Result<()> {
    // Someone else's drive is not this account's plan.
    if !is_video_name(file_name) || destination.owner_ss58.is_some() {
        return Ok(());
    }
    let Ok(account) = state.current_session_account() else {
        return Ok(());
    };
    let Ok(tier) = super::allowance::recording_tier(state, &account).await else {
        return Ok(());
    };
    if !is_limited(tier) {
        return Ok(());
    }
    match upload_verdict(recording_count(state, account_id).await) {
        UploadVerdict::Allowed => Ok(()),
        UploadVerdict::LimitReached => {
            tracing::info!("recording kept on this computer: the free plan's recordings are used up");
            Err(AppError::NotReady(NotReadyKind::RecordingLimitReached))
        }
        UploadVerdict::CountUnavailable => Err(AppError::NotReady(NotReadyKind::RecordingCountUnavailable)),
    }
}

/// What [`require_room_to_upload`] decides for a limited plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadVerdict {
    Allowed,
    LimitReached,
    CountUnavailable,
}

/// One more recording fits while fewer than the limit are counted.
#[must_use]
pub fn upload_verdict(counted: Option<usize>) -> UploadVerdict {
    match counted {
        Some(n) if n < FREE_RECORDING_LIMIT => UploadVerdict::Allowed,
        Some(_) => UploadVerdict::LimitReached,
        None => UploadVerdict::CountUnavailable,
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

    /// A recording that waited uploads only while the plan has room, and an
    /// unknown count keeps it here rather than letting it through.
    #[test]
    fn a_waiting_recording_uploads_only_while_there_is_room() {
        assert_eq!(upload_verdict(Some(0)), UploadVerdict::Allowed);
        assert_eq!(upload_verdict(Some(FREE_RECORDING_LIMIT - 1)), UploadVerdict::Allowed);
        assert_eq!(upload_verdict(Some(FREE_RECORDING_LIMIT)), UploadVerdict::LimitReached);
        assert_eq!(upload_verdict(Some(FREE_RECORDING_LIMIT + 3)), UploadVerdict::LimitReached);
        assert_eq!(upload_verdict(None), UploadVerdict::CountUnavailable);
    }

    /// Recordings waiting on this computer count toward the limit at the
    /// start: 24 listed and one kept after "Not now" leaves no room.
    #[test]
    fn the_start_gate_counts_recordings_waiting_here() {
        assert_eq!(with_waiting(Some(24), 1), Some(25));
        assert_eq!(decide_start(RecordingTier::Free, with_waiting(Some(24), 1)), StartVerdict::LimitReached);
        assert_eq!(decide_start(RecordingTier::Free, with_waiting(Some(23), 1)), StartVerdict::Allowed);
        assert_eq!(with_waiting(None, 3), None, "an unknown listing stays unknown");
    }

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
    fn every_video_is_a_recording_whatever_its_name() {
        for name in [
            "Recording 2026-09-22 at 09.00.05.mp4",
            "Recording 2026-09-22 at 09.00.05 (2).webm",
            "holiday.mp4",
            "Renamed.MOV",
            "a.b.c.webm",
        ] {
            assert!(is_video_name(name), "{name}");
        }
        // The app's own name for a fresh recording is one.
        let fresh = super::super::naming::capture_file_name(
            super::super::session::CaptureKind::Recording,
            chrono::NaiveDate::from_ymd_opt(2026, 1, 2).unwrap().and_hms_opt(3, 4, 5).unwrap(),
        );
        assert!(is_video_name(&fresh), "{fresh}");
        for name in [
            "Screenshot 2026-09-22 at 09.00.05.png",
            "clip.mkv",
            "notes.txt",
            "mp4",
            ".mp4",
            "Recording",
        ] {
            assert!(!is_video_name(name), "{name}");
        }
    }

    /// The count from a server listing: every video anywhere in the drive,
    /// whatever its name, so renaming a recording does not free a slot;
    /// screenshots and other files never.
    #[test]
    fn the_count_comes_from_the_drive_listing() {
        let files = listed(&[
            "Recording 2026-09-22 at 09.00.05.mp4",
            "Recording 2026-09-22 at 09.00.05 (2).mp4",
            "Screenshot 2026-09-22 at 09.00.05.png",
            "notes.txt",
            "holiday.mp4",
            "Demo for the team.MOV",
            "Old/Recording 2025-01-01 at 10.00.00.webm",
            // Same name in another folder is another recording.
            "Old/Recording 2026-09-22 at 09.00.05.mp4",
            "clip.mkv",
            ".mp4",
        ]);
        assert_eq!(recording_paths("Hippius Captures", &files).len(), 6);
        assert!(recording_paths("Hippius Captures", &listed(&[])).is_empty());
        // The same path in two captures drives is two recordings.
        let both: HashSet<String> = recording_paths("Hippius Captures", &files)
            .into_iter()
            .chain(recording_paths("Hippius Captures-2", &files))
            .collect();
        assert_eq!(both.len(), 12);
    }

    /// A drive as the server's folder list gives it: the name it is listed
    /// under and the folder hash of the key label it was made with.
    fn on_server(name: &'static str, key_label: &str) -> (&'static str, String) {
        (name, crate::sync::mnemonic::folder_hash(key_label))
    }

    fn listed_drives<'a>(drives: &'a [(&'static str, String)]) -> impl Iterator<Item = (&'a str, &'a str)> {
        drives.iter().map(|(name, hash)| (*name, hash.as_str()))
    }

    /// The hash is hcfs-client's rule, and the web console looks the
    /// captures drive up by the same value.
    #[test]
    fn the_captures_drive_hash_is_the_one_the_console_looks_for() {
        assert_eq!(crate::sync::mnemonic::folder_hash("Hippius Captures"), "4a1c1de2d7c3ef04");
        assert_eq!(
            default_captures_hashes().get("4a1c1de2d7c3ef04").map(String::as_str),
            Some("Hippius Captures")
        );
        assert_eq!(default_captures_hashes().len(), 99, "Hippius Captures, then -2 to -99");
    }

    #[test]
    fn default_captures_labels_are_the_base_and_its_numbers() {
        for label in ["Hippius Captures", "Hippius Captures-2", "Hippius Captures-13"] {
            assert!(is_default_captures_label(label), "{label}");
        }
        for label in [
            "Hippius Captures-",
            "Hippius Captures-x",
            "Hippius Captures 2",
            "Work",
            "My Hippius Captures",
            "hippius-captures",
        ] {
            assert!(!is_default_captures_label(label), "{label}");
        }
    }

    /// The desktop's default: a drive keyed "Hippius Captures" whose folder
    /// is `hippius-captures`, which is the name the server lists. It counts,
    /// under its key label, which is what its files are listed by.
    #[test]
    fn a_drive_listed_as_hippius_captures_is_counted() {
        let drives = [
            on_server(super::super::naming::CAPTURES_FOLDER_NAME, "Hippius Captures"),
            on_server("Work", "Work"),
        ];
        assert_eq!(captures_drives(&[], listed_drives(&drives)), vec!["Hippius Captures".to_string()]);
        // Also when this machine remembers it (the usual case), still once.
        assert_eq!(
            captures_drives(&["Hippius Captures".to_string()], listed_drives(&drives)),
            vec!["Hippius Captures".to_string()]
        );
    }

    /// The user picked a folder of their own: the drive is listed under that
    /// folder's name. A moved captures folder ("Hippius Captures-2") and a
    /// drive this machine kept captures in count the same way.
    #[test]
    fn a_drive_listed_under_a_user_picked_name_is_counted() {
        let drives = [
            on_server("hippius-recording", "Hippius Captures"),
            on_server("Screen recordings", "Hippius Captures-2"),
            on_server("Old moves", "Hippius Captures-99"),
            on_server("clips", "Screens"),
            on_server("Work", "Work"),
        ];
        let known = vec!["Screens".to_string(), "Gone".to_string()];
        assert_eq!(
            captures_drives(&known, listed_drives(&drives)),
            vec![
                "Hippius Captures".to_string(),
                "Hippius Captures-2".to_string(),
                "Hippius Captures-99".to_string(),
                "Screens".to_string(),
            ],
            "a remembered drive the server no longer holds is not listed"
        );
        // Past the numbers looked for by hash, the listed key label counts
        // only when the hash is that label's.
        let far = [on_server("Hippius Captures-100", "Hippius Captures-100")];
        assert_eq!(captures_drives(&[], listed_drives(&far)), vec!["Hippius Captures-100".to_string()]);
        // The server's hash case does not matter.
        let upper = [("hippius-captures", crate::sync::mnemonic::folder_hash("Hippius Captures").to_uppercase())];
        assert_eq!(captures_drives(&[], listed_drives(&upper)), vec!["Hippius Captures".to_string()]);
    }

    /// A normal drive is never counted for its name, however much it looks
    /// like a recordings or captures folder: only its hash decides.
    #[test]
    fn a_normal_drive_named_like_a_recordings_folder_is_not_counted() {
        let drives = [
            on_server("hippius-captures", "Work"),
            on_server("Recordings", "Recordings"),
            on_server("Screen recordings", "Documents"),
            // Listed under the captures key label but made with another key.
            on_server("Hippius Captures", "Photos"),
            on_server("Hippius Captures-2", "Photos-2"),
        ];
        assert!(captures_drives(&[], listed_drives(&drives)).is_empty());
        assert!(captures_drives(&["Screens".to_string()], listed_drives(&drives)).is_empty());
    }

    /// Captures filed in a folder of the main drive count only the videos
    /// under that folder, never the rest of the drive; a drive already
    /// counted whole is not counted again by folder. The drive is found by
    /// the hash of its key label, whatever it is listed as.
    #[test]
    fn a_captures_folder_inside_another_drive_counts_only_that_folder() {
        use super::super::destination::CaptureFolder;
        let files = listed(&[
            "hippius-captures/Recording 2026-09-22 at 09.00.05.mp4",
            "hippius-captures/Old/clip.mov",
            "hippius-captures/Screenshot 2026-09-22 at 09.00.05.png",
            "Holiday/beach.mp4",
            "hippius-captures 2/talk.mp4",
            "family.mp4",
        ]);
        let only = recording_paths_in("Main", "hippius-captures", &files);
        assert_eq!(only.len(), 2, "{only:?}");
        assert!(only.contains("Main/hippius-captures/Old/clip.mov"));

        let folder = |label: &str, folder: &str| CaptureFolder {
            label: label.into(),
            folder: folder.into(),
        };
        let remembered = [folder("Main", "hippius-captures"), folder("Gone", "x"), folder("Hippius Captures", "sub")];
        let whole = vec!["Hippius Captures".to_string()];
        // The main drive keyed "Main" is listed as its folder, "Documents".
        let drives = [on_server("Documents", "Main"), on_server("hippius-captures", "Hippius Captures")];
        assert_eq!(
            captures_folders(&whole, &remembered, listed_drives(&drives)),
            vec![folder("Main", "hippius-captures")],
            "a drive the server no longer holds, or one counted whole, is left out"
        );
        // A drive merely LISTED as "Main" is not the one the folder is in.
        let lookalike = [on_server("Main", "Other")];
        assert!(captures_folders(&[], &remembered, listed_drives(&lookalike)).is_empty());
    }

    fn captures() -> Vec<String> {
        vec!["Hippius Captures".to_string(), "Hippius Captures-2".to_string()]
    }

    #[test]
    fn a_free_plan_at_the_limit_or_with_an_unread_count_is_refused() {
        let free = RecordingTier::Free;
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
            decide_start(free, None),
            StartVerdict::CountUnavailable,
            "an unread count is refused with a Retry, never let through"
        );
        assert_eq!(
            decide_start(RecordingTier::Paid, Some(500)),
            StartVerdict::Allowed,
            "paid plans have no count"
        );
        assert_eq!(decide_start(RecordingTier::Paid, None), StartVerdict::Allowed, "and never list one");
    }

    #[test]
    fn only_the_free_plan_is_limited() {
        assert!(is_limited(RecordingTier::Free));
        assert!(!is_limited(RecordingTier::Paid));
    }

    /// Only a known free plan gets the notice; the count is capped at the
    /// limit and left out when it cannot be read.
    #[test]
    fn the_free_plan_notice_is_for_a_known_free_plan_only() {
        let free = Some(RecordingTier::Free);
        assert_eq!(
            free_plan_notice(free, Some(3)),
            Some(FreePlanNotice {
                used: Some(3),
                limit: 25,
                max_recording_mins: 5
            })
        );
        assert_eq!(free_plan_notice(free, Some(40)).unwrap().used, Some(25));
        assert_eq!(free_plan_notice(free, None).unwrap().used, None);
        assert_eq!(free_plan_notice(Some(RecordingTier::Paid), Some(3)), None);
        assert_eq!(free_plan_notice(None, Some(3)), None);
        let json = serde_json::to_value(free_plan_notice(free, Some(1)).unwrap()).unwrap();
        assert_eq!(json, serde_json::json!({ "used": 1, "limit": 25, "maxRecordingMins": 5 }));
    }

    fn set(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| (*p).to_string()).collect()
    }

    #[test]
    fn a_listing_answers_for_its_ttl_then_is_read_again() {
        let cache = CountCache::default();
        let t0 = Instant::now();
        assert_eq!(cache.fresh("a", t0), None, "nothing listed yet");
        assert_eq!(cache.store("a", &captures(), set(&["r1", "r2"]), t0), 2);
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
        cache.store("a", &captures(), set(&["r1"]), t0);
        cache.note_delivered("a", "r2", t0);
        cache.note_delivered("a", "r2", t0);
        assert_eq!(cache.fresh("a", t0), Some(2));
        // The next listing holds it.
        assert_eq!(cache.store("a", &captures(), set(&["r1", "r2"]), t0 + COUNT_TTL), 2);
        // Delivered with nothing listed yet: it still counts once listed.
        let other = CountCache::default();
        other.note_delivered("a", "r9", t0);
        assert_eq!(other.store("a", &captures(), set(&[]), t0), 1);
        // A pending row that never shows up expires.
        assert_eq!(other.store("a", &captures(), set(&[]), t0 + PENDING_FOR), 0);
    }

    /// A completed sync or a delete in any captures drive drops the listing;
    /// another drive's does not.
    #[test]
    fn a_change_in_the_drive_drops_its_listing() {
        let cache = CountCache::default();
        let t0 = Instant::now();
        cache.store("a", &captures(), set(&["r1"]), t0);
        cache.invalidate_label("Work");
        assert_eq!(cache.fresh("a", t0), Some(1));
        cache.invalidate_label("Hippius Captures-2");
        assert_eq!(cache.fresh("a", t0), None);
        cache.store("a", &captures(), set(&["r1"]), t0);
        cache.invalidate_label("Hippius Captures");
        assert_eq!(cache.fresh("a", t0), None);
        cache.store("a", &captures(), set(&["r1"]), t0);
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
