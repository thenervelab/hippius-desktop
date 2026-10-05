//! Per-drive record of a held mass delete, as the large-delete prompt shows it.
//!
//! ## What hcfs reports
//!
//! hcfs-client holds back one side's deletes when a cycle would remove most
//! of a drive (an unmounted or evicted folder scans as empty; a truncated
//! listing omits files). The cycle still succeeds, and the runner emits
//! `SyncEvent::MassDeleteHeld { side, count, synced_count }` on EVERY cycle
//! while the hold stands. A requested restore is reported once by the cycle
//! that applies it (`MassDeleteRestored`), or refused on every cycle until it
//! fits (`MassDeleteRestoreRefused`, followed by the hold again). All of them
//! arrive before that cycle's first `SyncCompleted`; every successful cycle
//! emits `SyncStarted` first and `SyncCompleted` last (twice when it skipped
//! conflicts), and rewrites hcfs's own held
//! record (`mass_delete_held.json`), so "the cycle completed without a hold
//! for this side" is exactly "the hold is over".
//!
//! ## What this state adds
//!
//! - **Change-only emits.** The UI and the log need the hold once, and again
//!   only when it changes; per-cycle repeats are absorbed here
//!   ([`HeldChange::Unchanged`]).
//! - **One notification per episode.** An episode starts when a side becomes
//!   held and ends when the hold clears or is restored; the latch is the
//!   side's `notified` flag. A hold seeded from disk at init counts as
//!   already notified, so relaunching the app does not notify again.
//! - **The hold as the commands validate it.** `restore_mass_delete` /
//!   `confirm_mass_delete` check the side and count the user was shown
//!   against [`MassDeleteHoldState::entry`]. hcfs's own confirm does not
//!   compare the count at all, so this check is what stops a stale dialog
//!   from releasing a hold that has grown since.
//! - **Folder restores owed.** The engine plans files only; the desktop's
//!   folder job puts empty folders back itself, once per applied restore
//!   (see `folder_entries_materialize`). The flag is set only when files were
//!   actually restored, never on a refusal.
//!
//! ## Cycle bookkeeping
//!
//! [`MassDeleteHoldState::begin_cycle`] (on `SyncStarted`) opens the cycle
//! and marks every side unseen; a hold or restore event marks its side seen;
//! [`MassDeleteHoldState::finish_cycle`] (on the cycle's first
//! `SyncCompleted`) closes it, dropping every side still unseen and
//! reporting it as cleared. A further `SyncCompleted` for the same cycle
//! (hcfs sends two when a cycle skipped conflicts) finds it closed and
//! clears nothing. A `Restoring` side is kept
//! for one cycle, mirroring hcfs, which keeps a restored side in its held
//! record until the next cycle completes.
//!
//! ## Concurrency
//!
//! One `std::sync::Mutex` locked for a single map operation per call; every
//! method returns owned values, and the bridge calling them is synchronous,
//! so no guard crosses an `.await`.

use hcfs_client::sync::{HeldMassDelete, HoldState, MassDeleteSide};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// What a recorded hold is waiting for. Desktop copy of hcfs's
/// `HoldState`, which is `#[non_exhaustive]`: an unknown future state is
/// read as `Held`, the fail-closed direction for every gate keyed on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldPhase {
    /// The deletes wait for the user to restore or remove them.
    Held,
    /// The last completed cycle restored these files; kept until the next
    /// cycle completes.
    Restoring,
}

impl HoldPhase {
    /// Stable snake_case wire name, as hcfs spells `HoldState`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Held => "held",
            Self::Restoring => "restoring",
        }
    }
}

impl From<HoldState> for HoldPhase {
    fn from(state: HoldState) -> Self {
        match state {
            HoldState::Restoring => Self::Restoring,
            _ => Self::Held,
        }
    }
}

/// One side's hold as the user is shown it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldEntry {
    /// Held, or restored by the last cycle.
    pub phase: HoldPhase,
    /// How many files the hold covers.
    pub count: usize,
    /// The synced baseline the count was measured against.
    pub synced_count: usize,
    /// The drive folder has no visible entries: the shape of a disconnected
    /// disk or an evicted cloud folder. Only ever true for the server side.
    pub empty_root: bool,
}

/// A hold, with the drive and side it belongs to, as hydration returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabeledHold {
    /// The drive label.
    pub label: String,
    /// Which copies the held deletes would remove.
    pub side: MassDeleteSide,
    /// The hold itself.
    pub entry: HoldEntry,
    /// Whether this account may restore it (a shared-drive member cannot
    /// restore a local-side hold).
    pub can_restore: bool,
}

/// What recording a `MassDeleteHeld` changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldChange {
    /// The same hold as last cycle: nothing to emit or log.
    Unchanged,
    /// New or different: emit it. `notify` is true once per episode.
    Changed {
        /// Raise the persisted notification for this episode.
        notify: bool,
    },
}

/// Which sides of a drive owe their empty folders a restore.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FolderRestores {
    /// Files missing here were downloaded back: recreate the empty folders
    /// the server still has.
    pub server: bool,
    /// Files missing from the server were uploaded back: re-register the
    /// empty folders this device still has.
    pub local: bool,
}

impl FolderRestores {
    /// Whether any side owes a restore.
    #[must_use]
    pub fn any(self) -> bool {
        self.server || self.local
    }
}

/// Per-side bookkeeping. `entry` is what the UI shows; the rest is latch
/// state that lives exactly as long as the episode (except `folder_restore`,
/// which outlives it until the folder job consumes it).
#[derive(Debug, Default)]
struct SideSlot {
    /// The current hold, if any.
    entry: Option<HoldEntry>,
    /// The episode's notification has been raised.
    notified: bool,
    /// A hold or restore event for this side arrived in the current cycle.
    seen: bool,
    /// The refusal reason last emitted in this episode.
    refused: Option<String>,
    /// An applied restore whose empty folders the folder job still owes.
    folder_restore: bool,
}

impl SideSlot {
    /// End the episode, keeping only what outlives it.
    fn end_episode(&mut self) {
        self.entry = None;
        self.notified = false;
        self.refused = None;
    }
}

/// Everything recorded for one drive label.
#[derive(Debug, Default)]
struct LabelHolds {
    /// Shared-drive member drive (armed at init).
    member: bool,
    /// The drive folder (armed at init), for the empty-root check.
    sync_root: Option<PathBuf>,
    /// A cycle has started and not yet completed. hcfs can complete one
    /// cycle twice (see [`MassDeleteHoldState::finish_cycle`]); only the
    /// first completion may clear anything.
    cycle_open: bool,
    /// Deletes of the server copies (files missing here).
    server: SideSlot,
    /// Deletes of this device's copies (files missing from the server).
    local: SideSlot,
}

impl LabelHolds {
    fn slot(&self, side: MassDeleteSide) -> &SideSlot {
        match side {
            MassDeleteSide::Server => &self.server,
            MassDeleteSide::Local => &self.local,
        }
    }

    fn slot_mut(&mut self, side: MassDeleteSide) -> &mut SideSlot {
        match side {
            MassDeleteSide::Server => &mut self.server,
            MassDeleteSide::Local => &mut self.local,
        }
    }

    fn can_restore(&self, side: MassDeleteSide) -> bool {
        !(self.member && side == MassDeleteSide::Local)
    }
}

/// Both sides, in a fixed order, for iteration.
const SIDES: [MassDeleteSide; 2] = [MassDeleteSide::Server, MassDeleteSide::Local];

/// Per-label held mass deletes. See the module docs.
#[derive(Debug, Default)]
pub struct MassDeleteHoldState {
    inner: Mutex<HashMap<String, LabelHolds>>,
}

impl MassDeleteHoldState {
    /// An empty state.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Poison is fatal, as for the sibling latches: a panic under the guard
    /// means the episode bookkeeping is already corrupt.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, LabelHolds>> {
        self.inner.lock().expect("mass-delete-hold mutex poisoned")
    }

    /// Record a drive's init: whether it is a shared-drive member drive, its
    /// folder, and the holds hcfs recorded on disk (so the prompt shows
    /// before the first cycle, and survives a relaunch).
    ///
    /// Seeded holds count as already notified: the user was told when the
    /// episode began, possibly in an earlier run. A pending folder restore
    /// is kept across a re-init (pause and resume between the restore and
    /// the folder job would otherwise lose it).
    pub fn arm(&self, label: &str, member: bool, sync_root: &Path, seed: &[HeldMassDelete]) {
        let mut map = self.lock();
        let holds = map.entry(label.to_string()).or_default();
        holds.member = member;
        holds.sync_root = Some(sync_root.to_path_buf());

        for side in SIDES {
            let slot = holds.slot_mut(side);
            slot.end_episode();
            slot.seen = false;
            if let Some(held) = seed.iter().find(|h| h.side == side) {
                slot.entry = Some(HoldEntry {
                    phase: held.state.into(),
                    count: held.count,
                    synced_count: held.synced_count,
                    empty_root: false,
                });
                slot.notified = true;
            }
        }
    }

    /// The drive folder recorded at init, for the empty-root check.
    #[must_use]
    pub fn sync_root(&self, label: &str) -> Option<PathBuf> {
        self.lock().get(label).and_then(|h| h.sync_root.clone())
    }

    /// Whether `label` was armed as a shared-drive member drive.
    #[must_use]
    pub fn is_member(&self, label: &str) -> bool {
        self.lock().get(label).is_some_and(|h| h.member)
    }

    /// A cycle started: every side is unseen until an event reports it.
    pub fn begin_cycle(&self, label: &str) {
        let mut map = self.lock();
        let holds = map.entry(label.to_string()).or_default();
        holds.cycle_open = true;
        holds.server.seen = false;
        holds.local.seen = false;
    }

    /// Record a `MassDeleteHeld`, reporting whether it changed anything.
    pub fn record_held(&self, label: &str, side: MassDeleteSide, count: usize, synced_count: usize, empty_root: bool) -> HeldChange {
        let entry = HoldEntry {
            phase: HoldPhase::Held,
            count,
            synced_count,
            empty_root,
        };

        let mut map = self.lock();
        let slot = map.entry(label.to_string()).or_default().slot_mut(side);
        slot.seen = true;
        if slot.entry == Some(entry) {
            return HeldChange::Unchanged;
        }

        // A side that was restoring and is held again is a new episode.
        if slot.entry.is_some_and(|e| e.phase == HoldPhase::Restoring) {
            slot.end_episode();
        }
        slot.entry = Some(entry);
        let notify = !std::mem::replace(&mut slot.notified, true);
        HeldChange::Changed { notify }
    }

    /// Record a `MassDeleteRestored`: the side is restoring until the next
    /// cycle completes, and the episode is over. Owes the folder job a
    /// restore only when files were actually put back.
    pub fn record_restored(&self, label: &str, side: MassDeleteSide, restored: usize, total: usize) {
        let mut map = self.lock();
        let slot = map.entry(label.to_string()).or_default().slot_mut(side);
        let previous = slot.entry;

        slot.end_episode();
        slot.seen = true;
        slot.entry = Some(HoldEntry {
            phase: HoldPhase::Restoring,
            count: previous.map_or(total, |e| e.count),
            synced_count: previous.map_or(0, |e| e.synced_count),
            empty_root: false,
        });
        if restored > 0 {
            slot.folder_restore = true;
        }
    }

    /// Record a `MassDeleteRestoreRefused`, reporting whether this reason is
    /// new for the episode. hcfs repeats a refusal every cycle until the
    /// files fit; only the first (or a different reason) is worth an emit.
    pub fn record_refused(&self, label: &str, side: MassDeleteSide, reason: &str) -> bool {
        let mut map = self.lock();
        let slot = map.entry(label.to_string()).or_default().slot_mut(side);
        slot.seen = true;
        if slot.refused.as_deref() == Some(reason) {
            return false;
        }
        slot.refused = Some(reason.to_string());
        true
    }

    /// A cycle completed: drop every side no event reported this cycle and
    /// return those that had a hold (the cleared ones).
    ///
    /// Acts once per [`Self::begin_cycle`]. hcfs emits `SyncCompleted` twice
    /// for a cycle that skipped conflicts (once from the conflict re-stage,
    /// again from the result dispatch, both after the hold events), and a
    /// second pass over sides it had just marked unseen would clear a hold
    /// that still stands. A completion with no cycle open clears nothing.
    pub fn finish_cycle(&self, label: &str) -> Vec<MassDeleteSide> {
        let mut map = self.lock();
        let Some(holds) = map.get_mut(label) else {
            return Vec::new();
        };
        if !std::mem::replace(&mut holds.cycle_open, false) {
            return Vec::new();
        }

        let mut cleared = Vec::new();
        for side in SIDES {
            let slot = holds.slot_mut(side);
            if !slot.seen && slot.entry.is_some() {
                slot.end_episode();
                cleared.push(side);
            }
            slot.seen = false;
        }
        cleared
    }

    /// The current hold on `label`'s `side`, if any.
    #[must_use]
    pub fn entry(&self, label: &str, side: MassDeleteSide) -> Option<HoldEntry> {
        self.lock().get(label).and_then(|h| h.slot(side).entry)
    }

    /// Whether this account may restore `label`'s `side`.
    #[must_use]
    pub fn can_restore(&self, label: &str, side: MassDeleteSide) -> bool {
        self.lock().get(label).is_none_or(|h| h.can_restore(side))
    }

    /// Every current hold, sorted by label then side, for UI hydration.
    #[must_use]
    pub fn all(&self) -> Vec<LabeledHold> {
        let map = self.lock();
        let mut holds: Vec<LabeledHold> = map
            .iter()
            .flat_map(|(label, holds)| {
                SIDES.into_iter().filter_map(move |side| {
                    holds.slot(side).entry.map(|entry| LabeledHold {
                        label: label.clone(),
                        side,
                        entry,
                        can_restore: holds.can_restore(side),
                    })
                })
            })
            .collect();
        holds.sort_by(|a, b| (a.label.as_str(), a.side.as_str()).cmp(&(b.label.as_str(), b.side.as_str())));
        holds
    }

    /// The folder restores `label` owes, without consuming them: the folder
    /// job acknowledges with [`Self::ack_folder_restores`] only once it has
    /// applied them, so a failed run retries.
    #[must_use]
    pub fn folder_restores(&self, label: &str) -> FolderRestores {
        self.lock().get(label).map_or_else(FolderRestores::default, |h| FolderRestores {
            server: h.server.folder_restore,
            local: h.local.folder_restore,
        })
    }

    /// Mark the given folder restores done.
    pub fn ack_folder_restores(&self, label: &str, done: FolderRestores) {
        if let Some(holds) = self.lock().get_mut(label) {
            if done.server {
                holds.server.folder_restore = false;
            }
            if done.local {
                holds.local.folder_restore = false;
            }
        }
    }

    /// Forget `label` entirely (drive removal).
    pub fn clear(&self, label: &str) {
        self.lock().remove(label);
    }

    /// Forget every label (logout, account switch, `SyncReset`): the labels
    /// belong to the previous account.
    pub fn clear_all(&self) {
        self.lock().clear();
    }
}

/// Read the holds hcfs recorded for a drive, without the drive's lock.
///
/// A throwaway `Drive` over the same config directory reads what the syncing
/// one wrote (`Drive::held_mass_deletes`: no unlock, no client). Off the
/// async workers: the record lists every held file id, so a large hold is a
/// multi-megabyte JSON parse.
///
/// # Errors
///
/// An unreadable or corrupt record, which callers gating on it must treat
/// as held (fail closed); or the blocking task failing to join.
pub async fn read_recorded_holds(sync_root: PathBuf, config_dir: PathBuf) -> std::result::Result<Vec<HeldMassDelete>, String> {
    tokio::task::spawn_blocking(move || {
        hcfs_client::drive::Drive::with_config_dir(&sync_root, &config_dir)
            .held_mass_deletes()
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("held mass delete read task failed: {e}"))?
}

/// Whether `root` has no visible entries: the empty-root shape of a
/// disconnected disk or an evicted cloud folder. Dot-entries (`.DS_Store`,
/// a cloud provider's markers) do not count. An unreadable root reads as
/// not empty, so the extra "reconnect" advice is only given when true.
#[must_use]
pub fn root_looks_empty(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    !entries.flatten().any(|e| !e.file_name().to_string_lossy().starts_with('.'))
}

/// What the user's machine is called in copy.
const THIS_DEVICE: &str = if cfg!(target_os = "macos") { "this Mac" } else { "this computer" };

/// The persisted notification's text for a new hold. Rust owns it so the
/// side, the empty-root advice and the member caveat cannot drift from the
/// state that decides them.
#[must_use]
pub fn held_notification_text(label: &str, side: MassDeleteSide, entry: HoldEntry, can_restore: bool) -> String {
    match side {
        MassDeleteSide::Server => {
            let reconnect = if entry.empty_root {
                " If an external disk or cloud folder is disconnected, reconnect it."
            } else {
                ""
            };
            format!(
                "In \"{label}\", {} of {} files are missing from {THIS_DEVICE}. Nothing has been deleted from Hippius yet.{reconnect}",
                entry.count, entry.synced_count
            )
        }
        MassDeleteSide::Local => {
            let caveat = if can_restore {
                ""
            } else {
                " Only the owner of this shared drive can put them back."
            };
            format!(
                "In \"{label}\", {} files are missing from Hippius. Nothing has been deleted from {THIS_DEVICE} yet.{caveat}",
                entry.count
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use MassDeleteSide::{Local, Server};

    const L: &str = "photos";

    fn held(side: MassDeleteSide, state: HoldState, count: usize) -> HeldMassDelete {
        HeldMassDelete {
            side,
            state,
            count,
            synced_count: 200,
            held_at: 1,
        }
    }

    /// One cycle reporting `events` (each a closure over the state).
    fn cycle(state: &MassDeleteHoldState, events: impl FnOnce(&MassDeleteHoldState)) -> Vec<MassDeleteSide> {
        state.begin_cycle(L);
        events(state);
        state.finish_cycle(L)
    }

    #[test]
    fn a_repeated_hold_is_emitted_and_notified_once() {
        let state = MassDeleteHoldState::new();
        state.arm(L, false, Path::new("/x"), &[]);

        state.begin_cycle(L);
        assert_eq!(state.record_held(L, Server, 150, 200, false), HeldChange::Changed { notify: true });
        assert!(state.finish_cycle(L).is_empty(), "a side held this cycle is not cleared");

        state.begin_cycle(L);
        assert_eq!(
            state.record_held(L, Server, 150, 200, false),
            HeldChange::Unchanged,
            "same hold, next cycle"
        );
        assert!(state.finish_cycle(L).is_empty());

        state.begin_cycle(L);
        assert_eq!(
            state.record_held(L, Server, 160, 200, false),
            HeldChange::Changed { notify: false },
            "a changed count is emitted but the episode already notified"
        );
        assert_eq!(state.entry(L, Server).map(|e| e.count), Some(160));
    }

    #[test]
    fn a_cycle_without_the_hold_clears_it_and_starts_a_new_episode() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| {
            s.record_held(L, Local, 120, 200, false);
        });

        assert_eq!(cycle(&state, |_| {}), vec![Local], "the hold is reported cleared once");
        assert_eq!(state.entry(L, Local), None);
        assert!(cycle(&state, |_| {}).is_empty(), "nothing left to clear");

        state.begin_cycle(L);
        assert_eq!(
            state.record_held(L, Local, 120, 200, false),
            HeldChange::Changed { notify: true },
            "a hold after a cleared one is a new episode"
        );
    }

    /// hcfs completes a cycle that skipped conflicts twice: once from the
    /// conflict re-stage and again from its result dispatch. Only the first
    /// completion closes the cycle; the second must not read the hold as
    /// unreported and clear it.
    #[test]
    fn a_second_completion_of_one_cycle_keeps_the_hold() {
        let state = MassDeleteHoldState::new();
        state.arm(L, false, Path::new("/x"), &[]);

        state.begin_cycle(L);
        assert_eq!(state.record_held(L, Server, 150, 200, false), HeldChange::Changed { notify: true });
        assert!(state.finish_cycle(L).is_empty());
        assert!(state.finish_cycle(L).is_empty(), "the repeated completion clears nothing");
        assert!(state.entry(L, Server).is_some(), "the hold stands");

        state.begin_cycle(L);
        assert_eq!(
            state.record_held(L, Server, 150, 200, false),
            HeldChange::Unchanged,
            "the episode was not ended, so it does not notify again"
        );
    }

    #[test]
    fn a_completion_without_a_start_clears_nothing() {
        let state = MassDeleteHoldState::new();
        state.arm(L, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        assert!(state.finish_cycle(L).is_empty(), "no cycle is open, so nothing went unreported");
        assert!(state.entry(L, Server).is_some());
    }

    #[test]
    fn sides_are_tracked_apart() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| {
            s.record_held(L, Server, 150, 200, true);
            s.record_held(L, Local, 110, 200, false);
        });

        let cleared = cycle(&state, |s| {
            s.record_held(L, Server, 150, 200, true);
        });
        assert_eq!(cleared, vec![Local]);
        assert!(state.entry(L, Server).is_some());
    }

    #[test]
    fn a_restore_restores_for_one_cycle_then_clears() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| {
            s.record_held(L, Server, 150, 200, false);
        });

        assert!(cycle(&state, |s| s.record_restored(L, Server, 150, 150)).is_empty());
        let entry = state.entry(L, Server).expect("restoring side is kept");
        assert_eq!(entry.phase, HoldPhase::Restoring);
        assert_eq!(entry.count, 150);

        assert_eq!(cycle(&state, |_| {}), vec![Server], "the next completed cycle ends it");
    }

    #[test]
    fn a_hold_after_a_restore_notifies_again() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| {
            s.record_held(L, Server, 150, 200, false);
        });
        cycle(&state, |s| s.record_restored(L, Server, 150, 150));

        state.begin_cycle(L);
        assert_eq!(state.record_held(L, Server, 150, 200, false), HeldChange::Changed { notify: true });
    }

    #[test]
    fn a_refusal_is_reported_once_per_episode_and_keeps_the_hold() {
        let state = MassDeleteHoldState::new();
        state.begin_cycle(L);
        assert!(state.record_refused(L, Server, "insufficient_space"));
        state.record_held(L, Server, 150, 200, false);
        state.finish_cycle(L);

        state.begin_cycle(L);
        assert!(!state.record_refused(L, Server, "insufficient_space"), "repeated every cycle by hcfs");
        assert_eq!(state.record_held(L, Server, 150, 200, false), HeldChange::Unchanged);
        assert!(state.finish_cycle(L).is_empty());
        assert_eq!(state.folder_restores(L), FolderRestores::default(), "a refusal restores no folders");

        state.begin_cycle(L);
        state.finish_cycle(L);
        state.begin_cycle(L);
        assert!(state.record_refused(L, Server, "insufficient_space"), "a new episode reports it again");
    }

    #[test]
    fn only_a_restore_that_put_files_back_owes_folders() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| s.record_restored(L, Local, 0, 40));
        assert_eq!(state.folder_restores(L), FolderRestores::default());

        cycle(&state, |s| s.record_restored(L, Local, 3, 40));
        assert_eq!(state.folder_restores(L), FolderRestores { server: false, local: true });

        state.ack_folder_restores(L, FolderRestores { server: false, local: true });
        assert!(!state.folder_restores(L).any());
    }

    #[test]
    fn a_folder_restore_outlives_the_episode_and_a_re_init() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| s.record_restored(L, Server, 10, 10));
        cycle(&state, |_| {});
        state.arm(L, false, Path::new("/x"), &[]);
        assert!(state.folder_restores(L).server, "consumed only by the folder job");
    }

    #[test]
    fn a_seeded_hold_is_shown_but_not_notified_again() {
        let state = MassDeleteHoldState::new();
        state.arm(L, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        assert_eq!(state.entry(L, Server).map(|e| e.phase), Some(HoldPhase::Held));

        state.begin_cycle(L);
        assert_eq!(
            state.record_held(L, Server, 150, 200, true),
            HeldChange::Changed { notify: false },
            "the empty-root check fills in, but the episode was notified when it began"
        );
    }

    #[test]
    fn a_member_cannot_restore_the_local_side() {
        let state = MassDeleteHoldState::new();
        state.arm(
            L,
            true,
            Path::new("/x"),
            &[held(Local, HoldState::Held, 120), held(Server, HoldState::Restoring, 130)],
        );
        assert!(!state.can_restore(L, Local));
        assert!(state.can_restore(L, Server));

        let all = state.all();
        assert_eq!(all.len(), 2);
        assert_eq!((all[0].side, all[0].can_restore), (Local, false));
        assert_eq!((all[1].side, all[1].entry.phase), (Server, HoldPhase::Restoring));
    }

    #[test]
    fn clear_and_clear_all_forget_everything() {
        let state = MassDeleteHoldState::new();
        cycle(&state, |s| {
            s.record_held(L, Server, 150, 200, false);
            s.record_restored("other", Local, 5, 5);
        });

        state.clear(L);
        assert_eq!(state.entry(L, Server), None);
        assert!(state.entry("other", Local).is_some());

        state.clear_all();
        assert!(state.all().is_empty());
        assert!(!state.folder_restores("other").any());
    }

    #[test]
    fn root_looks_empty_ignores_dot_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(root_looks_empty(dir.path()));

        std::fs::write(dir.path().join(".DS_Store"), b"").expect("write");
        assert!(root_looks_empty(dir.path()), "Finder metadata is not user content");

        std::fs::write(dir.path().join("a.txt"), b"").expect("write");
        assert!(!root_looks_empty(dir.path()));
        assert!(!root_looks_empty(&dir.path().join("missing")), "unreadable is not called empty");
    }

    #[test]
    fn notification_copy_follows_the_side() {
        let entry = HoldEntry {
            phase: HoldPhase::Held,
            count: 150,
            synced_count: 200,
            empty_root: true,
        };

        let server = held_notification_text("Photos", Server, entry, true);
        assert!(server.contains("150 of 200 files are missing from"));
        assert!(server.contains("Nothing has been deleted from Hippius yet."));
        assert!(server.contains("reconnect it"));

        let local = held_notification_text("Photos", Local, entry, false);
        assert!(local.contains("150 files are missing from Hippius."));
        assert!(!local.contains("reconnect"), "the empty-root advice is about this device's folder");
        assert!(local.contains("Only the owner"));
    }
}
