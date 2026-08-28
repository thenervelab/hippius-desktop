//! Per-label gate for the "Folder Restored" notification.
//!
//! ## What the event means
//!
//! hcfs-client runs `check_and_recover_remote_folder` at the top of EVERY
//! sync cycle. For an OWN drive whose folder is absent from the server
//! listing it re-registers the folder, deletes the local `sync_state.json`
//! baseline, and emits `SyncEvent::FolderRecovered`. Because that baseline is
//! what the engine's `SuspiciousEmptyRemote` mass-delete guard is anchored
//! on, the next plan then classifies the whole tree as new uploads — so the
//! user is about to pay to re-upload the drive and deserves to be told.
//!
//! ## Why the raw event cannot be notified on directly
//!
//! Two distinct situations produce it, and only one is worth a notification.
//!
//! 1. **A genuine restore.** The folder existed on the server and vanished —
//!    in practice, deleted from the web console while this device still
//!    synced it. The user needs to know their delete was undone.
//!
//! 2. **A brand-new folder losing a race.** `initialize_sync_inner` calls
//!    `register_drive` and starts the sync loop BEFORE its
//!    `spawn_folder_registration` (a detached `tokio::spawn`) has reached the
//!    server. The loop's first `trigger_sync` therefore runs the folder check
//!    against a listing that does not contain the folder yet, takes the same
//!    own-drive branch, and reports `Recovered`. Nothing was restored — the
//!    registration simply had not landed. `spawn_folder_registration` also
//!    swallows a failed registration with only a `warn!`, so any transient
//!    5xx there makes this deterministic rather than a narrow race.
//!
//! Notifying on (2) tells a user who has just added a folder that it "was
//! missing on the server", which is both false and alarming, and it fires on
//! the single most common flow in the product.
//!
//! ## The discriminator
//!
//! A drive that has ever completed a sync has a `sync_state.json` baseline; a
//! brand-new one does not. That file is captured at init
//! (`initialize_sync_inner` → [`Self::arm`]) rather than read when the event
//! arrives, because the recovery DELETES it before emitting — by then both
//! situations look identical on disk.
//!
//! ## Why it is also a latch
//!
//! `run_presync_folder_check` re-emits `FolderRecovered` on every cycle whose
//! listing still lacks the folder, and `ensure_folder_registered` returns
//! `Ok(())` whether or not the folder actually became visible. If the
//! listing lags its own registration, the raw event repeats every cycle.
//! [`Self::take`] therefore CONSUMES the armed flag, so one init yields at
//! most one notification — the same "once per episode, not once per cycle"
//! discipline [`crate::sync::error_notify::ErrorNotifyState`] applies to
//! sustained failures. A later init of the same label re-arms it.
//!
//! KNOWN GAP (under-notification, never spam): a folder added and then
//! deleted from the console within the SAME app run was armed as unsynced at
//! init, so its genuine restore is silent until the next init. The safe
//! direction — a missed notification beats one that fires on every folder
//! add.
//!
//! ## Concurrency
//!
//! The inner `std::sync::Mutex` is locked only for one map operation and
//! every method returns an owned value, so no guard escapes a method or
//! crosses an `.await` (axiom `rust_quality_74`). Mirrors the
//! `ErrorNotifyState` / `PreparingState` composition: owned state behind an
//! `Arc` on [`crate::app_state::AppState`], `&self` methods.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Basename of the engine's local sync baseline inside a drive's config dir.
/// Owned by hcfs-client (`check_and_recover_remote_folder` deletes exactly
/// this file); duplicated here because the desktop must sample its existence
/// before the engine can remove it.
const SYNC_BASELINE_FILE: &str = "sync_state.json";

/// Per-label "a restore notification is owed" flag.
///
/// A label is absent until [`Self::arm`] records an init, and its value is
/// `true` only while a notification is still owed — [`Self::take`] consumes
/// it. Absent and `false` therefore both mean "stay silent", which is the
/// correct default for a label nothing knows about.
pub struct FolderRestoreNotifyState {
    inner: Mutex<HashMap<String, bool>>,
}

impl Default for FolderRestoreNotifyState {
    fn default() -> Self {
        Self::new()
    }
}

impl FolderRestoreNotifyState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Poison is fatal here for the same reason as `ErrorNotifyState`: a panic
    /// while holding the guard means the flag's invariant is already corrupt,
    /// so propagating (axiom `rust_quality_173`) is the correct policy.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, bool>> {
        self.inner.lock().expect("folder-restore-notify mutex poisoned")
    }

    /// Record at init whether `label` had already synced, deciding whether a
    /// later `FolderRecovered` for it may notify.
    ///
    /// Re-arms on every init, so a drive that genuinely recovers, is later
    /// re-initialized, and recovers again notifies both times.
    pub fn arm(&self, label: &str, had_baseline: bool) {
        self.lock().insert(label.to_string(), had_baseline);
    }

    /// Sample the baseline for a drive's config directory. Split from
    /// [`Self::arm`] so the decision itself stays free of filesystem access
    /// and is unit-testable without a real drive layout.
    pub fn baseline_exists(folder_dir: &Path) -> bool {
        folder_dir.join(SYNC_BASELINE_FILE).exists()
    }

    /// Consume `label`'s armed flag: `true` exactly once per init, and only
    /// for a drive that had synced before.
    ///
    /// An unknown label returns `false` — a drive this process never
    /// initialized cannot have had a restore worth reporting.
    pub fn take(&self, label: &str) -> bool {
        let mut g = self.lock();
        match g.get_mut(label) {
            Some(armed) => std::mem::replace(armed, false),
            None => false,
        }
    }

    /// Drop `label` entirely (drive removal / teardown).
    pub fn clear(&self, label: &str) -> bool {
        self.lock().remove(label).is_some()
    }

    /// Drop every label (logout / account switch / `SyncReset`) so one
    /// account's state can never gate another's notification.
    pub fn clear_all(&self) {
        self.lock().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drive_that_had_synced_notifies_once_per_init() {
        let state = FolderRestoreNotifyState::new();
        state.arm("photos", true);

        assert!(state.take("photos"), "the first recovery after an init notifies");
        assert!(
            !state.take("photos"),
            "a re-emitted FolderRecovered in the same episode must stay silent — the engine repeats it every cycle whose listing still lacks the folder"
        );

        state.arm("photos", true);
        assert!(state.take("photos"), "a later init re-arms the notification");
    }

    // The regression this exists for: adding a folder starts the sync loop
    // before the detached folder registration reaches the server, so the first
    // cycle's folder check reports `Recovered` for a folder that was never on
    // the server. Notifying there tells a user who just added a folder that it
    // "was missing on the server".
    #[test]
    fn a_brand_new_drive_never_notifies() {
        let state = FolderRestoreNotifyState::new();
        state.arm("new-folder", false);
        assert!(
            !state.take("new-folder"),
            "a drive with no prior baseline has nothing to restore — the recovery is the registration race, not a console delete"
        );
    }

    #[test]
    fn an_unknown_label_never_notifies() {
        let state = FolderRestoreNotifyState::new();
        assert!(
            !state.take("never-initialized"),
            "a label this process never initialized cannot have had a restore worth reporting"
        );
    }

    #[test]
    fn clear_and_clear_all_disarm() {
        let state = FolderRestoreNotifyState::new();
        state.arm("a", true);
        state.arm("b", true);

        assert!(state.clear("a"));
        assert!(!state.clear("a"), "clearing an absent label reports nothing was tracked");
        assert!(!state.take("a"));

        state.clear_all();
        assert!(!state.take("b"), "clear_all must disarm every label, not just the cleared one");
    }

    #[test]
    fn baseline_exists_tracks_the_engine_state_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(
            !FolderRestoreNotifyState::baseline_exists(dir.path()),
            "a fresh config dir has no baseline"
        );

        std::fs::write(dir.path().join(SYNC_BASELINE_FILE), b"{}").expect("write baseline");
        assert!(
            FolderRestoreNotifyState::baseline_exists(dir.path()),
            "a drive that has synced before has a baseline"
        );
    }
}
