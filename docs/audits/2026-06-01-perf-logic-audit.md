# Hippius Desktop — Performance & Logic Audit: Fix Tracker

Generated 2026-06-01 from a 14-unit fan-out audit (70 agents) followed by a 43-finding deep-evaluation pass (43 independent evaluators re-derived each finding from the live code).

**Result:** 24 valid · 19 partially valid (real but narrower than first reported) · 0 invalid · 0 needs-human.

Severity reflects the *deep-eval* re-assessment, not the original audit. `[HCFS]` = fix lands in the upstream `hcfs` crate (pinned git dep), not this repo. Effort: **S** <1h · **M** half-day · **L** multi-day.

## Summary

| ID | Sev | Eff | Verdict | Area | Title |
|----|-----|-----|---------|------|-------|
| [F01](#f01) | 🟠 high | M | partial | hcfs sync engine (cross-repo) [HCFS] | Stall watchdog cancels every sync cycle that legitimately runs longer than 3 minutes (larg |
| [F02](#f02) | 🟠 high | S | valid | Rust · sync logic | start_server_migration leaks migration.in_progress=true on every error path, permanently w |
| [F04](#f04) | 🟠 high | M | valid | Rust · auth/recovery | reencrypt_all_folder_mnemonics swallows all per-folder failures and returns Ok, silently w |
| [F05](#f05) | 🟠 high | S | valid | Rust · auth/recovery | Process-global LEGACY_TOKEN_MIGRATED flag suppresses auth_session token lookup for a secon |
| [F06](#f06) | 🟠 high | S | valid | Rust · blockchain | Graceful WebSocket stream-end permanently stops block subscription with no reconnect |
| [F03](#f03) | 🟡 medium | S | partial | Rust · sync perf | Per-file completion fires an unthrottled full-snapshot emit, each triggering a spawned SQL |
| [F07](#f07) | 🟡 medium | S | partial | TS · query cache | Low-credit notification never re-evaluates within a session (frozen staleTime:Infinity cac |
| [F08](#f08) | 🟡 medium | M | partial | TS · render perf | FilesTable renders the entire filtered list not the paginated slice infinite scroll is dea |
| [F09](#f09) | 🟡 medium | M | partial | Rust · sync logic | remove_drive/teardown_previous_drive wipe sync_state.json without awaiting in-flight sync  |
| [F10](#f10) | 🟡 medium | S | valid | Rust · sync perf | get_recent_files materializes the full synced-file metadata of every drive (with repeated  |
| [F12](#f12) | 🟡 medium | S | valid | Rust · blockchain | connect_guard held across the entire multi-minute retry loop blocks every blockchain comma |
| [F14](#f14) | 🟡 medium | S | valid | Rust · state/IPC | Frontend still substring-matches AppError Display text in 3 places despite the structured  |
| [F15](#f15) | 🟡 medium | S | valid | Rust · SQLite | sync_paths table-swap migration silently drops is_paused (and relative_paths_backfilled_at |
| [F16](#f16) | 🟡 medium | M | valid | TS · sync hooks | Conflict review is global, not per-drive: cancel_review/pendingConflictsAtom collapse all  |
| [F17](#f17) | 🟡 medium | S | partial | TS · global state | Sync atoms never reset on logout/account-switch — previous account's drive statuses, faile |
| [F18](#f18) | 🟡 medium | S | valid | TS · global state | hasConfiguredDrivesAtom evaluates against the previous account's stale map on next login b |
| [F19](#f19) | 🟡 medium | S | valid | TS · query cache | Nested folder view (files-folder) ignores sync-completed events — listing goes stale after |
| [F11](#f11) | 🟢 low | M | partial | Rust · auth/recovery | validate_master_against_existing_folders silently skips validation when drive_password is  |
| [F13](#f13) | 🟢 low | S | partial | Rust · billing | VM chain-balance guard fails OPEN when the substrate RPC is unavailable, contradicting cre |
| [F20](#f20) | 🟢 low | M | partial | TS · render perf | NotificationItem calls getVersion() Tauri IPC on every item mount and is unmemoized; N not |
| [F21](#f21) | 🟢 low | S | partial | Rust · sync perf | delete_files runs one (often two) SQLite query per file in a batch instead of resolving la |
| [F22](#f22) | 🟢 low | S | valid | Rust · sync perf | add_folder and add_files walk the entire source tree twice (bytes, then count) before copy |
| [F23](#f23) | 🟢 low | S | valid | Rust · auth/recovery | Concurrent token refreshes are not mutually exclusive; TokenRefreshGuard is an advisory bo |
| [F24](#f24) | 🟢 low | S | partial | Rust · crypto | Sub-account seed-phrase encryption is write-only: ciphertext is never decrypted anywhere,  |
| [F25](#f25) | 🟢 low | S | valid | Rust · crypto | migrate_if_needed runs two BIP-39 PBKDF2 key derivations on every login and every boot eve |
| [F26](#f26) | 🟢 low | S | partial | Rust · blockchain | TOCTOU on `running` flag lets two concurrent start_block_subscription calls spawn duplicat |
| [F27](#f27) | 🟢 low | S | valid | Rust · blockchain | get_block_timestamp can spuriously fail with 'RPC client not initialized' due to client/rp |
| [F28](#f28) | 🟢 low | S | partial | Rust · blockchain | to_plancks accepts negative input and returns a malformed negative planck string |
| [F29](#f29) | 🟢 low | S | valid | Rust · billing | Malformed / non-numeric balance string silently parses to 0.0, blocking the user with no d |
| [F30](#f30) | 🟢 low | S | valid | Rust · billing | add_file gates with bytes=0 (legacy floor) whenever metadata() fails, under-pricing the up |
| [F31](#f31) | 🟢 low | S | valid | Rust · state/IPC | drive_removed_notify is a dead wakeup channel: notified at two sites, awaited nowhere; doc |
| [F32](#f32) | 🟢 low | S | valid | Rust · SQLite | set_sync_path_internal runs 4 sequential queries outside any transaction — overlap check c |
| [F33](#f33) | 🟢 low | S | partial | Rust · SQLite | Credits-notification existence checks scan notifications with no index on (notification_ty |
| [F34](#f34) | 🟢 low | S | partial | TS · sync hooks | Tray sync-progress listener and login-status interval are never torn down on logout; only  |
| [F35](#f35) | 🟢 low | M | valid | TS · global state [HCFS] | metadataStaleLabelsAtom clears the entire map on any hcfs_activity_updated, dropping legit |
| [F36](#f36) | 🟢 low | S | partial | TS · auth context | Provider value object is never memoized — every auth state change re-renders all 66 consum |
| [F37](#f37) | 🟢 low | S | valid | TS · auth context | sessionTimeRemaining is a dead context field that still triggers app-wide re-renders |
| [F38](#f38) | 🟢 low | S | partial | TS · query cache | Home 'Credits' tile is stale-by-design next to 6s-polling sibling tiles, creating inconsis |
| [F39](#f39) | 🟢 low | S | valid | TS · render perf | useInfiniteScroll computes a JSON.stringify data signature on every data change |
| [F40](#f40) | 🟢 low | S | valid | TS · render perf | SyncStatusDialog renders the full file list even while collapsed (maxHeight:0) |
| [F41](#f41) | 🟢 low | S | valid | hcfs sync engine (cross-repo) [HCFS] | resolve_rename_hints does full per-cycle rename computation then discards the result (`let |
| [F42](#f42) | 🟢 low | S | partial | TS · sync hooks | useStagedChanges unmount cleanup unconditionally calls cancel_review, clearing all drives' |
| [F43](#f43) | 🟢 low | S | partial | TS · render perf | Each NameCell row mounts 1-2 Radix Tooltip.Provider trees and is not memoized; multiplies  |

---

## F01

### 🟠 HIGH · M effort · partially_valid · `[HCFS]` — Stall watchdog cancels every sync cycle that legitimately runs longer than 3 minutes (large files / many files can never complete)

- **Area:** hcfs sync engine (cross-repo)

**Root cause**

The per-cycle stall watchdog measures wall-clock since cycle start, not since last real I/O. `run_sync_cycle` (runner.rs:1766) calls `reset_progress_time()` once at cycle start, then spawns a watchdog (runner.rs:1771-1784) that every 10s calls `is_progress_stalled()` and, when true, cancels the shared `CancellationToken`. `is_progress_stalled()` (runner.rs:492-498) returns `(now - last_progress_time) > 180`. The ONLY function that advances `last_progress_time` forward during work is `touch_progress_time` (runner.rs:484), and `rg` across the whole hcfs repo confirms it has exactly ONE caller — the PyO3 passthrough `PySyncRunner::touch_progress_time` (python.rs:726), which itself is never invoked from any Rust sync path. So `last_progress_time` is frozen at cycle-start for the entire cycle and the watchdog is a hard 180s wall-clock ceiling. The cancel returns `Err(SyncError::Cancelled)`, which `dispatch_sync_result` (runner.rs:1978) routes to `handle_sync_error` -> `record_sync_failure()` (consecutive_failures++) -> `apply_error_backoff_and_notify` (backoff caps at 300s). `clear_failure_state` runs only on Synced-success / NoChanges, so a perpetually-cancelled file keeps the drive in a backed-off retry loop. HOWEVER the auditor's blast-radius is overstated: cancellation is checked between file operations (manager.rs:313 doc; sync_flow.rs:920-940, 1108-1120), and on cancel the engine drains already-completed uploads/downloads into `state.synced` and saves partial state (sync_flow.rs:514-519). So completed files persist and resumed cycles skip them — many-small-files and multi-file workloads make forward progress across cycles and DO complete. The only thing that can be permanently stranded is a SINGLE file whose own transfer exceeds 180s (e.g. a multi-GB file, or any file on a slow/throttled link): it is spawned, cancelled at 180s while still in flight (try_join_next finds it not done, abort_all kills it), never persisted, and re-attempted from scratch every cycle forever.

**Evidence (re-read)**

runner.rs:492-498 `pub fn is_progress_stalled(&self) -> bool { let last = self.last_progress_time.load(Ordering::Acquire); if last == 0 { return false; } (chrono::Utc::now().timestamp() - last) > 180 }` — wall-clock since last_progress_time. runner.rs:484-486 `pub fn touch_progress_time(&self){ self.last_progress_time.store(chrono::Utc::now().timestamp(), Ordering::Release); }`. `rg "touch_progress_time"` across hcfs returns only runner.rs:484 (def) and python.rs:726-727 (PyO3 wrapper calling self.inner.touch_progress_time()); `rg "last_progress_time"` confirms it is written ONLY by touch (no Rust caller) and reset_progress_time (runner.rs:488, called once at runner.rs:1766) — so nothing inside the sync advances it. Watchdog runner.rs:1771-1784: `loop { sleep(10s); if stall_runner.is_progress_stalled() { error!("Sync stalled — no progress for 3 minutes"); stall_token.cancel(); break; } if stall_runner.is_cancelled() { stall_token.cancel(); break; } }` with stall_token=cancel_token.clone() (1768). Error routing: runner.rs:1978-1980 `SyncResult::Synced { outcome: Err(e), .. } => handle_sync_error(...)`; handle_sync_error 2083 `let failures = runner.record_sync_failure();` then 2091 apply_error_backoff_and_notify; no Cancelled special-case to skip the failure counter. WHAT THE CLAIM GOT WRONG: (1) the parenthetical "thousands of small files can never complete" and "large file never completes" overstate scope — sync_flow.rs:920-940 drains completed uploads into state.synced/state.remote on cancel and sync_flow.rs:514-519 saves partial state, so completed files persist and resumed cycles skip them. Per-file cancel granularity (doc at manager.rs:311-312 "aborts the sync between file operations") means only a single file whose own transfer exceeds 180s is permanently stranded; aggregate workloads of many sub-180s files complete incrementally. (2) Desktop silencing confirmed (tauri_bridge.rs:352 drops error==CANCELLED_MARKER), so the stranded-file symptom is silent — no user error toast — which makes it harder to diagnose, not less real.

**Fix**

Make the stall timer reflect real I/O, not wall-clock. Wire touch_progress_time() into the per-byte/per-chunk progress path so it is called whenever a chunk lands. The progress callbacks already flow through file_op_ctx (sync_flow.rs:885,1073) into upload_file_standalone/download_file_standalone; thread a callback (or the Arc<SyncRunner>/an Arc<AtomicI64> handle) into file_op_ctx so each chunk-progress emission calls touch_progress_time(). Then is_progress_stalled() correctly measures stall (no bytes moved for 180s) instead of cycle duration, and a slow-but-progressing multi-GB transfer is never cancelled. Keep the 180s threshold. Secondary hardening (defense in depth): in dispatch_sync_result / handle_sync_error, when err is SyncError::Cancelled do NOT call record_sync_failure()/apply_error_backoff_and_notify — a cancel (user or watchdog) is not a server/auth failure and should not drive the consecutive_failures backoff; leave failure accounting to genuine errors. This keeps the drive responsive even if a stall is later detected.

_Files:_ `hcfs-client/src/engine/runner.rs`, `hcfs-client/src/drive/sync_flow.rs`, `hcfs-client/src/drive/file_ops (upload_file_standalone / download_file_standalone chunk-progress emit sites)`

_Test to add:_ In hcfs-client, an integration test that uploads/downloads a file via a mock transport that streams chunks slowly (>180s of simulated transfer but a chunk every <180s) with the watchdog active, asserting the cycle returns Ok (not Err(SyncError::Cancelled)) and the file lands in state.synced. Plus a regression unit test asserting touch_progress_time() advances last_progress_time and is invoked by the chunk-progress callback (e.g. spy callback increments a counter). Also a test that a true stall (no chunk for >180s) still cancels.

_Risk:_ Low-to-medium. Threading the progress hook into file_op_ctx touches the hot transfer path — ensure the touch is a cheap relaxed/release atomic store (it is) and not per-byte allocation. Risk of regressing the genuine-stall detection if the callback fires from a keep-alive that isn't real progress; gate touch on actual bytes-transferred deltas. The secondary change (not counting Cancelled as a failure) must preserve the existing user-cancel semantics already relied on by the desktop CANCELLED_MARKER silencing (tauri_bridge.rs:352) — that path is unaffected since it keys on the error string, not the failure counter.

_Notes:_ No Rust diff produced this turn (read-only validation): rust_preflight / data-structure plan / axioms-baseline / quality_gate / critique / exemplars / seven-item self-review checklist are all N/A. Verdict partially_valid, not valid, because the auditor's "thousands of small files / large file never completes" framing is refuted by the partial-state-save + per-file cancel granularity (sync_flow.rs:514-519, 920-940, 1108-1120): completed files persist and resumed cycles skip them, so aggregate workloads complete incrementally. The genuine, narrower bug is that a SINGLE file requiring >180s of its own transfer is permanently stranded and silently retried forever, with consecutive_failures climbing. Severity corrected critical->high: it does not block all sync, it silently strands a class of files (large files / slow links). The fix lands cross-repo in hcfs (hcfs-client), pinned by Cargo.toml git rev in this repo. The desktop side is correct as-is; the events.rs::cancelled_marker_matches_upstream test already pins the marker. touch_progress_time having zero real callers is verified dead-on-arrival watchdog instrumentation — the intended wiring was never completed.

- [UPSTREAM] **F01** — cross-repo hcfs fix; spec in 'Cross-repo (hcfs) upstream work' section below (document-only this session, per user)

---

## F02

### 🟠 HIGH · S effort · valid — start_server_migration leaks migration.in_progress=true on every error path, permanently wedging all sync

- **Area:** Rust · sync logic

**Root cause**

`start_server_migration` (src-tauri/src/sync/migration.rs:642) sets `state.migration.in_progress.store(true, SeqCst)` at line 650 as the very first side effect, then runs a long linear pipeline of ~15 fallible operations that each propagate failure with `?` or `.map_err(...)?`. There is no RAII guard / Drop impl on the flag, and none of the error/early-return paths reset it to false. The flag is an in-memory AtomicBool (MigrationState, migration.rs:976/1005, default false) that is only ever cleared in three places: `dismiss_migration` (L458), `complete_migration_transition` (L520), and process restart (re-init to false). Once it sticks true, `initialize_sync_inner` (lifecycle.rs:953) rejects every non-"migration" label with "Migration in progress — sync blocked" and `auto_init_sync_inner` (lifecycle.rs:1595) returns early with skipped_reason "Migration in progress" — so ALL normal sync init for the logged-in account is disabled for the rest of the session after a single transient migration-start failure.

**Evidence (re-read)**

migration.rs:650-651 (verbatim): `state.migration.in_progress.store(true, Ordering::SeqCst);` then `state.migration.poll_failure_count.store(0, Ordering::SeqCst);`. The fallible operations after the set all leak: L656 `get_server_url(...).map_err(...)?`, L675 `check_disk_space(sync_dir, total_size)?`, L681 `get_mnemonic_for_account(...).await?`, L697-698 `save_encrypted_mnemonic(...).map_err(...)?`, L703-704 mnemonic `parse_in_normalized(...).map_err(...)?`, L711-714 `derive_folder_mnemonic(...).map_err(...)?`, L715-716 folder mnemonic parse, L721-724 `recover_signing_key(seed).map_err(...)?`, L735-738 `fetch_s3_credentials(...).map_err(...)?`, L741-747 `get_api_token(...).map_err(...)?.ok_or_else(...)?`, L773-778 `.send().await.map_err(...)?`, L815-818 retry `.send().await.map_err(...)?`, L823 `return Err(...Migration start failed after retry...)`, L826 `retry_resp.json().await?`, L833 `return Err(...Migration start failed: {text}...)`, L836 `resp.json().await?`. Only the two Ok returns (L829 retry-success, L843 main-success) are reached on success. Reset sites confirmed: dismiss_migration L458, complete_migration_transition L520. Consumers confirmed verbatim: lifecycle.rs:953 `if label != "migration" && app_state.migration.in_progress.load(SeqCst) { return Err("Migration in progress — sync blocked...") }` and lifecycle.rs:1595-1600 `if state.migration.in_progress.load(Ordering::SeqCst) { ... skipped_reason: Some("Migration in progress".into()) }`. CORRECTION to the original claim's line numbers: the HTTP-send leak is at L773-778 (the auditor wrote both "L775" and "L778" — the `?` is on L778); the retry send `?` is at L818 (not L823 — L823 is the retry-fail `return Err`); the retry json-parse leak at L826 was under-counted in the prose list. None of these affect the mechanism. KEY SEVERITY FINDING the auditor under-stated: the sole FE caller, useMigration.ts launchServerMigration (L201-261), in its catch block (L226-258) only sets migrationLockAtom=false, shows a toast, and setCurrentStep("prompt") — it NEVER calls dismiss_migration or complete_migration_transition, so the FE error path does NOT clear the flag. The flag therefore reliably sticks on any start failure; the only user escape without restart is clicking "Skip" (confirmSkip → dismiss_migration). NOTE the auditor got right: there is a separate legitimate `in_progress.store(true)` at migration.rs:334 inside check_migration's "resume tracking" branch — that one is correct and must NOT be guarded; only start_server_migration leaks.

**Fix**

Introduce a small RAII guard in migration.rs mirroring the existing AutoInitGuard (lifecycle.rs:1522-1537). It holds &AtomicBool, stores true on construction is NOT needed — instead set in_progress=true at L650 as today, then construct a guard `struct InProgressGuard<'a>{ flag: &'a AtomicBool, armed: bool }` whose Drop stores false when armed, with a `commit(&mut self)` that disarms it. Construct the guard immediately after the L650 store, then call `guard.commit()` on the two success paths only (just before `return Ok(result)` at L829 and `Ok(result)` at L843). Every `?`-driven unwind then resets the flag while genuine success leaves it set. Do NOT touch the legitimate set at L334 in check_migration. Keep poll_failure_count reset as-is. The guard must reference state.migration.in_progress with the same Ordering::SeqCst used elsewhere.

_Files:_ `src-tauri/src/sync/migration.rs`

_Test to add:_ A Rust integration/unit test that drives start_server_migration into a guaranteed early-return error and asserts the flag is cleared. Cleanest seam: point get_server_url / the migration client at an unreachable URL (or inject a pool with no api_token row so the L741-747 ok_or_else fires), call start_server_migration, assert it returns Err, AND assert state.migration.in_progress.load(SeqCst) == false. Also add a positive test that a simulated success leaves it true (or assert via the guard unit test). Tests touching $HOME must take crate::test_helpers::HOME_LOCK. A focused alternative if full IPC wiring is heavy: extract the guard type and unit-test that dropping it un-armed clears the flag and commit() preserves it — but the integration test through the public command is preferred per axiom 111 (test through the public ingestion path, not internals).

_Risk:_ Low. The only behavioral change is on error paths, which today leak; clearing the flag is strictly more correct. Watch one ordering subtlety: complete_migration_transition (L520) and dismiss_migration (L458) still clear the flag explicitly — harmless double-clear. Verify the guard does NOT clear on the success returns (regression would re-enable sync init mid-migration and let a normal drive race the active server migration — exactly what L953/L334 guard against). Confirm no early `return Ok` exists between L650 and the success points other than the two committed ones.

_Notes:_ Verdict valid, severity high upheld. Re-derived independently: the leak mechanism is exactly as claimed and the blast radius (account-wide sync init block via lifecycle.rs:953 and 1595) is confirmed verbatim. The auditor actually UNDER-stated the trigger reliability: I read the sole FE caller (useMigration.ts:201-261) and its catch block never calls dismiss_migration, so the flag reliably sticks on any start failure rather than "depending on whether the FE catches the error and calls dismiss_migration" — the FE catches it but does NOT clear it. Mitigations that keep this below critical: (1) in-memory only, self-heals on app restart (AtomicBool::new(false) at migration.rs:1005); (2) the user can clear it by clicking Skip in the still-shown prompt (confirmSkip → dismiss_migration); (3) retrying migration start is not itself blocked. What makes it high not medium: the failure is silent for normal sync (no banner tells the user their drives stopped initializing), it is account-wide, and the triggers (server unreachable, expired API token, transient disk-space/mnemonic resolution failures) are realistic. Minor line-number drift in the original evidence noted in evidence_reread; mechanism unaffected. No Rust diff produced this turn (read-only audit) so all Rust workflow gates (preflight, axioms-baseline, data-structure plan, exemplars, critique, quality_gate, seven-item self-review checklist) are N/A.

- [x] **F02 fixed & tested** — committed 1a5a83ea

---

## F04

### 🟠 HIGH · M effort · valid — reencrypt_all_folder_mnemonics swallows all per-folder failures and returns Ok, silently wedging folders after password rotation

- **Area:** Rust · auth/recovery

**Root cause**

reencrypt_all_folder_mnemonics (mnemonic.rs:402-518) runs each folder's enc_mnemonic.json rewrite in an independent per-label future where every failure mode is warn!+return, then unconditionally returns Ok(()) at line 517. align_drive_password (recovery.rs:539-542) commits the NEW drive_password to the DB (save_hcfs_config_internal, line 540) BEFORE rewriting folders (line 541), so a partial folder failure leaves hcfs_config.drive_password=NEW while a folder file is still encrypted under OLD. On the next sync init, prepare_config_dir (lifecycle.rs:1008) -> ensure_derived_mnemonic -> recover_mnemonic(&folder_enc, NEW) (mnemonic.rs:66) fails AEAD with AppError::Hcfs and hard-propagates via `?` BEFORE init_or_unlock_drive's recover_drive self-heal (lifecycle.rs:1043/813) is ever reached, so the drive is permanently wedged. Because change_recovery_password's align Ok branch calls clear_rotation_sidecar (recovery.rs:719) and reports success, the sidecar-driven boot-time retry never fires.

**Evidence (re-read)**

mnemonic.rs:495-517 — save failure path: `Ok(Err(e)) => { tracing::warn!(...,"failed to save folder mnemonic; continuing"); }`, then `futures_util::future::join_all(futures).await;` then unconditional `Ok(())`. All five failure modes (446-454 dir, 463-470 derive, 476-481 create_dir_all, 497-503 save, 504-510 join) are `warn! + return` from the future. Confirmed.
recovery.rs:539-542 — `align_drive_password`: `save_hcfs_config_internal(... new_password ...)?;` (line 540) precedes `reencrypt_all_folder_mnemonics(...)?;` (line 541). DB password is flipped to NEW before folders are rewritten. Confirmed ordering.
recovery.rs:702-719 — on install_recovered_mnemonic Ok, align_drive_password Ok branch falls through to `clear_rotation_sidecar(&account_id).await;` (719). Comment at 697-701 claims "the sync layer's recover_drive self-heal handles any partial folder-rewrite state" — FALSE for the wedge path.
lifecycle.rs:720 — `ensure_derived_mnemonic(&folder_dir, &master_path, drive_password, label)?;` inside prepare_config_dir, called at lifecycle.rs:1007-1008 with `?`, which is BEFORE init_or_unlock_drive at lifecycle.rs:1043.
mnemonic.rs:63 (master) and mnemonic.rs:66 `let folder = hcfs_client::auth::recover_mnemonic(&folder_enc, password).map_err(|e| crate::error::AppError::Hcfs(e.to_string()))?;` — master decodes (rewritten to NEW by install_recovered_mnemonic), folder fails (still OLD). validate_new_password_inputs rejects new==current, so OLD != NEW guarantees the AEAD failure.
lifecycle.rs:1804-1813 — auto-init: non-NotReady error → DriveStatus::Error, no retry; AppError::Hcfs is not NotReady, so it emits a permanent Error.
Corrections to the original claim: the auditor's line numbers and entire chain are accurate. Only nuance — the bug manifests via the rotation path only (change_recovery_password / resume_recovery_password_rotation); seal_and_upload_mnemonic (signup/fresh-device, recovery.rs:617) has no pre-existing folders so it cannot trigger there. Existing test align_drive_password_writes_row_and_reencrypts_folders (recovery.rs:1138) covers only the happy path; no test asserts the failure-returns-Err contract.

**Fix**

Make reencrypt_all_folder_mnemonics return Err when any folder rewrite fails, and reorder align_drive_password so the DB password row is committed only after every folder file is rewritten. (1) In mnemonic.rs, change each per-label future to return Result<(), String> (failing label + error) instead of bare `return`, collect via join_all, and after the loop return Err(AppError::Other(format!("failed to re-encrypt folder mnemonics: {labels}"))) listing failed labels; keep per-folder logging but stop swallowing the aggregate. (2) In align_drive_password, run reencrypt_all_folder_mnemonics BEFORE save_hcfs_config_internal so a partial folder failure aborts before the DB password is flipped, leaving the system fully on OLD (consistent/usable) rather than half-rotated. With both, change_recovery_password's align Err branch (recovery.rs:702-717) already writes+keeps the sidecar so resume_recovery_password_rotation retries idempotently (folder re-derivation is deterministic from master). The reorder means on rotation the server blob is NEW (committed at recovery.rs:686) while DB stays OLD on failure; that is fine because get_drive_password reads the DB and sidecar-driven resume re-runs align to converge. Do BOTH: (1) restores the error contract, (2) closes the half-rotated window.

_Files:_ `src-tauri/src/sync/mnemonic.rs`, `src-tauri/src/recovery.rs`

_Test to add:_ Mirror align_drive_password_writes_row_and_reencrypts_folders (recovery.rs:1138): seed two sync_paths rows; force one folder's save to fail (e.g. create that folder's config dir path as a regular file, or make enc_mnemonic.json read-only) so create_dir_all/write errors. Assert reencrypt_all_folder_mnemonics returns Err naming the failing label while the good folder was still rewritten. Add a second test calling align_drive_password with the same forced failure and assert (a) it returns Err and (b) after the reorder hcfs_config.drive_password still decrypts to the OLD password (not flipped). Locks both the error contract and the ordering invariant.

_Risk:_ Low-to-medium. Behavioral change: rotation now reports failure instead of false success when a folder can't be rewritten (the intended fix), so the FE change_recovery_password flow must surface the Err and the finish-rotation prompt (has_pending_rotation gates on the sidecar, now preserved). Watch: (1) align_drive_password is shared by seal_and_upload_mnemonic and recover_mnemonic which have zero folders, so reorder is inert there — verify existing align test still passes. (2) Keep the migration pseudo-drive filtered (line 438) so its derive failures never enter the aggregate. (3) Confirm no caller treats align_drive_password Err as fatal-to-login; it is only invoked from recovery flows that already have soft Err branches.

_Notes:_ Verdict valid: the auditor's full chain reproduces in the current code with accurate line references. Scope nuance for the fix list: the wedge manifests only via the rotation paths (change_recovery_password / resume_recovery_password_rotation), not signup/fresh-device, because those have no pre-existing folder files. Trigger requires a partial IO failure during the bulk rewrite (disk full, permission, AV file lock, or a spawn_blocking panic) — not an everyday event, which is why this is high not critical: when it fires the impact is a folder permanently locked out of sync with the app falsely reporting rotation complete and no automatic recovery. Fix is local to this repo (mnemonic.rs + recovery.rs); hcfs-client's recover_mnemonic/save_encrypted_mnemonic behavior is correct and unchanged. No Rust diff produced this turn (analysis only): preflight / data-structure plan / axioms / exemplars / critique / quality_gate / self-review checklist all N/A.

- [x] **F04 fixed & tested** — committed 1a5a83ea

---

## F05

### 🟠 HIGH · S effort · valid — Process-global LEGACY_TOKEN_MIGRATED flag suppresses auth_session token lookup for a second account in the same process

- **Area:** Rust · auth/recovery

**Root cause**

A process-global `static LEGACY_TOKEN_MIGRATED: AtomicBool` (tokens.rs:28) guards lookups that are per-account. The optimization assumes "after one full fallback pass the scoped table is authoritative" — but that is only true per-account; the flag is global. Once ANY account walks get_api_token to the terminal Ok(None) (an account with no token in keychain/scoped/legacy/auth_session), line 186 sets the flag for the whole process. Thereafter, for ANY other account, line 145-147 returns Ok(None) before reaching the auth_session fallback at line 174. The auth_session fallback is the ONLY token source for an account restored via session_restore.rs's DB-fallback branch, because that branch (session_restore.rs:373-507) reads the token from auth_session and returns it to the FE without ever calling save_api_token to populate the keychain/scoped table. So sync init for that restored account (lifecycle.rs:1024) gets None and fails with "No authentication token found. Please log in again." despite a valid token existing in auth_session. The flag is never reset (no store(false) anywhere).

**Evidence (re-read)**

tokens.rs:28 `static LEGACY_TOKEN_MIGRATED: AtomicBool = AtomicBool::new(false);` — grep confirms exactly 3 refs (decl, load@145, store(true)@186); NO store(false), never reset on logout/login/switch. tokens.rs:145-147 `if LEGACY_TOKEN_MIGRATED.load(Ordering::Relaxed) { return Ok(None); }` precedes both the objectstore_auth block (150-169) and the auth_session_repo::get_token_and_expiry fallback (174-182). The auth_session branch at 177-181 self-heals via save_api_token (178) and returns Some — so within ONE account the first auth_session hit persists the token to the scoped table and is fine; the bug bites only when the flag was tripped by a DIFFERENT path BEFORE this account's first get_api_token. session_restore.rs:373 `let row = auth_session_repo::get_latest(pool).await?;` and :389 `let Some(auth_token) = row.auth_token` — the DB-restore branch builds oauth_session (426-434) from auth_session data and returns (497-507) WITHOUT ever calling save_api_token; grep of session_restore.rs confirms no save_api_token call. lifecycle.rs:1024-1026 is the exact failing site with the cited error string.

CORRECTION to the auditor's chain — a real mitigation they did not mention: lifecycle.rs:1017-1022 runs a pre-init refresh `if is_token_expiring(...60s) { refresh_auth_token_internal(...) }`, and service.rs:186 in that refresh DOES call save_api_token, which would repopulate the scoped table and mask the bug. BUT is_token_expiring (tokens.rs:195-204) returns false for a token whose expiry is >60s in the future — and restore_session only succeeds for non-expired tokens (session_restore.rs:404-423 rejects expiry>0 && expiry<now). So for the healthy, just-restored, still-valid token the refresh is SKIPPED and the bug is unmasked. The masking only happens for tokens coincidentally near expiry, so the finding stands for the common case. The auditor's location lines (28, 145-188) and the failing call site (lifecycle.rs:1024) are all accurate.

**Fix**

Stop gating the per-account auth_session lookup with a process-global flag. Cleanest fix: delete the global LEGACY_TOKEN_MIGRATED short-circuit entirely — the two skipped queries are cheap single-row indexed SQLite reads that run only on a keychain+scoped miss, so the optimization saves microseconds while breaking correctness. The auth_session fallback already self-heals (save_api_token at tokens.rs:178), so once any account is resolved once it is fast thereafter. If the round-trips are genuinely worth avoiding, key the flag per account: static LEGACY_MIGRATED: OnceLock<Mutex<HashSet<String>>> checked/inserted by account_id (insert only on the legacy objectstore_auth migration path near line 168, NOT on the auth_session path which must always run). Secondary hardening (defense in depth, recommended regardless): make session_restore.rs DB-fallback branch call save_api_token(pool, addr, &auth_token) after a successful restore so the token is never auth_session-only — mirrors the refresh path and the keychain-first invariant.

_Files:_ `src-tauri/src/auth/tokens.rs`, `src-tauri/src/auth/session_restore.rs`

_Test to add:_ In tokens.rs #[cfg(test)] using a temp SqlitePool through the public save/get API (not raw INSERT): test_two_accounts_one_process_flag_does_not_starve_second. (1) Seed account B's token ONLY into auth_session via auth_session_repo::upsert (the path a DB-restore takes). (2) Call get_api_token for account A which has nothing anywhere -> assert Ok(None) and that the flag is now set. (3) Call get_api_token for account B -> assert Ok(Some(token_b)). Without the fix, step 3 returns Ok(None). Add a companion assertion that the DB-restore branch persists to the scoped table once session_restore is wired to save_api_token.

_Risk:_ Low. Removing the short-circuit only adds two indexed single-row SELECTs on the cold path (keychain+scoped both miss); no behavior change when a token is present. The auth_session self-heal already writes back so steady-state perf is unaffected. Watch: ensure removing the flag does not reintroduce the legacy objectstore_auth migration running repeatedly — it deletes the legacy row after migrating (lines 161-167), so it is naturally idempotent. The session_restore save_api_token addition touches the keychain on every DB restore; tolerate keychain-unavailable (save_api_token already falls back to plaintext column and logs).

_Notes:_ The auditor's chain is sound and reproducible; the one thing they missed (the lifecycle.rs:1017-1022 pre-init refresh) does NOT save the finding because that refresh is skipped for the common case of a still-valid restored token (is_token_expiring returns false), which is exactly the state a successful DB restore leaves behind. hcfs-client is not involved — fix is fully local to hippius-desktop. Severity kept at high: a hard, user-facing auth block ("Please log in again") in a supported account-switch / multi-account / boot-ordering flow, recoverable by re-login and data-loss-free, but order-dependent (requires the global flag to be tripped before the restored account's first get_api_token). The order dependence is the only reason it is not critical. No Rust diff produced this turn, so preflight/axioms/exemplars/critique/quality_gate/self-review checklist are all N/A.

- [x] **F05 fixed & tested** — committed 1a5a83ea

---

## F06

### 🟠 HIGH · S effort · valid — Graceful WebSocket stream-end permanently stops block subscription with no reconnect

- **Area:** Rust · blockchain

**Root cause**

subscribe_blocks loops over a subxt finalized-block subscription built on the legacy backend over a plain non-reconnecting jsonrpsee client. subxt 0.38.1 RetrySubscription resubscribes only on a DisconnectedWillReconnect error, which the plain client never emits. A graceful WS close ends the stream as None, RetrySubscription returns None with no resubscribe, subscribe_blocks returns Ok, and the reconnect loop treats Ok as success and breaks permanently. Cleanup sets running and is_connected atomics to false but emits nothing, so the FE stays pinned at isConnected=true. Recovery needs an app restart.

**Evidence (re-read)**

subscription.rs:74-75 reconnect loop matches subscribe_blocks with an Ok arm that breaks, so a clean stream-end breaks permanently. subscription.rs:137 is the while-let and :167 returns Ok on the None exit. subscription.rs:113-116 only stores atomics with no app.emit; the only is_connected=false emit is the Err branch at :94-101. subxt-0.38.1 backend/utils.rs:57 returns None with no resubscribe; utils.rs:51-55 resubscribe only on is_disconnected_will_reconnect. error/mod.rs:125-126 and :157 show that flag is RpcError DisconnectedWillReconnect emitted only by the reconnecting client; jsonrpsee_impl.rs maps failures to ClientError. client.rs:85-86 confirms the plain legacy path. FE app/lib/polkadot-api-context/index.tsx:47 invokes start_block_subscription once behind an initiatedRef guard at line 24; lines 61-67 make block_number_updated the sole source of isConnected and blockNumber with no FE reconnect; rg confirmed no other caller. The original claim is accurate. Refinement: a mid-stream transport Err is also not auto-resubscribed by subxt but it is caught by the ? at line 143 and routed to backoff, so the project reconnect genuinely fails only on the None graceful-close case as claimed.

**Fix**

After the while-let in subscribe_blocks re-check the running atomic. The in-loop break handles intentional stop. If running is still true the exit was a stream None so return Err to route through the existing Err arm which flips is_connected false, emits the disconnect event, clears the client, and backs off before resubscribing. If running is false return Ok.

_Files:_ `src-tauri/src/blockchain/subscription.rs`

_Test to add:_ Refactor the post-loop decision into a pure helper classify_stream_exit taking running bool and returning Result, unit-test that running-true yields Err and running-false yields Ok, plus a test that two Ok blocks then None with running true drives subscribe_blocks to Err.

_Risk:_ Low-to-medium. Reconnect-storm risk if the endpoint accepts then immediately closes is bounded by the existing 5s to 60s backoff and the climbing consecutive_failures counter. No change to 429 handling.

_Notes:_ No Rust diff this turn (analysis only). Verified against subxt 0.38.1 vendored source. Fix is entirely in this repo. Larger alternative effort M: switch client.rs to subxt reconnecting RPC client so subxt resubscribes transparently. Severity high: default endpoint is a public WSS where idle and load-balancer graceful closes are routine, the FE has no independent reconnect, and the failure is silent with a falsely-green connectivity indicator.

- [x] **F06 fixed & tested** — committed 1a5a83ea

---

## F03

### 🟡 MEDIUM · S effort · partially_valid — Per-file completion fires an unthrottled full-snapshot emit, each triggering a spawned SQLite aggregate query that runs before dedup

- **Area:** Rust · sync perf

**Root cause**

The finding bundles two claims with very different validity.

CLAIM A (per-file mark_file_synced => unthrottled emit, N per cycle): largely REFUTED for the common path. hcfs-client's ProgressTracker::update_file_progress flips a non-zero-byte file to FileStatus::Completed on its FINAL byte chunk for BOTH Upload and Download (the `_ =>` arm: `if file.bytes_transferred >= file.total_bytes && file.total_bytes > 0 { file.status = Completed }`). That final chunk tick flows through the THROTTLED desktop path (update_file_progress -> try_claim_snapshot_emit, 100ms completion window). By the time hcfs-client fires on_file_synced, the file is already Completed, so mark_file_synced takes the early-return at progress.rs:304 (`return Ok(file.total_bytes)`) BEFORE reaching emit_snapshot(true) at line 317. The desktop's own comment (progress.rs:279-284) states this happens "for EVERY successful upload." So the auditor's headline scenario (first-sync of thousands of small files => thousands of unthrottled full-snapshot builds from mark_file_synced) does not occur for normal files. The unthrottled per-file emit at progress.rs:317 is only reached for (a) zero-byte files (total_bytes==0 never flips Completed in the tracker) and (b) the rare race where complete_pending_files marked it first. The genuinely unthrottled per-file path is mark_file_failed (progress.rs:375): it has NO pre-emit early-return, so a cycle where many files fail (e.g. an account-wide 402/credit wave mid-migration) produces one unthrottled build_full_snapshot per failing file.

CLAIM B (spawn_snapshot_emit pays the SQLite totals_for_account query BEFORE fingerprint dedup): factually CORRECT (tauri_bridge.rs:802 awaits build_intent_overlay -> totals_for_account at :836, then :804 does try_claim_snapshot_fingerprint), but impact is overstated. The fingerprint dedup only collapses byte-identical snapshots; during active transfer per-file progress changes every emit so fingerprints differ and the emit would fire anyway -- the query is not "wasted." The dedup-skip case only arises in steady state where emits are already throttled to low frequency, and the query runs per snapshot emit, not per chunk-tick (documented at intent.rs:430-437).

**Evidence (re-read)**

progress.rs:304 (early return BEFORE the emit): `return Ok(file.total_bytes);` inside `if file.status == FileStatus::Completed { ... }` -- the auditor cited :317 (`sync.emit_snapshot(true); Ok(observed_bytes)`) as the per-file emit but missed that the function returns at :304 on the common success path, so :317 is rarely reached for non-empty files.

hcfs tracker.rs update_file_progress `_ =>` arm (verified via illu cross-repo, full body): `file.bytes_transferred = file.bytes_transferred.max(bytes_transferred); if file.bytes_transferred >= file.total_bytes && file.total_bytes > 0 { file.status = FileStatus::Completed; file.progress = 100; file.completed_at = Some(now); }` -- this is what pre-marks Completed for Upload and Download. The Decrypt arm deliberately does NOT mark Completed (stays Decrypting until AEAD verify), but it only sets status `if file.status != FileStatus::Completed`, so a prior download-Completed survives decrypt.

progress.rs:375 mark_file_failed: ends `sync.emit_snapshot(true)` with NO status-Completed early-return guard ahead of it -- this is the real unthrottled per-file path (one full snapshot per failing file).

hcfs runner.rs:719-728 emit_snapshot confirmed: `if !immediate && !self.throttle_window_elapsed() { return; } let snapshot = self.build_full_snapshot();` -- immediate=true bypasses the 250ms coalesce and always rebuilds the full snapshot (build_full_snapshot at runner.rs:742 locks state and calls build_snapshot over all files). Correct as cited.

tauri_bridge.rs:801-816 spawn_snapshot_emit: `let overlay = build_intent_overlay(&app).await; let fp = snapshot_fingerprint(&snapshot, overlay); if try_claim_snapshot_fingerprint(&LAST_EMITTED_FINGERPRINT, fp) { ... app.emit(...) }` -- DB read before dedup, confirmed. intent.rs:438-449 totals_for_account is an indexed COUNT/SUM over (account_id,*); author documents it as "off the hot path -- one detached query per snapshot emit, never per chunk-tick" (intent.rs:437).

What the original got wrong: "Net effect for a cycle completing N files: N unthrottled O(session_files) snapshot builds + N SQLite queries" -- this is false for the SUCCESS path (early-return at :304 prevents it). It is true for the FAILURE path (mark_file_failed) and for zero-byte files. The DB-before-dedup waste is real but only bites in steady state, not during the burst the finding describes.

**Fix**

Two cheap, targeted fixes. (1) Route the per-file FAILURE emit through the throttle: in mark_file_failed (progress.rs:375) replace `sync.emit_snapshot(true)` with the same try_claim_snapshot_emit(&LAST_THROTTLED_EMIT_MS, monotonic_now_ms(), true, SNAPSHOT_THROTTLE_MS) gate used in update_file_progress (progress.rs:86), falling back to emit_snapshot(false) when claimed -- a per-file failure does not need a synchronous immediate emit; the next <=100ms completion-window tick reflects it, and end-of-cycle finalize_session_for_label already does an unconditional immediate emit so the final state is never lost. Apply the same gate to mark_file_synced's :317 emit to cover the zero-byte/race residual. Reserve emit_snapshot(true) for genuine session transitions (merge_into_session, remove_files_for_label, completion, error). (2) In spawn_snapshot_emit (tauri_bridge.rs:800), compute the fingerprint over the snapshot scalars+files FIRST and claim it BEFORE awaiting build_intent_overlay, so a deduped emit skips the SQLite query. Because the overlay's five fields also feed the fingerprint today, split snapshot_fingerprint into a snapshot-only hash for the early claim plus an overlay delta check, OR cache the last overlay and only re-query when the snapshot fingerprint changed. Fix (2) alone removes the steady-state wasted query; fix (1) alone removes the failure-storm burst.

_Files:_ `src-tauri/src/sync/progress.rs`, `src-tauri/src/sync/tauri_bridge.rs`

_Test to add:_ In src-tauri/src/sync/progress.rs add a unit test that drives N mark_file_failed calls within one throttle window against a SyncRunner with a counting/fake SyncEventHandler and asserts emit count is throttled (<= ~2) rather than N -- mirrors the existing logic.rs simulates_hot_path_reduction guard but for the completion/failure path. For fix (2), in tauri_bridge.rs add a test that calls spawn_snapshot_emit twice with byte-identical snapshots and a fake IntentRepo/pool whose totals_for_account increments a call counter, asserting the second (deduped) emit does NOT increment the DB-query counter. Both are behavior tests through the public emit path, not direct SQL.

_Risk:_ Throttling the failure emit could delay the failure banner by up to the completion window (100ms) -- negligible and covered by the unconditional finalize emit. The real regression risk is fix (2): the fingerprint currently folds in the overlay's five Option fields (tauri_bridge.rs:858-869 snapshot_fingerprint), so claiming before the overlay query means an overlay-only change (a mark_completed write while no transfer is in flight) would no longer flip the fingerprint and could be dropped. Mitigate by keeping the overlay in the fingerprint but caching the last totals_for_account result keyed by account_id and only re-querying when the snapshot-scalar hash changed. Watch the existing spawn_snapshot_emit_does_not_panic_off_runtime test (tauri_bridge.rs:1163) still passes -- the runtime-handle behavior must be unchanged.

_Notes:_ No Rust diff produced this turn (analysis only): preflight / data-structure-plan / axioms-baseline / exemplars / critique / quality_gate / self-review checklist all N/A. The fix lands entirely in this repo (hippius-desktop), NOT cross-repo: the unthrottled emit_snapshot(true) calls and the DB-before-dedup ordering both live in src-tauri; hcfs-client's emit_snapshot(true)/build_full_snapshot behave exactly as documented and need no change. Key correction for the fix list: severity downgraded high->medium because the auditor's primary scenario (thousands of small-file SUCCESS completions) is guarded by the progress.rs:304 early-return and the upstream final-chunk Completed flip; the genuine residual is the failure-storm path (mark_file_failed unthrottled per failing file, e.g. an account-wide 402 wave mid-migration) plus zero-byte-file bursts. Cross-repo fact-checked via illu against /Users/georgiosdelkos/Documents/GitHub/Bitensor/hcfs (runner.rs emit_snapshot/throttle_window_elapsed/build_full_snapshot, tracker.rs update_file_progress).

- [~] **F03 PARTIAL (failure-path throttle done; spawn_snapshot_emit dedup-before-DB deferred)** — committed b827e7da

---

## F07

### 🟡 MEDIUM · S effort · partially_valid — Low-credit notification never re-evaluates within a session (frozen staleTime:Infinity cache)

- **Area:** TS · query cache

**Root cause**

`useCreditsNotification`'s low-credit effect (useCreditsNotification.ts:34-87) decides whether to fire the "running low on credits" warning by passing `credits.planck` (from `useUserCredits()`) into the Rust `check_low_credit_notification` IPC. `useUserCredits` is configured `staleTime: Infinity` (useUserCredits.ts:33) with query key `["user-credits", addr]` and NO `refetchInterval`/`refetchOnWindowFocus`. No code anywhere invalidates or refetches that key except two manual UI buttons (DetailList "Refresh credits", CreditsWidget). The Rust command does NOT fetch a fresh balance — it parses the passed `credit_balance_planck` string and computes the threshold purely from it (credits.rs:85-86). So once the query resolves at load, `credits` is frozen for the whole session; the effect's `routeChangeKey` dep re-runs it but always with the same stale planck. A user who spends down to <0.5 credits during a session never gets the warning. The bug is real and the mechanism is exactly as described. Severity is overstated, though: the actual spend gate (`require_eligible` in every gated IPC, and `check_action_eligibility` which does a LIVE fetch) is independent of this frozen cache, so the user cannot actually overspend or lose data — the only consequence is a missed proactive UX notification, not financial/integrity harm. Hence medium, not high.

**Evidence (re-read)**

useUserCredits.ts:28-39 — `useInvokeQuery({ command: "get_user_credits", queryKey: (addr) => ["user-credits", addr], options: { staleTime: Infinity, select: ... } })`. No refetchInterval. useInvokeQuery DEFAULT_OPTIONS (useInvokeQuery.ts:10-14) = `{ staleTime: 30_000, refetchOnWindowFocus: false, retry: false }`, then `...config.options` overrides staleTime to Infinity. So no automatic refetch path exists.

useCreditsNotification.ts:79-87 — effect deps `[credits, isCreditsLoading, refreshUnread, areCreditsNotificationsEnabled, routeChangeKey, oauthSession, polkadotAddress]`. The original fixture said deps "include `credits`" — confirmed accurate; `routeChangeKey` is also present but re-running with an unchanged `credits` is a no-op-for-decision because line 48 `credits.planck.toString()` yields the same value.

credits.rs:85-86 — `let planck: u128 = credit_balance_planck.parse().unwrap_or(0); let credit_balance = planck as f64 / 1e18;` then threshold compares `credit_balance >= 0.5`. The Rust side rides entirely on the TS-supplied (stale) value — it never re-queries the chain. This is the load-bearing fact the fix depends on and the auditor did not state explicitly but is correct about.

rg across app/ confirms ZERO `invalidateQueries`/`refetchQueries` targeting `["user-credits"]`; only DetailList.tsx:36 `refetchCredits()` and CreditsWidget.tsx:73,84 `refetch()` (manual buttons). useSyncEvents.ts:112-116 invalidates `DRIVE_STORAGE_STATS_QUERY_KEY` on `hcfs_sync_completed` but NOT user-credits — matching the fixture.

What the original got wrong: severity. It rates "high" and frames the feature as critically broken. The credit GATE is enforced separately with live state — useFilesUpload/index.ts:102-108 explicitly documents the old `staleTime: Infinity` credit check was removed and replaced by `check_action_eligibility` (live fetch) + `require_eligible` IPC enforcement. So no overspend/data-loss; the impact is a missed warning toast/notification only. Also note every sibling balance hook (useAddCreditEvent, useDriveStorageStats, useMarketplaceCredits, useHippiusBalance, useDriveCreditsTotal) polls at LIVE_DATA_REFRESH_MS=6000; useUserCredits is the lone outlier with Infinity — strong corroboration this is an oversight, not intent.

**Fix**

Make the notification path read live balance. Simplest, lowest-risk: in useUserCredits.ts drop `staleTime: Infinity` and add `refetchInterval: LIVE_DATA_REFRESH_MS` (6s) to match every sibling balance hook — get_user_credits returns a fresh CreditBalance per call, so polling yields live data and the effect's `credits` dep changes when the balance moves. If a 6s poll is considered too chatty for display consumers, the alternative is event-driven: add `queryClient.invalidateQueries({ queryKey: ["user-credits", polkadotAddress] })` to the useSyncEvents `hcfs_sync_completed` handler (next to the existing DRIVE_STORAGE_STATS invalidation at useSyncEvents.ts:113) and to the post-upload invalidation in useFilesUpload/index.ts:142, so a charge forces a refetch. Preferred: the refetchInterval change — it is one line, matches the established LIVE_DATA_REFRESH_MS convention, and covers all charge sources (uploads, per-block sync charges) without enumerating event sites. Keep `select` and query key unchanged. No Rust change needed — get_user_credits already fetches live, and check_low_credit_notification correctly acts on whatever planck it is handed.

_Files:_ `app/lib/hooks/api/useUserCredits.ts`

_Test to add:_ Vitest on useCreditsNotification (or useUserCredits): with a QueryClient + mocked invoke, resolve get_user_credits first with a planck above the 0.5 threshold, assert check_low_credit_notification is called with that value; advance fake timers past LIVE_DATA_REFRESH_MS with invoke now returning a below-threshold planck; assert the effect re-runs check_low_credit_notification with the NEW lower planck and (when shouldNotify true) addNotification fires. This locks that the balance is re-read within a session and the warning can fire after first load. Mirror the existing app/lib/hooks/__tests__/useSyncEvents.test.tsx harness for QueryClient setup.

_Risk:_ Low. Switching to a 6s poll increases get_user_credits IPC traffic to the chain query — acceptable since five sibling hooks already poll at the same cadence, so the chain RPC load pattern is established. Watch: (1) display consumers (CreditsWidget, DetailList) will now refresh every 6s instead of staying frozen — verify no flicker/layout shift in the credits widget; (2) if get_user_credits is expensive, consider the event-driven alternative instead. No behavior change on the Rust side. The manual refetch buttons remain valid (they just force an immediate poll).

_Notes:_ No Rust diff this turn (fix is TypeScript query config) — illu Rust gates (preflight / axioms / quality_gate / critique / exemplars / self-review checklist) are N/A for this analysis. Scope correction vs. fixture: mechanism is exactly as claimed (frozen Infinity cache, effect re-runs but with stale `credits`, Rust acts on the passed value, no invalidation anywhere but two manual buttons), so the bug is VALID. Severity downgraded high->medium because the real credit GATE (check_action_eligibility live fetch + require_eligible IPC enforcement, see useFilesUpload/index.ts:102-108) is independent of this cache — the only lost behavior is the proactive low-credit warning notification, not overspend or data loss. Strong corroborating signal: useUserCredits is the lone balance hook using staleTime:Infinity; five siblings poll at LIVE_DATA_REFRESH_MS (6s).

- [x] **F07 fixed & tested** — committed 544e5838

---

## F08

### 🟡 MEDIUM · M effort · partially_valid — FilesTable renders the entire filtered list not the paginated slice infinite scroll is dead weight

- **Area:** TS · render perf

**Root cause**

List view feeds the full filtered list into TanStack Table and renders every row. Table data is the enriched full list at line 926 derived from the allFiles prop not the displayed slice. visibleRows is the full sorted row model at lines 968 to 971 mapped wholesale at line 994. The displayed slice prop is read only at lines 528 785 and 1100 and never bounds rendering. The IntersectionObserver and loadMore bump visibleCount but FilesTable never reads it so pagination is decorative. CardView paginates correctly proving the asymmetry is a bug. Both consumers wire props identically.</parameter>
<parameter name="overlaps">[]

**Evidence (re-read)**

files-table index line 926 data is enrichedAllFiles. Lines 206 to 237 enrichedAllFiles maps over allFiles never files. Lines 968 to 971 visibleRows has no slice. Line 994 maps every row. files prop only at 528 785 1100. use-infinite-scroll index lines 33 to 38 visibleData is the data sliced to visibleCount, initial 50. FilesContent lines 274 to 275 FilesTable gets files as the displayed slice and allFiles as the full filtered list while CardView line 285 gets only the displayed slice. Overstated by the claim, severity high and multi second jank is unverified and only affects users with hundreds to thousands of files in one folder. The per row Radix tooltip claim is wrong for idle rows since SyncStatusIcon returns null for synced at NameCell line 125 and SharedLinkBadge returns null for unshared files and folders at lines 34 and 40. The real per row cost is the NameCell subtree plus a per row action menu wrapper whose Radix content is lazy plus a useSharedFiles call per non folder row. The order N row count and order N log N re sort on every toggle are the genuine cost. No Rust diff this turn and illu does not index app TypeScript so Read and Grep are sanctioned.</parameter>
<parameter name="notes">buffer-after-evidence

**Fix**

Keep table data as the full enriched list so sort runs over all rows, return visibleCount from useInfiniteScroll, thread it through FilesContainer, files-folder and FilesContent into FilesTable, and slice the sorted rows to visibleCount before mapping. Reject option a of feeding the displayed slice as table data because it would sort only the visible 50.

_Files:_ `app/components/page-sections/files/files-table/index.tsx`, `app/components/page-sections/files/FilesContent.tsx`, `app/components/page-sections/files/FilesContainer.tsx`, `app/components/page-sections/files-folder/index.tsx`, `app/lib/hooks/use-infinite-scroll/index.ts`

_Test to add:_ Vitest plus React Testing Library render FilesTable with 200 rows and visibleCount 50 in list view assert 50 rows render then raise to 100 and assert 100, plus a sort correctness test with the smallest name at unsorted index 150 toggle name sort ascending and assert it appears in the first 50.

_Risk:_ Low to medium. Sort must run over the full set before slicing. Select all header already uses the displayed slice so its semantics are unchanged. Enrichment memo and folder nav still see the full list. getRowId stability is unaffected by slicing.

- [x] **F08 fixed & tested** — committed f03a9311

---

## F09

### 🟡 MEDIUM · M effort · partially_valid — remove_drive/teardown_previous_drive wipe sync_state.json without awaiting in-flight sync cycle exit — re-introduces the baseline race the wipe was meant to fix

- **Area:** Rust · sync logic

**Root cause**

`remove_drive` (src-tauri/src/sync/lifecycle.rs:1212-1288) tears down the drive then wipes the on-disk baseline via `clear_persisted_sync_state` (L1275), but never serializes against an in-flight sync cycle for that drive. `AppState.sync` is a single shared `Arc<hcfs_client::engine::runner::SyncRunner>` (app_state.rs:33); `register_drive` inserts one `Arc<TokioMutex<DriveManager>>` per drive into `sync.drives` (lifecycle.rs:358-369). hcfs-client's `trigger_sync_for_drive` (runner.rs:1681-1732) clones that Arc into a `tokio::spawn`ed cycle task, and `run_sync_cycle` (runner.rs:1740-1799) holds `m = drive_arc.lock().await` across `sync_with_resolver_inner`, whose Step 8 persists `sync_state.json` (sync_flow.rs:590) via atomic lock-free `std::fs::rename` (init.rs:241). `remove_drive_inmemory` (lifecycle.rs:282-325) only cancels the per-drive `CancellationToken` and removes the slot (non-blocking `try_lock` to read path; never `.lock().await`s the manager), so it does not await cycle exit. Cancellation is async, and the cancel path STILL saves: sync_flow.rs:514-519 calls `save_sync_state` on `Err(SyncError::Cancelled)`. So the cancelled cycle's save can land AFTER the raw `clear_persisted_sync_state` delete, leaving a stale baseline (and recreating `.bak` via fs::copy, init.rs:237). The only bounded wait (`wait_for_sync_loop_exit`/`teardown_last_drive`, lifecycle.rs:265-276) runs AFTER the wipe and only when `remaining == 0` (L1278); the multi-drive `remaining > 0` path never waits.

**Evidence (re-read)**

CONFIRMED RACE: (1) lifecycle.rs:1217 `remove_drive_inmemory(sync, &label).await` — remove_drive_inmemory (L283-291) does `slot.manager.try_lock().ok()` (non-blocking) then `slot.cancel_token.cancel()`; never awaits the manager lock. (2) lifecycle.rs:1274-1276 `clear_persisted_sync_state(acct, &label)` → L1310 `std::fs::remove_file(&path)` — raw, lock-free. (3) hcfs trigger_sync_for_drive runner.rs:1704-1714 `(slot.manager.clone(), new_token)`; run_sync_cycle line 1 `let mut m = drive_arc.lock().await;` held across `sync_with_resolutions_cancellable`. (4) DECISIVE — sync_flow.rs:514-519: `if matches!(&exec_result, Err(SyncError::Cancelled)) { if let Err(e) = self.save_sync_state(&state).await {...} return exec_result; }` proves cancellation does NOT prevent the baseline save. (5) init.rs:241 `std::fs::rename(&temp, &main)` — fs-atomic save, no advisory lock; ordering vs the wipe is pure timing.

FIXTURE INACCURACIES: (a) Claim that teardown_previous_drive (L982) "inherit[s] the same ordering" of the wipe is FALSE — teardown_previous_drive (L174-196) does NOT call clear_persisted_sync_state; it deliberately preserves the baseline (re-init reuses synced tree). `rg clear_persisted_sync_state src-tauri/src` → one production caller: remove_drive L1275. change_sync_folder (L1475) inherits the race only because it calls remove_drive. (b) "User files nuked" is overstated: hcfs sync_flow.rs:623-633 `SuspiciousEmptyRemote` now refuses an empty-remote-over-nonempty-synced plan, backstopping the exact full-wipe scenario from commit 17b8e159 (delete_remote_folder → empty remote). A non-empty-but-diverged remote still bypasses the guard, so residual risk is PARTIAL local deletes on re-add, not a full wipe — supporting medium, not high. Existing test `clear_persisted_sync_state_removes_baseline_files` (lifecycle.rs:2731-2753) only exercises the helper in isolation with no concurrent writer, so the race is untested.

**Fix**

In remove_drive, serialize the baseline wipe against the in-flight cycle. Make remove_drive_inmemory also return the per-drive Arc<TokioMutex<DriveManager>> (clone it before guard.remove). Then in remove_drive, after the token is cancelled and before clear_persisted_sync_state, acquire-and-drop that manager lock with a bounded timeout: `if let Some(m) = mgr_arc { let _ = tokio::time::timeout(GRACEFUL_SHUTDOWN, m.lock()).await; }`. Acquiring the same TokioMutex the cycle holds in run_sync_cycle guarantees the in-flight save_sync_state (run while that guard is held) has completed before the raw remove_file runs, closing the window. On timeout, log and proceed (best-effort, matching teardown_last_drive's abort fallback). Desktop-only; no hcfs-client change. Do NOT hold sync.drives map lock across this await (drop the map guard, then await the manager) so other drives' cycles aren't blocked. The lower-effort alternative of running wait_for_sync_loop_exit on the remaining>0 path is insufficient: it bounds the run_sync_loop task, not an individual spawned trigger_sync_for_drive cycle.

_Files:_ `src-tauri/src/sync/lifecycle.rs`

_Test to add:_ Add an async #[tokio::test] in lifecycle.rs tests: spawn a task that holds the drive's manager.lock().await, sleeps briefly, then writes sync_state.json and drops the guard (simulating an in-flight cancel-path save); concurrently run the new cancel→bounded-wait→clear_persisted_sync_state sequence; assert sync_state.json and .bak do NOT exist after remove_drive returns. This locks the ordering the existing isolated helper test cannot.

_Risk:_ Low-to-medium. The added bounded lock().await can delay remove_drive by up to GRACEFUL_SHUTDOWN (500ms) when a cycle is mid-flight — acceptable for a destructive action and capped so the IPC never hangs. Watch: acquire the manager Arc and drop the map guard before awaiting; run the wait AFTER the cancel so the cycle is unwinding, not at the start of a fresh long sync.

_Notes:_ No Rust diff this turn (read-only validation) — preflight/axioms/quality_gate/critique/exemplars/self-review gates N/A. Severity kept medium (not high) because the catastrophic full-wipe is backstopped by hcfs SuspiciousEmptyRemote (sync_flow.rs:623-633); residual harm is partial local deletes on same-label re-add against a diverged remote. The race is genuinely untested. Two fixture inaccuracies corrected: teardown_previous_drive L982 does NOT wipe the baseline (wipe is exclusive to remove_drive), and the 'files nuked' framing overstates current impact given the guard. Fix lands entirely in hippius-desktop; a cleaner long-term option is hcfs-client exposing a per-drive 'cycle finished' awaitable, but the desktop-side manager-lock serialization is self-contained and sufficient.

- [x] **F09 fixed & tested** — committed b827e7da

---

## F10

### 🟡 MEDIUM · S effort · valid — get_recent_files materializes the full synced-file metadata of every drive (with repeated clones) to satisfy a limit-bounded lookup

- **Area:** Rust · sync perf

**Root cause**

get_recent_files (files.rs:1071) needs metadata for at most `limit` (the FE always passes 50) recent activity rows, but step 3 calls get_synced_file_metadata(state.clone()) which is whole-corpus and unfiltered. get_synced_file_metadata (files.rs:972-1031) iterates every drive, calls build_synced_paths_from_state(&st) (returns one HashMap<String,SyncedFileInfo> entry per synced file), clones the map into the runner cache (paths.clone(), :997), pushes the owned map into `out`, then a second loop (:1015-1027) allocates a SyncedFileMetadata for EVERY synced file across all drives (per row: rel_path.clone(), info.path_hash_hex(), info.arion_cid.to_string()). get_recent_files then builds meta_map = HashMap::with_capacity(metadata.len()) (:1097) and for every one of those N entries allocates a format!("{}::{}") key and clones arion_hash + arion_cid into a MetadataBundle (:1098-1109) — an N-sized map queried via meta_map.remove(&key) only for the <=50 non_deleted rows (:1147). Allocation/clone work scales with total corpus size while the result is capped at `limit`. The path is hot: the FE hook refetches on every sync_files_completed event with staleTime:0.

**Evidence (re-read)**

files.rs:1080 `let items = sync.get_sync_activity(limit, None);` — bounded by limit; FE caller app/lib/hooks/use-recent-files/index.ts:65-68 passes `limit: 50`, staleTime:0, and refetches on `sync_files_completed_changed`. files.rs:1096 `let metadata = get_synced_file_metadata(state.clone()).await.unwrap_or_default();` then :1097 `HashMap::with_capacity(metadata.len())` and :1098-1109 the per-row format!()-key + arion_hash/arion_cid clone loop. files.rs:1118-1121 `non_deleted` is a filtered subset of `items` (<=limit). files.rs:1147 `let bundle = meta_map.remove(&key);` is the only consumer — at most non_deleted.len() lookups. get_synced_file_metadata waste confirmed: files.rs:996-998 `let paths = build_synced_paths_from_state(&st); sync.update_synced_paths_cache(label, paths.clone()); out.push((label.clone(), paths));` and :1015-1027 the full second loop. Cross-repo confirms unboundedness: SyncRunner::get_sync_activity at hcfs-client/src/engine/runner.rs:685-707 takes `limit: Option<usize>`; build_synced_paths_from_state returns a per-file HashMap. CORRECTION: the finding omits that get_synced_file_metadata has a cache-warming SIDE EFFECT (update_synced_paths_cache, :997) used by the OTHER caller get_user_files via synced_paths_for_label (:860). get_recent_files itself never reads synced_paths_cache, and the cache is independently warmed on the listing path, so a filtered fast-path can safely skip the cache write. Otherwise the finding is accurate.

**Fix**

Stop reusing the whole-corpus get_synced_file_metadata from get_recent_files. Reorder: compute deleted_names + non_deleted (and a HashSet<String> of the <=limit needed `file_name::label` keys) FIRST, then add a bounded lookup that walks the per-drive maps and only allocates for keys in the wanted set. Add a private helper `synced_metadata_for_keys(sync: &SyncRunner, wanted: &HashSet<String>) -> HashMap<String, MetadataBundle>` that reproduces the same drive-arc/try_lock/cache-fallback acquisition as get_synced_file_metadata (files.rs:977-1008) but, in its inner loop over (rel_path, info), skips any entry whose format!("{}::{}", rel_path, label) is not in `wanted` and inserts directly into the bundle map — no intermediate Vec<SyncedFileMetadata>, no with_capacity(N), no per-non-matching-row clones. Keep get_synced_file_metadata as-is for get_user_files. Optionally factor the drive-arc acquisition (:977-1008) into one shared helper to avoid duplication. The cache-warming write at :997 can be retained inside the shared acquisition (lower-risk) or dropped for recent-files since get_user_files warms it independently.

_Files:_ `src-tauri/src/sync/files.rs`

_Test to add:_ Add a #[tokio::test] in src-tauri (tests/hippius_recent_files_metadata.rs or inline mod) that seeds a SyncRunner with one label whose synced_paths_cache holds ~1000 SyncedFileInfo entries (via update_synced_paths_cache) but pushes only a handful of SyncActivityItem rows, calls the bounded lookup helper with the non_deleted key-set, and asserts the returned MetadataBundle map length == number of matching activity rows (NOT 1000). Locks in that lookup allocation scales with the activity window, not the corpus. Pair with fixtures: a non_deleted key with NO matching synced entry (bundle absent -> empty-string fallback at :1148-1151) and a synced entry with no activity row (must be excluded).

_Risk:_ Low-to-medium. Risk 1: the lookup key must stay byte-identical to today's format!("{}::{}", file_name, label) on BOTH sides — get_synced_file_metadata uses the full relative path as file_name (:1019) while activity items use item.file_name; the helper must preserve the exact key derivation. Risk 2: if the cache-warming side effect (:997) is dropped from the recent-files path, confirm get_user_files still warms synced_paths_cache (it does, via synced_paths_for_label :860); retaining the write removes this risk. Watch: drive try_lock contention fallback to cached paths must be kept identical so arion hashes stay visible during active syncs.

_Notes:_ No Rust diff produced this turn (analysis-only validation), so the illu Rust-diff gates (preflight, data-structure plan, axioms baseline, exemplars, critique, quality_gate, and the seven-item self-review checklist) are N/A. The fix is local to hippius-desktop (src-tauri/src/sync/files.rs); build_synced_paths_from_state / get_sync_activity / update_synced_paths_cache are consumed as-is, so cross_repo=false. Severity kept at medium: performance-only waste (no correctness/data-loss impact) but on a hot path (FE staleTime:0, refetch on every sync_files_completed event) scaling with total synced-file count, which can reach tens of thousands. The finding is accurate; my one correction is that it omits get_synced_file_metadata's cache-warming side effect, which widens the fix's design space rather than refuting it.

- [x] **F10 fixed & tested** — committed d295ed60

---

## F12

### 🟡 MEDIUM · S effort · valid — connect_guard held across the entire multi-minute retry loop blocks every blockchain command when the node is unreachable

- **Area:** Rust · blockchain

**Root cause**

get_substrate_client (client.rs:33-48) takes a NAMED guard binding `_guard = connect_guard.lock().await` at line 40 (tokio::sync::Mutex<()>, state.rs:14) that lives until function end, so it spans `connect_and_cache(app_state).await` at line 47. connect_and_cache (lines 82-145) runs an unbounded retry loop (MAX_RETRIES=10, or 3 for 429) with exponential backoff sleeps and NO per-attempt timeout on from_url. The guard is therefore held for the entire retry budget (~190s normal-unreachable, ~60s 429), and every other UI-triggered blockchain command serializes behind `connect_guard.lock().await` with no fast-fail path during an outage.

**Evidence (re-read)**

client.rs:40 `let _guard = app_state.blockchain.connect_guard.lock().await;` — named binding, lives until end of get_substrate_client, spanning client.rs:47 `connect_and_cache(app_state).await`. state.rs:14 confirms `pub connect_guard: tokio::sync::Mutex<()>`. connect_and_cache loop: client.rs:83 `loop {`, client.rs:85 `RpcClient::from_url(&wss_endpoint).await` (no timeout wrapper), client.rs:124/142 `sleep(retry_delay(attempt, rate_limited)).await`. retry_delay (client.rs:67-74): base_secs = 2^min(attempt,5), 429-floored at 30. Normal-unreachable backoff sum across 10 attempts = 2+4+8+16+32+32+32+32+32 ≈ 190s of sleeps alone — the auditor's "~60s normal" UNDERSTATES this (the verify_notes already caught and corrected this). 429 path = 3 attempts ≈ 60s. Slow path is gated by read_cached_client returning None (client.rs:35), so it only fires on first connect or after clear_substrate_client. test_rpc_endpoint (client.rs:188) proves the codebase knows from_url needs a timeout: `tokio::time::timeout(Duration::from_secs(10), ...)`. All grep'd call sites (queries.rs:15/45/130/166, staking.rs:13/73/102/145, transfers.rs:46/90, subscription.rs:126) are reached from #[tauri::command] async fns or the background subscription task — auditor's "17 call sites / every blockchain command" is directionally right but slightly overstated; I count ~14 distinct invoke sites. No early-return, timeout, or separate in-progress flag refutes the finding.

**Fix**

Two complementary fixes, both in src-tauri/src/blockchain/client.rs only. (1) Add a per-attempt timeout to the slow-path connect, mirroring test_rpc_endpoint: wrap the RpcClient::from_url + OnlineClient::from_rpc_client at client.rs:85-86 in tokio::time::timeout(Duration::from_secs(10), ...) so a single attempt cannot block indefinitely on a dead/hung endpoint; treat the timeout as a normal connect failure that feeds the retry/backoff branch. (2) Decouple 'a connect is in progress' from 'wait the whole retry budget' so late callers fail fast: in get_substrate_client, replace the unconditional `connect_guard.lock().await` with `try_lock()` — the task that wins the lock runs connect_and_cache; concurrent callers that fail try_lock return Err immediately as a transient not-ready error rather than queuing for minutes. The winning connector still serializes, the cache re-check after acquiring still dedups, and once connected the fast path (read_cached_client) serves everyone. Optionally also cap cumulative backoff (lower MAX_RETRIES or wrap connect_and_cache in an overall timeout), but the try_lock fail-fast is the core UX fix.

_Files:_ `src-tauri/src/blockchain/client.rs`

_Test to add:_ Add a tokio test (in client.rs or tests/blockchain_commands.rs) pointing wss_endpoint at an unroutable/blackhole address, spawning one task as the connector and a second concurrent task, asserting the second returns Err within a small bound (< 2s) instead of blocking for the full retry budget. A second test asserts a single hung from_url attempt is bounded by the 10s per-attempt timeout. Use tokio::time::pause/advance or a fake endpoint for determinism.

_Risk:_ Low-to-medium. The try_lock change turns a previously-blocking 'eventually succeeds' call into an immediate transient error for concurrent callers during the first connect — UI catch blocks must treat it as retryable (the fn already returns Result so all callers handle Err). Watch for callers that assumed get_substrate_client only errs after exhausting retries; with try_lock they can now err 'in progress' on the first concurrent call. The per-attempt timeout is the safer half (additive bound, matches existing test_rpc_endpoint precedent). Verify the block-subscription reconnect loop retries on the new transient error rather than tearing down permanently.

_Notes:_ No Rust diff produced this turn (read-only validation): preflight / data-structure plan / axioms-baseline / quality_gate / critique / exemplars / self-review checklist all N/A. Confirmed entirely in this repo's src-tauri (client.rs, state.rs, subscription.rs) — the retry loop lives here, NOT in the hcfs cross-repo dep, so the fix is local (cross_repo=false). Auditor's two minor overstatements: (a) "17 call sites" — I count ~14 distinct invoke sites; (b) "~60s normal" — actual normal-unreachable backoff is ~190s of sleeps, an understatement that makes the finding worse, not better. Neither weakens the verdict. Severity kept at medium: outage-only responsiveness/UX degradation, no data loss, no crash, and Tauri commands run on a worker pool so the UI thread isn't frozen — but every blockchain command serializes behind the guard during an outage.

- [x] **F12 fixed & tested** — committed cb9361a4

---

## F14

### 🟡 MEDIUM · S effort · valid — Frontend still substring-matches AppError Display text in 3 places despite the structured `subkind` field added specifically to eliminate it

- **Area:** Rust · state/IPC

**Root cause**

The Rust `AppError::serialize` impl (error.rs:168-173) emits a stable machine-readable `subkind` field for `NotReady` errors precisely so the FE can stop matching English Display strings, and its own doc comment (error.rs:137-145) states this goal verbatim. But three live FE matchers still gate on substrings of `message` (which is `self.to_string()`, i.e. raw Display output, error.rs:172): `isNotReady`'s `e.message.toLowerCase().includes(substring)` and `dispatchSigningError`'s `e.message.includes("re-entering your seed phrase")`. Because `message` is the Display text, any reword of NotReadyKind::InsufficientCredits / MasterMnemonicUnrecoverable / SigningKeyUnavailable Display strings silently breaks the credit dialog, the auto-init retry, and the reauth toast — no compile error, no test failure. The robust `switch(typed.subkind)` pattern already exists in useMigration.ts:234-253, proving the intended contract is applied inconsistently.

**Evidence (re-read)**

error.rs:172 `s.serialize_field("message", &self.to_string())?;` — message IS the Display output, so a reword propagates straight into the FE-matched string. error.rs:137-145 doc comment: "The frontend can then dispatch on `err.subkind` instead of pattern-matching English substrings of `err.message` — the substring match was fragile and broke silently whenever the Display text was reworded." Display strings keyed on: error.rs:131 `write!(f, "Insufficient credits to perform this action.")`, error.rs:118 MasterMnemonicUnrecoverable (contains "mnemonic"), error.rs:127 SigningKeyUnavailable (contains "re-entering your seed phrase"). dispatchTauriError.ts:59-64 `if (e?.kind !== "NotReady") return false; ... return typeof e.message === "string" && e.message.toLowerCase().includes(messageSubstring.toLowerCase());`. dispatchTauriError.ts:83-87 `e?.kind === "NotReady" && typeof e.message === "string" && e.message.includes("re-entering your seed phrase")`. Call sites confirmed: upload-files-flow/index.tsx:87 `isNotReady(err, "insufficient credits")`; useHcfsSync.ts:256 `isNotReady(err, "mnemonic")`. Correct pattern: useMigration.ts:236 `switch (typed.subkind) { case "NOT_ENOUGH_DISK_SPACE": ... case "MASTER_MNEMONIC_UNRECOVERABLE": ...}`. TWO scope corrections, both BROADENING the finding: (1) `dispatchSigningError` has THREE live call sites, not one — StakeWidget.tsx:46, stake-bridge/index.tsx:100, unstake/index.tsx:72 — so the reauth toast is brittle across all three wallet signing flows. (2) `isNotReady(err, "mnemonic")` at useHcfsSync.ts:256 is more fragile than the auditor stated: the sync init path raises several NotReadyKind variants (NoEncryptionKey, DriveNotInitialized, DriveNotUnlocked, SyncSetup, MasterMnemonicUnrecoverable per rg over sync/*.rs), and the substring "mnemonic" matches ONLY MasterMnemonicUnrecoverable by accident of current wording — a `subkind === "MASTER_MNEMONIC_UNRECOVERABLE"` check would be exact. One nuance the original missed: the existing Rust test `not_ready_kind_display_all_variants` (error.rs:504-526) pins the exact Display strings, but it pins them to themselves (a reword edits Display + test together) and is in NO way linked to the FE substrings, so it does NOT protect the FE matchers.

**Fix**

Migrate the three matchers off Display text onto the existing `subkind` discriminant. (1) Change `isNotReady` to accept an optional `NotReadyKind` SCREAMING_SNAKE constant and compare `e.subkind === expected` instead of substring-matching `e.message`; keep the `kind === 'NotReady'` gate. (2) Change `dispatchSigningError` to gate on `e.subkind === 'SIGNING_KEY_UNAVAILABLE'`. (3) Update upload-files-flow/index.tsx:87 to `isNotReady(err, 'INSUFFICIENT_CREDITS')` and useHcfsSync.ts:256 to `isNotReady(err, 'MASTER_MNEMONIC_UNRECOVERABLE')` (the latter also fixes the accidental-substring imprecision). Optionally export a `NotReadyKind` string-union type in dispatchTauriError.ts so the constants are typo-checked by tsc. As a Rust backstop, add a test that pins the FE-facing subkind wire values (the SCREAMING_SNAKE names) since those, not the Display strings, are now the contract — mirroring the `cancelled_marker_matches_upstream` pattern in sync/events.rs:129. The Display-string reword risk then disappears entirely because no FE code reads `message` for control flow.

_Files:_ `app/lib/utils/dispatchTauriError.ts`, `app/components/page-sections/files/upload-files-flow/index.tsx`, `app/lib/hooks/useHcfsSync.ts`, `src-tauri/src/error.rs`

_Test to add:_ Frontend (vitest, colocated dispatchTauriError.test.ts): assert isNotReady({kind:'NotReady',subkind:'INSUFFICIENT_CREDITS',message:'<any reworded text>'},'INSUFFICIENT_CREDITS') === true and that it returns false when subkind differs, proving message wording is irrelevant; same for dispatchSigningError keyed on subkind. Rust (error.rs tests): a test asserting serde_json::to_value(&AppError::NotReady(NotReadyKind::InsufficientCredits))['subkind'] == 'INSUFFICIENT_CREDITS' (and the other two FE-consumed variants), pinning the wire contract the FE now depends on so a rename of the enum variant fails CI loudly.

_Risk:_ Low. Behavior-preserving for current wording. Watch: (a) every catch block must receive the structured object (plain object from invoke), not an Error instance — already the case here; (b) ensure no OTHER caller passes a free-text substring to isNotReady (rg confirms only the two call sites exist); (c) the optional `messageSubstring===undefined => match any NotReady` branch must be preserved for callers that only check kind. No cross-repo change; SigningKeyUnavailable/InsufficientCredits/MasterMnemonicUnrecoverable are all raised within src-tauri, and the subkind values already ship today.

_Notes:_ No Rust diff produced this turn (validation only); the four illu Rust workflow gates and the seven-item self-review checklist are therefore N/A. src-tauri/ is not illu-indexed, so error.rs and the sync/*.rs scans used Read + rg as sanctioned fallback; app/ TS was read directly. Verdict valid (not partially_valid) because the core mechanism is exactly as claimed and verified line-for-line; the only deviations from the writeup make the impact slightly broader (3 dispatchSigningError call sites, not 1; the 'mnemonic' substring matches by luck), not narrower. Severity medium is appropriate: silent UX regressions (credit-insufficient dialog never opens, reauth toast across 3 wallet flows degrades to generic toast, auto-init retry loses its retry signal) with no data loss and no automated detection.

- [x] **F14 fixed & tested** — committed 303c3ae0

---

## F15

### 🟡 MEDIUM · S effort · valid — sync_paths table-swap migration silently drops is_paused (and relative_paths_backfilled_at) — loses user pause state

- **Area:** Rust · SQLite

**Root cause**

In `ensure_table_schema` (src-tauri/src/utils/schema.rs), the per-boot ALTER migrations add `is_paused` (line 157) and `relative_paths_backfilled_at` (line 172) to the live `sync_paths` table BEFORE the constraint-recreation swap block (lines 185-242) runs. The swap triggers whenever the stored DDL lacks `UNIQUE(owner, label)` (e.g. an old DB created with `UNIQUE(owner, type)` — ALTER never rewrites the constraint, so `sqlite_master.sql` keeps the old DDL and `has_correct_constraint` is false at line 192). The copy INSERT (lines 225-233) selects only `(id, owner, path, type, label, timestamp)`. `sync_paths_new` declares `is_paused INTEGER NOT NULL DEFAULT 0` (line 214) and has no `relative_paths_backfilled_at` column at all, so after `DROP TABLE sync_paths` + `RENAME`, every surviving row takes the defaults: `is_paused=0`, `relative_paths_backfilled_at=NULL`. A user who paused a drive on the old-constraint schema is silently un-paused (sync resumes against intent), and the backfill flag reset re-triggers the one-shot relative_path backfill on next init. This is a one-time loss per DB: once the swap runs, the new table has the correct constraint and the block never runs again.

**Evidence (re-read)**

schema.rs:155-160 — old table gets `is_paused` via `ALTER TABLE sync_paths ADD COLUMN is_paused INTEGER NOT NULL DEFAULT 0` (runs first). schema.rs:170-175 — `relative_paths_backfilled_at INTEGER` added via ALTER (also before swap). schema.rs:186-192 — `has_correct_constraint` is computed from `sqlite_master` DDL containing `UNIQUE(owner, label)`; an old `UNIQUE(owner, type)` DB fails this, so the else branch runs. schema.rs:207-216 — `sync_paths_new` has `is_paused INTEGER NOT NULL DEFAULT 0` and NO `relative_paths_backfilled_at` column. schema.rs:225-233 — the lossy copy: `INSERT OR IGNORE INTO sync_paths_new (id, owner, path, type, label, timestamp) SELECT id, owner, path, type, label, timestamp FROM sync_paths ...` — both preserved columns omitted. schema.rs:235-237 — `DROP TABLE sync_paths` then `RENAME` makes the loss permanent. Consumption confirmed: sync/relative_path_backfill.rs:176 reads `relative_paths_backfilled_at` (NULL ⇒ backfill re-runs); sync/paths.rs:173-186 reads `is_paused` into the per-drive status. main.rs:574 runs `ensure_table_schema` (the lossy swap) BEFORE user_stopped_migration (588) and user_stopped_reversal (595), and those one-shots are sentinel-gated and do NOT restore a user's genuine post-migration pause. Test gap confirmed: the only relevant test, schema.rs:804-816 `sync_paths_has_required_columns_after_schema_ensure`, asserts columns EXIST but never seeds an old `UNIQUE(owner,type)` table with `is_paused=1` and never asserts the VALUE survives; `temp_pool()` (line 680) always builds a fresh schema, so the swap branch is never exercised with pre-existing data. Scope correction to original claim: the `relative_paths_backfilled_at` reset is NOT data loss — it only forces a redundant one-shot backfill (extra work + transient "Indexing folders…" banner). The medium severity is carried entirely by the `is_paused` silent un-pause. Original claim is otherwise accurate; it also missed that sync_paths_new lacks the relative_paths_backfilled_at column entirely (must be added to the CREATE, not just the copy lists).

**Fix**

In the swap INSERT (schema.rs:225-233), copy the preserved columns conditionally on the `sync_paths_cols` HashSet already read at line 144 (which reflects the OLD/source table's columns at swap time, since the ALTERs at 149/157/172 ran against it first). Build the column lists dynamically: always include (id, owner, path, type, label, timestamp); append `is_paused` to both the INSERT column list and the SELECT list iff `sync_paths_cols.contains("is_paused")`; do the same for `relative_paths_backfilled_at` (and add that column to the `sync_paths_new` CREATE at lines 207-216, which currently lacks it entirely — without that the column cannot be carried even when present in the source). Keep `OR IGNORE` and the `ORDER BY CASE type` dedup tie-break unchanged. Because the source may be a very old schema predating these columns, the HashSet gate keeps the SELECT valid against tables that genuinely lack them.

_Files:_ `src-tauri/src/utils/schema.rs`

_Test to add:_ Add a #[tokio::test] in schema.rs that: (1) on a temp pool, manually CREATEs a sync_paths table with the legacy `UNIQUE(owner, type)` DDL plus `is_paused` and `relative_paths_backfilled_at` columns, (2) INSERTs a row with is_paused=1 and a non-NULL relative_paths_backfilled_at, (3) calls ensure_table_schema, (4) asserts the migrated table now contains UNIQUE(owner, label) in its DDL AND that the row still has is_paused=1 and the original relative_paths_backfilled_at value. This both locks the fix and is the first test to exercise the swap branch with pre-existing data.

_Risk:_ Low. Change is confined to the migration copy path that runs once per old-constraint DB. Watch: (a) the dynamically-built SQL must keep INSERT and SELECT column counts equal — a format/concat mismatch silently corrupts the copy, so the new test must assert values not just column existence; (b) adding `relative_paths_backfilled_at` to sync_paths_new CREATE must match the live `sync_paths` CREATE (line 128) type (INTEGER, nullable) so post-migration DDL is identical across fresh-vs-migrated paths; (c) ensure the OR IGNORE dedup still drops the correct duplicate when carrying is_paused (no behavior change expected since dedup is on owner,label).

_Notes:_ No Rust diff produced this turn (read-only validation) — Rust workflow gates (preflight, data-structure plan, axioms-baseline, exemplars, critique, quality_gate, adversarial self-review checklist) are N/A. Scope correction vs. original: is_paused loss = real silent un-pause (the medium-severity core, violates CLAUDE.md's "is_paused represents user intent and must survive"); relative_paths_backfilled_at reset = real but only redundant backfill work, not data loss. One-time-per-DB loss (swap self-disables after first run). The suggested gating on the line-144 HashSet is correct, but the original suggested_fix missed that sync_paths_new (lines 207-216) has no relative_paths_backfilled_at column at all — that column must be added to the CREATE for the copy to carry it.

- [x] **F15 fixed & tested** — committed cb9361a4

---

## F16

### 🟡 MEDIUM · M effort · valid — Conflict review is global, not per-drive: cancel_review/pendingConflictsAtom collapse all drives into one, losing conflicts

- **Area:** TS · sync hooks

**Root cause**

The multi-drive sync engine emits conflict-review events per-drive (each carries a `label`), and syncs all drives concurrently so events interleave. But the FE conflict-review state and the cancel_review IPC are single-global: pendingConflictsAtom is one StagedChanges (not keyed by label), ConflictEventListener discards payload.label on write and clears the atom on ANY drive's completion/error, and cancel_review calls clear_all_reviews() (which iterates every drive's state) instead of the existing per-label clear_drive_review(label). With >1 configured drive, a second drive's conflicts overwrite the first, a third drive's clean cycle wipes still-pending conflicts, and cancel cancels every drive at once.

**Evidence (re-read)**

All four cited locations re-read and confirmed.

(1) Label dropped: ConflictEventListener.tsx:24-26 — `const payload = event.payload as { label: string; staged: StagedChanges }; setPendingConflicts(payload.staged);` writes only `staged` into the single global atom. syncAtoms.ts:5 — `export const pendingConflictsAtom = atom<StagedChanges | null>(null);` (single global, not keyed by label). The backend payload genuinely carries a label: events.rs:242-245 `ConflictsPendingPayload { label, staged }`, emitted per-drive at tauri_bridge.rs:462. So a second drive's ConflictsPending overwrites the first's staged set.

(2) Any-drive completion wipes all: ConflictEventListener.tsx:28-30 `["hcfs_sync_completed", () => { setPendingConflicts(null); }]` — the SyncCompletedPayload carries a label the listener ignores. A third drive's clean cycle clears another drive's still-pending conflicts. Same for hcfs_sync_error (lines 31-33).

(3) cancel_review is global: control.rs:189 `pub async fn cancel_review(app: tauri::AppHandle)` takes no label and calls `sync.clear_all_reviews()` (control.rs:194). Confirmed in hcfs-client runner.rs:530-539 — `clear_all_reviews` does `for s in states.values_mut()` clearing in_review/review_entered_at for EVERY drive (vs. the per-label `clear_drive_review(label)` at runner.rs:519-528). The per-label primitive already exists and is already used correctly inside sync_with_conflict_resolutions (control.rs:128), proving only cancel_review regresses to the global one. So useStagedChanges' label='default' default (useStagedChanges.ts:16) is indeed meaningless for cancel.

WHAT THE FINDING UNDERSTATED — an additional, arguably worse failure mode: ConflictsBanner.tsx is the sole reader of the atom (line 13) and constructs useStagedChanges() with NO label (line 15), so it defaults to 'default'. When the banner displays drive B's conflicts (B won the atom race) and the user clicks Review & Resolve → handleSync → syncWithResolutions, control.rs:60 receives label='default' and applies B's resolution decisions to the 'default' drive (control.rs:94-96). control.rs:66-71 validates only the resolution STRING values, not that FileIds belong to the target drive — so resolutions chosen for one drive's files route to a different drive. Misapplied-resolution bug, not just dropped/cancelled.

Nothing in the original claim is wrong; severity is conservatively rated.

**Fix**

Make conflict-review state per-drive end to end. FE: change pendingConflictsAtom from atom<StagedChanges|null> to atom<Map<string, StagedChanges>> (mirror driveStatusesAtom in unpinAtoms.ts). In ConflictEventListener set/delete the Map entry by payload.label; on hcfs_sync_completed/hcfs_sync_error/hcfs_review_mode_timeout read the label off the payload and delete only that entry (all three payloads carry label). ConflictsBanner renders one banner per Map entry and passes that entry's label into useStagedChanges(label) so syncWithResolutions/cancelReview target the correct drive. Backend: add label: String param to cancel_review (control.rs:189) and call the existing sync.clear_drive_review(&label) instead of clear_all_reviews(); keep clear_all_reviews only for logout/reset. Optionally harden sync_with_conflict_resolutions to reject FileIds not in the target drive's staged set so a wrong-label call errors instead of silently misapplying. Minimal interim if full per-drive UI is deferred: ignore completion/error events whose label != the label currently in the atom, and thread label through cancel_review.

_Files:_ `app/lib/store/syncAtoms.ts`, `app/(pages)/ConflictEventListener.tsx`, `app/components/ui/ConflictsBanner.tsx`, `app/lib/hooks/useStagedChanges.ts`, `src-tauri/src/sync/control.rs`

_Test to add:_ Rust: a control.rs test asserting cancel_review(label) clears only that label's review state (set in_review on two drives via the runner, cancel one, assert the other still in_review) — proves the clear_all_reviews→clear_drive_review swap. FE (vitest): a ConflictEventListener test firing hcfs_conflicts_pending for label 'a' then 'b' asserting both Map entries coexist; then fire hcfs_sync_completed for 'a' and assert only 'a' is removed while 'b' survives. Optionally a ConflictsBanner test asserting the label passed to useStagedChanges matches the displayed drive.

_Risk:_ Medium. ConflictsBanner currently renders a single banner; moving to a Map means N banners or a drive selector — UI churn and possible visual regressions. The atom type change is a breaking shape change for readers (verified only ConflictEventListener writes and ConflictsBanner reads, so blast radius is small). The cancel_review signature change touches a registered Tauri command — all three call sites (useStagedChanges.ts cancelReview, the unmount safety-net at line 72, and ConflictsBanner.tsx:27) must pass a label or be given a path. Watch the unmount safety-net cancels: they fire without a label today and must not become no-ops or clear the wrong drive.

_Notes:_ Fix lands entirely in hippius-desktop: the per-drive primitive clear_drive_review(label) already exists in hcfs-client (runner.rs:519-528) and is already used by sync_with_conflict_resolutions, so no hcfs change is required — only swapping which existing function cancel_review calls, plus the FE/atom rework. The optional FileId-ownership hardening in sync_with_conflict_resolutions could touch hcfs-client if matching must error on unknown IDs, but that is not required for the core fix. Real-world trigger requires >1 configured drive AND concurrent conflicting cycles, which is why medium (not high) is correct — single-drive users (the common case; useStagedChanges defaults to 'default') are unaffected.

- [x] **F16 fixed & tested** — committed 0bf8f7b9

---

## F17

### 🟡 MEDIUM · S effort · partially_valid — Sync atoms never reset on logout/account-switch — previous account's drive statuses, failed-files modal, conflicts, credits banner, and health all leak into the next session

- **Area:** TS · global state

**Root cause**

The Jotai `appStore` (app/lib/store/jotaiStore.ts:10) is mounted at the root via `<JotaiProvider store={appStore}>` in app/components/providers/index.tsx:24, which sits ABOVE both `WalletAuthProvider` and the protected `app/(pages)/layout.tsx`. On logout, `setIsAuthenticated(false)` makes `OnBoardingGuard` return `null` (OnBoardingGuard.tsx:40), unmounting all the listener components — but the atom *values* live in the root store and survive. `logout()` (wallet-auth-context.tsx:146-189) only resets `syncRequiresReauthAtom` (line 182). The sync listeners are write-forward-only: their effects depend on stable `useSetAtom` setters (e.g. useDriveStatuses.ts:147 `[setDriveStatuses,setLoaded]`, FailedFilesListener.tsx:29, ConflictEventListener.tsx:43), so they neither clear on unmount nor key off the account id. Contrast useServerCapabilities.ts:20-26, which depends on `polkadotAddress` and explicitly clears its atom to null on logout — the correct pattern that the sync atoms omit.

**Evidence (re-read)**

VERIFIED TRUE: appStore created once (jotaiStore.ts:10), JotaiProvider at root above protected layout (providers/index.tsx:24, layout.tsx:40-41 nest Providers→WalletAuthProvider→…→(pages)). logout() resets only `appStore.set(syncRequiresReauthAtom, false)` (wallet-auth-context.tsx:182). OnBoardingGuard returns null when unauthenticated (OnBoardingGuard.tsx:40). All seven atoms exist: syncAtoms.ts:5 pendingConflictsAtom, :46 syncEngineHealthAtom, :60 failedFilesAtom, :88 creditsExhaustedAtom; unpinAtoms.ts:58 driveStatusesAtom, :68 driveStatusesLoadedAtom, :109 metadataStaleLabelsAtom. FailedFilesModal.tsx:68 gate `open = failedFiles !== null && failedFiles.length > 0` reads the persisted value; FailedFilesListener.tsx:21-22 only sets-forward, with NO clearing event anywhere — strongest leak.

WHAT THE CLAIM OVERSTATED (impact is narrower than 'everything leaks into the next session'):
- creditsExhaustedAtom self-heals: useCreditsExhausted.ts:45-52 clears on `hcfs_sync_started`, which fires when B's auto_init_sync triggers its first cycle. Leak window is only until B's first sync starts.
- metadataStaleLabelsAtom self-heals: useMetadataStale.ts:71-77 clears the whole map on `hcfs_activity_updated` (B's first activity).
- pendingConflictsAtom self-heals partially: ConflictEventListener.tsx:28-33 clears on `hcfs_sync_completed`/`hcfs_sync_error` — leaks only until B's first cycle finishes.
- driveStatusesAtom/driveStatusesLoadedAtom self-heal in-page: useDriveStatuses remounts on login and re-fetches `get_all_drive_statuses` (useDriveStatuses.ts:63-89), overwriting with B's drives. Real but transient load window. The tray submenu leaks longer: useTrayInit subscribes to driveStatusesAtom (useTraySync.ts:338-340) and rebuilds with NO isAuthenticated gate (the logout effect at :159-173 clears icon/label/latch but NOT driveSubmenu), and the tray runs above the guard so it never unmounts — A's drives stay in the 'Sync Folders' submenu until the atom changes.
- syncEngineHealthAtom: no logout clear; self-heals only when B's health-check cadence overwrites it.

GENUINELY LEAKS WITH NO SELF-HEAL: failedFilesAtom — no backend clearing event; the only writer that nulls it is user action in FailedFilesModal.tsx:169. Account A's failed-files set survives logout and the modal pops for account B.

**Fix**

Add a single `resetSyncSession()` helper (e.g. in app/lib/store/syncAtoms.ts or a new app/lib/store/resetSyncSession.ts) that does `appStore.set(...)` for all session-scoped atoms to their initial values: failedFilesAtom->null, pendingConflictsAtom->null, creditsExhaustedAtom->null, metadataStaleLabelsAtom->new Map(), driveStatusesAtom->new Map(), driveStatusesLoadedAtom->false, syncEngineHealthAtom->DEFAULT_SYNC_ENGINE_HEALTH, syncRequiresReauthAtom->false. Call it inside logout() in wallet-auth-context.tsx (replacing the single line 182), and also at the start of the restore_session !authenticated branch (line 326-327) for the boot path. Resetting driveStatusesLoadedAtom->false is important so hasConfiguredDrivesAtom (unpinAtoms.ts:85-89) returns to its loading->treat-as-configured state instead of evaluating against a stale empty/old map. Prioritize failedFilesAtom: it has no self-heal path and is the only one that produces a wrong-account modal. The pattern already exists for serverCapabilitiesAtom (useServerCapabilities.ts:20-26) - this generalizes it.

_Files:_ `app/lib/wallet-auth-context.tsx`, `app/lib/store/syncAtoms.ts`

_Test to add:_ Vitest: render with the shared appStore, seed failedFilesAtom with account A's files + driveStatusesAtom with A's drives, invoke logout() (mock invoke('logout_full')), then assert appStore.get(failedFilesAtom)===null, driveStatusesAtom.size===0, driveStatusesLoadedAtom===false, creditsExhaustedAtom===null, pendingConflictsAtom===null. Mirror the existing useTraySync.test.tsx store-seeding style (it already seeds driveStatusesAtom at lines 220/369/414/465).

_Risk:_ Low. Resetting driveStatusesLoadedAtom->false momentarily flips hasConfiguredDrivesAtom back to true (treat-as-configured) which is the intended cold-start behavior, so upload buttons won't wrongly show the 'set up sync' toast during the gap. Watch: ensure resetSyncSession runs AFTER the awaited logout_full IPC (so a late in-flight event from A's teardown doesn't re-populate an atom post-reset) - placing the reset at the end of logout() (as line 182 already is) keeps it after the awaited stop. Also confirm the tray submenu rebuild fires on the driveStatusesAtom->empty transition so the 'Sync Folders' list clears.

_Notes:_ TypeScript/frontend-only finding; no Rust diff, so the Rust workflow gates (preflight/plan/axioms/exemplars/critique/quality_gate/self-review checklist) are N/A. The fixture's verify_notes were accurate on the core mechanism. Corrected scope: the blanket 'all leak into the next session' is overstated - only failedFilesAtom leaks with no self-heal; creditsExhausted/metadataStale/pendingConflicts/driveStatuses self-heal once account B emits its first sync event or the listener remounts and re-fetches. The longest-lived non-self-healing leak besides failedFiles is the tray 'Sync Folders' submenu, which persists A's drives because useTraySync runs above the auth guard and its logout effect does not clear driveSubmenu. The Rust side correctly does NOT emit hcfs_drive_removed on logout (stop_sync is intentional cleanup-only), so the cleanup must happen on the FE - confirming the fix belongs in this repo.

- [x] **F17 fixed & tested** — committed 54d40446

---

## F18

### 🟡 MEDIUM · S effort · valid — hasConfiguredDrivesAtom evaluates against the previous account's stale map on next login because driveStatusesLoadedAtom is never reset to false

- **Area:** TS · global state

**Root cause**

`driveStatusesLoadedAtom` is a latch that `useDriveStatuses` flips to `true` exactly once (after its first `get_all_drive_statuses` fetch) and never resets. Both it and `driveStatusesAtom` live in the module-level `appStore` (a Jotai `createStore()` singleton injected via `<JotaiProvider store={appStore}>`), so they persist across the logout→login boundary — logout only does `router.push("/login")` (a client navigation, not a page reload) and explicitly resets only `syncRequiresReauthAtom`. On the second and later logins, the cold-start guard in `hasConfiguredDrivesAtom` (`if (!loaded) return true`) is skipped because `loaded` is still `true`, so the derived value is computed from the stale `driveStatusesAtom` left over from the previous account during the window between layout remount and the new account's fetch resolving. The intended "distinguish loading from loaded-empty" contract holds only for the first-ever login.

**Evidence (re-read)**

unpinAtoms.ts:85-89 — `export const hasConfiguredDrivesAtom = atom((get) => { const loaded = get(driveStatusesLoadedAtom); if (!loaded) return true; return get(driveStatusesAtom).size > 0; });`. unpinAtoms.ts:58,68 — both atoms default to empty/false. useDriveStatuses.ts:87-89 — `} finally { if (!cancelled) setLoaded(true); }` is the ONLY production writer of either atom (confirmed by `rg driveStatusesLoadedAtom|driveStatusesAtom app/`: only useDriveStatuses writes them; every other reference is a reader or a test). The hook never resets the atoms at effect start — it only `setDriveStatuses(map)` AFTER the fetch resolves (line 80). providers/index.tsx:24 — `<JotaiProvider store={appStore}>` proves the persistent store backs every `useSetAtom`/`useAtomValue`. wallet-auth-context.tsx:182 — logout sets only `appStore.set(syncRequiresReauthAtom, false)`; the drive atoms are untouched. wallet-auth-context.tsx:185 / :323 — logout does `router.push(redirectPath)` (e.g. "/login"), a client nav, not a reload. SyncEventLogger mounts useDriveStatuses inside app/(pages)/layout.tsx:23, so it unmounts on logout (redirect leaves the (pages) group) and remounts on next login, re-running the effect — but the appStore atoms survive the unmount, so the latch stays true into the next session. Consumers confirmed: AddFileButton.tsx:67,76-87 gates the "Set up a sync folder…before uploading" toast on this atom at file-drop time; FilesContainer.tsx:143, SyncConnectivityAlert.tsx:88, FolderUploadDialog/AddFileToFolderButton/AddFolderToFolderButton/FolderToFolderUploadDialog all read it. What the original claim slightly overstated: the impact is a bounded transient (one IPC round-trip after the post-login layout remount), not a persistent state — the new account's fetch self-corrects `driveStatusesAtom` to its real value (including down to an empty Map). The dangerous direction is A-had-drives → B-has-none, where the stale non-empty map suppresses the "set up sync first" guard until B's fetch returns; the reverse direction merely shows a spurious onboarding prompt for the same brief window. SyncFolderSelect.tsx:34 also reads driveStatusesLoadedAtom directly, sharing the same stale-latch exposure.

**Fix**

Reset the two atoms to their initial values inside `logout` in app/lib/wallet-auth-context.tsx, alongside the existing `appStore.set(syncRequiresReauthAtom, false)` at line 182: add `appStore.set(driveStatusesLoadedAtom, false)` and `appStore.set(driveStatusesAtom, new Map())`. This restores the cold-start contract for every login. logout already imports `appStore` and uses `appStore.set`, so no new wiring is needed — import the two atoms from @/app/lib/global-atoms/unpinAtoms. (Alternative, more localized but more code: make useDriveStatuses set `loaded=false` + clear the map at the START of its effect before the fetch, so each remount re-enters the loading state. The logout-reset is the minimal, single-chokepoint fix and matches how syncRequiresReauthAtom is already handled.)

_Files:_ `app/lib/wallet-auth-context.tsx`, `app/lib/hooks/__tests__/useDriveStatuses.test.tsx (or a new wallet-auth-context logout test)`

_Test to add:_ A vitest case that: (1) renders useDriveStatuses against a shared store seeded so the initial fetch returns one drive entry and asserts loaded===true and map.size===1; (2) simulates account switch by invoking the logout reset (or unmount+reset+remount) and asserts driveStatusesLoadedAtom===false and driveStatusesAtom.size===0 BEFORE the second fetch resolves; (3) asserts hasConfiguredDrivesAtom===true during that pre-fetch window (loading), then computes from the new account's fetched map afterward. This locks the 'loading vs loaded-empty' contract across the login boundary, which the current suite only verifies for a single fresh mount.

_Risk:_ Low. The reset runs on logout only; the only consumers re-read via the live useDriveStatuses fetch on the next login. Watch: components that read driveStatusesAtom during the brief post-login loading window now correctly see empty+loading (hasConfiguredDrivesAtom returns true) instead of stale data — verify FilesOnboarding/SyncFolderSelect don't flash onboarding during that window (they already gate on the loaded latch, so resetting it to false keeps them in the loading branch). Ensure the reset fires on ALL logout paths (the single `logout` callback covers timer logout, sidebar logout, and signing-error logout, since they all funnel through it).

_Notes:_ Pure TypeScript/frontend finding — no Rust involved, so all Rust workflow gates (preflight, axioms, exemplars, critique, quality_gate, 7-item self-review) are N/A this turn. The finding's verify_notes were cut off mid-sentence at point 3 but the three claims I could read (single writer, appStore persistence, logout-only-resets-syncRequiresReauth) all reproduce exactly. Severity kept at medium because the wrong direction can suppress a data-safety guard (upload to an account with no configured sync folder), but the practical exposure is narrower than a flat 'medium logic bug' implies: it is a sub-second post-login window requiring immediate user interaction and self-corrects on fetch — reasonable reviewers could call it low. The fix is genuinely small (S) and the minimal form matches the existing syncRequiresReauthAtom reset pattern already in logout.

- [x] **F18 fixed & tested** — committed 54d40446

---

## F19

### 🟡 MEDIUM · S effort · valid — Nested folder view (files-folder) ignores sync-completed events — listing goes stale after sync

- **Area:** TS · query cache

**Root cause**

FolderView (`app/components/page-sections/files-folder/index.tsx`) fetches its listing imperatively via `invoke("list_sync_folder_grouped")` into local `useState` and only reloads on three triggers: the mount/dep effect (deps are stable identity/path values), the `syncPathRefreshTrigger` atom effect, and the manual Refresh button. It registers exactly one window listener — `hippius:file-drop` (line 361) — and never subscribes to the app-wide `sync_files_completed_changed` window CustomEvent. That event is dispatched globally by `useSyncEvents` (mounted via `SyncEventLogger` in `app/(pages)/layout.tsx`) with a 250ms debounce after every sync cycle that completes files. The sibling data sources `use-user-files` and `use-recent-files` both listen for it and refetch. Because FolderView does not, when a download/upload completes while the user is viewing a subfolder, newly arrived/changed files and pending→synced transitions do not appear until manual refresh or navigate-away-and-back. No data integrity impact — purely a staleness/UX inconsistency.

**Evidence (re-read)**

files-folder/index.tsx:159 `const listing = await invoke<GroupedListing>("list_sync_folder_grouped", {...});` inside `loadFolderContents` (useCallback), result stored via `setFiles(formattedFiles)` at :195 — confirmed useState, not TanStack Query. Reload triggers: :217-219 `useEffect(() => { loadFolderContents(); }, [loadFolderContents])` (deps at :206-214 are folderCid/folderName/mainFolderActualName/subFolderPath/polkadotAddress/syncFolderPath/syncFolderLabel — all stable across a sync completion); :257-274 syncPathRefreshTrigger effect; :275 handleRefresh button. The ONLY window listener is :361 `window.addEventListener("hippius:file-drop", handleFileDrop)` — no `sync_files_completed_changed`. Cross-checked with `rg "sync_files_completed_changed"`: dispatched at useSyncEvents.ts:72 (debounced CustomEvent), listened at use-recent-files/index.ts:53 (`queryClient.refetchQueries({ queryKey: ["recent-files"] })`) and use-user-files/index.ts:79. Confirmed dispatcher is global: SyncEventLogger.tsx:28 calls `useSyncEvents()` and is mounted at layout.tsx:23, so the event fires app-wide regardless of current page. The finding's claims (line numbers, useState-backed, single hippius:file-drop listener, sibling-hook contrast) are all accurate. One nuance the description slightly overstates: it lists `syncStatus pending→synced` transitions as missed — true, but `isAssigned`/`sync_status` here mostly affects the assigned badge, not file appearance; the load-bearing miss is newly-arrived rows. Severity is correctly medium but at the low end — recoverable via manual refresh, no correctness/data-loss dimension.

**Fix**

Add a useEffect in FolderView that registers a `sync_files_completed_changed` window listener and calls `loadFolderContents(false)` (silent refresh, sets isRefreshing not isLoading), mirroring use-recent-files/index.ts:48-57. Effect deps must be `[loadFolderContents]` so the handler always closes over the current sync path/label/subfolder. loadFolderContents already handles empty syncPath gracefully. The heavier alternative — migrating to a TanStack Query keyed by ["folder-listing", addr, syncPath, subfolder, label] sharing the coalesced invalidation — is cleaner long-term but is M effort and out of scope for the bug fix; the listener is the minimal correct fix.

_Files:_ `app/components/page-sections/files-folder/index.tsx`

_Test to add:_ Add app/components/page-sections/files-folder/__tests__/index.test.tsx (RTL): render FolderView with invoke mocked to return a one-file listing, assert that file renders; then change the mock to return two files and dispatch `new CustomEvent("sync_files_completed_changed", { detail: { filesCompleted: 1 } })` on window; assert the second file appears without clicking the manual Refresh button. A regression-guard variant: assert invoke('list_sync_folder_grouped') is re-called after the event. This locks the listener so a future refactor can't silently drop it.

_Risk:_ Low. Risk is a redundant re-fetch storm if upstream debounce is bypassed, but useSyncEvents already coalesces to a single 250ms trailing-edge dispatch, and the refresh uses showLoading=false so no loading-spinner flicker. Watch for a harmless double-refresh when both syncPathRefreshTrigger and the new listener fire from the same settings change (duplicate IPC, not a correctness issue). Ensure the listener closes over the latest loadFolderContents to avoid fetching a stale subfolder.

_Notes:_ No Rust diff this turn; preflight / data-structure plan / axioms-baseline / exemplars / critique / quality_gate / self-review checklist all N/A (TypeScript-only fix). Verified via direct reads of the cited TSX and sibling hooks plus rg cross-checks. The fix is self-contained in one TS file and mirrors an established, tested pattern (use-recent-files). Severity kept at medium per fixture but sits at the boundary with low: recoverable staleness/UX-consistency defect with zero data-integrity impact.

- [x] **F19 fixed & tested** — committed 303c3ae0

---

## F11

### 🟢 LOW · M effort · partially_valid — validate_master_against_existing_folders silently skips validation when drive_password is unavailable, allowing a wrong master to be sealed

- **Area:** Rust · auth/recovery

**Root cause**

`validate_master_against_existing_folders` (recovery.rs:472-525) reads the per-folder encrypted mnemonics by first obtaining the drive_password via `get_drive_password(pool, account_id, None)` (recovery.rs:482). With `mnemonic=None`, `get_drive_password` returns `Err` for `encryption_version=1` rows (config.rs:172-174). The guard's `_ =>` arm (recovery.rs:484-490) catches that Err and returns `Ok(())`, skipping the real folder-derivation comparison (recovery.rs:514). For ANY enc_v1 user with folders the guard is structurally dead. The actual corruption is only INTRODUCED on the seal path when the candidate master is wrong: in `seal_and_upload_mnemonic`, `get_mnemonic_for_account` errors and a fresh master is generated (recovery.rs:570-572, is_fresh_signup=true). The drive_password row is encrypted under `drive_password_key(master)` (store.rs:58), so even passing the candidate would not decrypt it when the candidate is wrong — the auditor's suggested mnemonic-passthrough alone does not catch the wrong-master case; the correct fix is to treat "folders exist + an enc_v1 drive_password row the candidate cannot decrypt" as a refusal, not a skip.

**Evidence (re-read)**

recovery.rs:482-491 (verbatim): `let drive_password = match crate::sync::config::get_drive_password(pool, account_id, None).await { Ok(pw) if !pw.is_empty() => pw, _ => { /* No usable drive password yet ... Allow the seal */ return Ok(()); } };` — the `_` arm swallows the enc_v1 Err. config.rs:165-176 confirms `(1, None) => Err(AppError::Crypto("Drive password is encrypted but no mnemonic available for decryption"))`. store.rs:58 `drive_password_key(mnemonic, account_id)` confirms the row is keyed by the master mnemonic. WHAT THE AUDITOR GOT WRONG: it names "an OAuth returning user whose drive_password is enc_v1 and mnemonic not cached" as "exactly the population most at risk." That population is routed AWAY from seal: check_recovery_state_inner (recovery.rs:237-247) maps `(true, false, Some(true))` and `(false, _, Some(true))` to `RecoveryFlow::Unlock` (recovery.rs:243), whose comment literally says "OAuth + drive_password enc_ver=1 + no cached mnemonic"; Unlock invokes `recover_mnemonic` (recovery.rs:319), which downloads the blob and caches the correct mnemonic — it never calls seal. `can_decrypt_local_mnemonic` (recovery.rs:164-172) returns false only for enc_v1+no-cache, driving exactly that routing. The genuinely reachable corruption is the narrower `Proceed`+legacy-migration state: `local=true`, master file undecryptable (enc_v1, no cache), `blob=Some(false)` → matches `(true,_,_)`=Proceed with `should_prompt_legacy_migration=true` (recovery.rs:252); ExistingUserRecoveryPrompt.tsx:70 then calls seal, `get_mnemonic_for_account` Errs, a fresh wrong master is minted, the guard skips, and a non-deriving master is sealed. The change_recovery_password call site (recovery.rs:680) is low risk: its candidate comes from `open_mnemonic(&blob, &current, ...)` (recovery.rs:676), the authoritative server master, so rotation never introduces a NEW wrong master. No test exercises the guard (grep found zero references in src-tauri/tests).

**Fix**

In validate_master_against_existing_folders, split the single `get_drive_password(None)` skip (after the existing folders.is_empty() early return at recovery.rs:478) into three branches: (1) Ok(pw) non-empty -> run the existing comparison loop; (2) no hcfs_config row / no drive_password set yet -> Ok(()) (pre-config, nothing to compare); (3) a drive_password row EXISTS at encryption_version=1 but is undecryptable with the candidate -> return Err(AppError::Validation) refusing the seal and directing the user to unlock with their original recovery password first. Implement by querying encryption_version/presence directly (mirroring drive_password_is_plaintext at recovery.rs:180) to distinguish 'no row' from 'enc_v1 row present', and pass Some(candidate_master) to get_drive_password so a CORRECT candidate decrypts the row and validation proceeds (closing case 2a where the guard no-ops even for a correct master). The same stricter guard is safe at the change_recovery_password call site.

_Files:_ `src-tauri/src/recovery.rs`

_Test to add:_ Add a #[tokio::test] in recovery.rs (acquiring crate::test_helpers::HOME_LOCK) that seeds a sync_paths folder row + a folder enc_mnemonic.json derived from master A, writes an hcfs_config drive_password row at encryption_version=1 (encrypted under drive_password_key(A)), then calls validate_master_against_existing_folders with a DIFFERENT master B and asserts Err (currently Ok). Companion tests: correct master A returns Ok; and no folders / no hcfs_config row returns Ok (fresh-signup regression guard).

_Risk:_ A legitimate signup/first-config flow with a stray sync_paths row but no usable drive_password could newly be refused. Mitigate by gating the refusal strictly on 'enc_v1 drive_password row present AND undecryptable' (case 3), keeping case 2 (no row) as Ok. Watch ExistingUserRecoveryPrompt on real enc_v1 devices to confirm correct-master seals still pass once Some(candidate) is threaded through get_drive_password.

_Notes:_ Partially valid: the swallow-on-Err mechanism is exactly as quoted and the guard is structurally dead for enc_v1 users, but the auditor's stated highest-risk population (OAuth returning user with a server blob) is diverted to RecoveryFlow::Unlock -> recover_mnemonic by the decision table at recovery.rs:243 and never reaches seal. Real reachable corruption is the narrower Proceed+legacy-migration state (local master undecryptable, blob=Some(false), folders exist) where a fresh wrong master is minted (recovery.rs:572) and sealed. change_recovery_password call site is low risk because its candidate is the authoritative server-blob master. Severity lowered from medium to low. No Rust diff produced this turn; preflight/quality_gate/critique/exemplars/self-review checklist all N/A (read-only validation).

- [x] **F11 fixed & tested** — committed 257bb16d

---

## F13

### 🟢 LOW · S effort · partially_valid — VM chain-balance guard fails OPEN when the substrate RPC is unavailable, contradicting create_vm's documented refusal

- **Area:** Rust · billing

**Root cause**

In `check_action_eligibility_inner` (src-tauri/src/billing/eligibility.rs:299-326) the chain-balance=0 refusal for `VmCreation` is gated behind two nested let-chains with four fallible steps: `substrate_client` is `Some`, `account_id.parse::<AccountId32>()` is `Ok`, `client.storage().at_latest().await` is `Ok`, and `storage.fetch(&query).await` is `Ok`. None of the four has an `else` arm, so any failure (client not connected, parse failure, RPC error/lag) skips the entire block and control falls through to the final `Ok(ActionEligibility { eligible: true, .. })` at line 328. The credit gate above (line 274 `.await?`, line 285-293) is fail-closed; only the chain-balance layer is best-effort fail-open. The doc comment at infra/vm.rs:126-132 states create_vm "Refuses to call the spawn endpoint if the user has ... a zero chain balance," a guarantee that only holds when the RPC succeeds.

**Evidence (re-read)**

eligibility.rs:299-326 confirmed verbatim: `if action.requires_chain_balance() { let substrate_client = { ... guard.clone() }; if let Some(client) = substrate_client && let Ok(acct) = account_id.parse::<subxt::utils::AccountId32>() { ... if let Ok(storage) = client.storage().at_latest().await && let Ok(info) = storage.fetch(&query).await { let free = info.map_or(0, |i| i.data.free); if free == 0 { return Ok(ActionEligibility { eligible:false, reason:Some("balance_zero"...) }) } } }` — no else on any of the four conditions; fall-through to eligible:true at line 328. The finding's evidence and verify_notes are accurate. The test pins it: tests/eligibility_enforcement.rs:193-212 says "with no substrate client wired up ... that branch is a no-op and returns Ok(())". CORRECTIONS to the finding's framing: (1) The credit gate is the PRIMARY fail-closed gate (≥10 VM_CREATION, line 285); the chain-balance=0 check is a SECONDARY pre-flight refusal, so the fail-open only lets through an account that already passed the ≥10-credit check but has zero on-chain balance AND hit an RPC failure — a narrow conjunction, not "any zero-balance user." (2) Runtime impact is confined to a server-side failed/rejected extrinsic and confusing UX (the finding states this too); no fail-closed gate is bypassed, no data/fund loss — the /vm/spawn endpoint server-side is the true authority. (3) The sibling `check_sync_eligibility` (credits.rs:95-122) routes through FolderSync, which has `requires_chain_balance() == false`, so despite its doc saying "Checks chain balance" it never enters this block — only VmCreation does, so blast radius is exactly one action.

**Fix**

Decide the policy explicitly and make it observable rather than silent. Recommended: keep the spawn endpoint as the authoritative gate but stop the doc from over-promising AND make the skip observable. Concretely: (1) restructure the let-chains so each fallible step has an explicit handling arm — when substrate_client is None OR parse fails OR at_latest()/fetch() errors, emit a tracing::warn! noting the chain-balance pre-flight was skipped (account_id, error) and continue as best-effort; (2) soften the create_vm doc comment at infra/vm.rs:126-132 to state the chain-balance refusal is best-effort and only applies when the substrate RPC is reachable, with /vm/spawn as the authoritative gate. If product instead wants a hard pre-flight, change the fall-through to return Ok(ActionEligibility{eligible:false, reason:Some("balance_unknown")}) (or Err(NotReady)) on RPC/parse failure — but that makes VM creation impossible whenever the node is briefly unreachable, a worse UX, so the observable-best-effort option is preferred. Either way the silent fall-through must go.

_Files:_ `src-tauri/src/billing/eligibility.rs`, `src-tauri/src/infra/vm.rs`

_Test to add:_ In tests/eligibility_enforcement.rs, replace the Case-3 assertion that pins the no-op-on-missing-client behavior with an intentional, documented assertion of the CHOSEN policy: e.g. assert that with no substrate client and a >=10 credit balance, require_eligible(VmCreation) returns Ok(()) (best-effort) AND that a warn-level skip was logged (via a tracing subscriber capture), so the fail-open is asserted as a deliberate, observable choice rather than an accidental side effect. If the hard-fail policy is chosen instead, assert it returns Err(NotReady) / eligible:false with reason balance_unknown when the client is absent.

_Risk:_ Low. The credit gate (fail-closed) is untouched, so the primary refusal path keeps working. The observable-best-effort variant changes only logging + doc wording and preserves current runtime behavior, so no functional regression. The hard-fail variant WOULD regress: any transient node unavailability blocks all VM creation — must not ship without product sign-off. Watch: tests/eligibility_enforcement.rs:193-212 currently encodes the no-op behavior and will need updating in lockstep, otherwise the chosen fix fails that pinned test.

_Notes:_ No Rust diff produced this turn (read-only validation), so the Rust workflow gates (preflight/axioms/quality_gate/critique/exemplars/self-review) are N/A. Finding is code-accurate and the auditor read the code correctly; downgraded from medium to low and to partially_valid because the framing overstates impact: the chain-balance=0 check is a secondary best-effort pre-flight layered on top of the fail-closed >=10-credit gate, the /vm/spawn server endpoint is the authoritative gate, blast radius is exactly one action (VmCreation), and the worst case is a wasted round-trip + a server-side rejected extrinsic, not a bypass of a fail-closed control. The genuine defect worth fixing is (a) the silent fall-through with zero observability and (b) the create_vm doc comment claiming a hard refusal it cannot guarantee.

- [x] **F13 fixed & tested** — committed 257bb16d

---

## F20

### 🟢 LOW · M effort · partially_valid — NotificationItem calls getVersion() Tauri IPC on every item mount and is unmemoized; N notifications = N IPC round-trips

- **Area:** TS · render perf

**Root cause**

Three independent inefficiencies in the notifications list, all confirmed in code: (1) NotificationItem runs a per-mount `getVersion()` Tauri IPC stored in per-item `useState`, so an N-row list fires N identical IPC calls each triggering a per-item setState/re-render; the value is app-global and the @tauri-apps/api/app binding does not cache it. (2) NotificationItem is exported without React.memo. (3) NotificationList passes a fresh `onClick={() => onSelectNotification(notification.id)}` arrow per row, and the parent's `onItemClick`/`onReadToggle`/`onRefresh` handlers are themselves recreated each render (no useCallback), so any state change in the parent (e.g. selecting one notification) re-renders every row. The dominant real cost is the render-all-on-select, not the IPC fan-out: getVersion() is a cheap in-process Tauri IPC (invoke 'plugin:app|version'), not a network round-trip, so the finding's headline framing ('N IPC round-trips') overstates impact even though the call pattern is exactly as described.

**Evidence (re-read)**

NotificationItem.tsx:60 `const [currentVersion, setCurrentVersion] = useState<string>("");` and :64-68 `useEffect(() => { getVersion().then(setCurrentVersion).catch((err)=>console.warn(...)); }, []);` — confirmed: mount effect, per item, resolves into per-item state. :232 `export default NotificationItem;` — plain, no memo wrapper (grep confirms memo only in NotificationDetailView/index, not item/list). NotificationList.tsx:22-41 maps `visible` to NotificationItem with :37 `onClick={() => onSelectNotification(notification.id)}` — a fresh closure each render. index.tsx:143-145 `const visible = items.filter(...).filter(...)` rendered whole at :296-302 — no slice/pagination/virtualization, so all rows mount. index.tsx:158 `const onItemClick = (id)=>{...}` and :147 `const onReadToggle` are plain inline functions (no useCallback), so even with memo the closures would still bust it unless stabilized. Corrections to the original claim: location header cites ':38' for 'no memo' — line 38 is the component declaration; the export-without-memo is at :232 (verify_notes gets this right). The 'IPC round-trips' framing is technically accurate but impact-inflated: these are local in-process IPC, not network calls, and notification lists are small-to-moderate, so the user-visible cost is mostly the redundant re-renders, not IPC latency.

**Fix**

(1) Hoist the version: a small `useAppVersion()` hook backed by a module-level memoized promise (or a Jotai atom) so getVersion() runs once per app session; index.tsx reads it once and passes `currentVersion` down as a prop to NotificationItem, removing the per-item effect and useState. (2) Wrap NotificationItem in React.memo. (3) Stabilize selection: pass the stable `onSelectNotification` and `id` to a memoized NotificationItem and define the onClick inside the component closing over stable props; wrap the parent handlers (`onItemClick`, `onReadToggle`, `handleRefreshNotifications`) in useCallback so memo actually holds. The same getVersion-per-item pattern also exists in NotificationMenuItem.tsx:63 (dropdown menu) and should use the shared hook too.

_Files:_ `app/components/page-sections/notifications/NotificationItem.tsx`, `app/components/page-sections/notifications/NotificationList.tsx`, `app/components/page-sections/notifications/index.tsx`, `app/components/dashboard-title-wrapper/notifications-menu/NotificationMenuItem.tsx`

_Test to add:_ Vitest + React Testing Library in NotificationList.test.tsx: render N notifications with getVersion mocked (vi.mock '@tauri-apps/api/app'); assert getVersion is called exactly once after the hoist; then re-render with a changed selectedNotificationId and assert only the previously- and newly-selected items re-render (render-count spy on a memo'd item) while other rows do not, locking the memo + stable-handler fix.

_Risk:_ Low. Behavior-preserving refactor of presentational components. Watch: (a) version-gating logic (isUpdateAlreadyInstalled, NotificationItem.tsx:75-80) must still see the resolved version — preserve the empty-string-until-resolved guard so the Install Update button doesn't flash. (b) React.memo with object/function props is a no-op unless parent handlers are stabilized — verify with the render-count test. (c) NotificationMenuItem shares the pattern but is a separate surface; the shared hook must not alter its existing behavior.

_Notes:_ No Rust in this task; all Rust gates (preflight, data-structure plan, axioms, exemplars, critique, quality_gate, self-review checklist) are N/A. Pure TypeScript/React perf finding. All concrete code claims verify exactly against re-read source (line numbers match). Downgraded severity medium->low because the headline 'N IPC round-trips' overstates impact: getVersion() is a cheap in-process Tauri IPC (plugin:app|version), not a network call, and notification lists are bounded; the worthwhile fix is React.memo + stable handlers to stop re-rendering the whole list on every selection, with the version hoist as a clean secondary win. Same getVersion-per-item anti-pattern also lives in NotificationMenuItem.tsx:63.

- [~] **F20 PARTIAL (getVersion IPC hoisted via useAppVersion; NotificationItem memo + onClick WONTFIX (low-value, user opted to skip))** — committed 544e5838

---

## F21

### 🟢 LOW · S effort · partially_valid — delete_files runs one (often two) SQLite query per file in a batch instead of resolving labels once

- **Area:** Rust · sync perf

**Root cause**

delete_files (src-tauri/src/sync/files.rs:523-605) iterates the FileDeleteRequest batch and, for every file, calls get_sync_path_for_label(pool, &account_id, effective_label) (files.rs:535) — each of which is a separate awaited `SELECT path FROM sync_paths WHERE owner = ? AND label = ?` via fetch_optional (config.rs:184-188), with no caching. When effective_label != "default" and the first lookup errors, a SECOND query against "default" runs (files.rs:537-539). Since a multi-select delete almost always shares one or two labels, this is a textbook N+1 (up to 2N) resolving the same handful of rows. The pattern is real exactly as described. Where the finding overstates is impact framing: sync_paths has UNIQUE(owner,label) and holds one row per drive (a handful of rows), so each lookup is an indexed local point query in the microsecond range, and each loop iteration is dominated by the actual filesystem work (tokio::fs::metadata + remove_file/remove_dir_all). The N+1 is a genuine inefficiency but "serializes hundreds of DB round-trips while the user waits" overstates its share of wall-clock time relative to the FS I/O.

**Evidence (re-read)**

files.rs:533-541 (verbatim): `for file in &files { let effective_label = file.label.as_deref().unwrap_or("default"); let sync_path = match crate::sync::config::get_sync_path_for_label(pool, &account_id, effective_label).await { Ok(p) => p, Err(_) if effective_label != "default" => crate::sync::config::get_sync_path_for_label(pool, &account_id, "default").await.unwrap_or_default(), Err(_) => String::new(), };` — confirms one query per file plus the conditional second fallback query. config.rs:180-193: get_sync_path_for_label runs a single `SELECT path FROM sync_paths WHERE owner = ? AND label = ?` via fetch_optional and returns NotReady(SyncSetup) on None — one awaited round-trip, no memoization. folders.rs:96-118: get_all_sync_paths_internal already does `SELECT path, type, label, is_paused FROM sync_paths WHERE owner = ?` and returns Vec<SyncPathResult> carrying both `label` and `path`, so a label→path HashMap is buildable from ONE query — the suggested fix is directly supported. schema.rs:136 confirms UNIQUE(owner, label), so the table is one-row-per-drive (small) and the HashMap has no duplicate-key ambiguity. What the original claim got wrong/overstated: it presents the round-trips as the thing "the user waits" on, but each iteration's dominant cost is the filesystem delete, not the local point query; the table being tiny further shrinks the absolute saving. Severity low is correct; the perf win is real but modest.

**Fix**

Before the loop, call let sync_paths = crate::sync::folders::get_all_sync_paths_internal(pool, &account_id).await.unwrap_or_default(); and build a HashMap<String,String> label->path from it (entry.label -> entry.path). Capture the default path once: let default_path = map.get("default").cloned(). Inside the loop replace the two get_sync_path_for_label calls with: let sync_path = map.get(effective_label).or(default_path.as_ref()).cloned().unwrap_or_default(); This collapses up to 2N queries into exactly one, preserving the existing fallback-to-default semantics and the empty-string-on-miss behavior (unwrap_or_default yields ""). No behavior change for the error/empty cases since derive_relative_name + ensure_within already handle an empty sync_path the same way today.

_Files:_ `src-tauri/src/sync/files.rs`

_Test to add:_ Add an integration test (e.g. src-tauri/tests/file_commands.rs or a new delete_files test) that seeds sync_paths with two labels ("default" and "work") via the public schema/insert path, constructs a batch of FileDeleteRequest mixing both labels plus one unknown label, runs delete_files against a temp HOME, and asserts each file resolves to the correct sync_path (deleted count matches, files on disk under the right roots are removed, unknown label falls back to default). To lock the perf intent without flakiness, factor the label-resolution into a small pure helper (resolve_paths(map, files) -> Vec<String>) and unit-test it directly so the N->1 query collapse is structurally guaranteed; the integration test pins behavior parity with the old per-file lookups.

_Risk:_ Low. Single-file change in delete_files. Regression to watch: the fallback ordering must stay 'effective_label first, then default' and miss must still yield empty string (today's unwrap_or_default). A subtle difference: the current code re-reads the DB per file, so it would observe a row inserted mid-batch; the cached map is a snapshot taken once at entry. That is acceptable and arguably more consistent for a single user-initiated batch delete, but note it in the commit message. Keep get_sync_path_for_label as-is — other callers depend on it.

_Notes:_ No Rust diff produced this turn (read-only validation), so the Rust workflow gates are N/A: no Rust this task — preflight N/A; data-structure plan, axioms-baseline, exemplars, critique, quality_gate, and the seven-item self-review checklist all N/A. Verdict is partially_valid rather than valid only because the impact framing ('hundreds of DB round-trips while the user waits') overstates the N+1's share of wall-clock time — sync_paths is a tiny indexed table and the per-file filesystem delete dominates each iteration. The code pattern itself matches the finding exactly and the suggested fix is correct and cheap (effort S, fully in-repo). No dedicated delete_files test exists today in src-tauri/tests/, so the locking test is net-new coverage.

- [x] **F21 fixed & tested** — committed 36693219

---

## F22

### 🟢 LOW · S effort · valid — add_folder and add_files walk the entire source tree twice (bytes, then count) before copy_dir_recursive walks it a third time

- **Area:** Rust · sync perf

**Root cause**

The two folder-upload IPCs each compute byte total and file count via two separate full recursive traversals of the identical source tree with no shared state.

**Evidence (re-read)**

add_folder (files.rs:206): `let bytes = sum_regular_file_bytes(Path::new(&folder_path)).await;` then (files.rs:234): `let count = count_regular_files(Path::new(&folder_path)).await;` — two independent walks, no shared state, no early-exit between them (the only conditional, `if count > 0`, is after both walks have run).
count_regular_files (files.rs:349-366): iterative stack walk, `fs::read_dir` + `entry.file_type()` per entry, no content read. sum_regular_file_bytes (files.rs:394-423): same shape plus `entry.metadata()` for file sizes; capped at FOLDER_BYTE_WALK_MAX_DEPTH=4096 stack entries.
sum_batch_bytes (files.rs:438-450): `let p = std::path::Path::new(fp); let add = if p.is_dir() { sum_regular_file_bytes(p).await } ...`. add_files count loop (files.rs:680-687): `for fp in &file_paths { let p = Path::new(fp); if p.is_dir() { total_count = total_count.saturating_add(count_regular_files(p).await.max(1)); } else { ... } }` — the `p.is_dir()` stat at :442 and :682 are duplicated; the per-dir walk is duplicated.
copy_dir_recursive (files.rs:2230-2231) delegates to hcfs_client::drive::files::copy_dir_recursive (confirmed via cross_query: hcfs-client/src/drive/files.rs:215-244), the third (content-copying) walk.
What the original claim got right: every concrete line number, the "no shared state" characterization, the duplicate is_dir stat, and the three-walk count. What is slightly understated by the phrasing "doubling the pre-copy latency": the two pre-walks are metadata-only (read_dir + stat, no file content), so they double only the pre-copy metadata phase — not total upload time, which is dominated by the content copy and network upload. The finding itself is careful here, so the framing is fair; severity low is correct.

**Fix**

Add a single helper async fn walk_regular_files_stats(root: &Path) -> (u64 /*bytes*/, u64 /*count*/) that performs one iterative stack-based read_dir walk accumulating both bytes (via entry.metadata().len()) and count in the same pass, preserving the existing invariants (no symlink follow, per-subdir I/O errors skipped via continue, FOLDER_BYTE_WALK_MAX_DEPTH stack cap, saturating_add). In add_folder, replace the two calls at files.rs:206 and :234 with one call and destructure (bytes, count). In add_files, add a sum_and_count_batch helper that classifies each path with a single fs::metadata (yielding both is_dir and len), summing bytes for files and walking dirs once via walk_regular_files_stats to get both bytes and the .max(1)-clamped count -- eliminating the duplicate is_dir stat and the second per-dir walk. Keep bytes-only sum_regular_file_bytes only if add_local_sync_folder still needs it. Net: one metadata pass instead of two for both upload paths.

_Files:_ `src-tauri/src/sync/files.rs`

_Test to add:_ Add a #[tokio::test] in files.rs building a tempdir tree (via tempfile) with N regular files of known sizes across nested subdirs, one symlink (asserted ignored), and one unreadable subdir (chmod 000) to exercise the error-skip path. Assert walk_regular_files_stats returns exactly (sum_of_sizes, file_count) matching the fixture and equals the pair (sum_regular_file_bytes, count_regular_files) would have produced -- locking that the merged single-pass helper is behavior-identical to the two old walks. Edge cases: empty dir -> (0,0); wholly-unreadable root -> (0,0); symlink not counted; size summed via entry metadata not symlink target.

_Risk:_ Low. Behavior must stay identical to the two existing walks. The count walk uses .max(1) for unwalkable subdirs in add_files ONLY (not in add_folder); the merged add_files helper must preserve that per-dir clamp while the add_folder helper must NOT clamp (its count==0 guard intentionally skips begin). Wrong clamp placement either raises a banner that never clears (folder path) or undercounts (files path). Also ensure the single-pass metadata() call does not change symlink/regular-file classification.

_Notes:_ Pure performance finding, correctly rated low. No correctness, data-loss, or security impact -- only redundant metadata syscalls on the pre-copy phase. Material only on large (tens of thousands of files) or high-latency/network filesystems; on local SSDs the doubled metadata pass is negligible relative to the subsequent content copy + network upload, which the finding does not claim to fix. The fix is entirely local to src-tauri/src/sync/files.rs (this repo); the third walk lives in hcfs-client but is the actual content copy and is not part of the optimization. Scope note: add_local_sync_folder also calls sum_regular_file_bytes but does not pair it with a count walk, so the double-walk is specific to the two upload paths the finding names -- its scope is accurate.

- [x] **F22 fixed & tested** — committed 36693219

---

## F23

### 🟢 LOW · S effort · valid — Concurrent token refreshes are not mutually exclusive; TokenRefreshGuard is an advisory bool, not a lock

- **Area:** Rust · auth/recovery

**Root cause**

refresh_auth_token_internal (service.rs:147-206) has no mutual-exclusion between concurrent invocations for the same account. The TokenRefreshGuard it acquires (hcfs runner.rs:198-213) only toggles a single SeqCst AtomicBool token_refreshing; no refresh path reads that bool before starting work (its sole reader, check_sync_preconditions at runner.rs:1638, only skips a SYNC CYCLE). Two refresh entry points exist — the desktop pre-init refresh at lifecycle.rs:1019 and the runner's 401/proactive callback via TauriSyncBridge::refresh_auth_token at tauri_bridge.rs:654. When they overlap, both run challenge_response then race to last-writer-wins on the auth_session ON CONFLICT(owner) upsert (auth_session_repo.rs:88-97) and the keychain store_token, so the loser can strand a token that may be server-side stale.

**Evidence (re-read)**

VERIFIED VERBATIM:
- hcfs-client/src/engine/runner.rs:203-206 `pub fn new(runner: Arc<SyncRunner>) -> Self { runner.set_token_refreshing(true); Self { runner } }` and runner.rs:547-549 `pub fn set_token_refreshing(&self, v: bool) { self.token_refreshing.store(v, Ordering::SeqCst); }` — a single AtomicBool, not a mutex, exactly as the docstring states.
- service.rs:150-151 `let sync = ...sync.clone(); let _guard = TokenRefreshGuard::new(sync);` then service.rs:171-188 does upsert(...) and save_api_token(...) with NO read of is_token_refreshing() — two invocations do not exclude each other.
- is_token_refreshing has exactly ONE call site: check_sync_preconditions (runner.rs:1638) which returns false to skip a sync cycle — NOT a refresh gate. Cross-repo references on TokenRefreshGuard inside hcfs return "No call sites found", confirming the runner's own refresh paths (maybe_refresh_token runner.rs:1570, trigger_sync gate runner.rs:1594) call callbacks.refresh_auth_token() directly and acquire the guard only transitively via the desktop callback.
- auth_session_repo.rs:88-97 ON CONFLICT(owner) DO UPDATE SET auth_token=excluded.auth_token... and token_keychain::store_token at line 67 — both last-writer-wins, no version/CAS check.
- app_state.rs:30-114 AppState has NO per-account refresh mutex.

WHAT THE ORIGINAL CLAIM SLIGHTLY OVER/UNDER-STATES:
1. The two runner-side refresh paths both live in ONE sequential sync-loop task (maybe_refresh_token at runner.rs:1531 then trigger_sync at runner.rs:1539), so the runner cannot race ITSELF. The realistic concurrent pair is the DESKTOP pre-init refresh (lifecycle.rs:1019) vs the runner loop's refresh — a genuine but narrow window (second-drive re-init / resume-from-sleep while a loop is live).
2. The "older overwrites newer -> spurious 401" impact depends on UNVERIFIED hcfs-server token semantics. Both challenge_response calls mint valid 30-day tokens (expiry computed locally at service.rs:137). If the server keeps both valid, the race is harmless (one wasted round-trip). If minting T2 invalidates T1 and the keychain ends with T1, the worst case is one transient next-cycle 401 that the runner's own needs_auth_refresh handler (trigger_sync runner.rs:1594) auto-recovers from. No persistent broken session — caps severity at low, matching the fixture.

**Fix**

Add a per-account async coalescing primitive to AppState so a second refresh awaits the first instead of issuing a parallel challenge-response. Concretely: add a field like `refresh_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>` keyed by account_id; at the top of refresh_auth_token_internal get-or-insert the per-account Arc<TokioMutex<()>> and hold its guard across the entire challenge_response + upsert + save_api_token + update_all_drive_tokens block. This serializes refreshes per account so the second caller blocks then re-reads the now-fresh token. A true single-flight (return the in-flight result) is nicer but a per-account async mutex is the minimal correct fix and matches suggested_fix. Keep TokenRefreshGuard (it still correctly pauses sync cycles via check_sync_preconditions).

_Files:_ `src-tauri/src/app_state.rs`, `src-tauri/src/auth/service.rs`

_Test to add:_ Concurrency test driving two refresh_auth_token_internal calls for the same account against a mock challenge-response endpoint that records call ordering and delays the first response; assert (a) the two challenge_response round-trips do NOT overlap (serialized) and (b) the final auth_session row + get_api_token return the token minted by the LAST-completing challenge_response, not whichever upsert landed last. Lighter unit-level alternative: assert two tasks taking the per-account guard observe mutual exclusion (second critical section starts only after the first ends).

_Risk:_ Low. Holding a per-account async mutex across challenge_response (a ~hundreds-of-ms network round-trip) means a same-account second refresh waits instead of running in parallel — acceptable since the goal is one fresh token. Must NOT hold any std::sync (blocking) lock across the await (clippy await_holding_lock); use tokio::sync::Mutex only. RAII drop releases the guard on every error path. Deadlock risk nil (no nested locks). Logout/account-switch does not strand a held guard since it is per-call-scoped.

_Notes:_ Pure analysis task; no Rust written, so Rust workflow gates (preflight, axioms, quality_gate, self-review checklist) are N/A this turn. The structural bug is real and verified verbatim. Severity stays low: worst realistic outcome is a wasted challenge-response round-trip or a single transient 401 that the runner's existing needs_auth_refresh handler auto-recovers from — no persistent session breakage, no data loss. The DB/keychain last-writer-wins mechanism is confirmed, but its user-visible harm depends on hcfs-server token-invalidation semantics not determinable from this repo (a needs_human sub-question on harm magnitude only, not on the bug's existence). Fix is desktop-only (AppState + service.rs); the runner correctly delegates refresh to the desktop callback so no hcfs change is needed.

- [x] **F23 fixed & tested** — committed a924a3c4

---

## F24

### 🟢 LOW · S effort · partially_valid — Sub-account seed-phrase encryption is write-only: ciphertext is never decrypted anywhere, and the decrypt helper is dead code

- **Area:** Rust · crypto

**Root cause**

`migrate_if_needed` (src-tauri/src/crypto/store.rs:150) encrypts two columns in one transaction: `sub_accounts.sub_account_seed_phrase` and `hcfs_config.drive_password`. The drive_password half has a real reader (sync/config.rs:165-176 branches on encryption_version and calls store::decrypt). The sub_account_seed_phrase half has NO reader anywhere in production code — outside schema DDL and crypto/store.rs itself, nothing in src-tauri references `sub_accounts` or `seed_phrase`. So the sub-account branch of the migration is write-only encryption, and the supporting surface (`sub_account_key`, `INFO_SUB_ACCOUNTS` as a read key class, and `decrypt_or_plaintext`) is dead. `decrypt_or_plaintext` is dead even for the working column because the drive_password reader reimplements the version-branch inline instead of calling it. This is a dead-code / phantom-feature hygiene issue, not a security or correctness defect: no data loss, no crash, the column is simply never consulted.

**Evidence (re-read)**

store.rs:157-173 — the sub-account write path: `SELECT id, sub_account_seed_phrase FROM sub_accounts WHERE encryption_version = 0 ...` then `UPDATE sub_accounts SET sub_account_seed_phrase = ?, encryption_version = 1`. `rg sub_account_seed_phrase src/` returns exactly 3 hits: schema.rs:98 (DDL), store.rs:158 (the migration SELECT), store.rs:168 (the migration UPDATE). No reader. `rg "sub_accounts" src/` outside DDL/docs hits only store.rs:158/168. `rg seed_phrase src/` (whole tree) hits only schema.rs and crypto/store.rs. So there is provably no production consumer.

store.rs:207 `pub fn decrypt_or_plaintext(...)` — `rg decrypt_or_plaintext src/` returns exactly 1 hit: the definition. Zero callers. Confirmed dead.

store.rs:49 `pub fn sub_account_key(...)` — `rg sub_account_key src/` returns 1 hit: the definition. The migration derives the key inline via `derive_key(mnemonic, account_id, INFO_SUB_ACCOUNTS)` at store.rs:151, NOT via this wrapper. Dead.

Contrast — the working counterpart at sync/config.rs:165-176: `match (enc_ver, mnemonic) { (1, Some(m)) => { let key = store::drive_password_key(...); let plaintext = store::decrypt(&key, &raw_password)?; ...} }`. This proves the encryption machinery works end-to-end for drive_password and is genuinely orphaned only for sub-accounts. It also shows decrypt_or_plaintext is dead because this reader hand-rolls the same version-branch.

Callers of migrate_if_needed: login.rs:131, session_restore.rs:252, session_restore.rs:482 — runs every login and every session restore.

CORRECTIONS to the original claim: (1) the description says 'PBKDF2 key derivation' — the code uses HKDF-SHA256 (store.rs:37), not PBKDF2. (2) 'a transactional UPDATE on every auth event' overstates the recurring cost: the UPDATE only runs once per row; after encryption_version flips to 1, later auth events do only the cheap SELECT (returns 0 rows) + two key derivations, no UPDATE. The recurring waste is two HKDF derivations per auth event, not a write. (3) 'irreversibly mutates' is technically loose — the same mnemonic re-derives the key, so a future reader could still recover the plaintext; it is functionally inaccessible only because no reader exists.

**Fix**

Decide the feature's fate and remove the dead half. Since no surface anywhere reads sub-account seed phrases, delete the sub-account branch of migrate_if_needed (store.rs:156-173, the sub_key derivation at :151, the sub_count plumbing, and the doc block referencing sub-accounts), delete sub_account_key (store.rs:49) and INFO_SUB_ACCOUNTS (store.rs:15), and delete the now-fully-dead decrypt_or_plaintext (store.rs:207). The drive_password half stays untouched (it has a real reader at config.rs:169). Do NOT attempt a one-shot DB downgrade of already-encrypted rows: leave existing encryption_version=1 sub_accounts rows as-is — they are inert and any future reader can be designed knowing version 1 means ChaCha20-Poly1305 under sub_account_key; just stop performing new encryption. If instead the product wants sub-account seed phrases surfaced, wire the read site (a new accounts.rs getter) through store::decrypt with a version branch mirroring config.rs:165-176, and add the round-trip test below. Default recommendation: remove, per the project 'no phantom features / flag dead code' rule.

_Files:_ `src-tauri/src/crypto/store.rs`

_Test to add:_ If removing: a compile-level guard is the removal itself plus `cargo build` (dead-code deletion needs no new test; the existing store.rs unit tests for derive_key/encrypt/decrypt still cover the live drive_password path). Optionally add an `#[test]` asserting the migration only touches hcfs_config now. If wiring a reader instead: an integration test in tests/ that INSERTs a plaintext sub_accounts row (encryption_version=0), runs migrate_if_needed, then calls the new getter and asserts it returns the original plaintext — exercising the full encrypt-then-decrypt round-trip through the public path, which today does not exist for sub-accounts.

_Risk:_ Removal is low risk because the deleted symbols have zero non-test callers (verified by rg). Watch: (1) the store.rs unit tests reference derive_key/encrypt/decrypt, not sub_account_key/decrypt_or_plaintext, so they keep compiling; (2) ensure schema.rs encryption_version column on sub_accounts is left in place (harmless, and removing a column is a riskier migration); (3) confirm no frontend invoke() targets a command that reads sub-account seed phrases — grep app/ for any such IPC before removing, since FE is illu-indexed but the Rust side shows no command exists.

_Notes:_ Verdict partially_valid (not fully valid) because the core dead-code claim is correct and verified, but three secondary claims in the description are inaccurate: it is HKDF-SHA256 not PBKDF2; the UPDATE runs once-per-row not on every auth event (only two HKDF derivations recur); and the mutation is reversible-in-principle since the key re-derives from the mnemonic. Severity stays low — this is a code-hygiene / phantom-feature issue with no security, data-loss, or correctness impact. Notably decrypt_or_plaintext is dead even for the live drive_password column because the reader at sync/config.rs:165-176 inlines its own version branch; if the feature is kept, that reader should be refactored to call decrypt_or_plaintext so the helper earns its existence. No Rust diff produced this turn (read-only validation), so the Rust workflow gates (preflight/axioms/quality_gate/critique/exemplars/self-review checklist) are N/A.

- [x] **F24 fixed & tested** — committed 47979825 (deleted dead crypto + retargeted tests)

---

## F25

### 🟢 LOW · S effort · valid — migrate_if_needed runs two BIP-39 PBKDF2 key derivations on every login and every boot even when nothing needs migrating

- **Area:** Rust · crypto

**Root cause**

migrate_if_needed (src-tauri/src/crypto/store.rs:150-201) derives both encryption keys unconditionally at the very top (lines 151-152) before issuing the two `WHERE encryption_version = 0` SELECTs (lines 157-160, 176-179) that determine whether any unmigrated rows exist. Each derive_key (store.rs:31-42) parses the mnemonic and calls `parsed.to_seed("")` (line 35), which is BIP-39 PBKDF2-HMAC-SHA512 with the spec-fixed 2048 iterations, followed by a (cheap) HKDF-SHA256 expand. sub_key is consumed only inside the sub_rows loop (line 167) and drive_key only inside the drive_rows loop (line 186); in steady state both row sets are empty so both loops are skipped and both derivations are pure waste. The function fires on mnemonic login (login.rs:131) and on both session-restore branches (session_restore.rs:252 OAuth/AlreadyWritten, :482 DB-fallback), so this redundant KDF work runs on every app start and every login.

**Evidence (re-read)**

store.rs:151-152 confirmed verbatim: `let sub_key = derive_key(mnemonic, account_id, INFO_SUB_ACCOUNTS)?;` / `let drive_key = derive_key(mnemonic, account_id, INFO_DRIVE_PASSWORD)?;` — both before `let mut tx = pool.begin()` (154) and before the SELECTs. derive_key (35): `let seed = Zeroizing::new(parsed.to_seed(""));` — BIP-39 to_seed is PBKDF2-HMAC-SHA512 x2048 per spec; auditor's iteration-count claim is correct. Usage confirmed loop-local: sub_key only at 167 `encrypt(&sub_key, plaintext)?` inside `for (id, plaintext) in &sub_rows` (163); drive_key only at 186 inside `for ... in &drive_rows` (182) — so the lazy-by-need fix is safe (keys are unused when their row set is empty). All three call sites re-read and confirmed unconditional with no version pre-check: login.rs:131, session_restore.rs:252, session_restore.rs:482. One correction to the auditor's impact wording: the DB-fallback site (session_restore.rs:480-492) already wraps migrate_if_needed in `tokio::join!` with asset-scope arming, so on that path the cost overlaps other async I/O; but the two derive_key calls are synchronous CPU work (no spawn_blocking) so they still occupy the executor thread. Also "tens of ms" is somewhat optimistic-to-high: two PBKDF2-HMAC-SHA512(2048) runs are typically low-single-digit ms each on modern hardware, so realistic total is a few ms, not tens — real but smaller than stated. Verdict and low severity are unaffected.

**Fix**

Move the two SELECTs above the derivations and derive each key lazily only when its row set is non-empty. Concretely: fetch sub_rows first, then `let sub_key = if !sub_rows.is_empty() { Some(derive_key(mnemonic, account_id, INFO_SUB_ACCOUNTS)?) } else { None };` and unwrap inside the loop (the loop only runs when Some); mirror for drive_rows/drive_key. In steady state both selects return empty and zero PBKDF2 work is done. Optional secondary win for the actual-migration case: derive the BIP-39 seed once (parse + to_seed) and run two HKDF expands over it with the different info strings, instead of re-running PBKDF2 per info string — but the lazy guard alone removes the common-case cost and is the minimal fix. Keep the existing transaction structure and the `sub_count>0 || drive_count>0` info log.

_Files:_ `src-tauri/src/crypto/store.rs`

_Test to add:_ Add an instrumentation-style unit test in store.rs tests module that drives migrate_if_needed against an in-memory SqlitePool seeded with only encryption_version=1 rows (the steady state), asserting it returns Ok and leaves rows unchanged; pair it with a counter/spy around derive_key (e.g. extract a `derive_key_counted` test seam or wrap to_seed) to assert zero derivations occur when both row sets are empty, and exactly the needed derivation(s) occur when only one table has version-0 rows. This locks the lazy behavior so a future refactor cannot silently reintroduce the unconditional derive.

_Risk:_ Low. Behavior-preserving: keys are only ever read inside the loops, so deferring their derivation cannot change migration output. Watch that the SELECTs are still issued inside the same transaction (move them, not the tx.begin) so the read-then-update stays atomic, and that the `Option<Zeroizing<[u8;32]>>` is unwrapped only inside the guarded loop (an `expect` there is justified by the is_empty guard but prefer destructuring to avoid an expect_used clippy warning). No cross-repo change.

_Notes:_ No Rust diff produced this turn (read-only validation), so the Rust workflow gates (preflight, axioms, quality_gate, critique, exemplars, self-review checklist) are N/A. Finding is real and correctly scoped at low severity (performance, cold-start path). Minor auditor overstatement: realistic added latency is a few ms, not "tens of ms", and the DB-fallback call site already runs concurrently with asset-scope arming — neither changes the verdict. The proposed lazy-by-need fix is verified safe because sub_key/drive_key are strictly loop-local.

- [x] **F25 fixed & tested** — committed 50740152

---

## F26

### 🟢 LOW · S effort · partially_valid — TOCTOU on `running` flag lets two concurrent start_block_subscription calls spawn duplicate subscription tasks

- **Area:** Rust · blockchain

**Root cause**

`start_block_subscription` guards idempotency with a non-atomic check-then-set on `running: AtomicBool` whose load/store gap spans an `.await`, so two overlapping invocations can both pass the running check and both spawn a subscription task; the second's JoinHandle overwrites the first at line 119, leaking the first task (never aborted), which doubles per-block subscription/processing for the process lifetime.

**Evidence (re-read)**

subscription.rs:47-56: `if bsub.running.load(Ordering::SeqCst) { return Ok(()); }` ... `if let Some(handle) = bsub.handle.lock().await.take() { handle.abort(); }` ... `bsub.running.store(true, Ordering::SeqCst);` — load/store are not atomic and an `.await` sits in the gap. state.rs:58 `running: AtomicBool::new(false)`, state.rs:61 `handle: tokio::sync::Mutex::new(None)` — confirms handle starts None, so the abort path is a no-op on first start. CORRECTIONS to the original claim: (1) The primary cited trigger — React StrictMode double-invoke — is REFUTED by app/lib/polkadot-api-context/index.tsx:21,24-25 (`const initiatedRef = useRef(false); useEffect(() => { if (initiatedRef.current) return; initiatedRef.current = true; ...`). StrictMode reruns the effect on the SAME instance with the SAME ref, so the second run early-returns; only one `invoke("start_block_subscription")` (index.tsx:47) fires. (2) The cited 'session-restore path' caller does NOT exist — `rg` shows exactly one caller (the single frontend invoke), and the provider is mounted once (app/components/providers/index.tsx:26). (3) 'leaks an open WebSocket' is imprecise — both tasks call `get_substrate_client` (client.rs:33) which returns the SHARED cached `Arc<OnlineClient>`; they open two logical finalized-block subscriptions over ONE connection, not two WebSockets. (4) 'both carry their own emit cadence and compete on shared atomics' understates the mitigation — `try_claim_block_emit` (subscription.rs:226) and `deferred_emit_in_flight` (subscription.rs:182) are SHARED CAS gates, so emits to the FE are largely deduped across both tasks; the FE does not see a real event flood. Realistic trigger is narrow: only a full provider unmount+remount that produces a fresh `initiatedRef` and a second `invoke` overlapping the first's pre-line-56 window.

**Fix**

Replace the load (line 47) + store (line 56) pair with a single atomic claim using compare_exchange: `if bsub.running.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() { return Ok(()); }` placed where the line-47 check is, and delete the line-56 store. This makes 'check already-running' and 'mark running' one indivisible operation so exactly one caller wins and spawns. Important ordering detail: the prior-handle abort (lines 52-54) must run only for the winner and AFTER winning the CAS, otherwise a loser could abort the winner's just-stored handle; keep the abort after the successful CAS. On any early Err return after winning (none currently, but if added) running must be reset to false to avoid a permanent stuck-true.

_Files:_ `src-tauri/src/blockchain/subscription.rs`

_Test to add:_ Add a #[tokio::test(flavor = "multi_thread", worker_threads = 4)] that fabricates a BlockSubscriptionState and exercises the claim logic directly: spawn N tasks racing `running.compare_exchange(false, true, SeqCst, SeqCst)` and assert exactly one returns Ok (i.e. exactly one would spawn). Since start_block_subscription needs a full AppHandle, refactor the claim into a tiny testable helper `fn try_claim_running(running: &AtomicBool) -> bool { running.compare_exchange(false, true, SeqCst, SeqCst).is_ok() }` and assert that across many concurrent callers the count of `true` results is exactly 1 (loom or a plain spawn-join loop both work; a loom model is the rigorous version).

_Risk:_ Very low. Behavior change is strictly a tightening (fewer, never more, spawned tasks). Watch that the prior-handle abort still runs for the legitimate restart case (current sole restart trigger is a fresh start after the task self-cleared running=false at line 115); confirm the CAS-winner still reaches the abort+spawn path. No external API or event-shape change.

_Notes:_ No Rust diff was produced this turn (analysis only), so the Rust workflow gates (preflight, axioms, quality_gate, critique, exemplars, self-review checklist) are N/A. The fix itself, when implemented, would be a Rust diff and should run those gates. Severity stays low: realistic trigger window is narrow (requires a full provider remount overlapping the first invoke's sub-line-56 window — StrictMode and a second caller path do NOT trigger it), shared throttle gates contain the FE-visible symptom, and the only durable harm is a leaked finalized-block subscription doubling per-block work. Worth fixing because the correct fix (compare_exchange) is a one-line, near-zero-risk change.

- [x] **F26 fixed & tested** — committed 36693219

---

## F27

### 🟢 LOW · S effort · valid — get_block_timestamp can spuriously fail with 'RPC client not initialized' due to client/rpc_client cache desync

- **Area:** Rust · blockchain

**Root cause**

`get_block_timestamp` reads two independent caches that are populated together but can be cleared concurrently. At queries.rs:130 it calls `get_substrate_client(&state).await?`, which on the cached fast path returns an `Arc<OnlineClient>` clone and releases the `client` RwLock. Then at queries.rs:133-139 it separately acquires the *distinct* `rpc_client` RwLock and errors with "RPC client not initialized" if it is `None`. These are two separate `std::sync::RwLock` fields (state.rs:9 `client`, state.rs:11 `rpc_client`). `connect_and_cache` writes both on success (client.rs:94, 97); `clear_substrate_client` clears both (client.rs:151-159) and holds NEITHER the `connect_guard` nor any lock the reader holds. The block-subscription error path calls `clear_substrate_client` on any non-429 disconnect (subscription.rs:106-108) from a separate tokio task. If that clear runs after line 130 returns but before line 135's read, the caller still holds a valid OnlineClient Arc but `rpc_client` is now `None`, so the command fails spuriously. It self-heals on the next call.

**Evidence (re-read)**

queries.rs:130 `let client = get_substrate_client(&state).await?;` then queries.rs:133-139 `let rpc = state.blockchain.rpc_client.read().map_err(...)?.clone().ok_or_else(|| crate::error::AppError::Other("RPC client not initialized".into()))?;` — two distinct lock acquisitions. state.rs:9-11 confirms `client` and `rpc_client` are two separate `std::sync::RwLock` fields. client.rs:151-159 `clear_substrate_client` sets `*client = None` then `*rpc = None`, taking only each write lock briefly — it does NOT take `connect_guard`. subscription.rs:106-108 `if !is_rate_limited { crate::blockchain::client::clear_substrate_client(&app_state); }` runs in the spawned block-subscription task (subscription.rs:62 `tokio::spawn`). Grep confirms queries.rs:135 is the ONLY reader of `rpc_client` in the whole backend, so this is the sole place the desync surfaces. CORRECTION to the suggested fix: it says "Derive the legacy RPC methods from the same OnlineClient" — but the OnlineClient is built via `OnlineClient::from_rpc_client(rpc.clone())` (client.rs:86) and subxt 0.38's OnlineClient does not re-expose the owned `RpcClient`, so the "derive from OnlineClient" path is not directly achievable; only the fallback/re-derive variant of the suggestion is. NUANCE the finding understates: there is no `.await` between line 130's return and line 135's read, so the interleaving requires genuine cross-thread parallelism (clear running on another tokio worker), making the window microseconds-small — real but extraordinarily rare.

**Fix**

Remove the second cache read and tie the RPC handle's availability to the same connect path the OnlineClient came from. Add a `get_rpc_client(app_state) -> Result<RpcClient, String>` helper in client.rs that mirrors get_substrate_client's fast-path/guard/re-derive structure: read `rpc_client` cache; if Some, return the clone; if None, take `connect_guard`, re-check, and if still None call `connect_and_cache` (which repopulates BOTH caches) then return the freshly-cached rpc_client. In get_block_timestamp, replace lines 133-139 with `let rpc = crate::blockchain::client::get_rpc_client(&state).await?;`. This turns a transient clear into a reconnect instead of a surfaced 'RPC client not initialized'. Keep get_substrate_client at line 130 (still needed for storage().at(block_hash) on line 149).

_Files:_ `src-tauri/src/blockchain/client.rs`, `src-tauri/src/blockchain/queries.rs`

_Test to add:_ Inline #[test] in client.rs `clear_then_read_does_not_leave_caches_desynced`: construct BlockchainState, populate both caches, call clear_substrate_client, assert BOTH are None (locks move in lockstep) — pinning that no code path can observe client=Some while rpc_client=None. Plus a logic test that get_rpc_client re-derives on a None cache rather than erroring. Full e2e needs live network, so the deterministic guard is the both-cleared-together assertion plus the re-derive-not-error path.

_Risk:_ Low. The change only widens behavior (reconnect instead of error) on a path that today errors. Watch: get_rpc_client must take connect_guard like get_substrate_client to avoid a thundering-herd reconnect, and must not hold the std RwLock across an await (connect_and_cache acquires the write lock only briefly after its await, so this holds). Ensure get_block_timestamp still calls get_substrate_client first so the OnlineClient on line 149 stays endpoint-consistent with the rpc handle.

_Notes:_ No Rust diff produced this turn (read-only validation), so preflight/axioms/quality_gate/exemplars/critique/self-review checklist are N/A. Severity is correctly low and NOT inflated — the finding itself rated it low and the impact (one transient, self-healing FE error on get_block_timestamp) matches the code. The suggested fix's primary phrasing ("derive from the OnlineClient") is not achievable in subxt 0.38 because OnlineClient::from_rpc_client does not re-expose the owned RpcClient; the actionable fix is the fallback/re-derive variant. get_block_timestamp is FE block-time display; a transient failure there is cosmetic, not data-loss.

- [x] **F27 fixed & tested** — committed 257bb16d

---

## F28

### 🟢 LOW · S effort · partially_valid — to_plancks accepts negative input and returns a malformed negative planck string

- **Area:** Rust · blockchain

**Root cause**

to_plancks (convert.rs:154-178) validates input only by calling `amount.parse::<f64>()` and discarding the result (line 158). It never re-checks the sign. For "-1": split_once('.')=None so whole="-1"; fraction_padded="000000000000000000"; combined="-1000000000000000000"; `trim_start_matches('0')` (line 172) only strips '0' characters and the leading '-' precedes the digits, so it is left intact; trimmed is non-empty -> returns Ok("-1000000000000000000"). The function's documented contract (return a valid planck digit string) is broken because the result is not a valid u128. This is the inverse of sibling normalize_decimal_digits, which deliberately clamps negative planck to "0" (convert.rs:111-112).

**Evidence (re-read)**

convert.rs:158 `amount.parse::<f64>().map_err(|_| "Invalid amount".to_string())?;` — parses but discards, so the sign is never inspected. convert.rs:160-163 split_once('.') -> whole="-1". convert.rs:171 `let combined = format!("{whole}{fraction_padded}");` -> "-1000000000000000000". convert.rs:172 `let trimmed = combined.trim_start_matches('0');` -> leading '-' survives. The trace in the fixture is exact. WHAT THE FINDING OVERSTATES: the claim "any other consumer of the raw command output gets garbage" has no actual consumer today. I enumerated every caller. (1) transfers.rs:103-106 validate_send_balance does `to_plancks(amount)?` then `planck_str.parse::<u128>()` -> "-1..." fails -> AppError::Validation("Invalid planck amount"). Caught. (2) Frontend only invokes "to_plancks" in two places: app/components/page-sections/stake-bridge/index.tsx:89 and app/components/page-sections/unstake/index.tsx:61. Both feed the result to operations.bond/unbond -> IPC stake_bond (staking.rs:15-17) / stake_unbond (staking.rs:75-77), each of which does `amount.parse::<u128>()` -> "-1..." fails -> AppError::Other("Invalid amount: invalid digit found in string"). Caught. The unstake FE pre-check (unstake/index.tsx:33 `BigInt((intPart||"0")+padded)`) does NOT block negatives — BigInt("-1000000000000000000") succeeds and the `> bondedPlanck` guard is false for a negative — but the backend u128 parse is the backstop. NET: the malformed string never reaches a blockchain extrinsic, never corrupts state; worst real impact is a less precise error message. Severity `low` in the fixture is correct.

**Fix**

After `amount.parse::<f64>()` succeeds, reject non-domain values explicitly instead of discarding the parsed float. Bind the parsed value and return AppError::Validation when it is negative or non-finite (NaN/inf): `let value = amount.parse::<f64>().map_err(|_| AppError::Validation("Invalid amount".into()))?; if !value.is_finite() || value < 0.0 { return Err(AppError::Validation("Amount must be a non-negative number".into())); }`. This mirrors normalize_decimal_digits' documented domain rule (planck is a non-negative integer). The existing string-divmod logic below stays unchanged because once the sign is rejected, `whole` can never carry a '-'. Note the f64 here is only a validity gate, not used for the conversion math (which is lossless string ops), so f64 precision loss is not a regression concern. Keep changes confined to to_plancks; do not touch the frontend BigInt pre-check (it is a UX convenience, not the security boundary).

_Files:_ `src-tauri/src/blockchain/convert.rs`

_Test to add:_ Add a unit test in convert.rs tests module: `#[test] fn to_plancks_rejects_negative() { assert!(to_plancks("-1".into()).is_err()); assert!(to_plancks("-0.5".into()).is_err()); }` plus a non-finite case `assert!(to_plancks("inf".into()).is_err()); assert!(to_plancks("NaN".into()).is_err());` (f64::parse accepts "inf"/"NaN"). These fail today because to_plancks("-1") returns Ok("-1000000000000000000"). Optionally a proptest asserting the output of every Ok(to_plancks(x)) parses as u128.

_Risk:_ Very low. The only behavior change is turning a previously-Ok malformed return into an Err for negative/non-finite input; all current consumers already error on that input one layer later, so no working flow regresses. Watch: confirm no caller relied on the f64-accepts-"inf"/"NaN" leniency (none found); confirm existing tests to_plancks_integer/decimal/zero/small_fraction/many_decimals still pass (they use only non-negative inputs).

_Notes:_ No Rust diff produced this turn (read-only validation), so the Rust workflow gates and the seven-item self-review checklist are N/A. The fixture's `low` severity and `high` confidence on the reproduction are both correct; I only corrected the impact scope from "any other consumer gets garbage" (no such consumer exists) to "every real consumer catches it via u128::parse; the bug is a contract violation of the standalone command, not an exploitable data-corruption path". Fix lands entirely in this repo (convert.rs), not hcfs.

- [x] **F28 fixed & tested** — committed 50740152

---

## F29

### 🟢 LOW · S effort · valid — Malformed / non-numeric balance string silently parses to 0.0, blocking the user with no diagnostic

- **Area:** Rust · billing

**Root cause**

The `unwrap_or(0.0)` on `credit_str.parse()` discards the FromStr error without any log, conflating "server returned an unparseable balance" with "wallet is empty"; the gate then refuses all gated actions with zero diagnostic signal.

**Evidence (re-read)**

eligibility.rs:274-276 (read verbatim): `let resp: crate::billing::credits::CreditBalanceResponse = client.get("/api/billing/credits/balance/", account_id).await?;` then `let credit_str = resp.balance.as_deref().unwrap_or("0");` then `let credits: f64 = credit_str.parse().unwrap_or(0.0);`. Gate at line 285: `let credits_ok = credits > 0.0 && (required <= 0.0 || credits >= required);` with the ineligible return at 286-293. Confirmed by reading the entire function (259-334): no tracing import in the file, no warn!/error!/debug! anywhere in eligibility.rs, so the parse-failure branch is completely silent — the finding's verify_notes is accurate. require_eligible (393-400) converts ineligible to Err(NotReady(InsufficientCredits)). CreditBalanceResponse (credits.rs:50-55) is `pub balance: Option<String>` with `#[serde(default)]`, so a 200 with missing/null balance is None and unwrap_or("0") covers that legitimately. Correction to the finding's divergence claim: get_user_credits (credits.rs:64-71) routes through credits_to_planck (14-33), which on a comma-string like "1,5" does NOT collapse to 0 — it splits on '.', treats "1,5" as the integer part, pads 18 zeros, and emits a MALFORMED non-zero planck string. So the display path and the gate path do diverge as claimed, but the display path produces garbage rather than a clean 0 — the disagreement is real but the display side is itself buggy on that input, not a tidy fallback. credits_to_planck does correctly handle empty and "0" (line 16). Net: finding is real and correctly scoped as low; only the "display just doesn't share the f64 fragility" framing slightly understates that the display path mangles the same input differently.

**Fix**

On the parse-failure branch, log before falling back. Replace `let credits: f64 = credit_str.parse().unwrap_or(0.0);` with an explicit match that emits `tracing::warn!(balance = %credit_str, %account_id, "unparseable credit balance from billing API; treating as 0")` before returning 0.0. Stronger option (recommended given the fail-closed UX cost): treat a 200-with-unparseable-balance as transient by returning a distinct error/reason so the FE shows 'could not verify balance, retry' instead of 'insufficient credits' — e.g. add a `reason: "balance_unverifiable"` ActionEligibility case (eligible:false, FE copy differs) OR return Err so require_eligible surfaces a retry-able NotReady kind rather than InsufficientCredits. Keep the empty/None/"0" path silent — only a genuine parse error should warn. Also guard with `credits.is_finite()` so a 'nan'/'inf' body is treated as unparseable rather than silently failing the > 0.0 comparison.

_Files:_ `src-tauri/src/billing/eligibility.rs`

_Test to add:_ Refactor the parse+classify step into a small pure helper (e.g. `fn classify_balance(raw: &str) -> BalanceParse` returning Parsed(f64) | Unparseable) and unit-test it directly: "1.5" -> Parsed(1.5), ""/"0" -> Parsed(0.0), "1,5" -> Unparseable, "nan" -> Unparseable, "inf" -> Unparseable. This locks the distinction the bug erases (empty wallet vs unparseable) without needing the network. Add a proptest asserting any string f64::from_str rejects maps to Unparseable, never silently to 0.0.

_Risk:_ Low. Adding a warn! is behavior-preserving for the happy path. The stronger 'transient error / new reason' variant changes the FE contract for the unparseable case — must update the TS reason-code handling and the insufficient-credits dialog copy table so 'balance_unverifiable' renders a retry message, not 'buy credits'. Watch that the empty-wallet path ('0'/None) stays classified as Parsed(0.0) and keeps showing the normal insufficient-credits flow, otherwise legitimately-broke users would see a misleading 'retry' message.

_Notes:_ Severity correctly low: triggering requires a server-side formatting regression or schema drift; the failure mode is fail-closed (safe for billing), so the only harm is poor diagnosability and a misleading 'insufficient credits' message instead of 'could not verify balance'. The legitimate None/empty/"0" cases are already handled correctly by unwrap_or("0") + credits_to_planck's empty guard, so any warn! must fire ONLY on a real parse error. The cited divergence with the display path is real but the display path mangles a comma-string into a malformed non-zero planck rather than collapsing to 0 — minor mischaracterization in the finding, does not change the verdict. No Rust diff produced this turn (analysis only); Rust workflow gates N/A.

- [x] **F29 fixed & tested** — committed 50740152

---

## F30

### 🟢 LOW · S effort · valid — add_file gates with bytes=0 (legacy floor) whenever metadata() fails, under-pricing the upload

- **Area:** Rust · billing

**Root cause**

add_file sizes the upload for the credit gate with `tokio::fs::metadata(...).await.map_or(0, |m| m.len())` (files.rs:133); a stat failure silently yields bytes=0, which makes required_credits 0.0 (eligibility.rs:193-202) and collapses the gate to `credits > 0.0` (eligibility.rs:285), so any file size slips past the byte-priced gate when metadata fails but copy later succeeds. The server 402 path remains the real backstop.

**Evidence (re-read)**

files.rs:133 verbatim: `let bytes = tokio::fs::metadata(Path::new(&file_path)).await.map_or(0, |m| m.len());` fed to `require_eligible(&state, &account_id, ...FileUpload, bytes)` at 134-140. eligibility.rs:193-198: `required_credits` does `threshold.max(cost_for_bytes(bytes))` for upload actions; FILE_UPLOAD const is 0.0 (eligibility.rs:64). eligibility.rs:136-142: `cost_for_bytes(0)` = `0.0 * 3.0e-12` = 0.0, pinned by test at eligibility.rs:507 (`cost_for_bytes(0).to_bits() == 0.0_f64.to_bits()`). eligibility.rs:285: `let credits_ok = credits > 0.0 && (required <= 0.0 || credits >= required);` — with required=0.0 this is exactly `credits > 0.0`. All three mechanical links confirmed exactly as the finding's verify_notes claim. The finding's scope claim — that the batch and folder paths "don't materially differ" — is ALSO correct on re-read: `sum_batch_bytes` (files.rs:445) sizes direct files with the identical `tokio::fs::metadata(p).await.map_or(0, |m| m.len())`, and `sum_regular_file_bytes` (files.rs:415-418) sums via `if let Ok(meta) = entry.metadata().await` and silently skips on error. So this is a module-wide "metadata-failure under-prices, server 402 is the backstop" design choice, not unique to add_file. Nothing in the original claim was wrong. What the finding correctly does NOT overstate: the gate is explicitly documented as best-effort, not transactional (eligibility.rs:368-379 "Race window ... NOT a transactional reservation"), with the per-file 402 mapping as the last line of defense — so impact is genuinely bounded. The comment at files.rs:126-131 only frames metadata-failure as "file removed between picker and IPC / permission denied / broken symlink" and indeed does not cover the "metadata fails yet copy succeeds" case, exactly as the finding states.

**Fix**

Keep the documented design (prefer a clear copy I/O error over a credit error — do NOT `?`-bail on the metadata failure), but make the under-pricing observable and explicit. Concretely: (1) in add_file, replace the silent `map_or(0, ...)` with a match that logs `warn!(file=%file_path, "could not size file for credit gate; falling back to legacy >0 floor")` on the Err branch before using bytes=0; (2) mirror the same warn! in sum_batch_bytes (per-file Err) and in sum_regular_file_bytes (per-entry metadata Err) so the module-wide behavior is uniformly traceable; (3) tighten the add_file comment (files.rs:126-131) to name the 'metadata fails yet copy succeeds' case as an accepted under-pricing window backstopped by the server 402. Re-gating from the canonicalized destination AFTER copy is NOT worth it — the file is already committed to the sync folder by then, so a post-copy refusal cannot prevent the upload; the 402 already covers that. Effort is small and the change is purely observability + docs, no behavior change to the eligible/ineligible decision.

_Files:_ `src-tauri/src/sync/files.rs`

_Test to add:_ Add a unit test in files.rs (or a tests/ harness) asserting that a non-existent / unreadable source path makes the size helpers return 0 — e.g. `assert_eq!(sum_batch_bytes(&["/nonexistent/x".into()]).await, 0)` and `assert_eq!(sum_regular_file_bytes(Path::new("/nonexistent")).await, 0)` — which pins the documented fallback. The warn! itself is best verified with a tracing-test capture asserting the warning fires on the Err path so a future refactor that drops the diagnostic fails the test. (A full add_file integration test would need an AppState + mocked balance API, so the size-helper unit test plus a tracing-capture assertion is the proportionate lock for a low-severity observability fix.)

_Risk:_ Very low. The fix changes no eligibility decision — bytes is still 0 on metadata failure, so currently-passing uploads keep passing and currently-failing ones keep failing. Only a log line and a comment are added. Watch that the warn! is not placed on the hot path in a way that floods logs for large batches (it only fires on the error branch, which is rare). No cross-repo change.

_Notes:_ Finding is fully valid and not inflated: severity correctly low because (a) the trigger is a narrow window (metadata fails AND copy later succeeds — transient stat on network/FUSE or a brief TOCTOU), and (b) the gate is documented as best-effort with hcfs-server's 402 as the authoritative backstop (eligibility.rs:368-379). The finding's scope note that the batch/folder paths "don't materially differ" is accurate — sum_batch_bytes (files.rs:445) and sum_regular_file_bytes (files.rs:415-418) use the same silent-0-on-Err pattern, so the proposed fix should touch all three sites for consistency, not just add_file. No Rust diff was produced this turn (analysis only), so the illu Rust gates (preflight / data-structure plan / axioms / critique / exemplars / quality_gate / 7-item self-review) are N/A.

- [x] **F30 fixed & tested** — committed 50740152

---

## F31

### 🟢 LOW · S effort · valid — drive_removed_notify is a dead wakeup channel: notified at two sites, awaited nowhere; documented consumer does not exist

- **Area:** Rust · state/IPC

**Root cause**

`AppState.drive_removed_notify: tokio::sync::Notify` (app_state.rs:74) is a dead synchronization primitive. Its doc comment (app_state.rs:72-73) promises it wakes a function `remove_drive_and_wait` "to wake without polling," but that function does not exist anywhere in the codebase — the symbol appears ONLY in the doc comment and in two code comments (lifecycle.rs:1235, 1333). The field is notified at exactly two sites — `remove_drive` (lifecycle.rs:1237) and `pause_drive` (lifecycle.rs:1335) — via `notify_waiters()`, and is awaited at zero sites (`.notified()` has zero occurrences across all of src-tauri/ including tests). Because `Notify::notify_waiters()` only wakes tasks already parked in `.notified().await` at the instant of the call and stores no permit, and the waiter set is permanently empty, both calls are unconditional no-ops. This is genuine dead code carried by a doc comment that lies about a nonexistent function. The teardown that callers actually rely on is fully synchronous: both `remove_drive` and `pause_drive` `.await` `remove_drive_inmemory` (lifecycle.rs:282) and complete all teardown before returning, so nothing needs to block on a removal signal — confirming the notify channel serves no purpose.

**Evidence (re-read)**

app_state.rs:72-74 (verbatim): `    /// Notified when a drive is removed from the registry, allowing\n    /// `remove_drive_and_wait` to wake without polling.\n    pub drive_removed_notify: tokio::sync::Notify,` — and app_state.rs:163 `drive_removed_notify: tokio::sync::Notify::new(),`. Producer 1, lifecycle.rs:1235-1237 inside `pub async fn remove_drive`: `// Wake any waiters in remove_drive_and_wait so they can re-check without\n    // sleeping through the full polling interval.\n    app_state.drive_removed_notify.notify_waiters();`. Producer 2, lifecycle.rs:1333-1335 inside `pub async fn pause_drive`: identical comment + `app_state.drive_removed_notify.notify_waiters();`. Exhaustive grep across src/ and tests/ for `remove_drive_and_wait|\.notified()|drive_removed_notify`: the ONLY hits are the field decl, the init, and the two producer lines plus their comments — no `fn remove_drive_and_wait`, no `.notified()` anywhere. `tokio::sync::Notify` is the ONLY Notify in the whole crate (grep for `tokio::sync::Notify|notify_one|notify_waiters` returns only these lines), so there is no sibling awaiter in another module either. The real teardown is synchronous: `async fn remove_drive_inmemory(sync, label) -> (usize, Option<PathBuf>)` (lifecycle.rs:282) is `.await`ed by both callers before they return (lifecycle.rs:1217, 1331). NOTHING the original claim stated was wrong — every factual assertion in the fixture holds. The one calibration correction: the fixture itself concedes the impact "is benign (no correctness bug)," which is consistent with the `low` severity it carries; the "lost-wakeup footgun" is purely hypothetical (only materializes if a future dev adds an awaiter AND mis-structures it), so it should not inflate severity above low.

**Fix**

Option (a) — delete the dead primitive. Remove the `drive_removed_notify` field (app_state.rs:74) and its doc comment (app_state.rs:72-73), remove its initializer (app_state.rs:163), and remove both `notify_waiters()` calls plus their two-line comments (lifecycle.rs:1235-1237 and 1333-1335). This is the correct move because `remove_drive`/`pause_drive` already perform all teardown synchronously via the awaited `remove_drive_inmemory` before returning, so no caller needs a wait-for-removal signal. Do NOT pursue option (b) (implementing `remove_drive_and_wait` with a `loop { grab notified() future; check registry; select! }`) — no consumer is planned per the code, and adding a real awaiter is speculative feature work that violates 'no speculative features'. If a future need for blocking-on-removal arises, it should be reintroduced together with its consumer in the same change so the doc never references a nonexistent function again.

_Files:_ `src-tauri/src/app_state.rs`, `src-tauri/src/sync/lifecycle.rs`

_Test to add:_ This is a pure deletion of dead code, so the lock is the compiler: after removal, `cargo build` (and `cargo clippy --all -- -D warnings`) must pass with no unused-field / unused-import fallout, proving nothing referenced the field. As a durable regression guard against the doc-references-a-nonexistent-fn pattern reappearing, optionally add a tiny source-text assertion test in tests/ (mirroring the existing `tests/hippius_relative_path_backfill.rs` static-source-check pattern) that reads app_state.rs and asserts it does NOT contain the string `remove_drive_and_wait`. Existing `remove_drive_inmemory_*` unit tests (lifecycle.rs:2576-2711) already cover the real teardown path and must still pass.

_Risk:_ Very low. The field is `pub` so in principle an out-of-crate consumer could reference it, but this is an application binary crate (not a published library) and grep confirms zero references anywhere in the workspace including tests. Removing a never-awaited `Notify` cannot change runtime behavior — `notify_waiters()` against an empty waiter set is already a no-op. Watch for: any in-flight branch that adds an awaiter (none on this branch); the `pub` visibility means re-run a full-workspace `cargo build` after the edit to catch any external reference the single-crate grep missed.

_Notes:_ No Rust diff produced this turn (read-only validation), so the mandatory Rust gates (preflight, data-structure plan, axioms baseline, exemplars, critique, quality_gate, seven-item self-review checklist) are N/A per the CLAUDE.md conditional carve-outs. Severity confirmed at low: the finding itself concedes zero correctness impact; the value of fixing it is removing a doc comment that actively misleads (it names `remove_drive_and_wait`, a function that has never existed) plus two no-op calls and one dead field. The tokio characterization in the fixture is accurate: `Notify::notify_waiters` wakes only already-parked waiters and stores no permit, so even a future awaiter added naively would be exposed to a lost-wakeup unless it re-checks state in a loop with the `notified()` future acquired before the check — which is exactly why option (b) is not worth doing speculatively. Cross-repo is false: this is entirely local desktop state in app_state.rs + sync/lifecycle.rs; hcfs-client is not involved (its `remove_drive_inmemory` is the desktop's own function, not an hcfs symbol).

- [x] **F31 fixed & tested** — committed 50740152

---

## F32

### 🟢 LOW · S effort · valid — set_sync_path_internal runs 4 sequential queries outside any transaction — overlap check can race a concurrent writer

- **Area:** Rust · SQLite

**Root cause**

`set_sync_path_internal` (src-tauri/src/sync/paths.rs:78-142) performs a classic check-then-act with no enclosing transaction and no application-level lock. It SELECTs the existing rows for the owner (line 84-88), runs the pure overlap validation against that in-memory snapshot (`validate_no_path_overlap`, line 92), then later runs the `INSERT ... ON CONFLICT(owner,label) DO UPDATE` (line 111-121) as a *separate* auto-commit statement. Between the snapshot read and the insert, another writer can commit a row. The only DB-level uniqueness on the table is `UNIQUE(owner, label)` (schema.rs:136/215) — there is no unique index on `path`, so the DB cannot reject two overlapping-but-differently-labeled roots; `validate_no_path_overlap` is the sole defense, and it operates on a stale snapshot. Tauri IPC handlers are async on a multithreaded tokio runtime over an 8-connection WAL pool (main.rs:474-483), so two concurrent writers for the same account (two `set_sync_path` calls, or `set_sync_path` racing `add_local_sync_folder`, which does its own un-serialized SELECT at lifecycle.rs:146-156) can each pass overlap validation against a snapshot predating the other's insert, producing two overlapping sync roots that the check exists to forbid. Under WAL, writes serialize at the SQLite level, but because each statement here is its own transaction the SELECT and INSERT are not atomic together — that is the TOCTOU window.

**Evidence (re-read)**

paths.rs:84-92 — `let rows = sqlx::query("SELECT label, path FROM sync_paths WHERE owner = ?").bind(&owner).fetch_all(pool).await...` then `validate_no_path_overlap(Path::new(path), label, &existing).await?;` — read against the bare `pool`, no tx. paths.rs:111-121 — the `INSERT ... ON CONFLICT(owner, label) DO UPDATE ...` runs `.execute(pool)` as a separate auto-commit statement; nothing serializes it against the earlier read. schema.rs:136 and schema.rs:215 — the table's only multi-column uniqueness is `UNIQUE(owner, label)`; there is NO unique constraint/index on `path`, confirming overlap is policed only in application code. main.rs:478-483 — `SqliteJournalMode::Wal`, `max_connections(8)`, `busy_timeout(5s)`, so concurrent connections exist and writes can interleave at statement granularity. lifecycle.rs:146-156 — `add_local_sync_folder` independently SELECTs labels and then calls `set_sync_path_internal`, a second un-serialized writer for the same owner. The original finding is accurate on all counts; the only thing slightly overstated is exploitability — both writers are user-initiated UI flows (Add Folder dialog / configure path), so the race requires two near-simultaneous IPC invocations for one account, which the normal single-dialog UI does not produce. A scripted/direct IPC caller could trigger it. Severity "low" is appropriate; impact is a redundant overlapping drive config (wasted re-upload / confusing dual roots), not data loss or corruption.

**Fix**

Wrap the overlap read + legacy REPLACE + final upsert in a single write transaction so the snapshot and the insert are serialized against other writers. In `set_sync_path_internal`, open `let mut tx = pool.begin().await?;`, perform the `SELECT label, path FROM sync_paths WHERE owner = ?` via `&mut *tx`, keep `validate_no_path_overlap` as-is, then run the legacy `SELECT id`/`REPLACE` and the final `INSERT ... ON CONFLICT` through the same `tx`, then `tx.commit().await?`. Critical nuance: a default `pool.begin()` is DEFERRED and only takes the write lock on first write, so it does NOT close the read-then-act window by itself — promote it to `BEGIN IMMEDIATE` (or issue a leading no-op write) so the write lock is held from the start of the overlap SELECT, forcing other writers to wait on busy_timeout. Apply the identical pattern to `add_local_sync_folder` (lifecycle.rs:146-159): do the label-generation SELECT and the `set_sync_path_internal` upsert inside one shared tx, or refactor `set_sync_path_internal` to accept a transaction so the caller owns the boundary. The macOS bookmark write (paths.rs:130) and `allow_asset_directory` (paths.rs:163) stay OUTSIDE the tx — they are side effects, not part of the atomic check-and-act.

_Files:_ `src-tauri/src/sync/paths.rs`, `src-tauri/src/sync/lifecycle.rs`

_Test to add:_ Add an async test (#[tokio::test] in paths.rs against a real sqlx SqlitePool built via `ensure_table_schema`, max_connections>=2) that spawns two `set_sync_path_internal` futures concurrently with `tokio::join!` for the SAME owner: one path `/tmp/parent` (label A) and one path `/tmp/parent/child` (label B). Assert exactly one succeeds and the other returns `AppError::Validation` (overlap), and the table ends with a single row. Confirm the test FAILS against the current non-transactional code (proving it catches the race) before applying the fix. Edge cases per SQLite contract: assert the loser surfaces the validation error after the winner commits rather than SQLITE_BUSY, given busy_timeout=5s.

_Risk:_ Holding a write transaction across `tokio::fs::canonicalize` (async realpath, 10-100ms on slow/network FS per the function's own doc comment) lengthens write-lock hold time, so a second writer for a different account could wait up to busy_timeout(5s) instead of proceeding immediately — watch for new SQLITE_BUSY/timeout surfacing under concurrent setup. Also verify the legacy REPLACE branch still degrades gracefully inside the tx (it currently only `warn!`s on failure; a failed REPLACE must not abort the whole upsert unless intended). Refactoring the signature to take a tx touches the other caller (`set_sync_path` at paths.rs:161) — keep a pool-taking wrapper to avoid a wide ripple.

_Notes:_ No Rust diff was produced this turn (analysis only), so the Rust workflow gates (preflight, data-structure plan, axioms baseline, exemplars, critique, quality_gate, and the 7-item self-review checklist) are N/A. Verdict VALID at low severity. The original finding is technically accurate on the mechanism (no tx around check-then-act; only UNIQUE(owner,label) protects the table; multithreaded tokio + 8-conn WAL pool permits statement interleaving; second un-serialized writer in add_local_sync_folder). One correction: exploitability is narrower than a generic "concurrent IPC writes" framing implies — both writers are single-dialog user UI flows, so two simultaneous same-account adds are unlikely in normal use; the race is reachable mainly via scripted/direct IPC or a rapid double-submit. Impact is a redundant overlapping drive (wasted re-upload, confusing dual roots), not data loss, so "low" stands. Fix is small and entirely in-repo (hippius-desktop); does NOT land in hcfs. The fix's most important non-obvious detail: pool.begin() defaults to DEFERRED and will NOT close the window — must use BEGIN IMMEDIATE.

- [x] **F32 fixed & tested** — committed a924a3c4

---

## F33

### 🟢 LOW · S effort · partially_valid — Credits-notification existence checks scan notifications with no index on (notification_type, notification_subtype)

- **Area:** Rust · SQLite

**Root cause**

The `notifications` table is created with exactly two indexes (schema.rs:448,452): `idx_notifications_user(user_address)` and `idx_notifications_user_deleted(user_address, is_deleted)`. The credit-dedup and low-credit-warning probes filter on `notification_type = 'Credits' AND notification_subtype = ?` (or `LIKE`/`IN`) with NO `user_address` predicate. Because SQLite can only use an index whose leading column matches a query predicate, neither index applies to these queries, so the planner falls back to a full table scan. These probes run on every credit poll driven by the frontend `useCreditsNotification.ts` hook, and the table is append-mostly (no retention/eviction; the `cleanup_duplicate_welcome` path confirms rows accumulate), so scan cost grows linearly with notification count.

**Evidence (re-read)**

CONFIRMED — index facts: schema.rs:448 `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_address)` and schema.rs:452 `... idx_notifications_user_deleted ON notifications(user_address, is_deleted)`. No index leads with notification_type/notification_subtype. notifications table DDL is schema.rs:429-443 (no other indexes).

CONFIRMED — scanning query sites (no user_address predicate, so neither index applies):
- crud.rs:424 `credit_already_notified`: `SELECT COUNT(*) FROM notifications WHERE notification_type = 'Credits' AND notification_subtype = ?`
- crud.rs:437 `low_credit_subtype_exists`: identical SQL.
- crud.rs:451 `has_active_low_credit_notification`: `... AND notification_subtype LIKE 'LowCreditWarning-%' AND is_deleted = 0`
- crud.rs:465 `get_last_deleted_low_credit_time`: `... LIKE 'LowCreditWarning-%' AND is_deleted = 1 ORDER BY deleted_at DESC LIMIT 1`
- credits.rs:117 and :137 are EXACT DUPLICATES of crud.rs:451/465 (the finding cited credits.rs but did not flag the duplication).
- credits.rs:234 `process_credit_events`: `SELECT notification_subtype FROM notifications WHERE notification_subtype IN (...)` — already batched to one IN query (credits.rs:232-239), so the per-event N+1 the auditor implies for this site is already gone; it is still one unindexed scan, not N.

WHAT THE FINDING GOT WRONG / OVERSTATED:
1. The location string says `credits.rs:117,137,234` as if top-level credits.rs; the actual paths are `src/notifications/credits.rs` and `src/notifications/crud.rs`. The verify_notes already self-corrected the crud.rs labeling.
2. The O(n)-growth / "can grow large" framing is overstated for a single-user desktop SQLite store: realistic row counts are hundreds-to-low-thousands, where a full scan is sub-millisecond. Real-world impact is negligible; this is a hygiene/defense-in-depth index, not a hot-path bottleneck.
3. The `list_notifications` ORDER BY claim (crud.rs:249-251) is partially imprecise. The WHERE is `(user_address = ? OR user_address = 'system') AND is_deleted = 0` — an OR across two user_address values. The proposed composite `(user_address, is_deleted, creation_time DESC)` cannot serve the ORDER BY across the OR-union, so SQLite would still sort. That sub-recommendation does not deliver the claimed pre-sorted read.

**Fix**

Add one idempotent index in ensure_table_schema (schema.rs, right after line 452/454 alongside the existing notifications indexes): CREATE INDEX IF NOT EXISTS idx_notifications_type_subtype ON notifications(notification_type, notification_subtype). This covers the equality probes (crud.rs:424,437 / credits.rs equivalents) directly; for the LIKE 'LowCreditWarning-%' prefix probes (crud.rs:451,465 / credits.rs:117,137) the leading notification_type='Credits' equality plus the anchored-prefix LIKE lets SQLite range-scan the index instead of the table. DROP the list-ordering composite index from scope: do NOT add (user_address, is_deleted, creation_time DESC) - the OR predicate on user_address defeats it, so it adds write cost with no read benefit. Separately worth a cleanup (out of finding scope but adjacent): credits.rs:117/137 duplicate crud.rs:451/465 verbatim and should call the crud.rs functions to remove the divergence risk.

_Files:_ `src-tauri/src/utils/schema.rs`

_Test to add:_ In tests/local_db_commands.rs, add a test that runs ensure_table_schema against a fresh temp SQLite pool, then asserts via SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='notifications' that idx_notifications_type_subtype exists, and runs EXPLAIN QUERY PLAN SELECT COUNT(*) FROM notifications WHERE notification_type='Credits' AND notification_subtype=? asserting the plan text contains 'USING INDEX idx_notifications_type_subtype' (not 'SCAN notifications'). This locks both the index creation and that the planner actually picks it.

_Risk:_ Very low. CREATE INDEX IF NOT EXISTS is idempotent and ensure_table_schema runs at every startup. The only cost is marginally slower INSERTs into notifications (one extra B-tree per row) - irrelevant at desktop write volumes. No behavior change to query results. Watch: confirm the LIKE-prefix probes actually use the index in EXPLAIN QUERY PLAN (anchored prefix on a non-leading column requires the leading notification_type equality to be present, which it is).

_Notes:_ Core claim (unindexed full scans on credit-dedup probes) is factually correct and verified verbatim. Downgraded from a clean "valid" to "partially_valid" because: (a) the O(n)/large-table impact is overstated for single-user desktop SQLite row counts (real impact negligible - this is hygiene, not a measurable bottleneck), and (b) the secondary list-ordering composite-index recommendation does not work as claimed because the (user_address = ? OR user_address = 'system') OR-predicate prevents SQLite from using the index for the creation_time DESC ordering. Severity correctly stays low. Adjacent issue not in the finding: credits.rs:117/137 are verbatim duplicates of crud.rs:451/465. No Rust diff this turn (validation only); preflight/axioms/quality_gate/self-review checklist all N/A.

- [x] **F33 fixed & tested** — committed 36693219

---

## F34

### 🟢 LOW · S effort · partially_valid — Tray sync-progress listener and login-status interval are never torn down on logout; only HMR-parked, leaking across account switches

- **Area:** TS · sync hooks

**Root cause**

`useTrayInit` (app/lib/wallet-auth-context.tsx:561, called once) runs a `menuPromise` IIFE guarded by `if (menuPromise) return` (useTraySync.ts:176). `menuPromise` is a module-level `let` (60) assigned exactly once at 178 and never reset to null, so the IIFE — and therefore `startSyncActivityWatcher()` (285) and `startLoginStatusWatcher()` (291) — run exactly once per process. Each parks its handle on `window.__hippiusLoginWatcher` / `window.__hippiusSyncWatcherUnsub` (HMR guards), and the logout effect (159-173) does NOT stop them. So a single 2s `setInterval` and a single `sync_progress_snapshot` listener persist for the app's entire lifetime, including while logged out. This is intentional: the login watcher IS the logout-detection mechanism — `wallet-auth-context.tsx:172` calls `clearLoginStatusCache()` on logout precisely so the watcher's next tick observes the logged-out state (see its comment). The "leaking across account switches" framing is incorrect: nothing accumulates — it is one persistent singleton, not a growing leak.

**Evidence (re-read)**

useTraySync.ts:865 `const h = setInterval(tick, INTERVAL_MS);` with INTERVAL_MS=2000 (846); the only clearInterval (868) is the HMR guard fired by a NEXT start that never happens. tick (848-862) calls refreshLoginStatus → refreshTrayData (123-134) which is cache-gated at 5s (TRAY_CACHE_DURATION=5000, line 112), so the actual IPC fires ~once per 5s, not every 2s. The IPC is get_tray_menu_data (src-tauri/src/utils/tray_menu.rs:30): when logged out it does ONE SQLite read of the latest auth_session row (34) and skips the billing API call entirely (substrate_address is None → credits=None, 47-60). So the persistent cost is one indexed SQLite read per ~5s. \n\nSnapshot listener: useTraySync.ts:1277 `listen("sync_progress_snapshot", ...)` parks unsub at 1282; the only invocation of that unsub is the HMR guard at 929-931. But its tick (935) short-circuits at 957 `if (!isUserLoggedIn())` → clears rows and returns, AND logout_full→stop_sync halts backend snapshot emission, so a logged-out account processes ~nothing. \n\nIntent confirmed: wallet-auth-context.tsx:170-172 — "Immediately invalidate login status cache so the tray watcher picks up the logged-out state on its next 2-second tick." clearLoginStatusCache(). \n\nThe finding's "leaking across account switches" and "snapshot listener that processes events for a logged-out/closed account" are both overstated — singleton (not leak), and short-circuited (not processing). lastLoginStatus (843) self-corrects on the next tick after login/logout (851-853), so its persistence is not a bug.

**Fix**

Documentation-first, not behavior change. The singleton-outlives-auth design is correct and load-bearing (the login watcher is the logout-detection mechanism). The right fix is to (1) add a comment block above startLoginStatusWatcher/startSyncActivityWatcher stating they are intentional process-lifetime singletons started once via the menuPromise guard, that logout is detected by the poll (not by teardown), and that the window handles are HMR guards only — not lifecycle teardown. Correct the misleading 'parked on window so HMR can clear' comments to also note no logout teardown is intended. (2) OPTIONAL micro-optimization if the ~1 SQLite read / 5s is judged worth removing: keep the interval running but skip the IPC when already-known-logged-out AND the cache was explicitly cleared, relying on clearLoginStatusCache() to force exactly one re-query on the logout transition; this avoids polling Rust indefinitely while preserving instant logout detection. Do NOT remove/teardown the watcher on logout — that breaks logout detection and re-login would never re-arm it (menuPromise never re-runs).

_Files:_ `app/lib/hooks/useTraySync.ts`

_Test to add:_ In app/lib/hooks/__tests__/useTraySync.test.tsx add a test that mounts useTrayInit(true), advances fake timers, flips to useTrayInit(false), and asserts: (a) the login-status interval is still active and its next tick observes loggedIn=false via the (mocked) get_tray_menu_data after clearLoginStatusCache, calling updateTraySyncLabel(null)/setTrayIconSyncing(false); (b) a sync_progress_snapshot emitted while logged out does NOT insert progress rows (tick short-circuits). This pins the intentional singleton-survives-logout contract so a future 'fix' that tears the watcher down on logout fails fast.

_Risk:_ Documentation-only change: zero runtime risk. If the optional IPC-skip is implemented, the regression risk is breaking logout/login detection latency — guard against it with the test above and verify clearLoginStatusCache() still forces a single re-query on the transition.

_Notes:_ No Rust diff this turn; all Rust gates N/A (this is a TypeScript finding; I only read Rust as supporting evidence). Verdict downgraded from the fixture's framing: the mechanical assertions are accurate, but two load-bearing claims are wrong — (1) it is a single process-lifetime singleton, NOT a leak that grows across account switches (the menuPromise guard makes the IIFE run exactly once); (2) the snapshot listener does not meaningfully 'process events for a logged-out account' because tick short-circuits on !isUserLoggedIn() and the backend stops emitting after logout_full→stop_sync. The 2s interval is real but cache-gated to ~1 lightweight SQLite read per 5s, and the poll is the INTENTIONAL logout-detection mechanism (wallet-auth-context.tsx:172 comment). Severity stays low; the actionable work is documentation + an optional poll-skip-while-logged-out micro-opt. Suggested-fix option in the fixture to 'tear down on logout and re-start on login' is actively wrong: menuPromise never re-runs, so a torn-down watcher would never re-arm and re-login would silently lose tray sync/login updates.

- [ ] **F34 fixed & tested**

---

## F35

### 🟢 LOW · M effort · valid · `[HCFS]` — metadataStaleLabelsAtom clears the entire map on any hcfs_activity_updated, dropping legitimately-stale labels for other drives

- **Area:** TS · global state

**Root cause**

The ACTIVITY_UPDATED listener in useMetadataStale.ts performs an all-or-nothing clear of the per-label metadataStaleLabelsAtom Map, even though the atom is keyed per drive label. Because the underlying Rust/hcfs-client event SyncEvent::ActivityUpdated is a unit variant carrying NO label, the FE has nothing to scope the clear with, so it wipes every drive's entry on any drive's activity. The inline comment justifies this by claiming each cleared entry "will re-fire its METADATA_STALE event on the next bounded-retry failure" — but METADATA_STALE is produced ONLY by spawn_reconcile_timestamps, which is spawned ONLY once per drive from register_drive at init. It is a one-shot per registration, not a recurring bounded retry, so a wrongly-cleared label for drive A will not re-surface its banner from the reconcile path. The mismatch is genuine: the atom is per-label by design but the clear is global.

**Evidence (re-read)**

useMetadataStale.ts:71-77 — `const activityHandle = await listen(ACTIVITY_UPDATED, () => { if (cancelled) return; setStale((prev) => { if (prev.size === 0) return prev; return new Map(); }); });` confirms the unconditional whole-map wipe with zero per-label scoping. The METADATA_STALE handler (lines 51-55) is correctly per-label (`next.set(event.payload.label, ...)`), proving the atom's intended granularity. Payload-less event confirmed cross-repo: hcfs-client events.rs:143-274 declares `ActivityUpdated` as a bare unit variant (no fields), and desktop tauri_bridge.rs:577-578 emits `app.emit(events::ACTIVITY_UPDATED, ())` and lifecycle.rs:449 emits the same `()` on reconcile success — so the FE physically cannot scope the clear today. One-shot origin confirmed: METADATA_STALE is emitted only at lifecycle.rs:481-487 inside spawn_reconcile_timestamps, which the docstring (lifecycle.rs:374-394, "The cold-start reconcile is a one-shot per drive") and the only spawn site (register_drive, lifecycle.rs:371) both confirm runs once per drive init. The auditor's claim is accurate. Correction to scope: the effect is a premature *dismissal* of a banner (under-reporting), not a false alarm, and the condition the banner describes (sparse DATE UPLOADED) self-heals on the next real sync cycle's remote-timestamp fetch regardless — MetadataStaleAlert.tsx:36-78 is a purely informational amber banner with no actionable affordance and no data impact. So low/cosmetic severity is correct. Minor inaccuracy in the auditor's framing: in hcfs-client the only in-tree emit of SyncEvent::ActivityUpdated is from apply_rename_to_activity (runner.rs:962-1034), so the cross-drive collision is even rarer than "any successful activity" implies, but the desktop-side reconcile-success emit (lifecycle.rs:449) does fire it per-drive at init, which is the realistic collision window.

**Fix**

Add a `label: String` field to hcfs-client's `SyncEvent::ActivityUpdated` variant (events.rs:143-274) and pass the owning drive label at both emit sites — apply_rename_to_activity (runner.rs) already has self/label in scope. In the desktop tauri_bridge.rs:577 match arm, forward the label as a typed LabelPayload instead of `()`; the reconcile-success emit at lifecycle.rs:449 already has `label` in scope and should emit it too. Then in useMetadataStale.ts the ACTIVITY_UPDATED listener becomes typed (listen<LabelPayload>) and clears only that label: setStale((prev) => { if (!prev.has(p.label)) return prev; const next = new Map(prev); next.delete(p.label); return next; }). This makes the clear granularity match the atom's per-label design. If a cross-repo hcfs-client bump is undesirable short-term, a desktop-only stopgap is to drop the global clear entirely and instead clear a label only when that label emits a scoped event the FE already receives with a label (e.g. hcfs_sync_completed), since a completed sync cycle is the event that actually backfilled the timestamps — strictly more correct than the current global wipe and needs no hcfs change.

_Files:_ `hcfs-client/src/engine/events.rs (cross-repo: add label to ActivityUpdated)`, `hcfs-client/src/engine/runner.rs (cross-repo: pass label at emit)`, `src-tauri/src/sync/tauri_bridge.rs (forward label payload)`, `src-tauri/src/sync/lifecycle.rs (emit label on reconcile success)`, `src-tauri/src/sync/events.rs (payload type if not reusing LabelPayload)`, `app/lib/hooks/useMetadataStale.ts (scoped delete)`

_Test to add:_ Vitest unit test for useMetadataStale: seed the atom with two labels (driveA stale, driveB stale), fire a mocked ACTIVITY_UPDATED with payload {label:'driveB'}, assert driveA's entry survives and only driveB's is deleted. Without the fix the test fails because both are wiped. Pair with a Rust assertion that the tauri_bridge ActivityUpdated arm emits a non-unit label payload (mirrors the existing LabelPayload event tests).

_Risk:_ Cross-repo enum change: SyncEvent is consumed via match in tauri_bridge.rs, so adding a field forces that one match arm to bind the new field — compiler-caught, low risk. Any other consumer of ActivityUpdated in hcfs-client must also be updated (only apply_rename_to_activity emits it today). The desktop-only stopgap variant carries near-zero risk but changes which event clears the banner (sync_completed vs activity_updated); verify a rename-only activity still eventually clears via the next sync cycle so a renamed-but-not-synced drive doesn't leave a sticky banner.

_Notes:_ No Rust diff produced this turn (analysis-only validation); the illu Rust gates (preflight, data-structure plan, axioms baseline, exemplars, critique, quality_gate, and the seven-item self-review checklist) are N/A for this read-only assessment. Verdict valid at low severity: the bug is real and the auditor's one-shot-reconcile reasoning is correct (even understated re: re-fire), but impact is bounded to premature dismissal of a cosmetic, self-healing informational banner with no data or gating consequence. The clean fix requires a cross-repo hcfs-client change to add a label to the payload-less ActivityUpdated event; a desktop-only stopgap (clear on the already-labeled sync_completed event) is available if the cross-repo bump must be deferred.

- [UPSTREAM] **F35** — cross-repo hcfs fix; spec in 'Cross-repo (hcfs) upstream work' section below (document-only this session, per user)

---

## F36

### 🟢 LOW · S effort · partially_valid — Provider value object is never memoized — every auth state change re-renders all 66 consumers

- **Area:** TS · auth context

**Root cause**

React Context with an inline object literal as `value`: every render of WalletAuthProvider mints a new value identity and React re-renders all 66 useWalletAuth consumers regardless of the field they read (bare useContext, no selector). 4 of 7 members (login, setSession, setOAuthSession, resetHippiusDesktop) are plain consts recreated each render, so a useMemo alone would still be invalidated unless they are useCallback-stabilized first. The mechanism is real; the impact is low because no high-frequency setState exists — sessionTimeRemaining is set once (no interval), and all setStates fire in rare login/logout/boot bursts whose real cost is awaited Rust IPCs, not React reconciliation.

**Evidence (re-read)**

app/lib/wallet-auth-context.tsx:563-579 — `return (<WalletContext.Provider value={{ isAuthenticated, polkadotAddress, isLoading, authType, oauthSession, getMnemonic, login, setOAuthSession, setSession, logout, resetHippiusDesktop, sessionTimeRemaining }}>` is a fresh inline object literal with NO useMemo wrapper. Confirmed.
Stability of members, re-read directly:
- getMnemonic (136-144): `const getMnemonic = useCallback(async ... , [polkadotAddress])` — STABLE (deps: polkadotAddress).
- logout (146-189): `const logout = useCallback(async ... , [router])` — STABLE.
- login (469): `const login = async (...)` — plain const, recreated every render. Confirmed unstable.
- setSession (411): `const setSession = async (...)` — plain const. Confirmed unstable.
- setOAuthSession (514): `const setOAuthSession = async (...)` — plain const. Confirmed unstable.
- resetHippiusDesktop (556): `const resetHippiusDesktop = async (...)` — plain const. Confirmed unstable.
useWalletAuth (585-590): `const ctx = useContext(WalletContext)` — bare, no use-context-selector, no memoized slicing. Confirmed.
illu references on useWalletAuth: "66 call site(s)". Confirmed.
What the original claim got WRONG: the `description` prose ("single biggest runtime cost in the auth subsystem", "each one a full app-wide re-render cascade") overstates impact. `rg` for setInterval/setSessionTimeRemaining (lines 95,100,178,325,348,454,470,509) shows there is NO interval driving any setState — every setState is a one-shot in a login/logout/boot burst. The fixture's own verify_notes already concedes "the severity is inflated," and the assigned severity (low) is in fact correct; only the narrative is hyperbolic. Hence partially_valid with severity confirmed low, not raised.

**Fix**

1) Wrap login, setSession, setOAuthSession, resetHippiusDesktop in useCallback. Their real dependencies are minimal because setState dispatchers and refs (logoutTimerRef, syncInitialized, polkadotAddressRef) are stable across renders; resetHippiusDesktop depends on [logout], the others on essentially nothing dynamic except the already-stable initSync/scheduleLogout closures. Note scheduleLogout and initSync are themselves plain functions today — to make the useCallback deps honest, either wrap them in useCallback too or (simpler) move them so the stabilized callbacks only close over stable refs/dispatchers; carefully preserve the existing stale-closure guard (polkadotAddressRef mirrors polkadotAddress, see lines 108-114) rather than capturing polkadotAddress directly. 2) Wrap the provider value in useMemo keyed on [isAuthenticated, polkadotAddress, isLoading, authType, oauthSession, sessionTimeRemaining, getMnemonic, login, setOAuthSession, setSession, logout, resetHippiusDesktop]. Once all functions are useCallback-stable, the memo only changes when a real state field changes. This is a frontend-only change — keep business logic in Rust per CLAUDE.md; this is pure UI render hygiene, which legitimately lives in the FE.

_Files:_ `app/lib/wallet-auth-context.tsx`

_Test to add:_ A Vitest + @testing-library/react render test that mounts WalletAuthProvider with a child consuming useWalletAuth via React.memo, asserts the child renders once, then triggers a no-op provider re-render (e.g. flip an unrelated parent prop) and asserts the memoized child does NOT re-render — locking value-identity stability. Plus a render-count assertion that flipping isLoading does not change the identities of login/logout (proves callback stability). Colocate as wallet-auth-context.test.tsx.

_Risk:_ Stale-closure regression is the main risk: the four functions reference state (polkadotAddress) and helper functions (scheduleLogout, initSync, logout) that are recreated each render; an incorrect/under-specified useCallback dep array would capture a stale polkadotAddress or stale logout and silently break logout-timer scheduling or sync init. The existing polkadotAddressRef pattern must be reused, not bypassed. Watch the boot useEffect (lines 263-409) whose deps are [logout, router] with an eslint-disable — changing logout identity stability there is already handled, but verify the effect doesn't re-fire unexpectedly. Low blast-radius otherwise; no Rust, no IPC contract change.

_Notes:_ No Rust this task; preflight/axioms/quality_gate/critique/exemplars/self-review checklist all N/A (TypeScript-only analysis, no Rust diff). The finding is structurally accurate in every specific claim (unmemoized value, 2 stable / 4 unstable functions, bare useContext, 66 call sites — all independently re-read and confirmed). Downgraded from the description's implied high-impact framing to partially_valid because the impact narrative ("single biggest runtime cost in the auth subsystem", "full app-wide re-render cascade on every render") is overstated: there is no high-frequency render trigger in this provider (no interval, no per-tick setState — verified via rg), so re-renders occur only in rare login/logout/boot bursts where the dominant cost is awaited Rust IPCs, not React reconciliation. The fixture's assigned severity (low) is already correct; only the prose oversells it. The suggested fix is sound and worth doing as cheap render hygiene (effort S), with the one caveat that useCallback dep arrays must reuse the existing polkadotAddressRef stale-closure guard.

- [WONTFIX] **F36** — low-impact render-perf; useCallback on 4 auth fns risks stale-closure auth bugs; user opted to skip

---

## F37

### 🟢 LOW · S effort · valid — sessionTimeRemaining is a dead context field that still triggers app-wide re-renders

- **Area:** TS · auth context
- **Overlaps:** F1

**Root cause**

See above.

**Evidence (re-read)**

CONFIRMED claims, with corrections:
- Declared on context type: `sessionTimeRemaining: number | null;` at wallet-auth-context.tsx:80.
- State: `const [sessionTimeRemaining, setSessionTimeRemaining] = useState<number | null>(null);` lines 100-102.
- Setter calls are at lines 178 (logout clear → null), 325 (boot not-authenticated clear → null), 348 (boot restore → result.logoutTimeMs), 454 (setSession → timeRemaining or null). The fixture cited 178/325/348/454 — accurate. (Fixture body once said "three+"; there are 4 setter calls plus the declaration.)
- Exposed on provider value: `sessionTimeRemaining` at line 577 inside the inline `value={{...}}` literal (line 565).
- Zero external consumers: `rg sessionTimeRemaining` excluding this file → empty. No `useContext(WalletContext)` outside the file, no `...useWalletAuth()` spread.
- No `useMemo` anywhere in the file (rg confirms), so the value object is rebuilt every render — finding #1's coupling is real.

CORRECTIONS to the fixture:
1) Blast radius is UNDERSTATED, not overstated: `rg -l useWalletAuth` (excluding the def) = 133 consumer files, not the "66-consumer / 68 call sites" the fixture claimed. The harm is larger than stated.
2) Performance framing is slightly INFLATED in cadence: the field is set once per auth event (login/restore), not on a hot path. Lines 178 and 325 set null when the value is typically already null, so React's Object.is bailout makes them no-ops; only lines 348 and 454 cause a real one-time render. So this is a one-shot extra render at auth boundaries, which is why "low" severity is correct.
3) "It is not just inert" overstates ongoing cost — there is no countdown/interval, so no repeated re-renders. The frozen-snapshot observation is correct (line 453).

**Fix**

Delete the dead field entirely: (1) remove `sessionTimeRemaining: number | null;` from WalletContextType (line 80); (2) remove the useState declaration (lines 100-102); (3) remove all four setSessionTimeRemaining calls (lines 178, 325, 348, 454) — the timer scheduling at scheduleLogout already owns the timeout via logoutTimerRef, so deleting the setter calls changes no behavior; (4) remove `sessionTimeRemaining` from the provider value object (line 577). This is a strict subtraction with no replacement. Independently, finding #1 (wrap the value object in useMemo with the correct dep list) should be fixed to actually cut the re-render coupling — removing sessionTimeRemaining alone does not memoize the value object. If a live countdown is ever wanted, derive it in a consumer from an absolute expiry timestamp, not a frozen ms snapshot.

_Files:_ `app/lib/wallet-auth-context.tsx`

_Test to add:_ Add a Vitest/RTL test (e.g. app/lib/wallet-auth-context.test.tsx) that renders WalletAuthProvider and asserts the context value object (read via useWalletAuth) does NOT contain a `sessionTimeRemaining` key, plus a lint/type guard: a tsc --noEmit run proves no consumer referenced the removed field. A simpler durable lock is a unit assertion `expect('sessionTimeRemaining' in ctx).toBe(false)`.

_Risk:_ Very low. The field has no readers, so removal cannot break a consumer (verified by repo-wide rg + tsc would fail-fast if a hidden reader existed). Only behavioral surface is React state churn, which decreases. Watch: ensure the logout timer still schedules — scheduleLogout(result.logoutTimeMs) at line 349 and scheduleLogout(timeRemaining) at line 455 must remain; only the setSessionTimeRemaining lines are deleted.

_Notes:_ No Rust diff this turn; Rust preflight / data-structure plan / axioms-baseline / quality_gate / critique / exemplars / self-review checklist all N/A (TypeScript-only finding). The re-render impact is real but coupled to finding #1 (unmemoized provider value at line 565). Removing sessionTimeRemaining is correct cleanup but does NOT by itself fix the re-render storm — both should be fixed together; F1 is the higher-leverage one. Fixture's consumer count (66/68) is wrong — actual is 133 files via `rg -l useWalletAuth`. Severity "low" upheld because the extra renders are one-shot at login/restore, not a hot loop.

- [x] **F37 fixed & tested** — committed 303c3ae0

---

## F38

### 🟢 LOW · S effort · partially_valid — Home 'Credits' tile is stale-by-design next to 6s-polling sibling tiles, creating inconsistent UI

- **Area:** TS · query cache

**Root cause**

The "Available Credits" tile reads useUserCredits (staleTime: Infinity, no poll, no focus refetch) while its two grid siblings poll every 6s, so the balance visually lags the storage tiles until manual refresh; nothing invalidates the user-credits key on sync/charge events.

**Evidence (re-read)**

DetailList.tsx:15-20 destructures useUserCredits() (incl. refetch: refetchCredits). DetailList.tsx:24-31 — BOTH the storage and file-count cards are fed by a SINGLE useDriveStorageStats() call (fileCount and totalBytes from driveStats); there is no useDriveCreditsTotal in this component. The detailCards array (DetailList.tsx:83-114) is exactly three tiles: available-credits, total-files, total-storage-used. useUserCredits.ts:32-38 — options: { staleTime: Infinity, select: ... } with NO refetchInterval/refetchOnWindowFocus. useInvokeQuery.ts:10-14 DEFAULT_OPTIONS = { staleTime: 30_000, refetchOnWindowFocus: false, retry: false }, so the credits query inherits refetchOnWindowFocus:false. useDriveStorageStats.ts:39-41 — staleTime:0, refetchOnWindowFocus:true, refetchInterval: LIVE_DATA_REFRESH_MS. CORRECTION to the fixture: the location/description say the credits tile sits next to the "Storage" / "Total Credit Used" tiles, but DetailList renders NO "Total Credit Used" tile — that tile (useDriveCreditsTotal, DRIVE_CREDITS_TOTAL_QUERY_KEY) lives in app/components/page-sections/home/credit-usage-trends/index.tsx, which home/index.tsx does NOT even render (home renders DetailList + StorageUsageTrends + recent-files Ipfs only). So the real adjacency is Credits-vs-two-storage-tiles within DetailList, not Credits-vs-Total-Credit-Used. The doc comment quoted by the fixture ("the home page never shows a stale total next to a fresh size") is real but lives in useDriveCreditsTotal.ts:34-36, describing Total-Credit-Used vs storage — not the credits-balance tile. Also: useMarketplaceCredits.ts:74 already polls a credit value at LIVE_DATA_REFRESH_MS under a DIFFERENT query key, but DetailList does not consume it. No QueryClient defaultOptions override exists and rg confirms zero invalidateQueries of user-credits across app/.

**Fix**

Give the home-page credits tile a live cadence matching its siblings. Cleanest: add an opt-in to useUserCredits, e.g. useUserCredits({ live: true }) that, when set, overrides options to staleTime:0 + refetchOnWindowFocus:true + refetchInterval: LIVE_DATA_REFRESH_MS, and call it that way in DetailList.tsx:15. Keep the default (Infinity) for static/eligibility-display callers. Per CLAUDE.md eligibility decisions must NOT read this hook anyway, so the live variant is display-only and safe. Alternative (lower blast radius): from the sync-completed / charge handlers, invalidate ['user-credits', addr] alongside the storage keys. This is a pure display-cadence change; no business logic moves to TS. The storageSubtitle effect (DetailList.tsx:57-66) depends on credits, so it tracks automatically once credits refresh.

_Files:_ `app/lib/hooks/api/useUserCredits.ts`, `app/components/page-sections/home/DetailList.tsx`

_Test to add:_ Vitest test (useUserCredits.test.ts or DetailList.test.tsx): mount with a mocked TanStack QueryClient + mocked invoke('get_user_credits'), assert the home/live variant registers refetchInterval === LIVE_DATA_REFRESH_MS (or advancing fake timers by 6s triggers a second invoke), proving the headline balance polls at the same cadence as useDriveStorageStats. Regression guard: assert refetchInterval is defined (not Infinity-with-no-poll) for the live variant.

_Risk:_ Low. Extra 6s poll of get_user_credits adds one IPC per interval per mounted home page — same cadence already paid by the two storage tiles and useMarketplaceCredits, so negligible. Must NOT change the default Infinity variant used by eligibility/static callers or it would add unwanted polling app-wide; gate the live behavior behind the explicit opt-in. Watch that credits-value churn on refetch doesn't spam calculate_storage_capacity — the effect already guards on credits===undefined and <=0, and TanStack only re-renders on changed data, so churn is bounded.

_Notes:_ Partially valid: the underlying bug (credits tile frozen at staleTime:Infinity next to 6s-polling storage tiles in DetailList, with no invalidation of the user-credits key) is real and the evidence lines are accurate. But the fixture's scope is overstated: it names "Total Credit Used" / useDriveCreditsTotal as a sibling tile, which is NOT in DetailList and is NOT rendered on the home page at all (it lives in credit-usage-trends, used elsewhere). The "never shows a stale total next to a fresh size" doc comment the fixture leans on describes a different tile pair. Severity correctly low: cosmetic UX only, no data loss, the tile already has a manual refresh button, and the storage tiles are backed by an indexer that can lag hours (useDriveStorageStats.ts:32-38), so "live" is already approximate. Fix is entirely in app/ TypeScript; cross_repo=false. No Rust diff this turn so Rust workflow gates (preflight/axioms/quality_gate/self-review checklist) are N/A.

- [x] **F38 fixed & tested** — committed 544e5838

---

## F39

### 🟢 LOW · S effort · valid — useInfiniteScroll computes a JSON.stringify data signature on every data change

- **Area:** TS · render perf

**Root cause**

The dataSignature useMemo (use-infinite-scroll/index.ts:12-20) is keyed on [data], so on every new `data` array reference it re-runs JSON.stringify on 3 sampled FormattedUserFile rows. The `.substring(0,50)` truncates the RESULT, not the work — each whole object (including any `fileDetails` array and byte-array `fileHash`) is fully serialized first. During an active sync, useUserFiles refetches → allData/allFilteredData/filteredData get fresh references every tick (useFilteredFiles.ts:51-55 calls setResult(files) on each `files` change in the no-op-criteria browse case), so the memo recomputes on a hot path. The reset it drives is largely redundant because both call sites already call resetScroll() explicitly on every filter/search/tab/viewMode change.

**Evidence (re-read)**

use-infinite-scroll/index.ts:12-20 verbatim: `const dataSignature = useMemo(() => { if (data.length === 0) return ""; const samples: unknown[] = [data[0]]; if (data.length > 2) samples.push(data[Math.floor(data.length / 2)]); if (data.length > 1) samples.push(data[data.length - 1]); return samples.map((item) => JSON.stringify(item).substring(0, 50)).join("|"); }, [data]);` — dep is `[data]`, recomputes on every reference change. Reset effect (23-31) only fires setVisibleCount(INITIAL_COUNT) when the signature differs, so the *behavior* is throttled but the stringify cost is paid every tick. Redundancy confirmed: FilesContainer.tsx:267 (resetScroll() inside updateFilters) and FilesContainer.tsx:290-301 (effect calling resetScroll() on searchTerm/fileTypes/date/fileSize/fileSizes/lastUpdated/selectedFolderTab); files-folder/index.tsx:134-136 (effect calling resetScroll() on searchTerm/fileTypes/date/fileSize/viewMode). Hot-path churn confirmed at useFilteredFiles.ts:51-55. What the claim overstates: (1) suggested_fix's "drop the auto-reset entirely" is NOT safe — the explicit resetScroll() calls only cover user-filter/tab/viewMode changes, NOT a raw data-source swap (account switch, refetch returning a different set with no filter change); the signature reset still covers that gap, so the correct fix is a cheaper heuristic, not removal. (2) Magnitude is tiny: 3 bounded stringifies are dwarfed by the React re-render and the filter_file_entries IPC round-trip on the same tick — severity low is right. Codebase already has the idiomatic cheap pattern at use-recent-files/index.ts:30-37 (makeFilesSignature, primitive field reads, no JSON.stringify) and a stable-id helper at mediaNavigation.ts:68-75 (getFileIdentifier).

**Fix**

Replace the JSON.stringify signature with a cheap primitive-field signature, mirroring makeFilesSignature (use-recent-files/index.ts:30-37). Keep the auto-reset (do NOT drop it — it covers data-source swaps the parent's explicit resetScroll() does not). Build sample-key = `${data.length}|${idOf(first)}|${idOf(mid)}|${idOf(last)}` where idOf(f) = `${f.label ?? ''}::${f.actualFileName ?? f.arionHash}::${f.lastChargedAt}` — no object serialization, O(1). Optionally accept an injectable keyFn<T> so the hook stays generic over T.

_Files:_ `app/lib/hooks/use-infinite-scroll/index.ts`

_Test to add:_ Add app/lib/hooks/use-infinite-scroll/index.test.ts (vitest + renderHook): (a) rerender with a NEW array reference whose sampled rows have identical id fields → visibleCount must NOT reset (no spurious reset on a sync-tick refetch returning the same logical rows); (b) rerender with content whose first/mid/last ids differ → visibleCount resets to 50 (data-source-swap reset still works); (c) spy on JSON.stringify and assert it is never called during signature computation (locks the perf fix).

_Risk:_ Low. Contract is 'reset scroll to 50 when the data SOURCE changes'. The cheap key must change whenever the old stringify key would have for the actual data; two genuinely-different sources colliding on length + first/mid/last ids would skip a needed reset (scroll stays deep). Mitigate with data.length + three positional samples (matches current sampling) + most-discriminating fields (actualFileName + lastChargedAt). Watch account-switch and folder-tab swaps the parent does not cover with explicit resetScroll — covered by test (b).

_Notes:_ TypeScript-only finding; no Rust touched, so the Rust workflow gates (preflight/axioms/data-structure plan/exemplars/critique/quality_gate) and the seven-item adversarial self-review checklist are N/A this turn. Fix is entirely in app/ (frontend), not cross-repo into hcfs. Fixture verify_notes was truncated mid-sentence but its substantive claims (exact memo body, [data] dep, the three explicit resetScroll sites) all check out. One correction to the auditor: 'drop the auto-reset entirely' is unsafe because the explicit resetScroll() calls don't cover non-filter data-source swaps — keep the reset, just make the signature cheap.

- [x] **F39 fixed & tested** — committed 303c3ae0

---

## F40

### 🟢 LOW · S effort · valid — SyncStatusDialog renders the full file list even while collapsed (maxHeight:0)

- **Area:** TS · render perf

**Root cause**

SyncStatusDialog is a plain function component (`const SyncStatusDialog: React.FC` at line 223, no React.memo) whose parent SyncStatusHandler subscribes to snapshotAtom via useSyncSnapshot(). useSyncSnapshotListener replaces the atom wholesale with a brand-new object on every `sync_progress_snapshot` event (useSyncSnapshot.ts:35-36 `setSnapshot(e.payload)`). The Rust emitter throttles byte updates to a trailing-edge ~250ms window (progress.rs `SNAPSHOT_THROTTLE_MS`, verified by logic.rs tests asserting block at 100ms / emit at 250ms), so during an active sync the dialog re-renders up to ~4x/sec. The animated body (lines 611-617) is unconditionally mounted; collapse is purely CSS (`maxHeight: isExpanded ? ... : "0"`, `opacity: isExpanded ? 1 : 0`), and `isExpanded` defaults to false (line 228). The `snapshot.files.map(...)` at lines 766-775 is NOT gated by isExpanded, so it allocates N SyncFileItem React elements and forces an N-child reconciliation on every render even while the list is invisible. The SyncFileItem custom-comparator memo (lines 196-213) correctly blocks the expensive per-item work (getFilePartsFromFileName/getFileTypeFromExtension/getFileIcon + DOM), so the avoided cost is bounded to element allocation + shallow child diffing.

**Evidence (re-read)**

SyncStatusDialog.tsx:223 `const SyncStatusDialog: React.FC<SyncStatusDialogProps> = ({ snapshot, open, onClose }) =>` — plain FC, NOT wrapped in memo (confirmed: `rg "memo\(SyncStatusDialog|export default memo"` returns nothing; export at line 783 is `export default SyncStatusDialog;`). Line 228 `const [isExpanded, setIsExpanded] = useState(false);`. Lines 611-616: body wrapper `<div className="overflow-hidden transition-[max-height,opacity] ..." style={{ maxHeight: isExpanded ? \`${BODY_MAX_HEIGHT_REM}rem\` : "0", opacity: isExpanded ? 1 : 0 }}>`. Lines 766-775: `{snapshot.files.map((file) => (<SyncFileItem key={file.path} ... />))}` — ungated by isExpanded, no virtualization, no early-return-when-collapsed. Parent SyncStatusHandler.tsx:18 `const snapshot = useSyncSnapshot();` then lines 39-45 render `<SyncStatusDialog snapshot={snapshot} ... />` — a fresh snapshot object re-renders the dialog every event. useSyncSnapshot.ts:35-36 confirms wholesale replacement. Throttle/4x-claim corroborated by progress.rs `const SNAPSHOT_THROTTLE_MS` and logic.rs tests (`assert!(!should_emit_snapshot(100,false,250))`, `assert!(should_emit_snapshot(250,false,250))`). What the original got RIGHT: every load-bearing claim holds — ungated map, ~4x/sec, no memo on dialog, item-memo bounds the cost. Nothing in the claim was wrong. One nuance worth adding (not an error): the widget only mounts when `snapshot.widgetVisible` (SyncStatusHandler.tsx:35-37), so it is not a persistent background cost — runs only during/just-after a sync, further supporting low severity. Existing test SyncStatusDialog.test.tsx:133-134 documents the exact flagged behavior ("Before expanding, file items exist in DOM but are hidden via max-height: 0px").

**Fix**

Gate the file-list map behind isExpanded so the per-file element allocation and child reconciliation only run when the body is visible. Change lines 766-775 from `{snapshot.files.map(...)}` to `{isExpanded && snapshot.files.map((file) => (<SyncFileItem key={file.path} .../>))}`. The body wrapper (lines 611-617) stays mounted so the max-height/opacity CSS transition still animates the empty container open; the list populates on first render after expand (synchronous in the same render pass, so no visible empty flash). Because SyncFileItem already keys by file.path and is memoized, no anti-flicker behavior is lost. Do NOT also memo the dialog — gating the map removes the dominant per-render cost while collapsed, and the dialog still needs to re-render the collapsed header (percentage, circular progress) on every snapshot.

_Files:_ `app/(pages)/SyncStatusDialog.tsx`

_Test to add:_ In app/(pages)/__tests__/SyncStatusDialog.test.tsx add a test 'does not render file items while collapsed': render <SyncStatusDialog snapshot={makeSnapshot([...3 files])} open={true} /> WITHOUT clicking the header, then assert `screen.queryAllByTestId('file-item')` has length 0 (currently it would be 3). Then click the header to expand and assert length 3. This pins both halves of the fix and is the inverse of the existing 'renders file items when expanded' test whose comment currently documents the buggy 'items exist in DOM but hidden' behavior — update that comment too.

_Risk:_ Low. Watch for: (1) any test or code that relies on file-item DOM nodes existing while collapsed (only SyncStatusDialog.test.tsx:108-143 touches file-item, and it expands first, so it stays green; grep confirms no other consumer queries [data-file-item]/file-item while collapsed). (2) The max-height open animation: since the list renders synchronously on the same render where isExpanded flips true, the container animates open with content already present — no empty-then-populate flash. (3) Scroll position is not preserved across collapse/expand, but it already resets today because the container's content is height-clamped; behavior is unchanged for the user.

_Notes:_ Pure TypeScript/React finding — no Rust diff this task; preflight/axioms/exemplars/critique/quality_gate/self-review-checklist all N/A. Cross-repo=false: fix is entirely in the desktop app/ frontend (the hcfs sync engine is not involved; it only sets the ~250ms emit cadence, which is correct and not the bug). Severity confirmed low and not inflated: the finding self-rates as the least severe, the SyncFileItem memo already blocks the expensive per-item work, and the widget is only mounted while widgetVisible is true, so there is no persistent background cost. Effort S (single one-line gate + one test + a comment update, well under 1h).

- [x] **F40 fixed & tested** — committed 303c3ae0

---

## F41

### 🟢 LOW · S effort · valid · `[HCFS]` — resolve_rename_hints does full per-cycle rename computation then discards the result (`let _ = file_hints;`)

- **Area:** hcfs sync engine (cross-repo)

**Root cause**

`resolve_rename_hints` (hcfs-client/src/engine/runner.rs:2407-2436) is a pending-wiring placeholder for hcfs#52 (rename passthrough). On any sync cycle where the OS watcher captured a rename within the drive's sync root, it drains the hints, deep-clones the entire per-label synced-paths cache, rebuilds it into a Vec<PathBuf>, runs an O(hints x paths) starts_with scan plus per-directory-rename O(paths) expansion to materialize a `Vec<RelativeRenameHint>` (`file_hints`) — and then throws the whole thing away with `let _ = file_hints;`. The computed hints have no downstream consumer: the sole caller `run_sync_cycle` invokes `m.sync_with_resolutions_cancellable(HashMap::new(), cancel_token)`, and that function's signature only accepts conflict `resolutions: HashMap<String,String>` + a cancel token — there is no rename-hint parameter, so the passthrough capability genuinely does not exist yet. Net: pure wasted compute on every rename-bearing cycle, and renames still fall through to delete+re-upload.

**Evidence (re-read)**

runner.rs:2407-2436 verbatim: function ends with `info!(label = label, raw_count = raw_hints.len(), resolved_count = file_hints.len(), "Rename hints resolved");` immediately followed by `let _ = file_hints;` — exact match to the fixture's evidence. The early-out `if raw_hints.is_empty() { return; }` (lines 2409-2411) means the body runs ONLY on rename-bearing cycles, not literally every cycle — the fixture title says "per-cycle" but the description correctly scopes it to drained-hint cycles, so impact is accurate not inflated.\n\nget_cached_synced_paths (runner.rs:767-770): `let cache = self.synced_paths_cache.lock().ok()?; cache.get(label).cloned()` — confirms the full HashMap<String, SyncedFileInfo> deep clone.\n\nrun_sync_cycle (runner.rs:1740-1799): `resolve_rename_hints(runner, label, &drive_sync_path);` at line 1756 (return value is `()`, no binding), then `let outcome = m.sync_with_resolutions_cancellable(HashMap::new(), cancel_token).await;` — confirms the empty map and zero connection to the computed hints.\n\nDriveManager::sync_with_resolutions_cancellable (manager.rs:313-322): signature is `(resolutions: HashMap<String, String>, cancel_token: CancellationToken)` — no rename parameter exists, confirming the passthrough is unfinished.\n\ncross_impact + cross_query confirm resolve_rename_hints has NO caller other than run_sync_cycle and RelativeRenameHint feeds nothing else.\n\nCorrection to the auditor's fix note (does not change verdict): the note says \"The drained hints are already consumed by apply_rename_to_activity (the UI-relabel path)\". apply_rename_to_activity (runner.rs:962-1034) is actually called from push_rename_hint (capture time, runner.rs:865), NOT from the drain in resolve_rename_hints. So the activity relabel is genuinely covered, but via a SEPARATE hint stream (push-time), not via the drained hints. The drain here does not starve the activity path — the conclusion that \"the activity side is covered\" is right, the stated mechanism is slightly off.

**Fix**

Two-tier. Minimum (option b, recommended now): stop materializing the discarded result. Replace the body after the `is_empty` early-return so it does NOT call get_cached_synced_paths (the full-cache clone), does NOT build known_from_cache, and does NOT run the expand/scan loop. Keep only the cheap drain (which must stay because drain_rename_hints_for_root also performs the orphaned-hint GC past RENAME_HINT_MAX_AGE — dropping the call entirely would leak stale hints). Downgrade the misleading `info!(... "Rename hints resolved")` to a `debug!` worded so it does not imply the rename was applied (e.g. "drained N rename hints (passthrough pending hcfs#52)"), and delete `let _ = file_hints;`. Preferred (option a, when hcfs#52 lands): thread the computed Vec<RelativeRenameHint> into a new rename-hints parameter on sync_with_resolutions_cancellable so the expensive clone/scan earns its cost. Until then, option b removes the pure waste while preserving the GC side-effect and the future wiring point.

_Files:_ `hcfs-client/src/engine/runner.rs`

_Test to add:_ In hcfs-client/src/engine/runner.rs tests (alongside drain_rename_hints_drops_orphans_past_max_age at runner.rs:3452): add a test that seeds synced_paths_cache for a label, pushes a rename hint via push_rename_hint, then asserts resolve_rename_hints still drains/GCs the hint (rename_hints empty afterward) WITHOUT requiring the synced cache — i.e. that the function no longer depends on get_cached_synced_paths. Pins both that the GC drain is preserved and that the discarded compute is gone, so a future re-add of the dead clone is caught.

_Risk:_ Very low. resolve_rename_hints returns () and feeds nothing, so removing the inner compute is behavior-preserving for sync. The one real hazard is accidentally removing the drain call itself (drain_rename_hints_for_root) which would leak/GC-starve hints and break apply_rename_to_activity's sibling capture stream is unaffected but the orphaned-hint GC would stop — keep the drain. Watch: ensure the `info!`->`debug!` downgrade does not break any log-scraping/test that asserts on the "Rename hints resolved" string (none found in this repo).

_Notes:_ Validated entirely against the hcfs cross-repo index (hcfs-client is a pinned git dep of hippius-desktop, not in this repo). Severity correctly low: fires only on rename-bearing cycles (user-paced, not a hot loop), clone bounded by one drive's synced-file count, no correctness/data-loss impact — purely wasted CPU + a misleading log. The finding's concrete claims all check out verbatim; the only correction is the fix-note's mechanism for the activity path (push-time apply_rename_to_activity, not drain-time), which does not change the verdict or the recommended fix.

- [UPSTREAM] **F41** — cross-repo hcfs fix; spec in 'Cross-repo (hcfs) upstream work' section below (document-only this session, per user)

---

## F42

### 🟢 LOW · S effort · partially_valid — useStagedChanges unmount cleanup unconditionally calls cancel_review, clearing all drives' reviews

- **Area:** TS · sync hooks

**Root cause**

useStagedChanges.ts:70-74 registers an unmount effect that calls invoke("cancel_review") unconditionally, with no guard for whether a review is active and with no label. The backend command (src-tauri/src/sync/control.rs:189-197) is global: it calls SyncRunner::clear_all_reviews(), which (hcfs-client/src/engine/runner.rs:530-539) iterates states.values_mut() over EVERY drive and sets in_review=false, review_entered_at=0, and review_cooldown_until = now + 60_000. The cooldown is the load-bearing harm: set_drive_review(label) (runner.rs:502-512) returns false when review_cooldown_until > now, and the re-stage path (runner.rs:1833-1841) only emits the ConflictsPending event when set_drive_review returns true. So for 60s after any cancel_review, a fresh conflict on ANY drive is silently swallowed (no dialog, auto-sync proceeds). The inline comment "no-op if not in review mode — Rust handles it" is therefore false — the call always imposes a 60s cross-drive cooldown. BUT the harm framing is inflated: the hook is mounted ONLY in ConflictsBanner, which is mounted ONLY in the persistent authenticated layout shell (ResponsiveContent → (pages)/layout.tsx → OnBoardingGuard children). That subtree unmounts only when OnBoardingGuard's isAuthenticated flips false (logout) — isLoading never toggles during an established authenticated session (wallet-auth-context.tsx sets it true only inside login(), when isAuthenticated is still false and the subtree is unmounted). At logout, logout() invokes logout_full / stop_sync (tearing down all drives) BEFORE setIsAuthenticated(false) triggers the React unmount, so the 60s cooldown is stamped on drives that are already stopping — no conflict can be suppressed. The "racing a freshly-staged review on another drive" scenario requires the hook to unmount while drives remain active and syncing, which does not happen in the current single-layout-mount topology. So it is a real latent/defensive-correctness defect (false comment, unconditional global side effect, duplicate of ConflictsBanner's own guarded cleanup) rather than a currently-exploitable data/UX-loss bug.

**Evidence (re-read)**

useStagedChanges.ts:69-74 (verbatim): `// Safety net: cancel review on unmount (no-op if not in review mode — Rust handles it)` / `useEffect(() => { return () => { invoke("cancel_review").catch(() => {}); }; }, []);` — confirmed unconditional, label-less. control.rs:189-197: cancel_review -> `sync.clear_all_reviews();`. hcfs-client runner.rs:530-539: clear_all_reviews loops `for s in states.values_mut() { s.in_review=false; s.review_entered_at=0; s.review_cooldown_until = now + cooldown_ms; }` with cooldown_ms=60_000 — across ALL drives, confirmed. runner.rs:502-512 set_drive_review: `if s.review_cooldown_until > now { return false; }` then sets in_review=true. runner.rs:1833-1841: `Ok(restaged) if !restaged.conflicts.is_empty() => { if runner.set_drive_review(label) { runner.handler.on_event(SyncEvent::ConflictsPending {..}) } }` — conflicts dropped if set_drive_review returns false. So the cooldown DOES have teeth (suppresses ConflictsPending), and the fixture's verify_notes are correct on the mechanism. ConflictsBanner.tsx:24-30 has its own reviewActiveRef-guarded cleanup (`if (reviewActiveRef.current) invoke("cancel_review")`) — duplicate-cancel claim confirmed. WHAT THE CLAIM GOT WRONG / OVERSTATED: (1) Mount topology — references(useStagedChanges) shows ONE caller (ConflictsBanner); rg shows ConflictsBanner is JSX-mounted only in ResponsiveContent.tsx:37, which sits in (pages)/layout.tsx:36 under OnBoardingGuard. OnBoardingGuard.tsx:37-49 returns PageLoader/null/OnBoardingPage before children, so children (incl. the hook) mount only for an authenticated, onboarded, non-loading user. (2) "fires even on any future remount / on logout" — true it fires on logout, but logout (wallet-auth-context.tsx:146-178) calls logout_full (line 158) before setIsAuthenticated(false) (line 177); stop_sync teardown precedes the unmount, so the cooldown lands on stopping drives. (3) "racing a freshly-staged review on another drive" — not reachable: the hook never unmounts while drives are active in the current app. NOTE: a genuinely separate (not-F42) cross-drive bug exists in the same file — cancelReview() at useStagedChanges.ts:59-67 and ConflictsBanner's handleDismiss also call the global cancel_review, so dismissing drive A's banner clears drive B's active review; control.rs:128 already shows a per-label clear_drive_review(&label) exists and is used by sync_with_conflict_resolutions, so the per-label primitive is available.

**Fix**

Two-line-confidence fix in the desktop FE (no hcfs change needed). Preferred: delete the unconditional unmount effect at useStagedChanges.ts:69-74 entirely — ConflictsBanner.tsx:24-30 already owns a reviewActiveRef-guarded unmount cancel, so the hook's copy is a redundant, unguarded duplicate. Letting the consumer own cancel semantics removes the false 'no-op' comment and the unconditional global side effect. If a hook-level safety net is still wanted, add a per-label cancel: expose a new Rust IPC cancel_review_for_label(label) in src-tauri/src/sync/control.rs that calls the EXISTING sync.clear_drive_review(&label) (already used at control.rs:128) instead of clear_all_reviews(), register it in main.rs, and have the hook gate its cleanup behind a ref that tracks whether THIS instance entered review and pass label. The global cancel_review should be reserved for true global resets (logout/login/reset in lifecycle.rs:274,1178). Separately (out of F42 scope but worth flagging on the same fix list): cancelReview() at useStagedChanges.ts:59-67 and ConflictsBanner.handleDismiss should also use the per-label cancel so dismissing one drive's banner does not clear other drives' active reviews via clear_all_reviews.

_Files:_ `app/lib/hooks/useStagedChanges.ts`, `app/components/ui/ConflictsBanner.tsx (only if consolidating cancel ownership)`, `src-tauri/src/sync/control.rs (only if adding per-label IPC)`, `src-tauri/src/main.rs (only if adding per-label IPC)`

_Test to add:_ Rust unit test in hcfs-client (or a desktop integration test against SyncRunner) that pins the suppression mechanism: enter review on drive 'b', call clear_all_reviews(), then assert set_drive_review('b') returns false for the next 60s and that the re-stage path does NOT emit ConflictsPending — this is the invariant the FE must not trip accidentally. On the FE side, a vitest test mounting ConflictsBanner with no pending conflicts and asserting that unmount does NOT call invoke('cancel_review') (after the fix), plus a test that with an active review it calls the per-label cancel exactly once (not twice).

_Risk:_ Very low. Removing the hook's cleanup cannot regress correctness because ConflictsBanner's guarded cleanup still cancels active reviews on its unmount; the only behavior removed is the unconditional global cooldown stamp on logout, which is already harmless (drives torn down). Watch: confirm no other consumer of useStagedChanges is added later that relied on the hook auto-cancelling (currently the only caller is ConflictsBanner). If the per-label IPC variant is chosen, watch that the label flows correctly (hook currently defaults label='default').

_Notes:_ Fixture verify_notes are truncated mid-sentence ("(1) useStagedChanges") but the author had clearly started to walk back the harm framing — my independent re-derivation confirms that intent. Code claims are exact; the downgrade from medium to low is purely about reachability: the dangerous race needs the hook to unmount while drives are active, which the current mount topology (single mount in the persistent authenticated layout, logout tears down sync before unmount) does not produce. Worth fixing as defensive correctness + to delete the false 'no-op' comment, and as a cheap guard against a future second consumer or a future code path that unmounts ConflictsBanner mid-session. Flagged a genuinely separate cross-drive clobber in the same file (cancelReview/handleDismiss dismiss path uses global clear_all_reviews) that should be tracked as its own finding — the per-label primitive clear_drive_review already exists in hcfs-client and is already used by sync_with_conflict_resolutions, so neither fix is cross-repo. No Rust diff produced this turn (read-only validation), so the Rust workflow gates are N/A.

- [x] **F42 fixed & tested** — committed 54d40446

---

## F43

### 🟢 LOW · S effort · partially_valid — Each NameCell row mounts 1-2 Radix Tooltip.Provider trees and is not memoized; multiplies the full-list render cost

- **Area:** TS · render perf
- **Overlaps:** F1, F4

**Root cause**

NameCell is an unmemoized FC rendered per visible row via column cell defs inside the memoized `tableBody`. On any `tableBody` recompute (sort toggle, selection-mode toggle, columnWidths change) every visible NameCell body re-runs: useUrlParams() + 3x getParam + buildFolderPath + an unconditional `folderUrl` object literal (allocated even for file rows where it is unused). SyncStatusIcon additionally wraps its icon in a per-row Radix Tooltip.Provider for pending/uploading/downloading/failed states. This is wasted work, but it is bounded to the currently-loaded slice and to non-synced rows, NOT to the whole list as the finding claims.

**Evidence (re-read)**

NameCell.tsx:215 `export default NameCell;` — confirmed no React.memo. NameCell.tsx:142-172: `const { getParam } = useUrlParams();` then 3 getParam calls, buildFolderPath, and `const folderUrl = { pathname: "/files", query: {...} }` allocated unconditionally (used only in the isFolder Link branch at :178). SyncStatusIcon NameCell.tsx:48-71/75-94/102-122 wraps icon in `Tooltip.Provider > Root > Trigger > Portal > Content`; NameCell.tsx:125 `return null;` for any other status (synced/unknown/excluded/undefined) — so synced/steady-state rows instantiate ZERO providers.

REFUTATIONS of the severity-driving claims:
1. "all rows render" is false. files-table renders `displayedData` = `useInfiniteScroll(filteredData).visibleData`; use-infinite-scroll/index.ts:33-34 `const visibleData = useMemo(() => data.slice(0, visibleCount), ...)` with `INITIAL_COUNT = 50` (line 3). Rows render in 50-row slices, not the full N. The finding leans on "finding #1 (all rows render)" which the slice contradicts.
2. SharedLinkBadge's Tooltip.Provider is effectively dead today. sharesAtoms.ts:41 `const shareFeatureEnabledAtom = atom(() => false);` -> useSharedFiles.ts query `enabled: Boolean(polkadotAddress) && shareEnabled` is disabled -> getSharesFor returns EMPTY_ROWS -> sharedBadgeTooltip.ts:13 `if (rows.length === 0) return null;` -> SharedLinkBadge.tsx:40 `if (!tooltipLines) return null;` returns before line 43's Tooltip.Provider. So the "~2N providers" doubling does not occur at all.
3. Radix Tooltip.Provider is a context provider for global delay config (verified via Radix docs), not a portal; only Tooltip.Portal/Content mount a portal and only on open/hover. Idle rows mount no portals. "creates many portal/context instances" overstates the cost.
4. Per-row Tooltip.Provider is a project-wide convention (InfoTooltip.tsx, MiddleTruncatedName.tsx, TabItem.tsx, PrivacyBadge.tsx all do the same), not a NameCell-specific defect.

**Fix**

Two low-risk cleanups, no new abstraction. (1) Wrap NameCell in React.memo — props are primitives/stable strings so default shallow compare prevents re-running getParam/buildFolderPath/folderUrl allocation for unchanged rows on sort/selection toggles. (2) Move the `folderUrl` object construction (and the buildFolderPath call) inside the `isFolder` branch so file rows skip it entirely. The Tooltip.Provider hoisting is optional and low-value: if pursued, hoist a single `<Tooltip.Provider delayDuration={200}>` to the files-table root and use bare Tooltip.Root in SyncStatusIcon/SharedLinkBadge — but treat as cosmetic, and apply consistently with the rest of the codebase or not at all. Do NOT cite the SharedLinkBadge provider as a cost; it is dead while shareFeatureEnabledAtom is false.

_Files:_ `app/components/page-sections/files/files-table/NameCell.tsx`

_Test to add:_ In NameCell.test.tsx add a render-count test: render NameCell (memoized) inside a parent that bumps an unrelated state value, assert getFileIcon/getParam invocation count (via spy) does not increase when NameCell props are unchanged across the parent re-render. This locks the memo. Also assert a file row (isFolder=false) does not call buildFolderPath.

_Risk:_ React.memo on a component that renders children via a render-prop (MiddleTruncatedName suffix uses inline JSX) is safe because the suffix is reconstructed from the same props; shallow compare still holds since suffix is built inside NameCell, not passed in. Watch: if a future caller passes a new inline function/object prop to NameCell, memo silently stops helping — keep props primitive. Moving folderUrl into the isFolder branch: verify no file-branch code path references it (it does not today). Hoisting the Provider risks changing delayDuration inheritance for any Root that relied on the local 200ms; keep delayDuration on the hoisted Provider to preserve behavior.

_Notes:_ No Rust diff this turn (TypeScript analysis only) — preflight/axioms/quality_gate/critique/exemplars/self-review checklist all N/A. Severity downgraded high -> low: the impact multipliers in the finding (2N tooltip providers, full-list render) are both refuted — infinite-scroll slices to 50-row pages (use-infinite-scroll/index.ts:33), the shared-badge provider is dead while shareFeatureEnabledAtom=false (sharesAtoms.ts:41), Radix Provider is a cheap context not a portal, and synced rows render zero providers (NameCell.tsx:125). The valid residue is genuine but minor: an unmemoized cell re-running cheap work for visible rows on sort/selection toggles, plus an unconditional folderUrl allocation. Overlaps F1 (all-rows-render premise) and F4 (parent re-render) — those two are the actual gate on whether this matters; if the table already slices to 50 rows, the practical cost here is negligible. Frontend perf concern; the project's CLAUDE.md pushes business logic to Rust but this is presentation/render perf which legitimately lives in app/.

- [x] **F43 fixed & tested** — committed 544e5838

---

---

## Cross-repo (hcfs) upstream work — F01, F35, F41

These three findings live in the pinned `hcfs` crate (`hcfs-client`), not in this
repo. They were **not applied this session** (decision: document-only; bumping
the `Cargo.toml` git rev requires the hcfs branch to be pushed first). Each is a
ready-to-implement upstream PR spec. After landing them in hcfs and pushing,
bump the `hcfs-client` / `hcfs-shared` rev in `src-tauri/Cargo.toml` and rebuild.

### F01 — stall watchdog cancels any sync cycle exceeding ~3 min (HIGH)
**Root cause:** `SyncRunner::is_progress_stalled` (runner.rs) compares wall-clock
to `last_progress_time`, which is only `reset_progress_time()`-ed once per cycle;
`touch_progress_time()` has zero callers in the Rust sync path, so the watchdog
is a hard 180s ceiling on a single cycle/file rather than a real stall detector.
A single file whose own transfer exceeds 180s (multi-GB / slow link) is
cancelled mid-flight, never persisted, and retried from scratch forever while
`consecutive_failures` climbs.
**Fix:** thread `touch_progress_time()` into the per-chunk byte-progress path
(`file_op_ctx` → `upload_file_standalone` / `download_file_standalone` chunk
emits in `drive/sync_flow.rs` + `drive/file_ops`) so the stall timer reflects
real I/O; keep the 180s threshold. Secondary: in `dispatch_sync_result` /
`handle_sync_error`, do NOT count `SyncError::Cancelled` toward
`record_sync_failure`/backoff (a cancel is not a server/auth failure).
**Files:** hcfs-client/src/engine/runner.rs, drive/sync_flow.rs, drive/file_ops.
**Test:** integration test streaming chunks slowly (>180s total, a chunk every
<180s) with the watchdog active → cycle returns Ok and the file lands in
`state.synced`; plus a true-stall test (no chunk >180s) still cancels.

### F35 — `SyncEvent::ActivityUpdated` carries no label; FE over-clears (LOW)
**Root cause:** `metadataStaleLabelsAtom` is per-label, but the unit
`ActivityUpdated` event has no label, so `useMetadataStale.ts` wipes EVERY
drive's entry on any drive's activity.
**Fix (cross-repo + desktop):** add `label: String` to `SyncEvent::ActivityUpdated`
(hcfs-client events.rs) and pass it at both emit sites (apply_rename_to_activity
already has `label`); in desktop `tauri_bridge.rs` forward it as a `LabelPayload`
(reconcile-success emit at lifecycle.rs already has `label`); in `useMetadataStale.ts`
make the listener typed and delete only `p.label`.
**Files:** hcfs-client events.rs + runner.rs; src-tauri sync/tauri_bridge.rs +
sync/lifecycle.rs + sync/events.rs; app/lib/hooks/useMetadataStale.ts.
**Test:** vitest — seed two stale labels, fire ACTIVITY_UPDATED {label:'b'},
assert only 'b' is removed.

### F41 — `resolve_rename_hints` computes then discards the result (LOW)
**Root cause:** after the empty-check, it clones the full synced-paths cache,
builds `known_from_cache`, runs the expand/scan loop, then `let _ = file_hints;`
throws it away (rename passthrough is pending hcfs#52).
**Fix (option b, recommended now):** after the `is_empty` early-return, keep ONLY
the cheap `drain_rename_hints_for_root` drain (it also GCs orphaned hints past
`RENAME_HINT_MAX_AGE` — must stay), drop the cache clone / `known_from_cache` /
expand loop, delete `let _ = file_hints;`, and downgrade the misleading
`info!("Rename hints resolved")` to a `debug!` ("drained N rename hints
(passthrough pending hcfs#52)").
**Files:** hcfs-client/src/engine/runner.rs.
**Test:** alongside `drain_rename_hints_drops_orphans_past_max_age`, assert
`resolve_rename_hints` still drains/GCs the hint (rename_hints empty after) while
no longer doing the discarded scan.
