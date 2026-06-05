# Audit Remediation Status — branch `fix/audit-2026-06-05-remediation`

Tracks execution of the 31 non-HIGH findings from `AUDIT_2026-06-05.md`.
Full per-finding detail + verifier-designed fixes live in that audit doc; the
implementation plan is `~/.claude/plans/eager-sauteeing-sunset.md`.

Each fix is its own commit tagged `[<id>]` in the subject, so any commit is a
safe stopping point. Resume by picking the next REMAINING item, re-reading the
live code via illu (line numbers drift), applying the fix, and running the
Rust gate sequence (`rust_preflight` → `axioms` → implement → `quality_gate`)
before committing.

## DONE (27 findings, 20 fix commits + 1 ledger + 3 PR-review fixes)

| Commit | Findings | Summary |
|--------|----------|---------|
| `05a98688` | A1, A2 | Reviewed-sync completion routed through shared `tauri_bridge::handle_sync_completed`; pure `validate_resolutions` + tests + static pin |
| `2d52e4e7` | B1 | Per-wallet async gate serializing check→verify→record across all 4 call sites (incl. `get_signer_and_address`); concurrency test |
| `6dec67d9` | B2 | `cache_remote_file` per-attempt-unique `.part`, cleanup-on-error, contextful rename error; folds the `.part`-leak + opaque-error items |
| `e13489b8` | B3 | Main window revealed from the DB-init task after pool+schema (and on fatal-failure paths); static pin |
| `f074b140` | C1, C2 | Referral reward via `planck_to_hip` (no integer truncation); fail-closed `parse_credit_balance` rejecting inf/NaN/negative + edge tests |
| `710c6f56` | C3, C4, C5, C6, **F2** | Logged/saturating parses (drive credits, chart amounts), frozen-aware transfer affordability, include-pattern trim/observe, gap-day own date |
| `746feb35` | D5, D6 | Token-expiry `0 = never expires` unified; logout clears persisted session before wiping in-memory auth |
| `f898720d` | E2 | Corrected `migrate_if_needed` doc (migrates only drive passwords, not `sub_accounts`) |
| `2b312f79` | D1 | `change_recovery_password`: when local rewrite AND sidecar both fail, return Err (was silent Ok) so the failure surfaces; static pin |
| `4c0b1417` | D2 | `start_migration_polling`: immediate poll before spawning the loop (no orphaned task on failed start); skip loop if first poll terminal; static pin |
| `bc815240` | D3 | Per-caller `&mut i32` failure streak (removed shared `poll_failure_count` atomic so callers don't corrupt each other's give-up); pure `poll_failure_flags` + edge tests. Wire format & FE unchanged; `should_abort` already resumable so no behavior change |
| `55b9b5f1` | D4 | `start_server_migration` job_exists branch: cancel is awaited+inspected (was fire-and-forget); single immediate retry replaced by a bounded backoff loop (`MAX_MIGRATION_START_RETRIES`=3, linear `migration_retry_backoff`); pure backoff test + static pin |
| `79f0bfca` | D7 | `claim_legacy_contacts`: documented why first-account-claim is an accepted tradeoff (no attribution for pre-owner rows; single-user-per-DB). The multi-account-claim test already existed; doc-only |
| `9c94cce7` | D8 | `migrate_account_keys`: per-table UPDATE error now propagates via `?` so the whole tx rolls back (was warn-swallowed + committed → split account across keys); collision-rollback test |
| `cb71cc08` | D10 | `process_credit_events`: pure `parse_event_timestamp_ms` (warn+skip vs coerce-to-0) and `parse_credit_amount_planck` (reject signed/fractional vs `-5`→`5`/`1.5`→`15`); 4 edge tests |
| `d44257ef` | E1 | Notification writes (`add_notification`, `create_sync_notification`, `create_credit_notifications`) scoped to the session account via shared `session_scoped_notification_account` (ignores caller-supplied address); 2 tests |
| `387332a8` | F3 | `IndexerClient::get`: logs the failing request path on a non-success response (matches `api::client::handle_response`); `ApiError` shape unchanged |
| `9465f1dc` | F1 | `complete_migration_transition`: comment explaining why the advisory `in_progress` store is intentionally unsynchronized vs `check_migration` (self-correcting; both SeqCst). Comment-only |
| `3ef962e0` | D9 | `AppState::pool`: returns `NotReady(DatabaseNotReady)` for an uninitialized pool (was misleading `Db(PoolClosed)`); new `NotReadyKind` variant mirrored into the FE TS union; behavioral round-trip test + the variant-coverage test upgraded to an exhaustive-match drift guard |
| `6fa51c18` | F4 | `blockchain/subscription.rs`: consecutive-failure ceiling — past `RECONNECT_CEILING_ATTEMPTS`=10 the loop falls back to a 5-min slow re-probe instead of retrying every 60s forever (never stops; a wallet must auto-recover). Pure `reconnect_delay_secs` + 3 edge tests; logs the transition once |

### PR-review fixes (post-remediation, 2026-06-05)

A 5-agent adversarial PR review (4 domain reviewers + 1 cross-cutting) found two real defects in the commits above plus one consistency gap; all fixed:

| Commit | Fixes | Summary |
|--------|-------|---------|
| `44749af5` | D8 (BLOCKER), D6 (MAJOR) | **D8**: `migrate_account_keys` listed `notifications` + `user_preferences`, which have NO `owner` column — the `?`-propagation rolled the migration back on the guaranteed "no such column" error every run, breaking every legacy account. The collision test passed only by loop-ordering luck. Trimmed to the 5 owner-bearing tables + happy-path commit test (mutation-verified). **D6**: `logout_full` swallowed the new `auth_logout_internal` Err into `warn!` and returned Ok, so a failed session clear still rehydrated on next boot — now propagated via `?`. |
| `cbb91d79` | D5 (MINOR) | `is_token_expiring` didn't honor `expiry==0`=never-expires, so a never-expiring token was force-refreshed every cycle; guarded + tested. Completes the D5 convention across validity AND refresh-policy checks. |

**Review verdict:** READY (after the above fixes). Remaining open items are tracked follow-ups, not blockers (see below).

### Tracked follow-ups (non-blocking, surfaced by the review)
- **FE logout handler**: now that `logout_full` can return `Err`, the frontend logout handler must clear local React/localStorage state ONLY on a resolved `logout_full` (else a failed logout still blanks the UI while Rust keeps the session). Frontend change, paired with D6.
- **A1 error/start arms still forked**: `sync_with_conflict_resolutions` routes its *completion* through the shared bridge (A1) but its `SYNC_ERROR` and `SYNC_STARTED` arms still `app.emit` directly, bypassing the bridge's cancel-drop (CANCELLED_MARKER) and full payload. Narrow edge (a stall-cancel during a reviewed-conflict sync would surface a spurious "Sync Failed"); a sibling `handle_sync_error` helper would close it.
- **D2 start-vs-dismiss race**: a precisely-timed `dismiss_migration` during the immediate poll's lock-free window can orphan the freshly-spawned loop. Re-check the `poll_task` slot under the store lock to abort instead of store.

## REMAINING (1 item — dropped by user decision)

- **F5 (DROPPED)** `billing/drive_credits.rs::cache()` (~104-128): process-wide drive-event cache keyed by `account_id` with a TTL can show a stale "Total Credit Used" briefly across an account switch. **User chose to leave as-is** (2026-06-05): the TTL self-heals within seconds and reworking the cache risks regressions in the credits display. No change.

All 30 actionable findings are resolved or consciously dropped; the single HIGH (OAuth deep-link) remains intentionally untouched per the original scope.

## Before the PR
- `cd src-tauri && SQLX_OFFLINE=true cargo test` (full suite).
- `cargo clippy --all -- -D warnings` — note the branch inherited ~48 pre-existing warnings unrelated to these fixes; the remediation added none.
- Manual smoke (`RUST_LOG=debug pnpm tauri:dev`): reviewed-conflict sync (A1), double-open a cloud preview (B2), no `PoolClosed` at startup (B3).
- Delete this file before merging, or keep it as the PR description scaffold.
