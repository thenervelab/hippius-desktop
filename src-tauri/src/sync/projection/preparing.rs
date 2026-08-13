//! Per-label "preparing" state for file-watcher-triggered sync cycles.
//!
//! Bridges the visibility gap between the start of a sync cycle's
//! indexing phase (scan + remote-state fetch) and the first
//! `ProgressSnapshot` that has files in the session.
//!
//! ## Why this exists
//!
//! For IPC-initiated uploads (`add_file`/`add_files`/`add_folder`) the
//! top-of-page [`crate::sync::upload_processing::UploadProcessingState`]
//! banner already covers the disk-copy + encryption window. For
//! file-watcher-initiated cycles (user drops a folder via Finder, an
//! external editor writes into the sync dir, etc.) there is no banner
//! by design — and the bottom-right widget is gated on
//! `total_files > 0` in [`hcfs_client::engine::progress::snapshot::build_snapshot`],
//! so the user sees nothing during the debounce + `scan_local_files`
//! + `fetch_remote_state` window even though the system is doing work.
//!
//! This module tracks which drive labels are currently in that
//! "preparing" window. The snapshot pipeline reads it and, when any
//! label is MARKED, overrides `widget_visible=true` and
//! `widget_state="preparing"` on an otherwise-invisible snapshot.
//!
//! ## Armed vs Marked (covering the scan window without the no-op flash)
//!
//! Marking used to happen only at `SyncEvent::PlanReady`, gated on a
//! non-empty plan. That fixed an earlier regression (marking at
//! `SyncStarted` flashed the red "Preparing sync…" tray state on every
//! periodic no-op cycle) but reopened the original gap for large adds:
//! `PlanReady` fires AFTER `scan_local_files` + `fetch_remote_state`,
//! so a Finder-drop of a 200 GB batch left the UI dark for the whole
//! multi-minute scan/hash phase.
//!
//! [`PreparingEntry`] resolves the tension as a two-phase state machine:
//!
//! - **`Armed`** — set at `SyncStarted` (every cycle). Invisible: it does
//!   NOT drive the widget override. It only records when the cycle's
//!   indexing began.
//! - **`Marked`** — the visible override. An `Armed` label is promoted by
//!   a scan/fetch progress tick once the cycle has been indexing for at
//!   least [`PREPARING_SURFACE_GRACE`] (see
//!   [`PreparingState::note_pre_plan_activity`], wired in
//!   `crate::sync::drive::lifecycle::callbacks`). A fast no-op cycle
//!   finishes indexing inside the grace window, its entry is disarmed at
//!   `PlanReady` / cleared at `SyncCompleted`, and nothing ever flashes.
//!   A long scan is truthfully surfaced a few seconds in. `PlanReady`
//!   with real work still promotes immediately (the pre-existing path),
//!   and the explicit-add / startup-seed paths still mark directly.
//!
//! Promotion from a scan tick is suppressed while the label's
//! upload-processing banner is active (same double-signalling rule as
//! the `PlanReady` mark — the caller passes `allow_promote = false`).
//!
//! ## Lifecycle
//!
//! - [`PreparingState::note_cycle_started`] — `SyncStarted` handler; arms
//!   the label (or refreshes activity if already marked).
//! - [`PreparingState::note_pre_plan_activity`] — scan/fetch progress
//!   callbacks; promotes an armed label after the grace, bumps activity
//!   on a marked one.
//! - [`PreparingState::note_activity`] — encrypt/decrypt/transfer
//!   progress callbacks; bumps activity on a marked label.
//! - [`PreparingState::mark_preparing`] — `PlanReady` handler when the
//!   plan has real work AND the upload-processing banner is NOT active;
//!   also the explicit-add path in `drive::lifecycle`.
//! - [`PreparingState::disarm`] — `PlanReady` handler when the plan is
//!   empty or the banner covers the label: indexing is over, there is
//!   nothing to surface, drop the armed entry.
//! - [`PreparingState::clear`] — `SyncCompleted`, `SyncError`, and
//!   `SyncStopped` handlers; and the `ProgressSnapshot` handler when the
//!   snapshot has files for that label (the real per-file widget takes
//!   over). Removes armed AND marked entries, so an empty-plan cycle
//!   ends with no residue at `SyncCompleted` — never waiting for the
//!   idle timeout.
//! - [`PreparingState::clear_all`] — `stop_sync` / logout / reset paths.
//! - [`PreparingState::drain_expired`] — the idle watchdog backstop. The
//!   normal-path clears above assume every cycle eventually produces a
//!   terminal event (or a files-populated snapshot). hcfs-client
//!   violates that on at least one path: if a drive leaves the registry
//!   between `run_sync_cycle` and `dispatch_sync_result`,
//!   `trigger_sync_for_drive` early-returns ("Drive removed during
//!   sync") emitting NO terminal event. Without a backstop the label is
//!   stranded and the widget/tray show "Preparing sync…" until an
//!   unrelated later action. The watchdog expires any entry that has
//!   seen no activity for [`PREPARING_WATCHDOG_IDLE_TIMEOUT`] — idle
//!   time, NOT total time: a long scan keeps emitting progress ticks, so
//!   only a genuinely silent (stuck / orphaned) cycle idles out. A
//!   wall-clock timeout here force-cleared the widget 60s into the very
//!   scans this module exists to surface.
//!
//! ## Concurrency
//!
//! All methods are synchronous and lock the inner [`Mutex`] only for
//! the duration of the operation; the guard is always dropped before
//! returning (the watchdog `.await`s on the returned `Vec`, never
//! across the guard — compatible with the project's async-lock
//! hygiene axiom). The TauriSyncBridge handlers that invoke
//! `mark_preparing`/`clear` are synchronous, and the progress callbacks
//! that invoke the `note_*` methods run on engine worker (incl. rayon
//! scan) threads — a single uncontended mutex tick per call.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

use hcfs_client::engine::runner::SyncRunner;

/// How long a preparing entry may sit with NO engine activity (no
/// scan/fetch/encrypt/transfer progress tick, no re-mark) before the
/// watchdog force-clears it.
///
/// **Why idle-based:** the legitimate preparing window can be minutes
/// (scanning + hashing a 200 GB add), and the engine emits progress the
/// whole time. A wall-clock cap measured from the first mark cleared the
/// widget mid-scan; measuring from the LAST activity keeps it up while
/// work flows, yet a cycle that lost its terminal event (the hcfs-client
/// "drive removed during sync" path) emits nothing and still expires.
///
/// 60s matches the sibling [`crate::sync::upload_processing`] idle
/// timeout so the two "stuck UI state" backstops behave identically.
pub const PREPARING_WATCHDOG_IDLE_TIMEOUT: Duration = Duration::from_mins(1);

/// How often the watchdog scans for expired labels. 10s caps observable
/// lateness (a stuck override clears within `TIMEOUT + SCAN_INTERVAL` of
/// the last activity) while keeping the idle wakeup rate negligible.
/// Mirrors the upload-processing scan cadence.
pub const PREPARING_WATCHDOG_SCAN_INTERVAL: Duration = Duration::from_secs(10);

/// How long a cycle must have been indexing (scan + remote fetch) before
/// a progress tick promotes its `Armed` entry to the visible `Marked`
/// override.
///
/// **Why a grace at all:** promoting on the first tick would repaint the
/// "Preparing sync…" state across the indexing window of EVERY cycle —
/// including periodic/heartbeat no-op cycles — which is exactly the
/// tray-flashing regression that moved marking from `SyncStarted` to
/// `PlanReady` in the first place.
///
/// **Why 5s:** the no-op indexing window is normally well under this
/// (watcher debounce + cached scan + one listing fetch), so routine
/// cycles never surface; a large add scans for minutes, so users see
/// "preparing" within seconds instead of a dark window.
pub const PREPARING_SURFACE_GRACE: Duration = Duration::from_secs(5);

/// Live indexing detail carried by a pre-plan progress tick, so the
/// "Preparing" widget can show ACTIVE work ("1,234 files scanned")
/// instead of a bare label. The two variants mirror the only two
/// pre-plan engine callbacks (`on_scan_progress`, `on_fetch_state_progress`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PreparingActivity {
    /// `scan_local_files` is running; `scanned_files` is the engine's
    /// cumulative per-cycle counter (one tick per hashed file).
    Scanning { scanned_files: u64 },
    /// `fetch_remote_state` is running; entries fetched so far out of
    /// the server-reported total.
    Fetching { fetched_entries: u64, total_entries: u64 },
}

/// Outcome of a pre-plan tick, telling the caller which snapshot emit
/// (if any) the tick warrants. An enum (not flags) so the emit policy
/// reads at the call site.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrePlanTick {
    /// Label is not visibly preparing (absent/armed): nothing to emit.
    Invisible,
    /// Label just became visible: emit one immediate snapshot.
    Promoted,
    /// Label was already visible and its live detail was refreshed:
    /// a throttled emit keeps the counter moving without flooding.
    Refreshed,
}

/// Aggregated live indexing detail across every visibly-Marked label,
/// for the snapshot wire. Each side is `None` when no marked label is
/// currently in that phase; sums mirror [`PreparingState::pending_summary`]'s
/// cross-label aggregation (the widget override itself is global).
///
/// Derives `Hash` so the bridge can fold it into the snapshot
/// fingerprint — counter motion must defeat the duplicate-emit gate.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub struct PreparingActivityTotals {
    pub scanned_files: Option<u64>,
    pub fetched_entries: Option<u64>,
    pub fetch_total_entries: Option<u64>,
}

/// Per-label two-phase state. See the module docs ("Armed vs Marked").
enum PreparingEntry {
    /// A sync cycle is indexing this label but nothing is surfaced yet.
    /// `cycle_started_at` anchors the [`PREPARING_SURFACE_GRACE`] check;
    /// deliberately NOT refreshed by pre-plan ticks, so a long scan
    /// promotes exactly `GRACE` after the cycle began, not `GRACE` after
    /// the most recent tick. `activity` is tracked even while invisible
    /// so a promotion (or a `PlanReady` mark) surfaces with the current
    /// counter instead of a blank frame.
    Armed {
        cycle_started_at: Instant,
        activity: Option<PreparingActivity>,
    },
    /// The visible "Preparing sync…" override for this label.
    Marked {
        /// Refreshed by every activity signal (progress ticks, re-marks).
        /// Read by [`PreparingState::drain_expired`] against
        /// [`PREPARING_WATCHDOG_IDLE_TIMEOUT`].
        last_activity_at: Instant,
        /// Optional local-pending summary attached at startup: the count and
        /// byte total of on-disk files not yet in this drive's synced baseline
        /// (`sync_state.json`). Lets the widget/tray show "N files · X ·
        /// Preparing" immediately on launch — before the slow remote fetch —
        /// instead of a bare "Preparing". 0 for the `PlanReady` / scan-promotion
        /// paths, which have no cheap pre-scan count. Summed across labels by
        /// [`PreparingState::pending_summary`].
        pending_files: u64,
        pending_bytes: u64,
        /// Latest pre-plan tick detail ("N files scanned" / "f of t
        /// entries fetched"), refreshed per tick and cleared when a new
        /// cycle starts (its scan restarts from zero). Read by
        /// [`PreparingState::activity_totals`].
        activity: Option<PreparingActivity>,
    },
}

/// Map of drive labels currently in the "preparing" window.
///
/// Owned by [`crate::app_state::AppState`] behind an `Arc`, mirroring
/// the [`crate::sync::upload_processing::UploadProcessingState`]
/// composition pattern. A label drives the widget override iff its
/// entry is [`PreparingEntry::Marked`]; `Armed` entries are invisible
/// bookkeeping for the scan-window grace.
pub struct PreparingState {
    inner: Mutex<HashMap<String, PreparingEntry>>,
}

impl Default for PreparingState {
    fn default() -> Self {
        Self::new()
    }
}

impl PreparingState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Acquire the inner mutex with a single poison-message helper.
    ///
    /// Centralises the `expect` panic message so a future addition to
    /// the API can't introduce a new wording variant. The returned
    /// guard's lifetime is tied to `&self`; each public method holds it
    /// for the smallest possible scope (no `.await` under the guard;
    /// the project axiom forbidding sync-mutex-across-await applies if a
    /// future caller adds async code here).
    fn lock(&self) -> MutexGuard<'_, HashMap<String, PreparingEntry>> {
        self.inner.lock().expect("preparing mutex poisoned")
    }

    /// Mark `label` (insert or promote to `Marked`), stamping `now` as
    /// its activity time.
    ///
    /// Split out from [`Self::mark_preparing`] so tests can inject a
    /// deterministic `now` without sleeping (mirrors
    /// `UploadProcessingState`'s `*_at` test seam). Returns `true` if
    /// the label became newly Marked (fresh insert or Armed→Marked
    /// promotion); `false` if it was already Marked — in which case the
    /// idle window is refreshed (a re-mark is an engine liveness
    /// signal) and a non-zero summary updates the counts in place, but
    /// a bare re-mark can't wipe a summary we already have.
    fn mark_at(&self, now: Instant, label: &str, pending_files: u64, pending_bytes: u64) -> bool {
        match self.lock().entry(label.to_string()) {
            Entry::Occupied(mut slot) => match slot.get_mut() {
                // Promotion carries the armed phase's live counter over,
                // so a `PlanReady` mark after a long scan surfaces with
                // "N files scanned" instead of a blank frame.
                PreparingEntry::Armed { activity, .. } => {
                    let activity = *activity;
                    slot.insert(PreparingEntry::Marked {
                        last_activity_at: now,
                        pending_files,
                        pending_bytes,
                        activity,
                    });
                    true
                }
                PreparingEntry::Marked {
                    last_activity_at,
                    pending_files: files,
                    pending_bytes: bytes,
                    activity: _,
                } => {
                    *last_activity_at = now;
                    if pending_files > 0 {
                        *files = pending_files;
                        *bytes = pending_bytes;
                    }
                    false
                }
            },
            Entry::Vacant(slot) => {
                slot.insert(PreparingEntry::Marked {
                    last_activity_at: now,
                    pending_files,
                    pending_bytes,
                    activity: None,
                });
                true
            }
        }
    }

    /// Insert `label` into the visible preparing set.
    ///
    /// Returns `true` if the label was newly surfaced; `false` if it was
    /// already Marked. Callers gate an immediate `emit_snapshot` on the
    /// `true` return so the widget appears within one tick, without
    /// re-emitting on every duplicate mark within the same window.
    ///
    /// The `MutexGuard` is dropped at the function boundary (the
    /// return value is `bool`, not the guard). This non-extending-the-
    /// guard contract is load-bearing for the
    /// [`crate::sync::tauri_bridge::TauriSyncBridge::on_event`]
    /// `PlanReady` arm: that arm calls this method and then invokes
    /// `emit_snapshot`, which synchronously re-enters `on_event` with
    /// `ProgressSnapshot` — and that re-entry reacquires this same
    /// mutex via `clear` / `is_any_preparing`. Since `std::sync::Mutex`
    /// is non-reentrant, holding the guard across `emit_snapshot`
    /// would deadlock. The `mark_then_read_does_not_deadlock_in_sequence`
    /// test below pins this invariant.
    pub fn mark_preparing(&self, label: &str) -> bool {
        self.mark_at(Instant::now(), label, 0, 0)
    }

    /// Like [`Self::mark_preparing`] but attaches a local-pending summary (file
    /// count + byte total) so the widget/tray can render "N files · X ·
    /// Preparing" during the startup window — before the engine's remote fetch.
    /// If the label is already marked, the summary is updated in place. Returns
    /// `true` if the label was newly surfaced (callers gate an immediate
    /// `emit_snapshot` on it).
    pub fn mark_preparing_with_summary(&self, label: &str, pending_files: u64, pending_bytes: u64) -> bool {
        self.mark_at(Instant::now(), label, pending_files, pending_bytes)
    }

    /// Record that a sync cycle started for `label`: arm the label (or
    /// refresh a re-armed / already-marked one). Called from the
    /// bridge's `SyncStarted` handler for EVERY cycle.
    ///
    /// Arming is invisible — `is_any_preparing` ignores `Armed` — so
    /// this deliberately does NOT reintroduce the "mark at SyncStarted"
    /// tray-flash regression. It only anchors the
    /// [`PREPARING_SURFACE_GRACE`] clock that
    /// [`Self::note_pre_plan_activity`] promotes against.
    pub fn note_cycle_started(&self, label: &str) {
        self.note_cycle_started_at(Instant::now(), label);
    }

    /// Clock-injected body of [`Self::note_cycle_started`].
    fn note_cycle_started_at(&self, now: Instant, label: &str) {
        match self.lock().entry(label.to_string()) {
            Entry::Occupied(mut slot) => match slot.get_mut() {
                // A NEW cycle re-anchors the grace clock; the previous
                // cycle's armed entry is stale by definition (its cycle
                // ended without disarm — e.g. a lost terminal event).
                // The live counter is dropped either way: the new
                // cycle's scan restarts from zero, so carrying the old
                // number would show a stale "N files scanned".
                PreparingEntry::Armed { cycle_started_at, activity } => {
                    *cycle_started_at = now;
                    *activity = None;
                }
                // Already surfaced (startup seed / previous promotion):
                // a new cycle beginning is an engine liveness signal.
                PreparingEntry::Marked {
                    last_activity_at, activity, ..
                } => {
                    *last_activity_at = now;
                    *activity = None;
                }
            },
            Entry::Vacant(slot) => {
                slot.insert(PreparingEntry::Armed {
                    cycle_started_at: now,
                    activity: None,
                });
            }
        }
    }

    /// Feed a pre-plan (scan / remote-fetch) progress tick for `label`,
    /// carrying the tick's live detail (`activity`).
    ///
    /// - `Marked` → refresh the idle window and the live detail;
    ///   returns [`PrePlanTick::Refreshed`] so the caller pushes a
    ///   THROTTLED emit (the counter keeps moving on screen).
    /// - `Armed` for at least [`PREPARING_SURFACE_GRACE`] AND
    ///   `allow_promote` → promote to `Marked`, returning
    ///   [`PrePlanTick::Promoted`] so the caller pushes one immediate
    ///   snapshot (the widget appears, counter already populated).
    /// - `Armed` within the grace → record the detail, keep the anchor.
    /// - Absent → arm now. Covers ticks whose `SyncStarted` predates this
    ///   state (or whose armed entry was idle-drained mid-scan between
    ///   sparse ticks, e.g. one giant file hashing for minutes).
    ///
    /// `allow_promote` is `false` while the label's upload-processing
    /// banner is active: the banner already signals "we're working", and
    /// surfacing both would double-signal (same rule as the `PlanReady`
    /// mark). Activity bumps still apply either way.
    pub fn note_pre_plan_activity(&self, label: &str, allow_promote: bool, activity: PreparingActivity) -> PrePlanTick {
        self.note_pre_plan_activity_at(Instant::now(), label, allow_promote, activity)
    }

    /// Clock-injected body of [`Self::note_pre_plan_activity`].
    fn note_pre_plan_activity_at(&self, now: Instant, label: &str, allow_promote: bool, tick: PreparingActivity) -> PrePlanTick {
        match self.lock().entry(label.to_string()) {
            Entry::Occupied(mut slot) => match slot.get_mut() {
                PreparingEntry::Armed { cycle_started_at, activity } => {
                    let past_grace = now
                        .checked_duration_since(*cycle_started_at)
                        .is_some_and(|elapsed| elapsed >= PREPARING_SURFACE_GRACE);
                    if allow_promote && past_grace {
                        slot.insert(PreparingEntry::Marked {
                            last_activity_at: now,
                            pending_files: 0,
                            pending_bytes: 0,
                            activity: Some(tick),
                        });
                        PrePlanTick::Promoted
                    } else {
                        // Track the counter while still invisible so the
                        // eventual promotion / `PlanReady` mark surfaces
                        // with a populated frame.
                        *activity = Some(tick);
                        PrePlanTick::Invisible
                    }
                }
                PreparingEntry::Marked {
                    last_activity_at, activity, ..
                } => {
                    *last_activity_at = now;
                    *activity = Some(tick);
                    PrePlanTick::Refreshed
                }
            },
            Entry::Vacant(slot) => {
                slot.insert(PreparingEntry::Armed {
                    cycle_started_at: now,
                    activity: Some(tick),
                });
                PrePlanTick::Invisible
            }
        }
    }

    /// Feed a post-plan (encrypt / decrypt / transfer) progress tick:
    /// refresh a `Marked` label's idle window. `Armed` entries are left
    /// untouched — post-plan phases can't promote, because `PlanReady`
    /// already resolved the label (marked it, or disarmed it as
    /// empty-plan / banner-covered).
    pub fn note_activity(&self, label: &str) {
        self.note_activity_at(Instant::now(), label);
    }

    /// Clock-injected body of [`Self::note_activity`].
    fn note_activity_at(&self, now: Instant, label: &str) {
        if let Some(PreparingEntry::Marked { last_activity_at, .. }) = self.lock().get_mut(label) {
            *last_activity_at = now;
        }
    }

    /// Drop `label`'s `Armed` entry, leaving a `Marked` one untouched.
    ///
    /// Called from the `PlanReady` handler when the plan has no work (or
    /// the upload-processing banner covers the label): indexing is over,
    /// so the scan-window grace can never legitimately fire again this
    /// cycle. A `Marked` entry survives — its clear paths are the
    /// files-populated snapshot and the terminal events.
    pub fn disarm(&self, label: &str) {
        let mut g = self.lock();
        let Some(entry) = g.get(label) else { return };
        match entry {
            PreparingEntry::Armed { .. } => {
                g.remove(label);
            }
            PreparingEntry::Marked { .. } => {}
        }
    }

    /// Remove `label` from the preparing state (armed or marked).
    ///
    /// Returns `true` iff the label was visibly Marked — callers use
    /// this to skip a redundant `emit_snapshot` when nothing the user
    /// can see changed (dropping an invisible `Armed` entry returns
    /// `false`).
    pub fn clear(&self, label: &str) -> bool {
        matches!(self.lock().remove(label), Some(PreparingEntry::Marked { .. }))
    }

    /// Remove every label (armed and marked).
    ///
    /// Returns `true` if any label was visibly Marked before the clear.
    /// Called on `SyncReset` and from `stop_sync` (logout / drive
    /// teardown), which must guarantee no preparing override leaks
    /// across an account switch.
    pub fn clear_all(&self) -> bool {
        let mut g = self.lock();
        let had_marked = g.values().any(|e| matches!(e, PreparingEntry::Marked { .. }));
        g.clear();
        had_marked
    }

    /// Returns `true` when at least one label is visibly Marked. Read by
    /// the snapshot pipeline to decide whether to apply the preparing
    /// override. `Armed` entries do not count — that is what keeps
    /// routine cycles from flashing the widget.
    pub fn is_any_preparing(&self) -> bool {
        self.lock().values().any(|e| matches!(e, PreparingEntry::Marked { .. }))
    }

    /// Sum of every Marked label's local-pending summary, or `None` when
    /// no label carries a non-zero count.
    ///
    /// Read by the snapshot wire wrapper so the FE can show a
    /// "N files · X bytes · Preparing" header while a startup-seeded drive waits
    /// for its first real session snapshot. `None` means "no summary known —
    /// render the generic preparing state". Cheap: one mutex lock, no allocation.
    pub fn pending_summary(&self) -> Option<(u64, u64)> {
        let g = self.lock();
        let mut files = 0u64;
        let mut bytes = 0u64;
        for entry in g.values() {
            match entry {
                PreparingEntry::Marked {
                    pending_files,
                    pending_bytes,
                    ..
                } => {
                    files = files.saturating_add(*pending_files);
                    bytes = bytes.saturating_add(*pending_bytes);
                }
                PreparingEntry::Armed { .. } => {}
            }
        }
        (files > 0).then_some((files, bytes))
    }

    /// Aggregated live indexing detail across every visibly-Marked
    /// label, for the snapshot wire ("Preparing — 1,234 files scanned").
    ///
    /// Sums per phase, mirroring [`Self::pending_summary`]'s cross-label
    /// aggregation (the preparing override is global on
    /// `is_any_preparing`, so per-label routing has no renderer). Armed
    /// entries are excluded — their counters exist only to pre-populate
    /// the frame a promotion surfaces. Cheap: one mutex lock, no
    /// allocation.
    pub fn activity_totals(&self) -> PreparingActivityTotals {
        let g = self.lock();
        let mut totals = PreparingActivityTotals::default();
        for entry in g.values() {
            let activity = match entry {
                PreparingEntry::Marked { activity, .. } => activity,
                PreparingEntry::Armed { .. } => &None,
            };
            match activity {
                Some(PreparingActivity::Scanning { scanned_files }) => {
                    totals.scanned_files = Some(totals.scanned_files.unwrap_or(0).saturating_add(*scanned_files));
                }
                Some(PreparingActivity::Fetching {
                    fetched_entries,
                    total_entries,
                }) => {
                    totals.fetched_entries = Some(totals.fetched_entries.unwrap_or(0).saturating_add(*fetched_entries));
                    totals.fetch_total_entries = Some(totals.fetch_total_entries.unwrap_or(0).saturating_add(*total_entries));
                }
                None => {}
            }
        }
        totals
    }

    /// Remove and return every Marked label that has seen no activity for
    /// at least [`PREPARING_WATCHDOG_IDLE_TIMEOUT`] as measured from
    /// `now`. Stale `Armed` entries (no promotion, no disarm, no clear
    /// for a full idle window) are removed in the same sweep but NOT
    /// returned — they were never visible, so there is nothing to emit
    /// or warn about.
    ///
    /// `now` is injected (not read internally) so tests are
    /// deterministic without sleeping — and so a single scan compares
    /// every entry against one consistent clock reading. Labels are
    /// returned sorted for deterministic emit/log order; the FE does
    /// not depend on order but the inline tests do.
    ///
    /// `now.checked_duration_since(t)` is `None` when the monotonic
    /// clock appears to have gone backwards (`now < t`); such an entry
    /// is treated as "not yet expired" rather than panicking or
    /// clearing a still-active preparing state. Mirrors
    /// `UploadProcessingState::drain_expired`.
    ///
    /// The guard is dropped before returning, so the watchdog may
    /// freely `.await` on the returned `Vec` (axiom Async Lock
    /// Hygiene).
    fn drain_expired(&self, now: Instant) -> Vec<String> {
        let mut g = self.lock();
        let mut stale_marked: Vec<String> = Vec::new();
        let mut stale_armed: Vec<String> = Vec::new();
        for (label, entry) in g.iter() {
            let (anchor, bucket) = match entry {
                PreparingEntry::Marked { last_activity_at, .. } => (*last_activity_at, &mut stale_marked),
                PreparingEntry::Armed { cycle_started_at, .. } => (*cycle_started_at, &mut stale_armed),
            };
            let expired = now
                .checked_duration_since(anchor)
                .is_some_and(|elapsed| elapsed >= PREPARING_WATCHDOG_IDLE_TIMEOUT);
            if expired {
                bucket.push(label.clone());
            }
        }
        for label in stale_marked.iter().chain(stale_armed.iter()) {
            g.remove(label);
        }
        drop(g);
        stale_marked.sort();
        stale_marked
    }

    /// Sorted snapshot of the visibly-Marked labels, for tests and
    /// diagnostics. Not on the hot path — produces a fresh `Vec` per call.
    #[doc(hidden)]
    pub fn snapshot_labels(&self) -> Vec<String> {
        let mut labels: Vec<String> = self
            .lock()
            .iter()
            .filter_map(|(label, entry)| match entry {
                PreparingEntry::Marked { .. } => Some(label.clone()),
                PreparingEntry::Armed { .. } => None,
            })
            .collect();
        labels.sort();
        labels
    }

    /// Test-only: is `label` currently in the invisible `Armed` phase?
    #[cfg(test)]
    fn is_armed_for_test(&self, label: &str) -> bool {
        matches!(self.lock().get(label), Some(PreparingEntry::Armed { .. }))
    }
}

/// Spawn the background watchdog that force-clears stuck preparing
/// labels.
///
/// The normal-path clears (`SyncCompleted`/`SyncError`/`SyncStopped`,
/// files-populated `ProgressSnapshot`) assume hcfs-client always emits
/// a terminal event after `SyncStarted`. It does not on the
/// "drive removed during sync" early-return — so without this backstop a
/// file-watcher-triggered cycle can strand a label and pin the
/// widget/tray on "Preparing sync…" indefinitely (the user-reported
/// bug). Every [`PREPARING_WATCHDOG_SCAN_INTERVAL`] this drains any
/// entry idle for [`PREPARING_WATCHDOG_IDLE_TIMEOUT`] — idle, not total
/// age: engine progress ticks keep a legitimate long scan alive — and,
/// when a VISIBLE (Marked) entry was drained, forces one snapshot emit
/// so the FE re-derives with `is_any_preparing() == false` and drops the
/// override.
///
/// Holds `Weak` handles (mirroring
/// [`crate::sync::upload_processing::spawn_watchdog`]) so the task does
/// not keep `AppState`/`SyncRunner` alive past app shutdown — it exits
/// when either is dropped. One emit clears the override for all drained
/// labels at once (the override is global on `is_any_preparing`), so
/// there is no per-label emit.
pub fn spawn_watchdog(state: Weak<PreparingState>, sync: Weak<SyncRunner>) {
    // `tauri::async_runtime::spawn`, not `tokio::spawn`: our caller is
    // Tauri's `setup` closure, which is not running inside a tokio
    // runtime context, so `tokio::spawn`/`tokio::time::sleep` would
    // panic at boot. Tauri's `async_runtime` is tokio underneath, so
    // the inner `sleep` is fine. Same rationale as
    // `upload_processing::spawn_watchdog`.
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PREPARING_WATCHDOG_SCAN_INTERVAL).await;
            let Some(state) = state.upgrade() else {
                tracing::debug!("preparing watchdog: state dropped, exiting");
                break;
            };
            let cleared = state.drain_expired(Instant::now());
            // Drop the strong ref before any further work so we never
            // extend AppState's lifetime across the (cheap) emit.
            drop(state);
            if cleared.is_empty() {
                continue;
            }
            for label in &cleared {
                tracing::warn!(
                    label = %label,
                    idle_timeout_secs = PREPARING_WATCHDOG_IDLE_TIMEOUT.as_secs(),
                    "auto-clearing stuck preparing override (no engine activity \
                     for a full idle window — likely the hcfs-client drive-\
                     removed-mid-cycle path)",
                );
            }
            // One forced emit re-runs `apply_preparing_override` with an
            // empty set, so the widget/tray leave "Preparing sync…".
            // `immediate=true` bypasses the snapshot throttle. If the
            // runner is already gone the override is moot anyway.
            if let Some(sync) = sync.upgrade() {
                sync.emit_snapshot(true);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shorthand scan tick for tests that only care about promotion /
    /// idle mechanics, not the counter value.
    fn scan(scanned_files: u64) -> PreparingActivity {
        PreparingActivity::Scanning { scanned_files }
    }

    #[test]
    fn mark_preparing_returns_true_on_first_insert() {
        let state = PreparingState::new();
        assert!(state.mark_preparing("drive-a"));
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    #[test]
    fn mark_preparing_returns_false_on_duplicate() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        assert!(!state.mark_preparing("drive-a"));
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    #[test]
    fn clear_returns_true_when_present() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        assert!(state.clear("drive-a"));
        assert!(state.snapshot_labels().is_empty());
    }

    #[test]
    fn clear_returns_false_when_absent() {
        let state = PreparingState::new();
        assert!(!state.clear("nobody"));
    }

    #[test]
    fn clear_all_removes_every_label() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        state.mark_preparing("drive-b");
        assert!(state.clear_all());
        assert!(!state.is_any_preparing());
    }

    #[test]
    fn clear_all_returns_false_on_empty() {
        let state = PreparingState::new();
        assert!(!state.clear_all());
    }

    #[test]
    fn is_any_preparing_reflects_membership() {
        let state = PreparingState::new();
        assert!(!state.is_any_preparing());
        state.mark_preparing("drive-a");
        assert!(state.is_any_preparing());
        state.clear("drive-a");
        assert!(!state.is_any_preparing());
    }

    #[test]
    fn snapshot_labels_returns_sorted_view() {
        let state = PreparingState::new();
        state.mark_preparing("drive-z");
        state.mark_preparing("drive-a");
        state.mark_preparing("drive-m");
        assert_eq!(
            state.snapshot_labels(),
            vec!["drive-a".to_string(), "drive-m".to_string(), "drive-z".to_string()],
        );
    }

    /// Re-entrancy guardrail. `PreparingState::mark_preparing` MUST
    /// release the inner mutex before returning so the
    /// `TauriSyncBridge::on_event` `PlanReady` arm can call it and
    /// then invoke `emit_snapshot`, which synchronously re-enters
    /// `on_event` and reacquires the same mutex via `clear` /
    /// `is_any_preparing`. `std::sync::Mutex` is non-reentrant, so a
    /// refactor that extended the guard's lifetime would deadlock at
    /// runtime.
    #[test]
    fn mark_then_read_does_not_deadlock_in_sequence() {
        let state = PreparingState::new();
        assert!(state.mark_preparing("drive-a"));
        assert!(state.is_any_preparing());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
        assert!(state.clear("drive-a"));
        assert!(!state.is_any_preparing());
    }

    // ── Idle watchdog backstop ───────────────────────────────────────

    /// A Marked label with no activity for a full idle window is
    /// drained and returned; the set no longer contains it. This is
    /// the core stuck-"Preparing sync…" fix: the missing-terminal-event
    /// path can't strand a label forever.
    #[test]
    fn drain_expired_removes_idle_label() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        assert!(state.mark_at(t0, "drive-a", 0, 0));
        let later = t0 + PREPARING_WATCHDOG_IDLE_TIMEOUT + Duration::from_secs(1);
        assert_eq!(state.drain_expired(later), vec!["drive-a".to_string()]);
        assert!(!state.is_any_preparing());
    }

    /// A label still within its idle window is left untouched — the
    /// watchdog must not cut short a legitimately-preparing cycle.
    #[test]
    fn drain_expired_keeps_fresh_label() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0, "drive-a", 0, 0);
        let soon = t0 + Duration::from_secs(5);
        assert!(state.drain_expired(soon).is_empty());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    /// Task test (b): a long scan whose progress ticks keep arriving
    /// must NOT be cleared at 60s of wall clock. Ticks land every 10s
    /// for three minutes; every sweep in between finds the entry fresh.
    #[test]
    fn periodic_activity_defeats_wall_clock_timeout() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        let mut last_tick = t0;
        for secs in (10..=180).step_by(10) {
            let tick = t0 + Duration::from_secs(secs);
            state.note_pre_plan_activity_at(tick, "drive-a", true, scan(secs));
            last_tick = tick;
        }
        // Promoted at the first past-grace tick, and 180s of ticks later
        // (three full wall-clock timeouts) it is still alive.
        assert!(state.is_any_preparing());
        assert!(
            state.drain_expired(last_tick + Duration::from_secs(1)).is_empty(),
            "steady progress must defeat the idle watchdog"
        );
        // Task test (c): once the ticks stop, one idle window later the
        // watchdog clears it — the anti-stuck purpose is preserved.
        let idle = last_tick + PREPARING_WATCHDOG_IDLE_TIMEOUT;
        assert_eq!(state.drain_expired(idle), vec!["drive-a".to_string()]);
    }

    /// Idle semantics: a duplicate mark (a new `SyncStarted` for a label
    /// that is already preparing) is an engine liveness signal and MUST
    /// extend the idle window. The old anti-storm rationale ("re-marks
    /// reset the timer forever") no longer applies: a watcher storm that
    /// keeps triggering real cycles also produces real terminal events
    /// (`SyncCompleted`/`SyncError`), which clear the state — the idle
    /// watchdog only needs to catch cycles that go silent.
    #[test]
    fn duplicate_mark_extends_idle_window() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0, "drive-a", 0, 0);
        // Re-marked 50s in — refreshes the idle window.
        let remark = t0 + Duration::from_secs(50);
        assert!(!state.mark_at(remark, "drive-a", 0, 0));
        // 65s after the FIRST mark but only 15s after the re-mark:
        // must NOT be drained.
        let sweep = t0 + PREPARING_WATCHDOG_IDLE_TIMEOUT + Duration::from_secs(5);
        assert!(state.drain_expired(sweep).is_empty(), "recent re-mark must extend the idle window");
        // One full idle window after the re-mark with no activity → drained.
        let idle = remark + PREPARING_WATCHDOG_IDLE_TIMEOUT;
        assert_eq!(state.drain_expired(idle), vec!["drive-a".to_string()]);
    }

    /// Clock-skew guard: if the supplied `now` precedes the entry's
    /// activity anchor (`checked_duration_since` → `None`), the entry is
    /// treated as not-yet-expired, never drained, never panics.
    #[test]
    fn drain_expired_ignores_entry_marked_in_the_future() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0 + Duration::from_mins(2), "drive-a", 0, 0);
        assert!(state.drain_expired(t0).is_empty());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
    }

    #[test]
    fn drain_expired_on_empty_returns_empty() {
        let state = PreparingState::new();
        assert!(state.drain_expired(Instant::now()).is_empty());
    }

    // ── Armed phase: scan-window coverage without the no-op flash ────

    /// Task test (a), first half: `SyncStarted` arms the label but the
    /// override stays INVISIBLE — a routine cycle's indexing window must
    /// not flash the widget/tray (the regression that moved marking off
    /// `SyncStarted` originally).
    #[test]
    fn cycle_start_arms_without_surfacing() {
        let state = PreparingState::new();
        state.note_cycle_started_at(Instant::now(), "drive-a");
        assert!(state.is_armed_for_test("drive-a"));
        assert!(!state.is_any_preparing(), "armed must be invisible");
        assert!(state.snapshot_labels().is_empty());
        assert_eq!(state.pending_summary(), None);
    }

    /// Task test (a), second half: an empty-plan cycle ends with the
    /// state fully cleared at `SyncCompleted` — promptly, not via the
    /// idle timeout — and, because the entry was never visible, `clear`
    /// reports `false` so the caller skips the redundant snapshot emit.
    #[test]
    fn empty_plan_cycle_clears_promptly_at_completion() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        // Fast indexing: a tick inside the grace does not promote.
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_secs(1), "drive-a", true, scan(1)),
            PrePlanTick::Invisible,
        );
        // PlanReady with an empty plan disarms…
        state.disarm("drive-a");
        // …and SyncCompleted's clear finds nothing visible.
        assert!(!state.clear("drive-a"));
        assert!(!state.is_any_preparing());
        assert!(!state.is_armed_for_test("drive-a"));
    }

    /// A cycle that was PROMOTED during a long scan and then turns out
    /// to have an empty plan is still cleared promptly by the
    /// `SyncCompleted` clear (which reports `true`: the override was
    /// visible, so the caller emits one snapshot to drop it).
    #[test]
    fn promoted_then_empty_plan_clears_at_completion() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + PREPARING_SURFACE_GRACE, "drive-a", true, scan(10)),
            PrePlanTick::Promoted,
        );
        assert!(state.is_any_preparing());
        assert!(state.clear("drive-a"), "visible override clear must report true");
        assert!(!state.is_any_preparing());
    }

    /// Promotion honours the grace: ticks before it leave the label
    /// armed; the first tick at/after it surfaces the override exactly
    /// once.
    #[test]
    fn promotion_waits_for_grace() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_secs(2), "drive-a", true, scan(1)),
            PrePlanTick::Invisible,
        );
        assert!(!state.is_any_preparing());
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + PREPARING_SURFACE_GRACE, "drive-a", true, scan(2)),
            PrePlanTick::Promoted,
        );
        assert!(state.is_any_preparing());
        // A later tick refreshes (throttled-emit signal), it does not
        // re-report a new surfacing (no duplicate immediate emits).
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_secs(10), "drive-a", true, scan(3)),
            PrePlanTick::Refreshed,
        );
    }

    /// The grace is anchored to the cycle start, NOT the latest tick —
    /// otherwise a steady tick stream would push promotion out forever.
    #[test]
    fn grace_is_anchored_to_cycle_start_not_last_tick() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_secs(4), "drive-a", true, scan(1)),
            PrePlanTick::Invisible,
        );
        // 4.9s… then 5.1s: second tick promotes because 5.1s ≥ grace
        // from t0, even though only 1.1s passed since the previous tick.
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_millis(5100), "drive-a", true, scan(2)),
            PrePlanTick::Promoted,
        );
    }

    /// While the label's upload-processing banner is active
    /// (`allow_promote = false`) scan ticks must never surface the
    /// override — the banner is already the "we're working" signal.
    #[test]
    fn promotion_suppressed_while_banner_active() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        for secs in [6u64, 30, 90] {
            assert_eq!(
                state.note_pre_plan_activity_at(t0 + Duration::from_secs(secs), "drive-a", false, scan(secs)),
                PrePlanTick::Invisible,
            );
        }
        assert!(!state.is_any_preparing());
        assert!(state.is_armed_for_test("drive-a"));
    }

    /// A pre-plan tick with no prior entry arms the label from the tick
    /// itself — covering sparse-tick scans whose armed entry was
    /// idle-drained (e.g. one giant file hashing for minutes between
    /// ticks) — and a follow-up tick past the grace still promotes.
    #[test]
    fn orphan_tick_rearms_and_can_still_promote() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        assert_eq!(state.note_pre_plan_activity_at(t0, "drive-a", true, scan(1)), PrePlanTick::Invisible);
        assert!(state.is_armed_for_test("drive-a"));
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + PREPARING_SURFACE_GRACE, "drive-a", true, scan(2)),
            PrePlanTick::Promoted,
        );
    }

    /// A new cycle re-anchors a stale armed entry's grace clock, so a
    /// leftover from a lost cycle can't make the next cycle's first
    /// tick promote instantly.
    #[test]
    fn new_cycle_rearms_stale_armed_entry() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        // Next cycle starts 30s later (previous one lost its terminal
        // event); its first tick 1s in must NOT promote.
        let t1 = t0 + Duration::from_secs(30);
        state.note_cycle_started_at(t1, "drive-a");
        assert_eq!(
            state.note_pre_plan_activity_at(t1 + Duration::from_secs(1), "drive-a", true, scan(1)),
            PrePlanTick::Invisible,
        );
        assert!(state.is_armed_for_test("drive-a"));
    }

    /// `note_cycle_started` on an already-Marked label (startup seed /
    /// previous promotion) must not demote it — it refreshes the idle
    /// window instead.
    #[test]
    fn cycle_start_on_marked_label_bumps_activity() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0, "drive-a", 3, 300);
        let t1 = t0 + Duration::from_secs(50);
        state.note_cycle_started_at(t1, "drive-a");
        assert!(state.is_any_preparing(), "cycle start must not demote a marked label");
        assert_eq!(state.pending_summary(), Some((3, 300)));
        // Idle window measured from t1, not t0.
        assert!(
            state
                .drain_expired(t0 + PREPARING_WATCHDOG_IDLE_TIMEOUT + Duration::from_secs(5))
                .is_empty()
        );
    }

    /// `disarm` drops Armed entries only; a visible Marked override is
    /// out of its jurisdiction.
    #[test]
    fn disarm_leaves_marked_untouched() {
        let state = PreparingState::new();
        state.mark_preparing("drive-a");
        state.disarm("drive-a");
        assert!(state.is_any_preparing());
        state.disarm("missing"); // absent label is a no-op, not a panic
    }

    /// Post-plan activity bumps Marked labels but never promotes Armed
    /// ones — `PlanReady` already resolved whether this cycle surfaces.
    #[test]
    fn post_plan_activity_bumps_marked_only() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.mark_at(t0, "drive-a", 0, 0);
        state.note_cycle_started_at(t0, "drive-b");
        let t1 = t0 + Duration::from_secs(50);
        state.note_activity_at(t1, "drive-a");
        state.note_activity_at(t1, "drive-b");
        // A sweep 55s in: drive-a is fresh (bumped at t1 — the bump is
        // what this test pins); drive-b is still armed and invisible —
        // its post-plan tick neither promoted nor re-anchored it.
        assert!(state.drain_expired(t0 + Duration::from_secs(55)).is_empty());
        assert_eq!(state.snapshot_labels(), vec!["drive-a".to_string()]);
        assert!(state.is_armed_for_test("drive-b"));
        // And drive-a's idle window is measured from t1, not t0.
        assert!(
            state
                .drain_expired(t0 + PREPARING_WATCHDOG_IDLE_TIMEOUT + Duration::from_secs(5))
                .is_empty()
        );
    }

    /// Stale Armed entries are swept by the idle watchdog too — but
    /// silently: they were never visible, so they must not appear in the
    /// drained list that triggers a snapshot emit.
    #[test]
    fn stale_armed_entry_is_swept_silently() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        let idle = t0 + PREPARING_WATCHDOG_IDLE_TIMEOUT + Duration::from_secs(1);
        assert!(state.drain_expired(idle).is_empty(), "armed drain must not report labels");
        assert!(!state.is_armed_for_test("drive-a"));
    }

    // ── live activity detail ("Preparing — N files scanned") ─────────

    /// Counter flow: ticks update the visible label's live detail, and
    /// the latest value is what `activity_totals` reports to the wire.
    #[test]
    fn activity_ticks_flow_to_totals() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        // Promoting tick carries its counter into the surfaced frame.
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + PREPARING_SURFACE_GRACE, "drive-a", true, scan(120)),
            PrePlanTick::Promoted,
        );
        assert_eq!(state.activity_totals().scanned_files, Some(120));
        // Later ticks keep the counter moving.
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_secs(9), "drive-a", true, scan(560)),
            PrePlanTick::Refreshed,
        );
        assert_eq!(state.activity_totals().scanned_files, Some(560));
        // Phase change: a fetch tick replaces the scan detail for the label.
        let fetch = PreparingActivity::Fetching {
            fetched_entries: 40,
            total_entries: 90,
        };
        assert_eq!(
            state.note_pre_plan_activity_at(t0 + Duration::from_secs(12), "drive-a", true, fetch),
            PrePlanTick::Refreshed,
        );
        let totals = state.activity_totals();
        assert_eq!(totals.scanned_files, None, "fetch phase supersedes the scan counter");
        assert_eq!(totals.fetched_entries, Some(40));
        assert_eq!(totals.fetch_total_entries, Some(90));
    }

    /// Counter reset between cycles: a new `SyncStarted` drops the
    /// previous cycle's detail (its scan restarts from zero), for both
    /// still-visible and armed labels.
    #[test]
    fn counter_resets_when_new_cycle_starts() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        state.note_pre_plan_activity_at(t0 + PREPARING_SURFACE_GRACE, "drive-a", true, scan(500));
        assert_eq!(state.activity_totals().scanned_files, Some(500));
        // New cycle: label stays visible (idle bump) but the stale
        // counter is gone until the new scan's first tick.
        state.note_cycle_started_at(t0 + Duration::from_secs(20), "drive-a");
        assert!(state.is_any_preparing());
        assert_eq!(state.activity_totals(), PreparingActivityTotals::default());
        // Armed labels reset too.
        state.note_cycle_started_at(t0, "drive-b");
        state.note_pre_plan_activity_at(t0 + Duration::from_secs(1), "drive-b", true, scan(7));
        state.note_cycle_started_at(t0 + Duration::from_secs(30), "drive-b");
        assert!(state.mark_at(t0 + Duration::from_secs(31), "drive-b", 0, 0));
        assert_eq!(state.activity_totals(), PreparingActivityTotals::default());
    }

    /// Armed labels track their counter invisibly: totals exclude them,
    /// but a `PlanReady`-style mark surfaces with the counter already
    /// populated instead of a blank first frame.
    #[test]
    fn armed_counter_is_hidden_until_marked() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        state.note_cycle_started_at(t0, "drive-a");
        state.note_pre_plan_activity_at(t0 + Duration::from_secs(1), "drive-a", true, scan(42));
        assert_eq!(
            state.activity_totals(),
            PreparingActivityTotals::default(),
            "armed detail must stay hidden"
        );
        assert!(state.mark_at(t0 + Duration::from_secs(2), "drive-a", 0, 0));
        assert_eq!(state.activity_totals().scanned_files, Some(42));
    }

    /// Cross-label aggregation mirrors `pending_summary`: two drives
    /// scanning at once sum their counters.
    #[test]
    fn activity_totals_sum_across_labels() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        for label in ["drive-a", "drive-b"] {
            state.note_cycle_started_at(t0, label);
            state.note_pre_plan_activity_at(t0 + PREPARING_SURFACE_GRACE, label, true, scan(100));
        }
        assert_eq!(state.activity_totals().scanned_files, Some(200));
    }

    // ── startup pending summary ──────────────────────────────────────

    #[test]
    fn pending_summary_none_when_empty_or_all_zero() {
        let state = PreparingState::new();
        assert_eq!(state.pending_summary(), None);
        // A bare (file-watcher PlanReady) mark carries no count.
        state.mark_preparing("drive-a");
        assert_eq!(state.pending_summary(), None);
    }

    #[test]
    fn pending_summary_sums_across_labels() {
        let state = PreparingState::new();
        assert!(state.mark_preparing_with_summary("drive-a", 3, 300));
        assert!(state.mark_preparing_with_summary("drive-b", 2, 200));
        assert_eq!(state.pending_summary(), Some((5, 500)));
    }

    /// A startup summary landing AFTER a bare `PlanReady` mark must populate the
    /// existing entry's count in place (refreshing the idle window — a re-mark is
    /// an activity signal under idle semantics).
    #[test]
    fn summary_updates_existing_mark_in_place() {
        let state = PreparingState::new();
        let t0 = Instant::now();
        assert!(state.mark_at(t0, "drive-a", 0, 0)); // PlanReady-style, no count
        let t1 = t0 + Duration::from_secs(30);
        assert!(!state.mark_at(t1, "drive-a", 4, 400)); // already present
        assert_eq!(state.pending_summary(), Some((4, 400)));
        // Idle window measured from the re-mark (t1): alive at t0+65s,
        // drained one full idle window after t1.
        assert!(
            state
                .drain_expired(t0 + PREPARING_WATCHDOG_IDLE_TIMEOUT + Duration::from_secs(5))
                .is_empty()
        );
        assert_eq!(state.drain_expired(t1 + PREPARING_WATCHDOG_IDLE_TIMEOUT), vec!["drive-a".to_string()],);
    }

    /// A bare re-mark must NOT wipe a summary already attached.
    #[test]
    fn bare_remark_preserves_existing_summary() {
        let state = PreparingState::new();
        assert!(state.mark_preparing_with_summary("drive-a", 7, 700));
        assert!(!state.mark_preparing("drive-a")); // bare re-mark (count 0)
        assert_eq!(state.pending_summary(), Some((7, 700)));
    }
}
