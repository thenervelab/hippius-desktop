---
paths:
  - "app/(pages)/Sync*"
  - "app/(pages)/syncStatusDialogLogic.ts"
  - "app/lib/hooks/useSync*"
  - "app/lib/hooks/useFileLiveProgress.ts"
  - "app/lib/upload-feed/**"
  - "app/lib/store/syncAtoms.ts"
  - "app/components/page-sections/drive/stagedChangesLogic.ts"
  # This file is the only home of the Rust halves of these invariants
  # (PlanReady gating, fixup_stalled_completion, completed-row ordering,
  # display_reason), so it must load for the backend that implements them.
  - "src-tauri/src/sync/projection/**"
---

# Sync widget and upload feed (frontend)

## Anti-flicker

The sync status widget (`SyncStatusDialog` + `SyncStatusHandler`) uses layered guards to prevent visual flicker:

1. **Unconditional finalization emit** — `finalize_session_for_label` in hcfs-client always calls `runner.emit_snapshot(true)` at exit (mirrors `handle_sync_error`), so any session-state cleanup mutations reach the FE immediately and stale per-chunk snapshots are flushed.
2. **isPreparing suppression** — `SyncStatusHandler` only sets `isPreparing=true` (from `hcfs_sync_started`) when the widget is NOT already visible (tracked via `shouldShowRef`).
3. **Targeted CSS transitions** — `transition-[width]`, `transition-[border-radius]`, `transition-[padding]`, `transition-[opacity]`, never `transition-all`.
4. **Single width source** — the outer wrapper div owns the width via inline style.
5. **Two-state collapsed widths** — `W_COLLAPSED_DONE` and `W_COLLAPSED_ACTIVE`.
6. **Stalled completion fixup** — `fixup_stalled_completion()` in `sync/progress.rs` detects when hcfs-client leaves a session active despite all files being done (the file watcher detecting self-generated writes via `changes_pending`). It overrides `effective_completed`, `effective_in_progress`, `widget_state`, and `status_variant` so the widget shows "Complete" instead of being stuck on "Syncing...".
7. **Stable file row keys** — file rows are keyed by `file.path` only (not `${file.path}-${index}`) so React moves DOM nodes when `snapshot.files` reorders by priority instead of unmount/remount, which avoids ghost text from `transition-opacity` restarts.
8. **Preparing marked at `PlanReady`, not `SyncStarted`** — the per-label `PreparingState` override (`sync/preparing.rs`, drives the red "⟳ Preparing sync…" widget/tray state) is marked in `tauri_bridge.rs`'s `PlanReady` arm, gated on a non-empty plan (`uploads + downloads + local_deletes + remote_deletes > 0`) and `!banner_active_for_label`. Marking it at `SyncStarted` (which fires *before* the plan is known) painted the tray/widget red for the entire scan + remote-fetch window of every periodic no-op cycle. Trade-off: a genuine Finder-drop now surfaces the indicator at `PlanReady` (after indexing) rather than at cycle start. The deeper cause of frequent no-op cycles (hcfs-client re-indexing all remote paths every cycle) is engine-side.
9. **Completed rows ordered newest-first** — `prepare_snapshot_for_emit` (`sync/progress.rs::sort_completed_tail_by_recency`) re-sorts the completed tail by `completed_at` descending for _every_ snapshot, not just on truncation in `cap_snapshot_files`, so a just-finished file surfaces at the top of the completed group instead of being buried by `build_snapshot`'s size-descending order. Group order (active → pending → completed) and pending order are unchanged — the snapshot carries no per-file queue index.
10. **ETA is EMA-smoothed, not just speed** — `resolveSmoothedEta` (`syncStatusDialogLogic.ts`) damps the raw ETA's up-jumps as new files enter the plan (the numerator steps up); smoothing only the speed left the displayed "time remaining" lurching on long queues.
11. **Transfer byte line survives the all-pending seam** — the "X of Y bytes" readout shows whenever the session is in progress with a known total (`showTransferBytes`), decoupled from `hasActiveFile`; only the speed suffix waits for a real transfer.

## Data correctness

The widget's header numbers and its file/upload lists must agree. Invariants:

1. **One byte source for the live header** — the "transferred / total" line is driven by the byte-granular, current-cycle counters (`combinedProgressBytes`/`combinedBytesExpected`, falling back to `progressBytes`/`bytesExpected`) via the pure `selectLiveTransferBytes` (`app/(pages)/syncStatusDialogLogic.ts`), the SAME source `overallPercent` is weighted on and the speed/ETA finite-difference. It deliberately does NOT use the intent overlay (`intentCompletedBytes`/`intentTotalBytes`), which counts only whole-FILE-completed bytes and is summed account-wide — wiring it into the live counter made a single in-flight file read "0B / 260MB" while the ring showed 16%. The intent overlay survives only as the file-count "X of Y" line. The tray mirror in `useTraySync.ts` follows the same rule.
2. **Smoothed percent can move down** — `resolveSmoothedPercent` clamps backward jitter WITHIN a stable plan but re-seeds on a new session, more files queued, a partial failure (`failedFiles` grows), or a re-plan/retry (`bytesExpected` changes), so the ring can't stick at a stale high-water mark.
3. **Completed uploads don't flicker out** — `dedupKey` in `mergeUploadFeed` normalizes both sides of the snapshot↔server join through `normalizeRelPath` (`app/lib/utils/relPath.ts`, mirrors Rust `recent_uploads.rs`'s `trim_start_matches('/')`) so a leading-slash mismatch can't split one file into two rows, and `useRetainedCompletedUploads` keeps a just-finished upload (captured once with a stable timestamp) visible across merges until the server refetch confirms it — bridging the window where it has left `snapshot.files` but the debounced `get_recent_uploads` hasn't landed.
4. **Per-file live progress joins by path, not name** — `findLiveFileMatch` (`app/lib/hooks/useFileLiveProgress.ts`) matches the unique rel-path first (label-scoped) and only falls back to a basename when it's unambiguous, returning no progress on collision rather than binding a row to the wrong file's percent.

All four are unit-tested (`syncStatusDialogLogic.test.ts`, `mergeUploadFeed.test.ts`, `useFileLiveProgress.test.ts`, `relPath.test.ts`).

## Collapsed / minimized form

The widget has a compact circular form (`app/(pages)/SyncStatusMini.tsx` — a percentage progress ring) shown _instead of_ hiding it, in two cases: the **sidebar is collapsed** (the narrow rail can't fit the full 239px card), and the user clicked the widget's **✕ icon**.

The ✕ does not call `sp_dismiss_sync_widget` (which fully hides it in Rust) — it sets the frontend-only `syncWidgetMinimizedAtom` (`app/lib/store/syncAtoms.ts`). This is pure UI presentation state, so it lives in the FE, not Rust; genuine teardown still flows through `sp_dismiss_sync_widget` (e.g. the `hcfs_sync_stopped` listener).

`SyncStatusHandler` ORs the sidebar-collapse state (`sidebarCollapsedAtom`) with `syncWidgetMinimizedAtom` into a single `minimized` flag passed to `SyncStatusDialog`; when set, the dialog renders `SyncStatusMini` (driven by the _same_ percentage/tone/status-text it would show in the full card, so they can't disagree). Clicking the ring (`onExpand`) clears `syncWidgetMinimizedAtom` AND uncollapses the sidebar. A **new sync session** (snapshot `startedAt` change) clears the minimized flag, so a prior minimize doesn't permanently shrink every future sync.

The handler renders in **both** sidebar states and owns its own layout margin: the full card bleeds with `-mx-3` so the 239px card fits the padded sidebar, but the **ring gets no `-mx-3`** so its left edge aligns under the profile avatar. The handler returns `null` when there's no sync so no empty flex slot/gap is left behind.

**Collapse/expand animation**: the ring and the full card mount with a grow keyframe (`tailwind.config.ts`: opacity 0→1 + scale 0.8→1, 0.3s) anchored via `origin-bottom-left` in the sidebar / `origin-bottom-right` in the portal — the sidebar host uses `animate-widget-grow-soft-0.3` (the gentler `cubic-bezier(0.4, 0, 0.2, 1)` curve matching the rail's collapse easing) and the portal host uses `animate-widget-grow-0.3`. The `expandOrigin` prop (`"bottom-left" | "bottom-right"`) threads from `SyncStatusHandler` (by `host`) → `SyncStatusDialog` → `SyncStatusMini`. The keyframe lives on a _wrapper_ around the ring (not the button) so its `forwards` fill doesn't pin the button transform and defeat `hover:scale-105`.

`SidebarFooter` mounts the live `<SyncStatusHandler host="sidebar" collapsed={collapsed} />`.

## Failure copy

The sidebar/tray row renders `FileProgress.error`, which Rust authors in `FileFailureKindPayload::display_reason` (`sync/projection/events.rs`) — never reqwest's Display.

- Transport failures (`Network`, and `Other` messages shaped like `"Network error: error sending request for url (https://…)"`) are remapped to Network. Copy is **"Couldn't reach the server — will retry."** and `is_transient` is true so the row is amber **Retrying** rather than red **Error** (the next cycle resumes from cached chunks; origin/edge resets stringify identically to "no wifi").
- Session-limit 429 (`ServerError { 429 }`, and `Other` carrying `"Too many active upload sessions"`) is the same shape: **"Too many uploads in progress — will retry."**, `is_transient`, amber. Do **not** say "too many devices" — desktop-only can trip the per-drive cap.
- A local file that existed at plan time and is gone at `open()`/`metadata()` (`Other` shaped like `No such file or directory` / `(os error 2)` — hcfs wraps it as `"IO error: …"` with no path) is **Gone**: **"File disappeared before upload — will retry."**, `is_transient`, amber. Remote `FileNotFound` and download HTTP 404 must not become Gone. Match only phrasings the OS emits — a bare `ENOENT` token appears nowhere in hcfs, and two `Other` messages DO interpolate the relative path, so accepting it would let a file named `enoent` launder a 5xx.
- **`fixup_gone_only_failures` (`sync/projection/progress.rs`) is the single place the Gone carve-out clears the Failed verdict**, and it runs in `prepare_snapshot_for_emit` between `fixup_stalled_completion` and `cap_snapshot_files`. Two authors derive `status_variant="error"` from `failed_files > 0` alone — the stalled fixup, and hcfs's `build_snapshot` (`!is_active && failed_files > 0`) once the cycle really closes — so carving Gone out inside only the first made the widget go green and flip back to Failed when the session ended. It only ever downgrades `"error"`.
- It fails closed three ways, and each guard is load-bearing: a non-Gone error (a 5xx still says Failed), a `failed_files` count the visible rows don't explain (the list is capped), and **`completed_files == 0`** — an unmounted volume or a deleted drive root ENOENTs every planned file, which is per-file indistinguishable from one vanished file, and a silent green "Complete" that uploaded nothing is worse than the failure it replaced.
- **The FE must not re-derive "failed" from `snapshot.failedFiles`** — a Gone row still counts there. `hasActionableFailures()` (`app/lib/sync/actionableFailures.ts`) is the shared predicate; the sidebar widget, the tray popover and the tray icon all read it. Trusting an explicit `statusVariant === "success"` is safe because hcfs never pairs it with a non-zero `failedFiles`; only the desktop carve-out does.
- A 5xx or credits failure stays red.

The FE `failureMessage()` for persisted Drive-table badges must stay word-aligned with `display_reason`. **Do not tell the user to check their connection.**

## Review Changes dialog state ownership

The resolution map lives in `ConflictBannerRow`, NOT in `StagedChangesDialog` — the dialog is a controlled presentation component (`resolutions` + `onResolutionsChange`).

`StagedChangesDialog` previously owned it and ran `useEffect(() => setResolutions({}), [stagedChanges])`, keyed on **object identity**; `ConflictEventListener` builds a fresh `staged` object on every `hcfs_conflicts_pending`, which the engine re-emits on each re-stage while review mode is armed, so one arriving mid-review silently wiped every pick. The banner runs `reconcileResolutions` instead (keep picks whose `file_id` the engine still reports, drop the rest so a stale id can never be submitted, return the same object identity when nothing changed). Lifting the state also means closing the dialog — or a sync that never started — no longer costs the user their choices.

Pure projections live in `app/components/page-sections/drive/stagedChangesLogic.ts`, unit-tested in `__tests__/stagedChangesLogic.test.ts`, with render-level wiring pinned in `__tests__/StagedChangesDialog.test.tsx`:

- **`deriveBulkSelection`** drives the "Apply to all" control's value, so the bar and the per-row selects read the same map and cannot disagree. The old bar coloured its four buttons from a static `APPLY_ALL_VARIANTS` table, which permanently tinted "Keep Both" brand-blue — it read as a selected state that never moved. The control is now the shared `SegmentedControl` (sliding indicator, `aria-pressed`, `value: T | null` hides the indicator when the rows disagree), not an ad-hoc `Button` row.
- **`isUnresolvedPathHash` / `describeStagedPath`** stop a bare 64-char hex `FileId` from being rendered in the filename column. `SyncState::display_path` falls back to `hex::encode` when no local side-table names a file, and the dialog was asking users to confirm deleting dozens of hashes from the server. Detection is deliberately strict (exactly 64 lowercase hex, no separator, no extension) so a real hashed build artifact is never mislabelled.
- **Layout**: conflicts render FIRST and the informational plan sections (`PlanSection`) are collapsed disclosure rows carrying their counts, with a warning edge on the two destructive ones. Everything used to sit in one flat 420px scroll container, so the only actionable section was below 60+ rows.

The engine-side half of the hex-path fix is hcfs-client `SyncState::display_path` (path_index → decrypt `remote_encrypted_paths` → `remote_file_names` → hex). Rungs 2 and 3 read `#[serde(skip)]` maps that only a remote fetch populates, so a cold `stage()` still degrades to hex — which is why the FE guard stays regardless of the pin.
