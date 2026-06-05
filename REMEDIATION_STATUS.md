# Audit Remediation Status — branch `fix/audit-2026-06-05-remediation`

Tracks execution of the 31 non-HIGH findings from `AUDIT_2026-06-05.md`.
Full per-finding detail + verifier-designed fixes live in that audit doc; the
implementation plan is `~/.claude/plans/eager-sauteeing-sunset.md`.

Each fix is its own commit tagged `[<id>]` in the subject, so any commit is a
safe stopping point. Resume by picking the next REMAINING item, re-reading the
live code via illu (line numbers drift), applying the fix, and running the
Rust gate sequence (`rust_preflight` → `axioms` → implement → `quality_gate`)
before committing.

## DONE (19 findings, 13 commits)

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
| _(this commit)_ | D4 | `start_server_migration` job_exists branch: cancel is awaited+inspected (was fire-and-forget); single immediate retry replaced by a bounded backoff loop (`MAX_MIGRATION_START_RETRIES`=3, linear `migration_retry_backoff`); pure backoff test + static pin |

## REMAINING (12 items: 8 includable + 2 droppable + D9 deferred)

### Batch D (error-surfacing) — remaining
- **D7** `auth/contacts.rs::claim_legacy_contacts` (~38-44): `UPDATE address_book SET owner=? WHERE owner=''` assigns ALL legacy rows to whichever account opens its book first. Add a test documenting the multi-account claim semantics + a `// why` comment (consider scoping the claim if a recoverable key exists). Primarily test + comment.
- **D8** `utils/schema.rs::migrate_account_keys` (~823-883): per-table UPDATE errors are `warn!`-swallowed while the tx still commits → partial owner migration on a UNIQUE collision. Make a per-table failure roll back the transaction (propagate Err) or resolve the collision deterministically. Test: forced collision on the first table asserts no partial commit.
- **D9** `app_state.rs::pool` (233-235): returns `sqlx::Error::PoolClosed` for an *uninitialized* pool (semantic mislabel). **DEFERRED** — the proper fix adds a `NotReadyKind` variant which cascades to the FE TS union (`app/lib/utils/dispatchTauriError.ts`) + the round-trip test. After B3 the early-call window is essentially closed, so this LOW is near-unreachable; do it only alongside the FE change. Decide with the user.
- **D10** `notifications/credits.rs::process_credit_events` (~230-302): amount parse mangles negative/fractional values and events with unparseable timestamps are silently dropped. Parse defensively; `warn!` + skip with reason on bad timestamp; handle sign/fraction explicitly. Test: negative/fractional amount + bad-timestamp fixtures.

### Batch E (security scoping) — remaining
- **E1** `notifications/crud.rs::add_notification` (~157-217) and `create_sync_notification`: stop persisting to a caller-supplied `user_address` without a session check — derive the account from `state.current_account_id()` (as the read side does) or assert it matches the session account. Test: a call with a mismatched address is rejected/ignored.

### Batch F (INFO polish)
- **F1** `sync/migration.rs::complete_migration_transition` (~510-554) vs `check_migration`: the `in_progress` atomic store has no synchronization against `check_migration` setting it. Verifier rated benign; tighten ordering/comment if cheap.
- **F3** `api/indexer.rs::IndexerClient::get` (~59-80): the non-success error body discards the request path — add the path to the `ApiError::Http` context (match the sibling `console_access` path).
- **F4 (DROPPABLE)** `blockchain/subscription.rs` reconnect loop (~70-118): no consecutive-failure ceiling — retries forever every 60s. An infinite chain-reconnect is arguably correct; confirm intent before adding a ceiling/backoff cap.
- **F5 (DROPPABLE)** `billing/drive_credits.rs::cache()` (~104-128): process-wide drive-event cache keyed by `account_id` with a TTL can show stale "Total Credit Used" across account context. Reworking caching risks regressions; key/invalidate on account switch only if desired.

## Before the PR
- `cd src-tauri && SQLX_OFFLINE=true cargo test` (full suite).
- `cargo clippy --all -- -D warnings` — note the branch inherited ~48 pre-existing warnings unrelated to these fixes; the remediation added none.
- Manual smoke (`RUST_LOG=debug pnpm tauri:dev`): reviewed-conflict sync (A1), double-open a cloud preview (B2), no `PoolClosed` at startup (B3).
- Delete this file before merging, or keep it as the PR description scaffold.
