# Drive Lifecycle Serialization + Dead-Code Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Before any Rust task: run `mcp__illu__rust_preflight`, load the `rfr-concurrency` skill, and finish with `mcp__illu__quality_gate` (the seven `self_review_*` answers go in the gate call).

**Goal:** Make a user's Pause deterministically win over any in-flight init/resume for the same drive (closing the race documented in PR #17), and delete the dead `tryInitializeSync` frontend path.

**Architecture:** A per-label *pause epoch* plus a short per-label *commit lock*, both living in `AppState` (the `SyncRunner` is defined in the external `hcfs-client` crate, so it cannot grow fields; `AppState.refresh_locks` already documents the exact per-key lock idiom to mirror). `pause_drive` bumps the epoch inside the commit lock; `initialize_sync_inner` snapshots the epoch at entry and, at its final commit step, atomically checks the epoch under the same lock — unchanged ⇒ clear `is_paused` and keep the registration; changed ⇒ tear down the just-registered drive and return `NotReady`, so the pause's `Paused` state stands. This replaces the `contains_key` heuristic shipped in PR #17 (which only covered the post-register window) with full coverage including the pre-register window, and as a bonus fixes the pre-existing zombie-drive bug where `remove_drive` mid-init let the init re-register a deleted drive.

**Tech Stack:** Rust (tokio, sqlx/SQLite, tauri), TypeScript (React hook cleanup), proptest.

**Invariants established:**
1. *Pause-wins:* if `pause_drive(label)` starts after an init for `label` begins and before that init commits, the final state is `is_paused=1` and the drive is NOT in the in-memory map.
2. *Single-writer:* every write to `sync_paths.is_paused` for a label happens while holding that label's commit lock.
3. *Lock hierarchy:* `commit_lock(label)` → `sync.drives` → progress `std::sync` mutexes. Never the reverse.

---

## Part 1 — Remove dead `tryInitializeSync` (separate small PR)

Verified 2026-06-12: `useHcfsSync`'s only consumer is `DriveContainer.tsx:214`, which destructures `setupAndInitialize, isInitializing, mnemonicToBackup, clearMnemonicBackup` — `tryInitializeSync` is returned but never consumed anywhere (`rg -n "tryInitializeSync" app` → only its definition, interface entry, and return).

### Task 1.1: Delete the dead callback

**Files:**
- Modify: `app/lib/hooks/useHcfsSync.ts` (interface entry ~line 18, callback ~lines 51–96, return entry ~line 150)

**Step 1:** Re-verify deadness (cheap insurance against drift since this plan was written):
Run: `rg -n "tryInitializeSync" app`
Expected: hits only inside `useHcfsSync.ts` (interface, definition, return). If any other file matches, STOP — the plan's premise is stale.

**Step 2:** Delete: the `tryInitializeSync` member from `UseHcfsSyncResult`, the `useCallback` body, and the entry in the hook's `return {...}`.

**Step 3:** Check whether `initializeSync` (imported from `@/app/lib/utils/hcfsConfigUtils`) is still referenced in this file (it was used only at the deleted line ~76). If unreferenced, remove it from the import. Do NOT remove `initializeSync` from `hcfsConfigUtils.ts` itself — `complete_migration_transition`/migration flows still invoke the `initialize_sync` IPC and the util is the typed wrapper.

**Step 4:** Verify:
Run: `pnpm exec tsc --noEmit 2>&1 | rg useHcfsSync` → no output.
Run: `pnpm exec eslint app/lib/hooks/useHcfsSync.ts` → clean.
Run: `pnpm test` → vitest suite unchanged.

**Step 5:** Commit: `chore(frontend): remove dead tryInitializeSync from useHcfsSync`

---

## Part 2 — Per-label lifecycle serialization (main PR)

### Design notes the implementer must read first

- `AppState` is at `src-tauri/src/app_state.rs`. Mirror the `refresh_locks` field (~lines 95–101): outer `std::sync::Mutex<HashMap<...>>` guards only the map insert (never held across an await); the inner `Arc<tokio::sync::Mutex<()>>` guard IS held across the short DB write (async-aware, allowed). Axiom `rust_quality_74_mutex_guard_await` governs: no `std` guard across `.await`.
- `pause_drive` / `resume_drive` / `initialize_sync_inner` / `remove_drive` / `stop_sync` are all in `src-tauri/src/sync/lifecycle.rs`. `set_sync_path_paused` is `src-tauri/src/sync/paths.rs:349`.
- `NotReadyKind` is `src-tauri/src/error.rs:66`. `resume_drive`'s `NotReady` arm prunes `drive_status_cache` and emits nothing (FE then falls back to DB-derived status = Paused — exactly right for "superseded by pause"). `auto_init_sync`'s per-drive `NotReady` arm logs and skips. Both existing arms therefore handle the new variant correctly with zero changes.
- The epoch check at commit makes the PR #17 `contains_key` guard redundant — delete it as part of Task 2.5.

### Task 2.1: `DriveLifecycle` guard module (pure, unit-tested first)

**Files:**
- Create: `src-tauri/src/sync/lifecycle_guard.rs`
- Modify: `src-tauri/src/sync/mod.rs` (add `pub mod lifecycle_guard;`)

**Step 1: Write the failing tests** (in `lifecycle_guard.rs::tests`):

```rust
#[test]
fn snapshot_is_current_until_bump() {
    let g = DriveLifecycle::default();
    let snap = g.snapshot("photos");
    assert!(g.is_current("photos", snap));
    g.bump("photos");
    assert!(!g.is_current("photos", snap));
    // a fresh snapshot after the bump is current again
    assert!(g.is_current("photos", g.snapshot("photos")));
}

#[test]
fn labels_are_independent() {
    let g = DriveLifecycle::default();
    let snap_a = g.snapshot("a");
    g.bump("b");
    assert!(g.is_current("a", snap_a), "bumping b must not invalidate a");
}

#[test]
fn commit_lock_is_per_label_and_stable() {
    let g = DriveLifecycle::default();
    let l1 = g.commit_lock("a");
    let l2 = g.commit_lock("a");
    let l3 = g.commit_lock("b");
    assert!(Arc::ptr_eq(&l1, &l2), "same label ⇒ same lock");
    assert!(!Arc::ptr_eq(&l1, &l3), "different label ⇒ different lock");
}

proptest! {
    /// Monotonicity: a snapshot is current iff zero bumps happened since.
    #[test]
    fn snapshot_current_iff_no_bumps(bumps in 0usize..8) {
        let g = DriveLifecycle::default();
        let snap = g.snapshot("x");
        for _ in 0..bumps { g.bump("x"); }
        prop_assert_eq!(g.is_current("x", snap), bumps == 0);
    }
}
```

**Step 2:** Run `cargo test --lib sync::lifecycle_guard` → FAIL (module/type missing).

**Step 3: Minimal implementation:**

```rust
//! Per-label drive lifecycle guard: pause epochs + commit locks.
//!
//! Why this exists: pause/resume/init for one drive label run as
//! independent tasks (IPC commands + the auto_init fan-out). A pause
//! landing anywhere inside an in-flight init must win — see the
//! pause-overwrite race analysis in PR #17. The epoch answers "did a
//! pause/removal supersede this init?"; the commit lock makes the
//! epoch check and the `is_paused` write one atomic step.
//!
//! Lock hierarchy (deadlock prevention): commit_lock(label) →
//! `SyncRunner::drives` → progress std mutexes. Never the reverse.
//! The outer std mutexes here guard only map access and are NEVER
//! held across an await (axiom rust_quality_74); the returned tokio
//! lock is the one callers hold across their short DB write.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct DriveLifecycle {
    epochs: Mutex<HashMap<String, u64>>,
    commit_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl DriveLifecycle {
    /// Current epoch for `label` (0 if never bumped).
    pub fn snapshot(&self, label: &str) -> u64 { /* read map, default 0 */ }

    /// Invalidate every snapshot taken before now. Called by
    /// pause_drive / remove_drive / stop_sync.
    pub fn bump(&self, label: &str) { /* entry += 1 */ }

    /// True iff no bump happened since `snapshot` was taken.
    pub fn is_current(&self, label: &str, snapshot: u64) -> bool { /* == */ }

    /// Per-label commit lock; same Arc for the same label.
    pub fn commit_lock(&self, label: &str) -> Arc<tokio::sync::Mutex<()>> {
        /* clone-or-insert, mirroring AppState::refresh_locks */
    }
}
```

(`proptest` is already a dev-dependency — see `utils/logs.rs` tests.)

**Step 4:** `cargo test --lib sync::lifecycle_guard` → PASS.
**Step 5:** Commit: `feat(sync): add DriveLifecycle pause-epoch guard module`

### Task 2.2: `apply_init_commit` — the atomic commit step (testable without Tauri)

**Files:**
- Modify: `src-tauri/src/sync/lifecycle_guard.rs` (or `paths.rs` — keep it next to the guard)
- Test: `src-tauri/tests/drive_lifecycle_race.rs` (new integration file)

**Step 1: Write the failing integration tests.** Reuse the `make_pool`/`account_key`/`insert_path` fixtures from `tests/drive_status.rs` (copy; they're ~30 lines). Three cases:

```rust
#[tokio::test]
async fn commit_clears_flag_when_epoch_unchanged() {
    // seed is_paused=1; snapshot; apply_init_commit
    // → Committed, row is_paused=0
}

#[tokio::test]
async fn commit_yields_when_pause_intervened() {
    // seed is_paused=0; snapshot; g.bump(label); pause-sim writes is_paused=1;
    // apply_init_commit → Superseded, row STILL is_paused=1
}

#[tokio::test]
async fn concurrent_pause_and_commit_serialize_on_the_lock() {
    // hold g.commit_lock(label) from a spawned "pause" task that bumps,
    // writes is_paused=1, then releases after a short sleep; concurrently
    // call apply_init_commit with a pre-bump snapshot. Whichever order the
    // runtime picks, the post-state must be is_paused=1 (pause wins).
}
```

**Step 2:** Run `cargo test --test drive_lifecycle_race` → FAIL (function missing).

**Step 3: Implementation:**

```rust
/// Outcome of the init commit step.
#[derive(Debug, PartialEq, Eq)]
pub enum CommitOutcome {
    /// No pause/removal superseded the init: is_paused cleared.
    Committed,
    /// A pause/removal bumped the epoch mid-init: nothing written;
    /// the caller must tear down its registration.
    Superseded,
}

/// Atomically (under the label's commit lock) re-check the epoch and,
/// if still current, clear `is_paused`. The single-writer invariant:
/// every is_paused write goes through a section like this one.
pub async fn apply_init_commit(
    lifecycle: &DriveLifecycle,
    pool: &sqlx::SqlitePool,
    account_id: &str,
    label: &str,
    snapshot: u64,
) -> crate::error::Result<CommitOutcome> {
    let lock = lifecycle.commit_lock(label);
    let _guard = lock.lock().await;
    if !lifecycle.is_current(label, snapshot) {
        return Ok(CommitOutcome::Superseded);
    }
    crate::sync::paths::set_sync_path_paused(pool, account_id, label, false).await?;
    Ok(CommitOutcome::Committed)
}
```

**Step 4:** `cargo test --test drive_lifecycle_race` → PASS.
**Step 5:** Commit: `feat(sync): atomic epoch-checked init commit step`

### Task 2.3: Wire `DriveLifecycle` into `AppState`

**Files:**
- Modify: `src-tauri/src/app_state.rs` — add field after `drive_status_cache`:

```rust
/// Per-label pause epochs + commit locks serializing the lifecycle
/// state writes (pause/resume/init). See sync::lifecycle_guard.
pub drive_lifecycle: crate::sync::lifecycle_guard::DriveLifecycle,
```

plus `drive_lifecycle: DriveLifecycle::default()` in `AppState::new()`.

**Step:** `cargo check` → clean. Commit with Task 2.4 (field alone is inert).

### Task 2.4: Producers — bump the epoch in `pause_drive`, `remove_drive`, `stop_sync`

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs`

**Step 1: Static failing tests first** (extend `tests/drive_status.rs`, same brace-matched body pattern as `initialize_sync_inner_clears_paused_flag`): `pause_drive` body must reference `bump` and `commit_lock`; `remove_drive` body must reference `bump`. Run → FAIL.

**Step 2: Implementation.**
- `pause_drive`: wrap the existing `{remove_drive_inmemory → set_sync_path_paused(true)}` pair:

```rust
let commit_lock = app_state.drive_lifecycle.commit_lock(&label);
let _guard = commit_lock.lock().await;
app_state.drive_lifecycle.bump(&label);
// ...existing remove_drive_inmemory + set_sync_path_paused(true)...
```

(Lock ordering honored: commit lock acquired before `remove_drive_inmemory` touches `sync.drives`.)
- `remove_drive` (via `remove_drive_for_account`): same bump-under-lock before the row delete + teardown.
- `stop_sync`: bump every label currently in `sync.drives` (collect labels first, then bump; logout must invalidate all in-flight inits).
- `resume_drive`: wrap its pre-init `set_sync_path_paused(false)` in the commit lock (no bump — resume doesn't supersede anything). Take and DROP the guard before calling `initialize_sync_inner` (holding it would deadlock against the commit step).

**Step 3:** `cargo test --test drive_status` → PASS. **Step 4:** Commit: `feat(sync): pause/remove/stop bump the drive lifecycle epoch`

### Task 2.5: Consumer — epoch-checked commit in `initialize_sync_inner`

**Files:**
- Modify: `src-tauri/src/sync/lifecycle.rs` (entry + the PR #17 guard block, currently ~lines 1155–1185)
- Modify: `src-tauri/src/error.rs` (new variant)
- Modify: `src-tauri/tests/drive_status.rs` (update the funnel pin)

**Step 1: Update the static funnel test to the new shape and watch it fail:** `initialize_sync_inner` body must reference `snapshot(` near its top AND `apply_init_commit` near its end; the old direct `set_sync_path_paused` assertion moves to `apply_init_commit`'s own body (covered by Task 2.2's tests — keep a body assertion that `apply_init_commit` passes `false`).

**Step 2: Implementation.**
- New `NotReadyKind::SupersededByPause` variant in `error.rs` (doc: "an in-flight init was superseded by a user pause/removal; the drive was not started"). It inherits the correct handling for free: `resume_drive`'s `NotReady` arm prunes the status cache without emitting, and `auto_init`'s arm logs-and-skips.
- At the TOP of `initialize_sync_inner` (before `teardown_previous_drive`): `let lifecycle_snapshot = app_state.drive_lifecycle.snapshot(&label);`
- REPLACE the PR #17 `still_registered` block with:

```rust
match crate::sync::lifecycle_guard::apply_init_commit(
    &app_state.drive_lifecycle, pool, &account_id, &label, lifecycle_snapshot,
).await {
    Ok(CommitOutcome::Committed) => { /* fall through to the Active emit */ }
    Ok(CommitOutcome::Superseded) => {
        // A pause/removal won. Undo OUR registration (the pause's
        // remove ran before our register_drive, or removed an older
        // slot) so the drive doesn't run against the user's intent.
        teardown_previous_drive(sync, &label).await;
        info!(label = %label, "init superseded by pause/removal — torn down, is_paused untouched");
        return Err(crate::error::AppError::NotReady(crate::error::NotReadyKind::SupersededByPause));
    }
    Err(e) => warn!(label = %label, error = %e, "Failed to clear is_paused after successful init"),
}
```

(`teardown_previous_drive` already does exactly the right cleanup: cancel token, drop slot, discard pending activity/progress. DB-write failure keeps the PR #17 warn-and-continue posture — the drive is running and `Committed`-with-failed-write self-heals on the next init.)

**Step 3:** `cargo test --test drive_status --test drive_lifecycle_race --lib sync::lifecycle` → PASS.
**Step 4: Mutation check** (mirror PR #17's): invert the epoch check in `apply_init_commit` (`is_current` → `!is_current`), confirm `drive_lifecycle_race` tests FAIL, revert.
**Step 5:** `cargo clippy --all-targets -- -D warnings` → clean. Commit: `fix(sync): pause deterministically wins over in-flight init`

### Task 2.6: Docs + gate + PR

**Steps:**
1. Update `CLAUDE.md` per-drive status section: replace the "pause-wins guard / contains_key" sentence from PR #17 with the epoch model (one short paragraph; name the lock hierarchy and `SupersededByPause`).
2. `mcp__illu__quality_gate` with the full diff staged (seven `self_review_*` answers; mutation evidence in `tests_run`).
3. PR against `redesign`; run the code-review workflow as on PR #17.

**Acceptance criteria (manual):** with two drives configured, click Resume then immediately Pause on the same folder repeatedly — the folder must always end Paused (DB `is_paused=1`, drive absent from the in-memory map, settings row shows Paused), never silently flip back to syncing.

---

## Explicitly out of scope (YAGNI)

- Serializing *across* labels (per-label locks are correct; cross-label ordering doesn't matter).
- Cancelling the in-flight init's network steps when superseded (it finishes and is then torn down; wasted seconds, no incorrect state — cancellation plumbing through `hcfs-client` is a separate upstream change).
- The repo-wide rustfmt-1.95 / `tsc` test-file debt noted during PR #17 (separate `chore` PR if wanted; not part of this work).

## Execution outcome

All tasks executed 2026-06-12 via subagent-driven development. Deviations from plan:

1. The `Superseded` arm uses `remove_drive_inmemory` + `teardown_last_drive` (terminal teardown) instead of the plan's `teardown_previous_drive` — a review-caught plan defect: `teardown_previous_drive` is the cheap entry-teardown for an init about to re-register everything, and here nothing re-registers, so it would have leaked the label root, watcher path, synced-paths cache, and first-reconcile gate.
2. The TS error-union mirror was updated (`dispatchTauriError.ts`) per the `wire_name` drift-guard contract when `NotReadyKind::SupersededByPause` was added.
3. `stop_sync`'s epoch bump is lock-free, with an inline justification: it writes no `is_paused` state of its own, and any commit that has not yet run re-checks the epoch under the commit lock.

Open follow-ups:

- Identity-aware slot teardown (the Superseded arm's removal is not protected against racing a newer registration).
- `stop_sync` pre-register-window gap — source bump labels from the account's `sync_paths` rows (every init path persists its row before initializing) or add a global epoch component.
- Epoch-gating `spawn_folder_registration` (the spawned registration is not yet supersession-aware).
- Late reconcile-timestamps writes after a supersession.
- No dynamic end-to-end test for the `Superseded` arm — exercising it for real needs a Tauri+HCFS harness; coverage today is the `lifecycle_guard` race tests plus static funnel pins.
- Orphaned `initializeSync` wrapper in `hcfsConfigUtils.ts` and a stale `tryInitializeSync` mention in the `lifecycle.rs` (~line 1627) comment.
- Raw-vs-sanitized label keying of the lifecycle guard (pre-existing class): the producer commands (`pause_drive`, `resume_drive`, `remove_drive_for_account`) key `commit_lock`/`bump`/`snapshot` by the RAW label they receive, while `initialize_sync_inner` keys by the `sanitize_label` output — a label that sanitization rewrites would contend on two different lock/epoch entries. Harden by sanitizing in the producer commands too.
- `resume_drive`'s failure-path `Error` emit still runs outside the commit lock (deliberate: failure-path emit ordering is a lower-stakes pre-existing edge — the init already failed, so there is no competing Active emit to be overtaken by).
