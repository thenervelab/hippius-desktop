# Audit Remediation Status — branch `fix/audit-2026-06-05-remediation`

Tracks execution of the 31 non-HIGH findings from `AUDIT_2026-06-05.md`.
Full per-finding detail + verifier-designed fixes live in that audit doc; the
implementation plan is `~/.claude/plans/eager-sauteeing-sunset.md`.

Each fix is its own commit tagged `[<id>]` in the subject, so any commit is a
safe stopping point. Resume by picking the next REMAINING item, re-reading the
live code via illu (line numbers drift), applying the fix, and running the
Rust gate sequence (`rust_preflight` → `axioms` → implement → `quality_gate`)
before committing.

## DONE (24 findings, 19 commits)

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
| _(this commit)_ | F1 | `complete_migration_transition`: comment explaining why the advisory `in_progress` store is intentionally unsynchronized vs `check_migration` (self-correcting; both SeqCst). Comment-only |

## REMAINING (3 items: D9 deferred + F4/F5 droppable — all need a user decision)

- **D9** `app_state.rs::pool` (233-235): returns `sqlx::Error::PoolClosed` for an *uninitialized* pool (semantic mislabel). **DEFERRED** — the proper fix adds a `NotReadyKind` variant which cascades to the FE TS union (`app/lib/utils/dispatchTauriError.ts`) + a round-trip test. After B3 the early-call window is essentially closed, so this LOW is near-unreachable; do it only alongside the FE change. **Decide with the user.**
- **F4 (DROPPABLE)** `blockchain/subscription.rs` reconnect loop (~70-118): no consecutive-failure ceiling — retries forever every 60s. An infinite chain-reconnect is arguably correct; **confirm intent** before adding a ceiling/backoff cap.
- **F5 (DROPPABLE)** `billing/drive_credits.rs::cache()` (~104-128): process-wide drive-event cache keyed by `account_id` with a TTL can show stale "Total Credit Used" across account context. Reworking caching risks regressions; key/invalidate on account switch **only if desired.**

## Before the PR
- `cd src-tauri && SQLX_OFFLINE=true cargo test` (full suite).
- `cargo clippy --all -- -D warnings` — note the branch inherited ~48 pre-existing warnings unrelated to these fixes; the remediation added none.
- Manual smoke (`RUST_LOG=debug pnpm tauri:dev`): reviewed-conflict sync (A1), double-open a cloud preview (B2), no `PoolClosed` at startup (B3).
- Delete this file before merging, or keep it as the PR description scaffold.
