//! Captures get a drive of their own.
//!
//! The first screenshot or recording asks where it goes: `hippius-captures`
//! in Documents unless the user picks another place. A folder they pick is
//! used as it is ([`folder_for_choice`]), except one too broad to upload
//! whole (the home folder, a disk's root, Documents, Desktop and the like),
//! which gets `hippius-captures` made inside it. The dialog shows the folder
//! that will be used before the user confirms.
//!
//! A free folder becomes a new drive, always labelled `Hippius Captures`
//! (`naming::CAPTURES_DIR_NAME`) whatever the folder is called, since the
//! web console and the browser extension find the captures drive by that
//! label. A folder inside one of the user's own drives (their main drive,
//! say) is used where it is: captures are filed in that drive, in that
//! folder ([`Place::InDrive`]), and no new drive is made. Picking the root of
//! an own drive that is not a captures drive files them in a
//! `hippius-captures` folder of it, never loose at its root.
//!
//! While nobody has answered, the capture waits in Hippius's own folder
//! (`~/.hippius/capture-waiting/<account>`) and the main window shows the
//! question ([`ask_for_location`]). Once the drive exists, the capture on the
//! card is sent the way Retry sends it (link and all) and every other one
//! waiting is moved into the drive, which uploads it.
//!
//! When the drive cannot be added (the plan has no room, the encryption
//! password was never chosen, the server cannot be reached) the chosen
//! folder is remembered (`capture_drive_pending_v1`), captures are kept in it
//! on this computer, and every later capture or Retry tries again. Nothing is
//! ever lost or thrown away on the way.
//!
//! The drive is added through `add_local_sync_folder`, the same path the
//! Drive page's Sync a Folder button runs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use super::destination::{self, CaptureDestination, DriveHere};
use super::naming::{CAPTURES_DIR_NAME, CAPTURES_FOLDER_NAME};
use super::preview::FailureReason;
use crate::app_state::AppState;
use crate::error::{AppError, NotReadyKind, Result};

/// Sent to the main window when a capture is waiting for the user to say
/// where captures go. The main window shows the question.
pub const SETUP_NEEDED_EVENT: &str = "capture_drive_setup_needed";

/// Sent when the captures drive was set up, moved, or its folder chosen:
/// the Captures page and Settings read the status again.
pub const DRIVE_CHANGED_EVENT: &str = "capture_drive_changed";

const PENDING_KEY_PREFIX: &str = "capture_drive_pending_v1:";

/// Why the captures drive could not be added yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupBlocked {
    /// The plan has no room for a new drive's uploads.
    StorageFull,
    /// The account never chose its encryption password, which every drive
    /// needs before it can upload.
    NeedsEncryptionPassword,
    /// The server could not be reached.
    Offline,
    /// Anything else; Rust's log has the detail.
    Other,
}

impl SetupBlocked {
    /// The card's reason, which decides its buttons (Upgrade for a full plan).
    #[must_use]
    pub fn failure_reason(self) -> FailureReason {
        match self {
            Self::StorageFull => FailureReason::StorageFull,
            Self::Offline => FailureReason::Offline,
            Self::NeedsEncryptionPassword | Self::Other => FailureReason::Other,
        }
    }
}

/// A capture that cannot go to a drive yet, and where it is kept meanwhile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    /// The folder the capture is moved into.
    pub dir: PathBuf,
    /// What the card calls where the capture is.
    pub place: String,
    /// The card's sentence: where the capture is and what gets it uploaded.
    pub message: String,
    pub reason: FailureReason,
    /// Nobody has said where captures go: ask (the main window's dialog).
    pub ask: bool,
}

/// Where a capture goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ensured {
    /// The captures drive is there: deliver as usual.
    Ready(CaptureDestination),
    /// Not yet: keep it on this computer as [`Kept`] says.
    Kept(Kept),
}

/// What [`ensure`] does, from what is stored for the account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The captures drive is set up.
    Deliver(CaptureDestination),
    /// A folder was chosen but its drive could not be added: try again.
    RetryAt(PathBuf),
    /// Nothing chosen yet: keep the capture waiting and ask.
    Ask,
}

/// The decision [`ensure`] acts on. A choice of the captures drive wins over
/// a pending folder (the pending row is cleared when the drive is made, but a
/// stale one must never send captures anywhere else).
#[must_use]
pub fn next_step(stored: Option<CaptureDestination>, pending: Option<PathBuf>) -> Step {
    match (stored, pending) {
        (Some(d), _) => Step::Deliver(d),
        (None, Some(dir)) => Step::RetryAt(dir),
        (None, None) => Step::Ask,
    }
}

/// One setup at a time: a capture landing, a Retry, and the user's answer
/// in the dialog all come here, and two of them must not make two drives.
static ENSURE_LOCK: Mutex<()> = Mutex::const_new(());

/// Where this capture goes, setting the drive up when a folder was chosen
/// before and could not be used then.
///
/// # Errors
///
/// A failure to read what is stored, or a chosen folder that cannot be used
/// any more (say it is now inside another drive). Every failure to ADD the
/// drive is an [`Ensured::Kept`], never an error.
pub async fn ensure(app: &tauri::AppHandle, account_id: &str) -> Result<Ensured> {
    let state = app.state::<AppState>();
    let pool = state.pool()?;
    let home = home_dir()?;
    let _one_at_a_time = ENSURE_LOCK.lock().await;
    let stored = destination::load(pool, account_id).await?;
    let pending = load_pending(pool, account_id).await?.map(|p| p.path);
    match next_step(stored, pending) {
        Step::Deliver(d) => Ok(Ensured::Ready(d)),
        Step::RetryAt(dir) => Ok(match add_drive(app, &state, account_id, &dir).await? {
            Added::Ready(d) => Ensured::Ready(d),
            Added::Blocked(why) => {
                save_pending(pool, account_id, &dir, why).await?;
                Ensured::Kept(kept_in_chosen(&dir, &home, why))
            }
        }),
        Step::Ask => Ok(Ensured::Kept(kept_waiting(waiting_dir(&home, account_id)))),
    }
}

/// What adding the drive came to.
enum Added {
    Ready(CaptureDestination),
    Blocked(SetupBlocked),
}

/// Make `dir` where this account's captures go: inside an own drive (its
/// root included, a drive whose first setup was cut short) captures are
/// filed in that drive at that folder, else the folder is made and added
/// like Sync a Folder adds one.
async fn add_drive(app: &tauri::AppHandle, state: &AppState, account_id: &str, dir: &Path) -> Result<Added> {
    let pool = state.pool()?;
    let home = home_dir()?;
    let drives = destination::drives_here(pool, account_id).await?;
    if let Place::InDrive { label, folder } = check_location(dir, &home, &drives)? {
        let root = drives
            .iter()
            .find(|d| d.label == label)
            .map_or_else(|| dir.to_path_buf(), |d| d.path.clone());
        let chosen = CaptureDestination {
            folder: folder.clone(),
            ..CaptureDestination::own(&label, &drive_name(&root, &label))
        };
        destination::save(pool, account_id, &chosen).await?;
        clear_pending(pool, account_id).await?;
        // Made now, so the folder is there to open before the first capture
        // lands in it. Delivery makes it too, so a failure here costs nothing.
        if !folder.is_empty()
            && let Err(e) = tokio::fs::create_dir_all(dir).await
        {
            tracing::warn!(error = %e, "captures folder inside a drive not made yet; delivery makes it");
        }
        tracing::info!(label = %label, in_folder = !folder.is_empty(), "captures go to an existing drive");
        return Ok(Added::Ready(chosen));
    }
    if let Err(e) = tokio::fs::create_dir_all(dir).await {
        tracing::warn!(error = %e, "captures drive: its folder could not be made");
        return Err(AppError::Validation(folder_refused_copy(dir, &home, e.kind())));
    }
    // A drive cannot upload without the account's encryption password, and
    // only the user can choose that. Their captures wait in the folder.
    match crate::sync::config::get_hcfs_config_internal(pool, account_id).await {
        Ok(config) if config.has_password => {}
        Ok(_) => return Ok(Added::Blocked(SetupBlocked::NeedsEncryptionPassword)),
        Err(e) => {
            tracing::warn!(error = %e, "captures drive: sync settings unreadable");
            return Ok(Added::Blocked(SetupBlocked::Other));
        }
    }
    let path = dir.to_string_lossy().into_owned();
    // The label is the captures drive's whatever the folder is called: the
    // web console and the extension find the captures drive by it.
    let base = CAPTURES_DIR_NAME.to_string();
    match crate::sync::lifecycle::add_local_sync_folder(app.clone(), account_id.to_string(), path, base, None).await {
        Ok(label) => {
            let chosen = CaptureDestination::own(&label, &drive_name(dir, &label));
            destination::save(pool, account_id, &chosen).await?;
            clear_pending(pool, account_id).await?;
            tracing::info!(label = %label, "captures drive added");
            Ok(Added::Ready(chosen))
        }
        // The folder itself cannot be a drive (it overlaps one, say): the
        // user is told and chooses again.
        Err(e @ AppError::Validation(_)) => Err(e),
        Err(e) => {
            // The drive's row may be written before its first sync failed;
            // the next try finds it at this folder and takes it.
            tracing::warn!(error = %e, "captures drive could not be added yet");
            Ok(Added::Blocked(blocked_by(&e)))
        }
    }
}

/// What stopped a drive being added, for the card's next step.
#[must_use]
pub fn blocked_by(e: &AppError) -> SetupBlocked {
    match e {
        AppError::NotReady(NotReadyKind::StorageLimitReached | NotReadyKind::InsufficientCredits) => SetupBlocked::StorageFull,
        other => match super::deliver::failure_reason(other) {
            FailureReason::Offline => SetupBlocked::Offline,
            _ => SetupBlocked::Other,
        },
    }
}

fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or_else(|| AppError::Other("No home folder to keep captures in.".into()))
}

/// The system's Documents folder, `~/Documents` when it names none.
fn documents_dir(home: &Path) -> PathBuf {
    dirs::document_dir().unwrap_or_else(|| home.join("Documents"))
}

/// The drive's name as Drive lists it (its folder's name).
fn drive_name(dir: &Path, label: &str) -> String {
    crate::sync::drive_status::derive_folder_name(&dir.to_string_lossy(), label)
}

/// Hippius's own folder for captures nobody has placed yet, per account so a
/// second account on this computer never uploads the first one's.
#[must_use]
pub fn waiting_dir(home: &Path, account_id: &str) -> PathBuf {
    home.join(".hippius")
        .join("capture-waiting")
        .join(crate::auth::account_key::account_key(account_id))
}

/// Where the captures drive goes unless the user picks another place:
/// `hippius-captures` in `documents` (the system's Documents folder, wherever
/// it really is, e.g. moved by Windows), or in the home folder when
/// Documents is itself inside one of their drives (the suggestion is always
/// a drive of its own).
#[must_use]
pub fn suggested_dir(home: &Path, documents: &Path, drives: &[DriveHere]) -> PathBuf {
    let own_drive = |dir: &Path| match check_location(dir, home, drives) {
        Ok(Place::NewDrive) => true,
        // An own drive already synced exactly there (a setup cut short).
        Ok(Place::InDrive { folder, .. }) => folder.is_empty(),
        Err(_) => false,
    };
    let documents = documents.join(CAPTURES_FOLDER_NAME);
    if own_drive(&documents) {
        return documents;
    }
    let in_home = home.join(CAPTURES_FOLDER_NAME);
    if own_drive(&in_home) {
        return in_home;
    }
    documents
}

/// The home folder's own folders, each too broad to upload whole as the
/// captures folder (macOS, Windows and Linux names).
const STANDARD_FOLDERS: [&str; 9] = [
    "Documents",
    "Desktop",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Videos",
    "Public",
    "Library",
];

/// Whether `dir` is a folder that must never become the captures folder
/// whole: the home folder, a disk's root, the system's Documents folder or
/// one of the home folder's standard folders.
fn too_broad(dir: &Path, home: &Path, documents: &Path) -> bool {
    dir == home
        || dir == documents
        || dir.parent().is_none()
        || (dir.parent() == Some(home)
            && dir
                .file_name()
                .is_some_and(|n| STANDARD_FOLDERS.iter().any(|s| n.to_string_lossy().eq_ignore_ascii_case(s))))
}

/// Whether the own drive `d` is a captures drive: labelled like one, kept
/// captures before (`known`), or a folder named like one.
fn is_captures_drive(d: &DriveHere, known: &[String]) -> bool {
    super::recording_allowance::is_default_captures_label(&d.label)
        || known.iter().any(|k| k == &d.label)
        || d.path.file_name().is_some_and(|n| n == CAPTURES_DIR_NAME || n == CAPTURES_FOLDER_NAME)
}

/// The folder captures go to when the user picks `picked`: the folder
/// itself, or `hippius-captures` inside it when it is too broad to upload
/// whole ([`too_broad`]) or is the root of one of their own drives that is
/// not a captures drive (captures are filed in a folder of it, never loose
/// at its root). `known` are the labels this account kept captures in
/// (`destination::own_capture_labels`). Applying it to its own answer gives
/// the same folder, which is what lets the dialog send back the path it
/// showed.
///
/// # Errors
///
/// [`AppError::Validation`] for a path that is not absolute.
pub fn folder_for_choice(picked: &Path, home: &Path, documents: &Path, drives: &[DriveHere], known: &[String]) -> Result<PathBuf> {
    if !picked.is_absolute() {
        return Err(AppError::Validation("Choose a folder on this computer.".into()));
    }
    let own_drive_root = drives.iter().find(|d| !d.member && d.path == picked);
    let inside = match own_drive_root {
        Some(d) => !is_captures_drive(d, known),
        None => too_broad(picked, home, documents),
    };
    Ok(if inside {
        picked.join(CAPTURES_FOLDER_NAME)
    } else {
        picked.to_path_buf()
    })
}

/// Where captures go for a folder ([`check_location`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// A folder outside every drive: a new captures drive is made of it.
    NewDrive,
    /// A folder in one of the account's own drives: captures are filed in
    /// that drive at `folder` (a path from its root; empty for the root
    /// itself, a drive already synced exactly there).
    InDrive { label: String, folder: String },
}

/// Where captures go if they are kept in `dir`.
///
/// # Errors
///
/// [`AppError::Validation`], with the sentence the dialog shows, for a
/// folder in a drive shared with this account, a folder holding a drive (two
/// drives never share files), Hippius's own folder, or a folder inside a
/// drive whose name the drive cannot hold.
pub fn check_location(dir: &Path, home: &Path, drives: &[DriveHere]) -> Result<Place> {
    // Compared where they really are: `a/../.hippius` or a link into a
    // shared drive must not pass as somewhere else.
    let dir = &resolved(dir);
    let home = &resolved(home);
    let drives: Vec<DriveHere> = drives
        .iter()
        .map(|d| DriveHere {
            path: if d.path.as_os_str().is_empty() {
                d.path.clone()
            } else {
                resolved(&d.path)
            },
            ..d.clone()
        })
        .collect();
    let drives = drives.as_slice();
    if dir.starts_with(home.join(".hippius")) {
        return Err(AppError::Validation(
            "That folder is where Hippius keeps its own files. Choose another place.".into(),
        ));
    }
    // The drive `dir` is in (drives never nest, so there is at most one).
    let drives = drives.iter().filter(|d| !d.path.as_os_str().is_empty());
    if let Some(d) = drives.clone().find(|d| dir.starts_with(&d.path)) {
        if d.member {
            return Err(AppError::Validation(format!(
                "That folder is in a drive shared with you, “{}”. Choose another place.",
                drive_name(&d.path, &d.label)
            )));
        }
        let rel = dir
            .strip_prefix(&d.path)
            .map(|rest| {
                rest.components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .unwrap_or_default();
        return Ok(Place::InDrive {
            label: d.label.clone(),
            folder: destination::normalize_folder(&rel)?,
        });
    }
    if let Some(d) = drives.clone().find(|d| d.path.starts_with(dir)) {
        return Err(AppError::Validation(format!(
            "That folder holds your drive “{}”. Choose another place.",
            drive_name(&d.path, &d.label)
        )));
    }
    Ok(Place::NewDrive)
}

/// Where `path` really is: `.` and `..` taken out, and the deepest part of
/// it that exists resolved through any links (the rest, a folder not made
/// yet, is kept as written). A relative path is returned as it is.
pub fn resolved(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut lexical = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                lexical.pop();
            }
            other => lexical.push(other.as_os_str()),
        }
    }
    if !lexical.is_absolute() {
        return lexical;
    }
    let mut existing = lexical.as_path();
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            let mut out = real;
            out.extend(rest.iter().rev());
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return lexical,
        }
    }
}

/// macOS asks before an app may use Documents, Desktop or Downloads. The
/// dialog says so first, so the system's question is expected.
#[must_use]
pub fn permission_note(dir: &Path, home: &Path, macos: bool) -> Option<String> {
    if !macos {
        return None;
    }
    let name = protected_folder(dir, home)?;
    Some(format!(
        "macOS will ask to let Hippius use your {name} folder. Choose Allow so your captures can be saved there."
    ))
}

/// The macOS-protected folder in the home folder that `dir` is inside.
fn protected_folder(dir: &Path, home: &Path) -> Option<&'static str> {
    ["Documents", "Desktop", "Downloads"]
        .into_iter()
        .find(|name| dir.starts_with(home.join(name)))
}

/// What the dialog says when the folder could not be made.
#[must_use]
pub fn folder_refused_copy(dir: &Path, home: &Path, kind: std::io::ErrorKind) -> String {
    match (kind, protected_folder(dir, home)) {
        (std::io::ErrorKind::PermissionDenied, Some(name)) if cfg!(target_os = "macos") => format!(
            "Hippius isn't allowed to use your {name} folder. Allow it in System Settings › Privacy & Security › Files and Folders, or choose another place."
        ),
        (std::io::ErrorKind::PermissionDenied, _) => "Hippius isn't allowed to make a folder there. Choose another place.".into(),
        _ => "Hippius couldn't make a folder there. Choose another place.".into(),
    }
}

/// How a folder is named to the user: its path from the home folder, as
/// `Documents › Hippius Captures`, or the whole path outside it.
#[must_use]
pub fn place_name(dir: &Path, home: &Path) -> String {
    match dir.strip_prefix(home) {
        Ok(rest) if rest.components().next().is_some() => rest
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" › "),
        _ => dir.to_string_lossy().into_owned(),
    }
}

/// A capture waiting for the user to say where captures go.
#[must_use]
pub fn kept_waiting(dir: PathBuf) -> Kept {
    Kept {
        dir,
        place: String::new(),
        message: WAITING_COPY.into(),
        reason: FailureReason::NeedsFolder,
        ask: true,
    }
}

/// The card's sentence while nobody has said where captures go.
pub const WAITING_COPY: &str = "Kept on this computer. It uploads once you choose a folder.";

/// A capture kept in the chosen folder while its drive cannot be added.
#[must_use]
pub fn kept_in_chosen(dir: &Path, home: &Path, why: SetupBlocked) -> Kept {
    let place = place_name(dir, home);
    Kept {
        dir: dir.to_path_buf(),
        message: local_only_copy(&place, why),
        place,
        reason: why.failure_reason(),
        ask: false,
    }
}

/// The card's sentence for a capture kept in the chosen folder, saying where
/// it is and what gets it uploaded.
#[must_use]
pub fn local_only_copy(place: &str, why: SetupBlocked) -> String {
    format!("Saved on this computer in {place}. {}", next_step_copy(why))
}

fn next_step_copy(why: SetupBlocked) -> &'static str {
    match why {
        SetupBlocked::StorageFull => "Upgrade your plan to upload it and get a link.",
        SetupBlocked::NeedsEncryptionPassword => "Open Drive in Hippius to set your encryption password, then Retry.",
        SetupBlocked::Offline => "Retry when you're back online to upload it.",
        SetupBlocked::Other => "Retry in a moment to upload it.",
    }
}

/// Show the main window on the question of where captures go.
pub fn ask_for_location(app: &tauri::AppHandle) {
    if let Some(main) = app.get_webview_window(super::commands::MAIN_WINDOW_LABEL) {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit(SETUP_NEEDED_EVENT, ());
}

// ── The chosen folder whose drive is not there yet ──────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Pending {
    path: PathBuf,
    why: SetupBlocked,
}

fn pending_key(account_id: &str) -> String {
    format!("{PENDING_KEY_PREFIX}{}", crate::auth::account_key::account_key(account_id))
}

async fn load_pending(pool: &sqlx::SqlitePool, account_id: &str) -> Result<Option<Pending>> {
    let raw = crate::utils::preferences::get_user_preference_internal(pool, &pending_key(account_id)).await?;
    Ok(raw.and_then(|v| serde_json::from_str::<Pending>(&v).ok()))
}

async fn save_pending(pool: &sqlx::SqlitePool, account_id: &str, dir: &Path, why: SetupBlocked) -> Result<()> {
    let value = serde_json::to_string(&Pending {
        path: dir.to_path_buf(),
        why,
    })
    .map_err(|e| AppError::Other(format!("Could not store the captures folder: {e}")))?;
    crate::utils::preferences::save_user_preference_internal(pool, &pending_key(account_id), &value).await
}

async fn clear_pending(pool: &sqlx::SqlitePool, account_id: &str) -> Result<()> {
    // An empty value reads as no pending folder (it does not parse).
    crate::utils::preferences::save_user_preference_internal(pool, &pending_key(account_id), "").await
}

// ── Moving waiting captures in ──────────────────────────────────────────────

/// Move every capture waiting in `from` into `to` (never over a file of the
/// same name), except `except`: the card's capture, which its own delivery
/// moves. Hidden files stay. Returns how many moved.
pub fn move_waiting(from: &Path, to: &Path, except: Option<&Path>) -> usize {
    let Ok(entries) = std::fs::read_dir(from) else { return 0 };
    let mut moved = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let hidden = entry.file_name().to_string_lossy().starts_with('.');
        if hidden || !path.is_file() || except == Some(path.as_path()) {
            continue;
        }
        match super::deliver::keep_in_folder(to, &path) {
            Ok(_) => moved += 1,
            Err(e) => tracing::warn!(error = %e, "a waiting capture could not be moved into the captures drive; left where it was"),
        }
    }
    moved
}

/// How many captures are waiting in `dir`.
#[must_use]
pub fn waiting_count(dir: &Path) -> usize {
    std::fs::read_dir(dir).map_or(0, |entries| {
        entries
            .flatten()
            .filter(|e| !e.file_name().to_string_lossy().starts_with('.') && e.path().is_file())
            .count()
    })
}

// ── What the Captures page, Settings and the dialog read ────────────────────

/// A folder the captures drive is, or would be, made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    /// `Documents › Hippius Captures`, or the whole path outside the home folder.
    pub place: String,
    /// What macOS will ask first, when it will.
    pub permission_note: Option<String>,
}

fn location(dir: &Path, home: &Path) -> Location {
    Location {
        path: dir.to_string_lossy().into_owned(),
        place: place_name(dir, home),
        permission_note: permission_note(dir, home, cfg!(target_os = "macos")),
    }
}

/// Where the account's captures drive stands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum CaptureDriveStatus {
    /// Captures go to this drive.
    #[serde(rename_all = "camelCase")]
    Ready {
        label: String,
        name: String,
        /// The folder in the drive captures go to, as a path from its root;
        /// empty for the root (a captures drive of its own).
        folder: String,
        /// Not synced on this computer: browsed from the server.
        remote: bool,
        /// Their folder here, when the drive is synced here.
        location: Option<Location>,
    },
    /// No folder chosen yet: the Captures page and Settings offer to set it
    /// up, and the first capture asks.
    #[serde(rename_all = "camelCase")]
    NeedsSetup {
        suggested: Location,
        /// Captures kept in Hippius's own folder until then.
        waiting: usize,
    },
    /// A folder was chosen but its drive could not be added yet.
    #[serde(rename_all = "camelCase")]
    Pending { location: Location, message: String },
}

async fn status_for(pool: &sqlx::SqlitePool, account_id: &str) -> Result<CaptureDriveStatus> {
    let home = home_dir()?;
    let drives = destination::drives_here(pool, account_id).await?;
    if let Some(d) = destination::load(pool, account_id).await? {
        // A paused drive is still this computer's: Drive browses it here.
        let here = drives.iter().find(|h| h.label == d.label && !h.member);
        return Ok(CaptureDriveStatus::Ready {
            remote: here.is_none(),
            location: here.map(|h| location(&destination::local_dir(&h.path, &d.folder), &home)),
            label: d.label,
            name: d.display_name,
            folder: d.folder,
        });
    }
    if let Some(p) = load_pending(pool, account_id).await? {
        let place = place_name(&p.path, &home);
        return Ok(CaptureDriveStatus::Pending {
            message: pending_copy(&place, p.why),
            location: location(&p.path, &home),
        });
    }
    let waiting = {
        let dir = waiting_dir(&home, account_id);
        tokio::task::spawn_blocking(move || waiting_count(&dir)).await.unwrap_or(0)
    };
    Ok(CaptureDriveStatus::NeedsSetup {
        suggested: location(&suggested_dir(&home, &documents_dir(&home), &drives), &home),
        waiting,
    })
}

/// What the Captures page says while the chosen folder has no drive yet.
#[must_use]
pub fn pending_copy(place: &str, why: SetupBlocked) -> String {
    format!(
        "Your captures are kept on this computer in {place} until Hippius can upload them. {}",
        next_step_copy(why)
    )
}

#[tauri::command]
pub async fn capture_drive_status(state: tauri::State<'_, AppState>) -> Result<CaptureDriveStatus> {
    let account_id = state.current_account_id()?;
    status_for(state.pool()?, &account_id).await
}

/// Where the captures drive goes if the user picks `folder` in the system's
/// folder picker, checked, so the dialog shows it (or why not) before Create.
#[tauri::command]
pub async fn capture_drive_location(state: tauri::State<'_, AppState>, folder: String) -> Result<Location> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    let home = home_dir()?;
    let drives = destination::drives_here(pool, &account_id).await?;
    let known = destination::own_capture_labels(pool, &account_id).await?;
    let dir = folder_for_choice(Path::new(&folder), &home, &documents_dir(&home), &drives, &known)?;
    check_location(&dir, &home, &drives)?;
    Ok(location(&dir, &home))
}

/// The user's answer: make the captures drive at `folder` (picked in the
/// system's picker; `None` = the suggested place), then send what was
/// waiting for it. Also how Settings moves it: the new folder becomes the
/// captures drive and the old one stays a drive with its captures in it.
///
/// # Errors
///
/// [`AppError::Validation`] with the dialog's sentence when the folder cannot
/// be used. A drive that cannot be added YET is not an error: the folder is
/// kept and the status says what is in the way.
#[tauri::command]
pub async fn capture_drive_create(state: tauri::State<'_, AppState>, app: tauri::AppHandle, folder: Option<String>) -> Result<CaptureDriveStatus> {
    let account_id = state.current_account_id()?;
    let pool = state.pool()?;
    let home = home_dir()?;
    {
        let _one_at_a_time = ENSURE_LOCK.lock().await;
        let drives = destination::drives_here(pool, &account_id).await?;
        let dir = match folder {
            Some(f) => {
                let known = destination::own_capture_labels(pool, &account_id).await?;
                folder_for_choice(Path::new(&f), &home, &documents_dir(&home), &drives, &known)?
            }
            None => suggested_dir(&home, &documents_dir(&home), &drives),
        };
        let already = match destination::load(pool, &account_id).await? {
            Some(current) => drives
                .iter()
                .any(|d| d.label == current.label && !d.member && destination::local_dir(&d.path, &current.folder) == dir),
            None => false,
        };
        if !already {
            match add_drive(&app, &state, &account_id, &dir).await? {
                Added::Ready(_) => {}
                Added::Blocked(why) => save_pending(pool, &account_id, &dir, why).await?,
            }
            // The card's capture first, sent as Retry sends it (it waits for
            // this lock, so it sees the drive), then everything else waiting.
            let on_card = super::commands::redeliver_kept_card(&app);
            let waiting = waiting_dir(&home, &account_id);
            let moved = tokio::task::spawn_blocking(move || move_waiting(&waiting, &dir, on_card.as_deref()))
                .await
                .unwrap_or(0);
            if moved > 0 {
                tracing::info!(moved, "waiting captures moved into the captures drive");
            }
        }
    }
    let _ = app.emit(DRIVE_CHANGED_EVENT, ());
    status_for(pool, &account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(label: &str, path: &str, member: bool) -> DriveHere {
        DriveHere {
            label: label.into(),
            path: PathBuf::from(path),
            member,
        }
    }

    const HOME: &str = "/Users/a";

    fn home() -> PathBuf {
        PathBuf::from(HOME)
    }

    /// The first capture asks; a chosen folder whose drive failed is tried
    /// again; once the drive exists captures go straight to it.
    #[test]
    fn a_capture_asks_only_while_nothing_was_chosen() {
        assert_eq!(next_step(None, None), Step::Ask);
        let dir = PathBuf::from("/Users/a/Documents/Hippius Captures");
        assert_eq!(next_step(None, Some(dir.clone())), Step::RetryAt(dir.clone()));
        let made = CaptureDestination::own("Hippius Captures", "Hippius Captures");
        assert_eq!(next_step(Some(made.clone()), Some(dir)), Step::Deliver(made.clone()));
        assert_eq!(next_step(Some(made.clone()), None), Step::Deliver(made));
    }

    #[test]
    fn the_suggested_place_is_hippius_captures_in_documents() {
        let docs = home().join("Documents");
        assert_eq!(suggested_dir(&home(), &docs, &[]), home().join("Documents/hippius-captures"));
        // Another drive elsewhere changes nothing.
        let work = [drive("Work", "/Users/a/Work", false)];
        assert_eq!(suggested_dir(&home(), &docs, &work), home().join("Documents/hippius-captures"));
        // Documents moved elsewhere by the system: there.
        let moved = PathBuf::from("/Users/a/OneDrive/Documents");
        assert_eq!(suggested_dir(&home(), &moved, &[]), moved.join("hippius-captures"));
    }

    /// Documents synced as a drive of its own: the suggestion is always a
    /// drive of its own, so it goes in the home folder.
    #[test]
    fn documents_inside_a_drive_moves_the_suggestion_to_the_home_folder() {
        let docs = [drive("Docs", "/Users/a/Documents", false)];
        assert_eq!(suggested_dir(&home(), &home().join("Documents"), &docs), home().join("hippius-captures"));
    }

    /// An absolute path on every platform (from a drive letter on Windows),
    /// since a picked folder must be absolute.
    fn abs(p: &str) -> PathBuf {
        PathBuf::from(if cfg!(windows) { format!("C:{p}") } else { p.to_string() })
    }

    fn abs_drive(label: &str, path: &str, member: bool) -> DriveHere {
        DriveHere {
            path: abs(path),
            ..drive(label, path, member)
        }
    }

    fn choice(picked: &str, drives: &[DriveHere], known: &[String]) -> PathBuf {
        folder_for_choice(&abs(picked), &abs(HOME), &abs("/Users/a/Documents"), drives, known).unwrap()
    }

    /// The folder the user picks is the one used, whatever it is called.
    #[test]
    fn a_picked_folder_is_used_as_it_is() {
        assert_eq!(choice("/Users/a/hipp.captures", &[], &[]), abs("/Users/a/hipp.captures"));
        assert_eq!(choice("/Users/a/Pictures/Screens", &[], &[]), abs("/Users/a/Pictures/Screens"));
        assert_eq!(choice("/Volumes/Ext/Shots", &[], &[]), abs("/Volumes/Ext/Shots"));
        // A captures folder from before, picked to go back to it.
        assert_eq!(
            choice("/Users/a/Documents/Hippius Captures", &[], &[]),
            abs("/Users/a/Documents/Hippius Captures")
        );
        assert!(matches!(
            folder_for_choice(Path::new("Pictures"), &abs(HOME), &abs("/Users/a/Documents"), &[], &[]),
            Err(AppError::Validation(_))
        ));
    }

    /// The home folder, a disk's root and the home folder's own folders are
    /// never uploaded whole: captures go in a folder made inside them.
    #[test]
    fn a_folder_too_broad_to_upload_gets_hippius_captures_inside_it() {
        for picked in [
            "/Users/a",
            "/Users/a/Documents",
            "/Users/a/Desktop",
            "/Users/a/Downloads",
            "/Users/a/Pictures",
            "/Users/a/Movies",
            "/Users/a/Music",
            "/Users/a/Videos",
            "/Users/a/Public",
            "/Users/a/Library",
            "/Users/a/documents",
            "/",
        ] {
            assert_eq!(choice(picked, &[], &[]), abs(picked).join("hippius-captures"), "{picked}");
        }
        // The system's Documents, wherever it really is.
        let moved = abs("/Users/a/OneDrive/Documents");
        assert_eq!(
            folder_for_choice(&moved, &abs(HOME), &moved, &[], &[]).unwrap(),
            moved.join("hippius-captures")
        );
    }

    /// The root of an own drive that is not a captures drive files captures
    /// in a folder of it, never loose at its root; a captures drive's root
    /// is used as it is.
    #[test]
    fn a_drive_root_gets_a_captures_folder_unless_it_is_a_captures_drive() {
        let drives = [
            abs_drive("Main", "/Users/a/Hippius", false),
            abs_drive("Hippius Captures", "/Users/a/Documents/Shots", false),
            abs_drive("Old", "/Users/a/Old", false),
            abs_drive("Team", "/Users/a/Team", true),
        ];
        assert_eq!(choice("/Users/a/Hippius", &drives, &[]), abs("/Users/a/Hippius/hippius-captures"));
        assert_eq!(choice("/Users/a/Documents/Shots", &drives, &[]), abs("/Users/a/Documents/Shots"));
        // A drive this account kept captures in before.
        assert_eq!(choice("/Users/a/Old", &drives, &["Old".into()]), abs("/Users/a/Old"));
        // A folder inside a drive is used as it is.
        assert_eq!(choice("/Users/a/Hippius/Screens", &drives, &[]), abs("/Users/a/Hippius/Screens"));
        // A drive shared with the account is left for the check to refuse.
        assert_eq!(choice("/Users/a/Team", &drives, &[]), abs("/Users/a/Team"));
    }

    /// The dialog sends back the folder it showed: resolving it again gives
    /// the same folder, never a folder inside it.
    #[test]
    fn resolving_a_resolved_folder_changes_nothing() {
        let drives = [abs_drive("Main", "/Users/a/Hippius", false)];
        for picked in [
            "/Users/a",
            "/Users/a/Documents",
            "/Users/a/Hippius",
            "/Users/a/Shots",
            "/Users/a/Hippius/x",
        ] {
            let once = choice(picked, &drives, &[]);
            let again = folder_for_choice(&once, &abs(HOME), &abs("/Users/a/Documents"), &drives, &[]).unwrap();
            assert_eq!(once, again, "{picked}");
        }
    }

    #[test]
    fn where_captures_go_for_each_kind_of_folder() {
        let drives = [
            drive("Main", "/Users/a/Hippius", false),
            drive("Team", "/Users/a/Team", true),
            drive("Hippius Captures", "/Users/a/Documents/Hippius Captures", false),
        ];
        let place = |dir: &str| check_location(Path::new(dir), &home(), &drives);
        // Free: a new drive.
        assert_eq!(place("/Users/a/Pictures/hippius-captures").unwrap(), Place::NewDrive);
        // An own drive already there: taken as it is.
        assert_eq!(
            place("/Users/a/Documents/Hippius Captures").unwrap(),
            Place::InDrive {
                label: "Hippius Captures".into(),
                folder: String::new()
            }
        );
        // Inside an own drive (the main drive, say): filed there.
        assert_eq!(
            place("/Users/a/Hippius/hippius-captures").unwrap(),
            Place::InDrive {
                label: "Main".into(),
                folder: "hippius-captures".into()
            }
        );
        assert_eq!(
            place("/Users/a/Hippius/Work/Screens").unwrap(),
            Place::InDrive {
                label: "Main".into(),
                folder: "Work/Screens".into()
            }
        );
        let refused = |dir: &str| match place(dir) {
            Err(AppError::Validation(m)) => m,
            other => panic!("{dir}: {other:?}"),
        };
        assert!(refused("/Users/a").contains("holds your drive"));
        assert!(refused("/Users/a/Team").contains("shared with you"));
        assert!(refused("/Users/a/Team/Shots").contains("shared with you"));
        assert!(refused("/Users/a/.hippius/hippius-captures").contains("its own files"));
        // A hidden folder in a drive would never sync.
        assert!(refused("/Users/a/Hippius/.private").contains("dot"));
    }

    /// The check compares where folders really are: `..` cannot walk back
    /// into Hippius's own folder, and a link cannot hide a shared drive.
    #[test]
    fn the_folder_check_sees_through_dots_and_links() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let team = home.join("Team");
        std::fs::create_dir_all(home.join(".hippius")).unwrap();
        std::fs::create_dir_all(home.join("Pictures")).unwrap();
        std::fs::create_dir_all(&team).unwrap();
        let drives = [DriveHere {
            label: "Team".into(),
            path: team.clone(),
            member: true,
        }];
        let refused = |dir: PathBuf| match check_location(&dir, &home, &drives) {
            Err(AppError::Validation(m)) => m,
            other => panic!("{}: {other:?}", dir.display()),
        };
        assert!(refused(home.join("Pictures/../.hippius/captures")).contains("its own files"));
        assert!(refused(home.join("Pictures/./../Team/Shots")).contains("shared with you"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&team, home.join("Pictures/Shortcut")).unwrap();
            assert!(refused(home.join("Pictures/Shortcut/Shots")).contains("shared with you"));
        }
        assert_eq!(
            check_location(&home.join("Pictures/hippius-captures"), &home, &drives).unwrap(),
            Place::NewDrive
        );
    }

    #[test]
    fn a_path_is_resolved_as_far_as_it_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let real = std::fs::canonicalize(tmp.path()).unwrap();
        assert_eq!(resolved(&tmp.path().join("a/../b/new")), real.join("b/new"));
        assert_eq!(resolved(Path::new("relative/../x")), PathBuf::from("x"));
    }

    #[test]
    fn macos_asks_first_only_for_its_protected_folders() {
        let docs = home().join("Documents/Hippius Captures");
        let note = permission_note(&docs, &home(), true).expect("Documents is protected");
        assert!(note.contains("Documents folder") && note.contains("Allow"), "{note}");
        assert!(permission_note(&home().join("Desktop/Hippius Captures"), &home(), true).is_some());
        assert_eq!(permission_note(&docs, &home(), false), None, "only macOS asks");
        assert_eq!(permission_note(&home().join("Hippius Captures"), &home(), true), None);
        assert_eq!(permission_note(Path::new("/Volumes/Ext/Hippius Captures"), &home(), true), None);
    }

    #[test]
    fn a_refused_folder_says_what_to_do() {
        let docs = home().join("Documents/Hippius Captures");
        let refused = folder_refused_copy(&docs, &home(), std::io::ErrorKind::PermissionDenied);
        if cfg!(target_os = "macos") {
            assert!(refused.contains("Files and Folders") && refused.contains("Documents"), "{refused}");
        }
        // macOS words it "..., or choose another place."; elsewhere it is a
        // sentence of its own, "Choose another place."
        assert!(refused.to_lowercase().contains("choose another place"), "{refused}");
        let other = folder_refused_copy(&docs, &home(), std::io::ErrorKind::Other);
        assert_eq!(other, "Hippius couldn't make a folder there. Choose another place.");
    }

    #[test]
    fn a_folder_is_named_from_the_home_folder() {
        assert_eq!(
            place_name(&home().join("Documents/Hippius Captures"), &home()),
            "Documents › Hippius Captures"
        );
        assert_eq!(
            place_name(Path::new("/Volumes/Ext/Hippius Captures"), &home()),
            "/Volumes/Ext/Hippius Captures"
        );
    }

    /// Cancel, or a capture before anyone answered: kept in Hippius's own
    /// folder for this account, and the main window asks.
    #[test]
    fn a_capture_nobody_placed_waits_in_hippiuss_folder_and_asks() {
        let dir = waiting_dir(&home(), "5Alice");
        assert!(dir.starts_with(home().join(".hippius/capture-waiting")));
        assert_ne!(dir, waiting_dir(&home(), "5Bob"), "per account");
        let kept = kept_waiting(dir.clone());
        assert!(kept.ask);
        assert_eq!(kept.dir, dir);
        assert_eq!(kept.message, WAITING_COPY);
        assert_eq!(kept.reason, FailureReason::NeedsFolder, "waiting, not failed");
    }

    #[test]
    fn a_capture_kept_in_the_chosen_folder_says_where_and_what_to_do() {
        let dir = home().join("Documents/Hippius Captures");
        let full = kept_in_chosen(&dir, &home(), SetupBlocked::StorageFull);
        assert!(!full.ask, "the folder was chosen: nothing to ask");
        assert_eq!(full.reason, FailureReason::StorageFull);
        assert_eq!(
            full.message,
            "Saved on this computer in Documents › Hippius Captures. Upgrade your plan to upload it and get a link."
        );
        let offline = kept_in_chosen(&dir, &home(), SetupBlocked::Offline);
        assert_eq!(offline.reason, FailureReason::Offline);
        assert!(offline.message.contains("back online"));
        let password = kept_in_chosen(&dir, &home(), SetupBlocked::NeedsEncryptionPassword);
        assert!(password.message.contains("encryption password"));
        assert!(pending_copy("Documents › Hippius Captures", SetupBlocked::StorageFull).contains("Upgrade your plan"));
    }

    #[test]
    fn a_full_plan_and_no_network_are_told_apart() {
        assert_eq!(
            blocked_by(&AppError::NotReady(NotReadyKind::StorageLimitReached)),
            SetupBlocked::StorageFull
        );
        assert_eq!(
            blocked_by(&AppError::Other("error sending request for url (https://x)".into())),
            SetupBlocked::Offline
        );
        assert_eq!(blocked_by(&AppError::Validation("nope".into())), SetupBlocked::Other);
    }

    /// Once the drive exists every waiting capture moves in, never over a
    /// file of the same name; the card's own capture is left for its
    /// delivery, and hidden files stay.
    #[test]
    fn waiting_captures_move_into_the_new_drive() {
        let tmp = tempfile::tempdir().unwrap();
        let waiting = tmp.path().join("waiting");
        let drive = tmp.path().join("Hippius Captures");
        std::fs::create_dir_all(&waiting).unwrap();
        std::fs::create_dir_all(&drive).unwrap();
        for name in ["a.png", "b.mp4", "card.png", ".DS_Store"] {
            std::fs::write(waiting.join(name), name).unwrap();
        }
        std::fs::write(drive.join("a.png"), "already here").unwrap();
        assert_eq!(waiting_count(&waiting), 3);
        let card = waiting.join("card.png");
        assert_eq!(move_waiting(&waiting, &drive, Some(&card)), 2);
        assert!(card.exists(), "the card's capture is its delivery's to move");
        assert!(waiting.join(".DS_Store").exists());
        assert_eq!(std::fs::read_to_string(drive.join("a.png")).unwrap(), "already here");
        assert_eq!(std::fs::read_to_string(drive.join("a (2).png")).unwrap(), "a.png");
        assert!(drive.join("b.mp4").exists());
        assert_eq!(waiting_count(&waiting), 1);
        assert_eq!(move_waiting(&tmp.path().join("missing"), &drive, None), 0);
    }

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::utils::schema::ensure_table_schema(&pool).await.unwrap();
        pool
    }

    /// The chosen folder is remembered per account until its drive exists.
    #[tokio::test]
    async fn a_chosen_folder_is_remembered_until_its_drive_exists() {
        let pool = pool().await;
        let dir = home().join("Documents/Hippius Captures");
        assert_eq!(load_pending(&pool, "5Alice").await.unwrap(), None);
        save_pending(&pool, "5Alice", &dir, SetupBlocked::Offline).await.unwrap();
        assert_eq!(
            load_pending(&pool, "5Alice").await.unwrap(),
            Some(Pending {
                path: dir.clone(),
                why: SetupBlocked::Offline
            })
        );
        assert_eq!(load_pending(&pool, "5Bob").await.unwrap(), None, "per account");
        clear_pending(&pool, "5Alice").await.unwrap();
        assert_eq!(load_pending(&pool, "5Alice").await.unwrap(), None);
    }

    /// What the Captures page and Settings read, in each state.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn the_status_follows_the_setup() {
        let _home = crate::test_helpers::HOME_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let pool = pool().await;
        let home = dirs::home_dir().unwrap();
        let CaptureDriveStatus::NeedsSetup { suggested, .. } = status_for(&pool, "5Status").await.unwrap() else {
            panic!("nothing chosen yet");
        };
        let documents = documents_dir(&home);
        assert_eq!(suggested.path, documents.join("hippius-captures").to_string_lossy());
        assert_eq!(suggested.place, place_name(&documents.join("hippius-captures"), &home));

        let dir = home.join("Elsewhere/Hippius Captures");
        save_pending(&pool, "5Status", &dir, SetupBlocked::StorageFull).await.unwrap();
        let CaptureDriveStatus::Pending { location, message } = status_for(&pool, "5Status").await.unwrap() else {
            panic!("chosen, not added");
        };
        assert_eq!(location.place, "Elsewhere › Hippius Captures");
        assert!(message.contains("Upgrade your plan"), "{message}");

        let owner = crate::auth::account_key::account_key("5Status");
        sqlx::query("INSERT INTO sync_paths (owner, path, type, label, is_paused, timestamp) VALUES (?, ?, 'private', 'Hippius Captures', 1, 0)")
            .bind(&owner)
            .bind(dir.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        destination::save(&pool, "5Status", &CaptureDestination::own("Hippius Captures", "Hippius Captures"))
            .await
            .unwrap();
        let CaptureDriveStatus::Ready { label, remote, location, .. } = status_for(&pool, "5Status").await.unwrap() else {
            panic!("the drive exists");
        };
        assert_eq!(label, "Hippius Captures");
        assert!(!remote, "a paused drive is still browsed here");
        assert_eq!(location.unwrap().place, "Elsewhere › Hippius Captures");

        // Moved into a folder of that drive: the folder is what is shown.
        let inside = CaptureDestination {
            folder: "Shots/hippius-captures".into(),
            ..CaptureDestination::own("Hippius Captures", "Hippius Captures")
        };
        destination::save(&pool, "5Status", &inside).await.unwrap();
        let CaptureDriveStatus::Ready { folder, location, .. } = status_for(&pool, "5Status").await.unwrap() else {
            panic!("the drive exists");
        };
        assert_eq!(folder, "Shots/hippius-captures");
        assert_eq!(location.unwrap().place, "Elsewhere › Hippius Captures › Shots › hippius-captures");
    }
}
