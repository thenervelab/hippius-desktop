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
//!   ([`HeldChange::Unchanged`]). A change is recorded on the bridge's
//!   thread and settled off it ([`MassDeleteHoldState::settle_held`]),
//!   because the empty-root check reads the drive folder.
//! - **One notification per episode.** An episode starts when a side becomes
//!   held and ends when the hold clears or is restored; the latch is the
//!   side's `notified` flag, and the first settle of the episode raises it,
//!   for the account the drive was armed for (the bridge saves it).
//!   A hold seeded from disk at init counts as already notified, so a
//!   relaunch or a pause and resume does not notify again (see
//!   [`MassDeleteHoldState::arm`]).
//! - **The hold as the commands validate it.** `restore_mass_delete` /
//!   `confirm_mass_delete` check the side and count the user was shown
//!   against [`MassDeleteHoldState::entry`]. hcfs's own confirm does not
//!   compare the count at all, so this check is what stops a stale dialog
//!   from releasing a hold that has grown since.
//! - **An answer that did not take.** An accepted answer shows as under way
//!   in the UI until an event moves it on; when the first cycle after it
//!   reports the same hold, that hold is shown again
//!   ([`MassDeleteHoldState::note_answered`]).
//! - **Folder restores owed.** The engine plans files only; the desktop's
//!   folder job puts empty folders back itself, once per applied restore
//!   (see `folder_entries_materialize`). The flag is set by every applied
//!   restore, whatever its counts, and never by a refusal. It is a
//!   generation counter, so the job's ack covers only the restores it read
//!   ([`OwedFolderRestores`]).
//!
//! ## Cycle bookkeeping
//!
//! [`MassDeleteHoldState::begin_cycle`] (on `SyncStarted`, or when a reviewed
//! sync starts) opens the cycle and marks every side unseen; a hold or
//! restore event marks its side seen; [`MassDeleteHoldState::finish_cycle`]
//! (on the cycle's first `SyncCompleted`, or the reviewed sync's end) closes
//! it, dropping every side still unseen and reporting it as cleared. A
//! further `SyncCompleted` for the same cycle (hcfs sends two when a cycle
//! skipped conflicts) finds it closed and clears nothing. A cycle is closed
//! only by the path that opened it ([`CycleSource`]): an engine completion
//! still on its way when a reviewed sync starts must not close the reviewed
//! cycle before its results are recorded. A `Restoring` side is kept
//! for one cycle, mirroring hcfs, which keeps a restored side in its held
//! record until the next cycle completes.
//!
//! ## Concurrency
//!
//! One `std::sync::Mutex` locked for a single map operation per call; every
//! method returns owned values, and none is async, so no guard crosses an
//! `.await`. [`MassDeleteHoldState::settle_held`] calls its `emit` under
//! the lock on purpose (ordering against a clear; see there).

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

/// One `MassDeleteHeld` report, as hcfs sends it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeldReport {
    /// Which copies the held deletes would remove.
    pub side: MassDeleteSide,
    /// How many files the hold covers.
    pub count: usize,
    /// The synced baseline the count was measured against.
    pub synced_count: usize,
}

/// What recording a `MassDeleteHeld` changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldChange {
    /// The same hold as last cycle, already shown: nothing to emit or log.
    Unchanged,
    /// New, different, or not yet shown: check the drive folder and settle
    /// it ([`MassDeleteHoldState::settle_held`]).
    Changed,
    /// New or different, but a settle for this side is already running and
    /// shows the side's hold as it stands when it finishes: start no other.
    Settling,
}

/// Which path opened a hold cycle; only the same path may close it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CycleSource {
    /// The sync engine's own cycle (`SyncStarted` .. `SyncCompleted`).
    Engine,
    /// A reviewed-conflict sync (`sync_with_conflict_resolutions`), whose
    /// results arrive on its outcome rather than as engine events.
    Reviewed,
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

/// The folder restores a drive owes, as the folder job read them.
///
/// Carries the generation of the latest applied restore per side, so the
/// job's acknowledgement covers exactly what it read: a restore recorded
/// while the job was fetching the server set has a later generation and
/// stays owed for the next run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OwedFolderRestores {
    /// Generation owed for the server side; 0 when nothing is owed.
    server: u64,
    /// Generation owed for the local side; 0 when nothing is owed.
    local: u64,
}

impl OwedFolderRestores {
    /// Which sides are owed.
    #[must_use]
    pub fn sides(self) -> FolderRestores {
        FolderRestores {
            server: self.server > 0,
            local: self.local > 0,
        }
    }

    /// Whether any side is owed.
    #[must_use]
    pub fn any(self) -> bool {
        self.sides().any()
    }
}

/// Where an answer to a side's hold stands, from the UI's point of view.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum AnswerCheck {
    /// No answer waiting to be checked.
    #[default]
    Idle,
    /// Answered; no cycle has started since.
    Answered,
    /// A cycle started after the answer: if it reports the hold, the answer
    /// was not applied, and the hold is shown again.
    Due,
}

/// Per-side bookkeeping. `entry` is what the UI shows; the rest is latch
/// state that lives exactly as long as the episode (except the folder
/// restore generations, which outlive it until the folder job acks them).
#[derive(Debug, Default)]
struct SideSlot {
    /// The current hold, if any.
    entry: Option<HoldEntry>,
    /// The episode's notification has been claimed.
    notified: bool,
    /// The episode's notification is claimed but not yet raised: the next
    /// successful [`MassDeleteHoldState::settle_held`] raises it.
    notify_pending: bool,
    /// The current `entry` has been settled (empty-root checked and shown).
    settled: bool,
    /// A settle (the blocking empty-root check) is running for this side.
    /// Outlives an episode end: the task is still running, and it settles
    /// whatever hold the side has when it finishes.
    settling: bool,
    /// A hold or restore event for this side arrived in the current cycle.
    seen: bool,
    /// The refusal reason last emitted in this episode.
    refused: Option<String>,
    /// Where an answer the user sent stands; see
    /// [`MassDeleteHoldState::note_answered`].
    answer: AnswerCheck,
    /// Generation of the latest applied restore (0: none yet). Bumped by
    /// every `MassDeleteRestored`.
    restores_applied: u64,
    /// The latest generation whose folders the folder job has put back.
    /// Owed while below `restores_applied`.
    restores_done: u64,
}

impl SideSlot {
    /// The generation the folder job owes, or 0.
    fn owed_restore(&self) -> u64 {
        if self.restores_applied > self.restores_done {
            self.restores_applied
        } else {
            0
        }
    }

    /// Acknowledge every generation up to `generation`; a later one stays
    /// owed.
    fn ack_restore(&mut self, generation: u64) {
        self.restores_done = self.restores_done.max(generation);
    }

    /// End the episode, keeping only what outlives it.
    fn end_episode(&mut self) {
        self.entry = None;
        self.notified = false;
        self.notify_pending = false;
        self.settled = false;
        self.refused = None;
        self.answer = AnswerCheck::Idle;
    }

    /// Whether the current entry is the hold `report` describes.
    fn holds(&self, report: HeldReport) -> bool {
        self.entry
            .is_some_and(|e| e.phase == HoldPhase::Held && e.count == report.count && e.synced_count == report.synced_count)
    }
}

/// Everything recorded for one drive label.
#[derive(Debug, Default)]
struct LabelHolds {
    /// The account whose drive this is (armed at init): the episode's
    /// notification is saved for it.
    owner: Option<String>,
    /// Shared-drive member drive (armed at init).
    member: bool,
    /// The drive folder (armed at init), for the empty-root check.
    sync_root: Option<PathBuf>,
    /// The cycle started and not yet completed, and which path opened it.
    /// hcfs can complete one cycle twice (see
    /// [`MassDeleteHoldState::finish_cycle`]); only the first completion
    /// from the same path may clear anything.
    cycle_open: Option<CycleSource>,
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

/// Re-seed one side at init from hcfs's record (see
/// [`MassDeleteHoldState::arm`]).
fn seed_slot(slot: &mut SideSlot, seeded: Option<&HeldMassDelete>) {
    let notify_pending = slot.notify_pending;
    let was_restoring = slot.entry.is_some_and(|e| e.phase == HoldPhase::Restoring);
    slot.end_episode();
    slot.seen = false;
    let Some(held) = seeded else {
        return;
    };

    let phase = HoldPhase::from(held.state);
    if phase == HoldPhase::Restoring && !was_restoring {
        slot.restores_applied += 1;
    }
    slot.notify_pending = notify_pending;
    slot.entry = Some(HoldEntry {
        phase,
        count: held.count,
        synced_count: held.synced_count,
        empty_root: false,
    });
    slot.notified = true;
}

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

    /// Record a drive's init: the account it belongs to, whether it is a
    /// shared-drive member drive, its folder, and the holds hcfs recorded on
    /// disk (so the prompt shows
    /// before the first cycle, and survives a relaunch).
    ///
    /// Seeded holds count as already notified: the user was told when the
    /// episode began, possibly in an earlier run, and a re-init (pause and
    /// resume, a relaunch) is not a new episode. The one exception is a
    /// notification claimed but not yet raised when the re-init came: it is
    /// still raised by the next settle, so the episode is not left silent.
    /// A seeded hold is unsettled, so the first cycle's report checks the
    /// drive folder and shows it again (with the empty-root advice, which
    /// the seed cannot carry). A hold the record no longer has is dropped
    /// without a cleared event: hydration reads the state afresh. A pending
    /// folder restore is kept across a re-init (pause and resume between
    /// the restore and the folder job would otherwise lose it).
    ///
    /// A re-init also closes any cycle the previous drive left open: none of
    /// the seeded holds was reported in it, so its late `SyncCompleted`
    /// would otherwise read them all as cleared.
    ///
    /// A side seeded as `Restoring` that this state did not already record
    /// as restoring owes its folders: hcfs applied that restore in a run
    /// that ended before the folder job put the empty folders back, and the
    /// owed generation lived in that run's memory.
    pub fn arm(&self, label: &str, owner: &str, member: bool, sync_root: &Path, seed: &[HeldMassDelete]) {
        let mut map = self.lock();
        let holds = map.entry(label.to_string()).or_default();
        holds.owner = Some(owner.to_string());
        holds.member = member;
        holds.sync_root = Some(sync_root.to_path_buf());
        holds.cycle_open = None;

        for side in SIDES {
            let seeded = seed.iter().find(|h| h.side == side);
            seed_slot(holds.slot_mut(side), seeded);
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

    /// A cycle started on `source`'s path: every side is unseen until an
    /// event reports it. The latest start wins: a reviewed sync holds the
    /// drive's lock, so an engine start seen after it is stale, and one
    /// seen before it is overtaken.
    pub fn begin_cycle(&self, label: &str, source: CycleSource) {
        let mut map = self.lock();
        let holds = map.entry(label.to_string()).or_default();
        holds.cycle_open = Some(source);
        for side in SIDES {
            let slot = holds.slot_mut(side);
            slot.seen = false;
            if slot.answer == AnswerCheck::Answered {
                slot.answer = AnswerCheck::Due;
            }
        }
    }

    /// Record a `MassDeleteHeld`, reporting whether it needs settling.
    ///
    /// Cheap and synchronous, for the bridge's event thread: it touches no
    /// disk. The empty-root check, the emits and the episode's notification
    /// happen in [`Self::settle_held`], off that thread, and only for a
    /// [`HeldChange::Changed`] report. Until then the entry keeps the last
    /// known empty-root flag (false for a new hold).
    ///
    /// At most one settle runs per side: an unplugged network share can
    /// stall the check, and hcfs keeps reporting the hold every cycle
    /// meanwhile. A report arriving while one runs is recorded and left to
    /// it ([`HeldChange::Settling`]).
    pub fn record_held(&self, label: &str, report: HeldReport) -> HeldChange {
        let mut map = self.lock();
        let slot = map.entry(label.to_string()).or_default().slot_mut(report.side);
        slot.seen = true;
        // Only a cycle that started after the answer can tell it was lost;
        // one already running keeps it waiting.
        let answer_lost = slot.answer == AnswerCheck::Due;
        if answer_lost {
            slot.answer = AnswerCheck::Idle;
        }
        if slot.holds(report) && slot.settled && !answer_lost {
            return HeldChange::Unchanged;
        }

        // A side that was restoring and is held again is a new episode.
        if slot.entry.is_some_and(|e| e.phase == HoldPhase::Restoring) {
            slot.end_episode();
        }
        let empty_root = slot.entry.is_some_and(|e| e.empty_root);
        slot.entry = Some(HoldEntry {
            phase: HoldPhase::Held,
            count: report.count,
            synced_count: report.synced_count,
            empty_root,
        });
        slot.settled = false;
        if !std::mem::replace(&mut slot.notified, true) {
            slot.notify_pending = true;
        }
        if std::mem::replace(&mut slot.settling, true) {
            return HeldChange::Settling;
        }
        HeldChange::Changed
    }

    /// Finish the settle [`Self::record_held`] started for `side`: store the
    /// empty-root check on the side's current hold and hand that hold to
    /// `emit`, with the account to save the episode's notification for when
    /// this settle raises it (the drive's owner, as armed). Returns whether
    /// `emit` ran.
    ///
    /// A drive no init armed has no owner: its notification stays pending
    /// for the first settle after the arm rather than being spent.
    ///
    /// It settles the hold as it stands now, not as it was when the settle
    /// started: reports that arrived meanwhile started no settle of their
    /// own ([`HeldChange::Settling`]), and the folder check is about the
    /// folder, whatever the count. `emit` runs only for an unsettled `Held`
    /// hold: one that cleared, or turned into a restore, must not be shown
    /// as held. It runs under the state's lock,
    /// so a `finish_cycle` that clears this side either happened first (no
    /// emit) or waits until the held event is out, and its cleared event
    /// follows it; the UI never sees a hold after its clear. `emit` must not
    /// call back into this state.
    pub fn settle_held(&self, label: &str, side: MassDeleteSide, empty_root: bool, emit: impl FnOnce(&LabeledHold, Option<&str>)) -> bool {
        let mut map = self.lock();
        let Some(holds) = map.get_mut(label) else {
            return false;
        };
        let can_restore = holds.can_restore(side);
        let owner = holds.owner.clone();
        let slot = holds.slot_mut(side);
        slot.settling = false;
        if slot.settled {
            return false;
        }

        let Some(entry) = slot.entry.as_mut().filter(|e| e.phase == HoldPhase::Held) else {
            return false;
        };
        entry.empty_root = empty_root;
        let entry = *entry;
        slot.settled = true;
        let notify = owner.as_deref().filter(|_| slot.notify_pending);
        if notify.is_some() {
            slot.notify_pending = false;
        }

        let hold = LabeledHold {
            label: label.to_string(),
            side,
            entry,
            can_restore,
        };
        emit(&hold, notify);
        true
    }

    /// Record that the user answered `side`'s hold (restore or remove).
    ///
    /// The prompt shows the answer as under way until an event moves it on,
    /// and hcfs may never send one: a request marker can expire unused, and
    /// one confirmation marker serves both sides, so a second removal
    /// overwrites the first. The next cycle then reports the same hold,
    /// which [`Self::record_held`] would absorb as unchanged. So the first
    /// cycle that STARTS after the answer (hcfs reads its markers when a
    /// cycle starts) and still reports the hold shows it again, which drops
    /// the answer in the UI. A cycle already running when the answer came
    /// does not count.
    pub fn note_answered(&self, label: &str, side: MassDeleteSide) {
        if let Some(holds) = self.lock().get_mut(label) {
            let slot = holds.slot_mut(side);
            if slot.entry.is_some() {
                slot.answer = AnswerCheck::Answered;
            }
        }
    }

    /// Record a `MassDeleteRestored`: the side is restoring until the next
    /// cycle completes, and the episode is over. `total` is every file the
    /// restore covered (restored, pending and skipped).
    ///
    /// Always owes the folder job a restore, whatever the counts: hcfs only
    /// reports a restore it applied (a refusal is a different event), files
    /// still `pending` finish on later cycles, and the empty folders beside
    /// them have no transfer to wait for.
    pub fn record_restored(&self, label: &str, side: MassDeleteSide, total: usize) {
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
        slot.restores_applied += 1;
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

    /// A cycle on `source`'s path completed: drop every side no event
    /// reported this cycle and return those that had a hold (the cleared
    /// ones).
    ///
    /// Acts once per [`Self::begin_cycle`], and only for the path that
    /// opened the cycle. hcfs emits `SyncCompleted` twice for a cycle that
    /// skipped conflicts (once from the conflict re-stage, again from the
    /// result dispatch, both after the hold events), and a second pass over
    /// sides it had just marked unseen would clear a hold that still
    /// stands. An engine completion arriving while a reviewed sync's cycle
    /// is open belongs to an earlier engine cycle, and closing the reviewed
    /// one before its results are recorded would clear its holds. A
    /// completion with no matching cycle open clears nothing.
    pub fn finish_cycle(&self, label: &str, source: CycleSource) -> Vec<MassDeleteSide> {
        let mut map = self.lock();
        let Some(holds) = map.get_mut(label) else {
            return Vec::new();
        };
        if holds.cycle_open != Some(source) {
            return Vec::new();
        }
        holds.cycle_open = None;

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
    pub fn folder_restores(&self, label: &str) -> OwedFolderRestores {
        self.lock().get(label).map_or_else(OwedFolderRestores::default, |h| OwedFolderRestores {
            server: h.server.owed_restore(),
            local: h.local.owed_restore(),
        })
    }

    /// Mark the folder restores the job read as done. A restore recorded
    /// since that read has a later generation and stays owed.
    pub fn ack_folder_restores(&self, label: &str, done: OwedFolderRestores) {
        if let Some(holds) = self.lock().get_mut(label) {
            holds.server.ack_restore(done.server);
            holds.local.ack_restore(done.local);
        }
    }

    /// Forget `label` entirely (drive removal), returning the sides that had
    /// a hold (held or restoring), so the UI can drop their banners.
    #[must_use = "a cleared side's banner stays up unless the UI is told"]
    pub fn clear(&self, label: &str) -> Vec<MassDeleteSide> {
        let Some(holds) = self.lock().remove(label) else {
            return Vec::new();
        };
        SIDES.into_iter().filter(|side| holds.slot(*side).entry.is_some()).collect()
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
/// a cloud provider's markers) do not count.
///
/// A missing root reads as empty too. On unix hcfs refuses a cycle whose
/// root is missing after it held files (`SyncError::RootNotMounted`,
/// before anything is planned, so no hold is reported), and elsewhere the
/// scan of a missing root fails; a hold reported with the root missing is
/// therefore a disk removed during the cycle, and the reconnect advice is
/// right. Any other unreadable root reads as not empty, so the advice is
/// only given on evidence.
///
/// Blocking: an unplugged network share can stall `read_dir`, so callers
/// run it off the async workers and the bridge's event thread.
#[must_use]
pub fn root_looks_empty(root: &Path) -> bool {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) => return e.kind() == std::io::ErrorKind::NotFound,
    };
    !entries.flatten().any(|e| !e.file_name().to_string_lossy().starts_with('.'))
}

/// What the user's machine is called in copy.
const THIS_DEVICE: &str = if cfg!(target_os = "macos") { "this Mac" } else { "this computer" };

/// A hold's words, as both the banner and the notification show them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldText {
    /// One line naming what is missing and where.
    pub title: String,
    /// What has (not) happened yet, and the advice that applies.
    pub body: Vec<String>,
}

/// `n` with comma thousands separators ("12,345"), the way the UI writes
/// every count, so a number reads the same in a banner, a notification and
/// a refusal.
#[must_use]
pub fn group_thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    grouped
}

/// "1 file" / "1,234 files".
fn files(n: usize) -> String {
    let noun = if n == 1 { "file" } else { "files" };
    format!("{} {noun}", group_thousands(n))
}

/// The verb agreeing with a count of files.
fn are(n: usize) -> &'static str {
    if n == 1 { "is" } else { "are" }
}

/// The words for a hold. Rust owns them so the side, the empty-root advice
/// and the member caveat cannot drift from the state that decides them,
/// and the banner and the notification cannot drift from each other.
#[must_use]
pub fn hold_text(label: &str, side: MassDeleteSide, entry: HoldEntry, can_restore: bool) -> HoldText {
    match side {
        MassDeleteSide::Server => {
            let mut body = vec!["Nothing has been deleted from Hippius yet.".to_string()];
            if entry.empty_root {
                body.push("If an external disk or cloud folder is disconnected, reconnect it.".to_string());
            }
            HoldText {
                title: format!(
                    "{} of {} in “{label}” {} missing from {THIS_DEVICE}",
                    group_thousands(entry.count),
                    files(entry.synced_count),
                    are(entry.count)
                ),
                body,
            }
        }
        MassDeleteSide::Local => {
            // A folder renamed or moved on another device reads here as its
            // files missing from Hippius; restoring cannot tell, and uploads
            // the old copies.
            let caveat = if can_restore {
                "If you renamed or moved the folder on another device, restoring uploads the old copies again."
            } else {
                "Only the owner of this shared drive can put them back on Hippius."
            };
            HoldText {
                title: format!("{} in “{label}” {} missing from Hippius", files(entry.count), are(entry.count)),
                body: vec![format!("Nothing has been deleted from {THIS_DEVICE} yet."), caveat.to_string()],
            }
        }
    }
}

/// The persisted notification's text for a new hold: the banner's words,
/// then what to do about them.
#[must_use]
pub fn held_notification_text(label: &str, side: MassDeleteSide, entry: HoldEntry, can_restore: bool) -> String {
    let text = hold_text(label, side, entry, can_restore);
    let next = if can_restore {
        "Open Hippius to restore them or remove them."
    } else {
        "Open Hippius to remove them."
    };
    format!("{}. {} {next}", text.title, text.body.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use MassDeleteSide::{Local, Server};

    const L: &str = "photos";
    const OWNER: &str = "5Owner";
    const ENGINE: CycleSource = CycleSource::Engine;

    /// A state with `L` armed for `OWNER`, as init leaves it.
    fn armed() -> MassDeleteHoldState {
        let state = MassDeleteHoldState::new();
        state.arm(L, OWNER, false, Path::new("/x"), &[]);
        state
    }

    fn held(side: MassDeleteSide, state: HoldState, count: usize) -> HeldMassDelete {
        HeldMassDelete {
            side,
            state,
            count,
            synced_count: 200,
            held_at: 1,
        }
    }

    fn report(side: MassDeleteSide, count: usize) -> HeldReport {
        HeldReport {
            side,
            count,
            synced_count: 200,
        }
    }

    /// Report a hold and settle it as the bridge does. `None` when nothing
    /// was emitted, else whether the emit carried the episode's
    /// notification.
    fn report_held(state: &MassDeleteHoldState, side: MassDeleteSide, count: usize) -> Option<bool> {
        if state.record_held(L, report(side, count)) == HeldChange::Unchanged {
            return None;
        }
        let mut emitted = None;
        state.settle_held(L, side, false, |_, notify| emitted = Some(notify.is_some()));
        emitted
    }

    /// One cycle reporting `events` (each a closure over the state).
    fn cycle(state: &MassDeleteHoldState, events: impl FnOnce(&MassDeleteHoldState)) -> Vec<MassDeleteSide> {
        state.begin_cycle(L, ENGINE);
        events(state);
        state.finish_cycle(L, ENGINE)
    }

    #[test]
    fn a_repeated_hold_is_emitted_and_notified_once() {
        let state = armed();
        state.arm(L, OWNER, false, Path::new("/x"), &[]);

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true));
        assert!(state.finish_cycle(L, ENGINE).is_empty(), "a side held this cycle is not cleared");

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), None, "same hold, next cycle");
        assert!(state.finish_cycle(L, ENGINE).is_empty());

        state.begin_cycle(L, ENGINE);
        assert_eq!(
            report_held(&state, Server, 160),
            Some(false),
            "a changed count is emitted but the episode already notified"
        );
        assert_eq!(state.entry(L, Server).map(|e| e.count), Some(160));
    }

    #[test]
    fn a_cycle_without_the_hold_clears_it_and_starts_a_new_episode() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Local, 120);
        });

        assert_eq!(cycle(&state, |_| {}), vec![Local], "the hold is reported cleared once");
        assert_eq!(state.entry(L, Local), None);
        assert!(cycle(&state, |_| {}).is_empty(), "nothing left to clear");

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Local, 120), Some(true), "a hold after a cleared one is a new episode");
    }

    /// hcfs completes a cycle that skipped conflicts twice: once from the
    /// conflict re-stage and again from its result dispatch. Only the first
    /// completion closes the cycle; the second must not read the hold as
    /// unreported and clear it.
    #[test]
    fn a_second_completion_of_one_cycle_keeps_the_hold() {
        let state = armed();
        state.arm(L, OWNER, false, Path::new("/x"), &[]);

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true));
        assert!(state.finish_cycle(L, ENGINE).is_empty());
        assert!(state.finish_cycle(L, ENGINE).is_empty(), "the repeated completion clears nothing");
        assert!(state.entry(L, Server).is_some(), "the hold stands");

        state.begin_cycle(L, ENGINE);
        assert_eq!(
            report_held(&state, Server, 150),
            None,
            "the episode was not ended, so it does not notify again"
        );
    }

    /// A reviewed sync starts while the engine's completion of the cycle
    /// before it is still on its way to the bridge. That completion belongs
    /// to the engine's cycle: closing the reviewed one with it would clear
    /// every hold before the reviewed sync recorded it.
    #[test]
    fn an_engine_completion_does_not_close_a_reviewed_cycle() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
        });

        state.begin_cycle(L, CycleSource::Reviewed);
        assert!(state.finish_cycle(L, ENGINE).is_empty(), "the late engine completion clears nothing");
        assert!(state.entry(L, Server).is_some(), "the hold stands");

        assert_eq!(report_held(&state, Server, 150), None, "the reviewed sync reports it unchanged");
        assert!(state.finish_cycle(L, CycleSource::Reviewed).is_empty());
        assert!(state.entry(L, Server).is_some());
    }

    /// The reviewed sync's own end does close it, clearing what it did not
    /// report.
    #[test]
    fn a_reviewed_cycle_clears_what_it_did_not_report() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
        });
        state.begin_cycle(L, CycleSource::Reviewed);
        assert_eq!(state.finish_cycle(L, CycleSource::Reviewed), vec![Server]);
    }

    #[test]
    fn a_completion_without_a_start_clears_nothing() {
        let state = armed();
        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        assert!(state.finish_cycle(L, ENGINE).is_empty(), "no cycle is open, so nothing went unreported");
        assert!(state.entry(L, Server).is_some());
    }

    #[test]
    fn sides_are_tracked_apart() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
            report_held(s, Local, 110);
        });

        let cleared = cycle(&state, |s| {
            report_held(s, Server, 150);
        });
        assert_eq!(cleared, vec![Local]);
        assert!(state.entry(L, Server).is_some());
    }

    #[test]
    fn a_restore_restores_for_one_cycle_then_clears() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
        });

        assert!(cycle(&state, |s| s.record_restored(L, Server, 150)).is_empty());
        let entry = state.entry(L, Server).expect("restoring side is kept");
        assert_eq!(entry.phase, HoldPhase::Restoring);
        assert_eq!(entry.count, 150);

        assert_eq!(cycle(&state, |_| {}), vec![Server], "the next completed cycle ends it");
    }

    #[test]
    fn a_hold_after_a_restore_notifies_again() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
        });
        cycle(&state, |s| s.record_restored(L, Server, 150));

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true));
    }

    #[test]
    fn a_refusal_is_reported_once_per_episode_and_keeps_the_hold() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        assert!(state.record_refused(L, Server, "insufficient_space"));
        report_held(&state, Server, 150);
        state.finish_cycle(L, ENGINE);

        state.begin_cycle(L, ENGINE);
        assert!(!state.record_refused(L, Server, "insufficient_space"), "repeated every cycle by hcfs");
        assert_eq!(report_held(&state, Server, 150), None);
        assert!(state.finish_cycle(L, ENGINE).is_empty());
        assert!(!state.folder_restores(L).any(), "a refusal restores no folders");

        state.begin_cycle(L, ENGINE);
        state.finish_cycle(L, ENGINE);
        state.begin_cycle(L, ENGINE);
        assert!(state.record_refused(L, Server, "insufficient_space"), "a new episode reports it again");
    }

    /// An applied restore owes its folders even when no file finished this
    /// cycle: the transfers that started (`pending`) finish later, and the
    /// empty folders have no transfer to wait for.
    #[test]
    fn every_applied_restore_owes_folders() {
        let state = armed();
        cycle(&state, |s| s.record_restored(L, Local, 40));
        let owed = state.folder_restores(L);
        assert_eq!(owed.sides(), FolderRestores { server: false, local: true });

        state.ack_folder_restores(L, owed);
        assert!(!state.folder_restores(L).any());
    }

    /// A second restore lands while the folder job is fetching the server
    /// set for the first. The job's ack covers what it read, not the
    /// restore it never saw, which stays owed for the next run.
    #[test]
    fn an_ack_does_not_cover_a_restore_that_landed_after_the_read() {
        let state = armed();
        cycle(&state, |s| s.record_restored(L, Server, 10));
        let read = state.folder_restores(L);

        cycle(&state, |s| s.record_restored(L, Server, 12));
        state.ack_folder_restores(L, read);
        assert!(state.folder_restores(L).sides().server, "the later restore is still owed");

        let read = state.folder_restores(L);
        state.ack_folder_restores(L, read);
        assert!(!state.folder_restores(L).any(), "acked once the job has read it");
    }

    #[test]
    fn a_folder_restore_outlives_the_episode_and_a_re_init() {
        let state = armed();
        cycle(&state, |s| s.record_restored(L, Server, 10));
        cycle(&state, |_| {});
        state.arm(L, OWNER, false, Path::new("/x"), &[]);
        assert!(state.folder_restores(L).sides().server, "consumed only by the folder job");
    }

    /// The app quit after a cycle applied a restore but before the folder
    /// job put the empty folders back: the owed flag lived in memory only.
    /// hcfs's record still says `Restoring`, so the arm owes it again.
    #[test]
    fn a_seeded_restoring_side_owes_its_folders_after_a_relaunch() {
        let state = MassDeleteHoldState::new();
        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Restoring, 150)]);
        assert_eq!(state.folder_restores(L).sides(), FolderRestores { server: true, local: false });
    }

    /// A pause and resume in the same run re-seeds the `Restoring` side the
    /// state already recorded; the restore it owed was already done once.
    #[test]
    fn a_re_init_does_not_owe_a_restore_the_folder_job_already_did() {
        let state = armed();
        cycle(&state, |s| s.record_restored(L, Server, 150));
        let owed = state.folder_restores(L);
        state.ack_folder_restores(L, owed);

        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Restoring, 150)]);
        assert!(!state.folder_restores(L).any());
    }

    #[test]
    fn a_seeded_hold_is_shown_but_not_notified_again() {
        let state = armed();
        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        assert_eq!(state.entry(L, Server).map(|e| e.phase), Some(HoldPhase::Held));

        state.begin_cycle(L, ENGINE);
        assert_eq!(
            report_held(&state, Server, 150),
            Some(false),
            "a seeded hold is shown again by the first cycle, but the episode was notified when it began"
        );
    }

    #[test]
    fn a_settle_stores_the_empty_root_check() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        assert_eq!(state.record_held(L, report(Server, 150)), HeldChange::Changed);
        assert!(state.settle_held(L, Server, true, |hold, _| assert!(hold.entry.empty_root)));
        assert_eq!(state.entry(L, Server).map(|e| e.empty_root), Some(true));
        assert!(
            !state.settle_held(L, Server, true, |_, _| panic!("settled twice")),
            "a hold is shown once"
        );
    }

    /// The empty-root check runs off the bridge's thread. A hold that
    /// cleared before it finished must not be shown after its clear.
    #[test]
    fn a_hold_cleared_before_it_settles_is_never_shown() {
        let state = armed();
        cycle(&state, |s| {
            s.record_held(L, report(Server, 150));
        });
        assert_eq!(cycle(&state, |_| {}), vec![Server]);
        assert!(!state.settle_held(L, Server, false, |_, _| panic!("shown after its clear")));
    }

    /// The hold changed again before the first check finished: the running
    /// settle shows the current hold, with the episode's notification, so
    /// neither is lost; once it is done, the next change starts a new one.
    #[test]
    fn a_running_settle_shows_the_hold_as_it_stands() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        assert_eq!(state.record_held(L, report(Server, 150)), HeldChange::Changed);
        state.finish_cycle(L, ENGINE);
        state.begin_cycle(L, ENGINE);
        assert_eq!(state.record_held(L, report(Server, 160)), HeldChange::Settling);

        let mut shown = None;
        assert!(state.settle_held(L, Server, false, |hold, notify| shown = Some((hold.entry.count, notify.is_some()))));
        assert_eq!(shown, Some((160, true)));

        assert_eq!(state.record_held(L, report(Server, 160)), HeldChange::Unchanged);
        assert_eq!(state.record_held(L, report(Server, 170)), HeldChange::Changed, "the settle is done");
    }

    /// A restore applied while the check ran ends the hold: the settle must
    /// not show the restoring side as held again.
    #[test]
    fn a_settle_after_a_restore_shows_nothing() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        state.record_held(L, report(Server, 150));
        state.record_restored(L, Server, 150);
        assert!(!state.settle_held(L, Server, false, |_, _| panic!("restoring side shown as held")));
    }

    /// hcfs re-reports a hold every cycle. While the empty-root check for
    /// one report is still running (a stalled network share), the next
    /// reports must not queue more blocking checks behind it.
    #[test]
    fn reports_during_a_settle_start_no_second_one() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        assert_eq!(state.record_held(L, report(Server, 150)), HeldChange::Changed);
        state.finish_cycle(L, ENGINE);

        state.begin_cycle(L, ENGINE);
        assert_ne!(
            state.record_held(L, report(Server, 150)),
            HeldChange::Changed,
            "same hold, check still running"
        );
        state.finish_cycle(L, ENGINE);
        state.begin_cycle(L, ENGINE);
        assert_ne!(
            state.record_held(L, report(Server, 160)),
            HeldChange::Changed,
            "changed hold, check still running"
        );
    }

    /// A pause and resume (or relaunch) is not a new episode, but one whose
    /// notification had not gone out yet still raises it.
    #[test]
    fn a_re_init_keeps_a_notification_not_yet_raised() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        state.record_held(L, report(Server, 150));
        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true));

        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(false), "raised once, never again for the episode");
    }

    /// A re-init lands while the old drive's cycle is still open: that
    /// cycle's late `SyncCompleted` saw none of the seeded holds reported,
    /// and must not read them as cleared.
    #[test]
    fn a_late_completion_after_a_re_init_keeps_the_seeded_holds() {
        let state = armed();
        state.arm(L, OWNER, false, Path::new("/x"), &[]);
        state.begin_cycle(L, ENGINE);

        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        assert!(state.finish_cycle(L, ENGINE).is_empty(), "the old drive's cycle closes nothing");
        assert_eq!(state.entry(L, Server).map(|e| e.count), Some(150));
    }

    /// The user answered, but hcfs's marker expired before a cycle used it:
    /// the next cycle reports the very same hold. That report must reach the
    /// UI again, or the banner says "Restoring…" for good. A cycle already
    /// running when the answer came read its markers before it, so its
    /// report does not count.
    #[test]
    fn an_answer_the_next_cycle_did_not_apply_re_emits_the_hold() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true));
        state.finish_cycle(L, ENGINE);

        state.begin_cycle(L, ENGINE);
        state.note_answered(L, Server);
        assert_eq!(
            report_held(&state, Server, 150),
            None,
            "this cycle started before the answer and never read it"
        );
        state.finish_cycle(L, ENGINE);

        state.begin_cycle(L, ENGINE);
        assert_eq!(
            report_held(&state, Server, 150),
            Some(false),
            "the first cycle after the answer still holds: shown again, not notified again"
        );
        state.finish_cycle(L, ENGINE);

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), None, "shown once per answer");
    }

    /// hcfs keeps one confirmation marker for both sides, so removing one
    /// side and then the other overwrites the first answer. The side whose
    /// answer was lost is held again by the next cycle and must be shown
    /// again; the side whose answer took effect clears.
    #[test]
    fn one_marker_for_both_sides_re_emits_the_side_whose_answer_was_lost() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
            report_held(s, Local, 120);
        });

        state.note_answered(L, Server);
        state.note_answered(L, Local);
        let cleared = cycle(&state, |s| {
            assert_eq!(report_held(s, Server, 150), Some(false), "the overwritten answer");
        });
        assert_eq!(cleared, vec![Local], "the applied answer clears its side");
    }

    /// An applied restore ends the episode, and the answer with it: a hold
    /// after the restore is a new one, not a lost answer.
    #[test]
    fn an_applied_restore_forgets_the_answer() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
        });
        state.note_answered(L, Server);
        cycle(&state, |s| s.record_restored(L, Server, 150));

        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true), "a new episode");
        state.finish_cycle(L, ENGINE);
        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), None);
    }

    #[test]
    fn a_member_cannot_restore_the_local_side() {
        let state = armed();
        state.arm(
            L,
            OWNER,
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
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
            s.record_restored("other", Local, 5);
        });

        assert_eq!(state.clear(L), vec![Server]);
        assert_eq!(state.entry(L, Server), None);
        assert!(state.entry("other", Local).is_some());

        state.clear_all();
        assert!(state.all().is_empty());
        assert!(!state.folder_restores("other").any());
    }

    /// A removed drive's banner must go: the clear reports every side that
    /// was showing one (held or restoring), so each can be told to the UI.
    #[test]
    fn clear_returns_the_sides_it_held() {
        let state = armed();
        cycle(&state, |s| {
            report_held(s, Server, 150);
            s.record_restored(L, Local, 5);
        });
        assert_eq!(state.clear(L), vec![Server, Local]);
        assert!(state.clear(L).is_empty(), "nothing left");

        cycle(&state, |s| s.record_restored(L, Server, 5));
        cycle(&state, |_| {});
        assert!(state.clear(L).is_empty(), "an owed folder restore is not a banner");
    }

    /// The episode's notification is saved for the account whose drive
    /// holds the files, as recorded when the drive was armed: never for
    /// whoever is signed in when the settle lands.
    #[test]
    fn the_notification_names_the_account_that_armed_the_drive() {
        let state = armed();
        state.begin_cycle(L, ENGINE);
        state.record_held(L, report(Server, 150));
        let mut owner = None;
        state.settle_held(L, Server, false, |_, notify| owner = notify.map(str::to_string));
        assert_eq!(owner.as_deref(), Some(OWNER));

        state.clear_all();
        state.arm(L, "5Next", false, Path::new("/x"), &[]);
        state.begin_cycle(L, ENGINE);
        state.record_held(L, report(Server, 150));
        state.settle_held(L, Server, false, |_, notify| owner = notify.map(str::to_string));
        assert_eq!(owner.as_deref(), Some("5Next"), "the next account's own episode");
    }

    /// A hold reported for a drive no init armed has no account to save
    /// its notification for. It is shown, and the notification waits for
    /// the arm instead of being spent on nobody.
    #[test]
    fn an_unarmed_drive_keeps_its_notification_for_the_arm() {
        let state = MassDeleteHoldState::new();
        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(false), "shown, nobody to notify");

        state.arm(L, OWNER, false, Path::new("/x"), &[held(Server, HoldState::Held, 150)]);
        state.begin_cycle(L, ENGINE);
        assert_eq!(report_held(&state, Server, 150), Some(true));
    }

    /// One saved notification per episode, end to end: the state raises
    /// it on the first settle only, and each raise saves one row.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_notification_is_saved_per_episode() {
        let dir = tempfile::tempdir().expect("tempdir");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(dir.path().join("test.db"))
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(options).await.expect("pool");
        crate::utils::schema::ensure_table_schema(&pool).await.expect("schema");
        let state = armed();

        for count in [150, 150, 160] {
            state.begin_cycle(L, ENGINE);
            let mut raise = None;
            if state.record_held(L, report(Server, count)) != HeldChange::Unchanged {
                state.settle_held(L, Server, false, |hold, notify| {
                    raise = notify.map(|owner| (owner.to_string(), held_notification_text(L, hold.side, hold.entry, hold.can_restore)));
                });
            }
            if let Some((owner, text)) = raise {
                crate::notifications::credits::create_mass_delete_held_notification(&pool, &owner, L, Server, &text)
                    .await
                    .expect("save");
            }
            state.finish_cycle(L, ENGINE);
        }

        let saved: Vec<(String,)> = sqlx::query_as("SELECT user_address FROM notifications")
            .fetch_all(&pool)
            .await
            .expect("rows");
        assert_eq!(saved, vec![(OWNER.to_string(),)]);
    }

    #[test]
    fn root_looks_empty_ignores_dot_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(root_looks_empty(dir.path()));

        std::fs::write(dir.path().join(".DS_Store"), b"").expect("write");
        assert!(root_looks_empty(dir.path()), "Finder metadata is not user content");

        std::fs::write(dir.path().join("a.txt"), b"").expect("write");
        assert!(!root_looks_empty(dir.path()));
        assert!(
            root_looks_empty(&dir.path().join("missing")),
            "a missing root is the disconnected shape too (a disk removed mid-cycle)"
        );
    }

    #[test]
    fn counts_are_grouped_like_the_ui_writes_them() {
        assert_eq!(group_thousands(0), "0");
        assert_eq!(group_thousands(999), "999");
        assert_eq!(group_thousands(1_000), "1,000");
        assert_eq!(group_thousands(1_234_567), "1,234,567");
        assert_eq!(files(1), "1 file");
        assert_eq!(files(12_000), "12,000 files");
    }

    #[test]
    fn hold_text_is_the_banners_title_and_lines() {
        let entry = HoldEntry {
            phase: HoldPhase::Held,
            count: 1_500,
            synced_count: 2_000,
            empty_root: false,
        };
        let device = THIS_DEVICE;
        let server = hold_text("Photos", Server, entry, true);
        assert_eq!(server.title, format!("1,500 of 2,000 files in “Photos” are missing from {device}"));
        assert_eq!(server.body, vec!["Nothing has been deleted from Hippius yet.".to_string()]);

        let one = hold_text("Photos", Local, HoldEntry { count: 1, ..entry }, false);
        assert_eq!(one.title, "1 file in “Photos” is missing from Hippius");
        assert_eq!(one.body[1], "Only the owner of this shared drive can put them back on Hippius.");
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
        assert!(server.contains("150 of 200 files in “Photos” are missing from"));
        assert!(server.contains("Nothing has been deleted from Hippius yet."));
        assert!(server.contains("reconnect it"));

        let local = held_notification_text("Photos", Local, entry, false);
        assert!(local.contains("150 files in “Photos” are missing from Hippius."));
        assert!(!local.contains("reconnect"), "the empty-root advice is about this device's folder");
        assert!(local.contains("Only the owner"));
        assert!(!local.contains("renamed"), "a member cannot restore, so the restore caveat is moot");
        assert!(
            local.ends_with("Open Hippius to remove them."),
            "a member is not offered a restore: {local}"
        );

        let own = held_notification_text("Photos", Local, entry, true);
        assert!(
            own.contains("If you renamed or moved the folder on another device, restoring uploads the old copies again."),
            "the banner's caveat, so the notification read later does not promise more than Restore does"
        );
        assert!(own.ends_with("Open Hippius to restore them or remove them."), "{own}");
        assert!(server.ends_with("Open Hippius to restore them or remove them."), "{server}");
    }
}
