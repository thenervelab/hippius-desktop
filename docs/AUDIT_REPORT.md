# Hippius Desktop — Production Readiness Audit

**Date:** 2026-03-16
**Branch:** `sync-engine`
**Scope:** Full codebase — frontend (`app/`) and backend (`src-tauri/src/`)

---

## Executive Summary

The codebase is in strong shape after the Rust migration effort. Business logic is ~95% moved to Rust. No SQL injection, no XSS, no secret leaks in git. The main issues are: (1) inconsistent logging — 297 `println!()` in Rust and 368 `console.log` in TypeScript that need to go through proper loggers before production, (2) a handful of `unwrap()`/`expect()` calls in startup code that will hard-crash the app if the environment is degraded, and (3) one remaining chunk of business logic in TypeScript (the update checker) that should move to Rust.

---

## 1. Business Logic Still in TypeScript

Per project rule: *"We ALWAYS try to put the business logic in the RUST side."*

### 1.1 Should Migrate to Rust

| File | Lines | What It Does | Why It Should Move |
|------|-------|--------------|-------------------|
| `app/components/updater/checkForUpdates.ts` | 237 | Update download orchestration, progress tracking, version comparison, signature verification | System-level update management is core backend logic, not UI |
| `app/lib/utils/transformMarketplaceCredits.ts` | 119 | Credit history → cumulative running totals for charts, divides by 10^18, fills date gaps | Data transformation with financial math — same pattern as the chart formatters already migrated |
| `app/lib/utils/storageCostUtils.ts` | 59 | Storage pricing: first-hour charge + per-block costs over 3 time frames, uses Bittensor block constants | Financial/pricing calculation with chain-specific constants |
| `app/lib/utils/staking.ts` | 40 | Planck ↔ decimal conversion (÷10^18), explorer URL generation | Blockchain unit conversion — already done in Rust for other contexts |

### 1.2 Intentionally Kept in TypeScript (Justified)

These were reviewed and deliberately left in JS — documented in memory:

| File | Lines | Justification |
|------|-------|--------------|
| `app/lib/utils/fileFilterUtils.ts` | 265 | In-memory array filtering per keystroke — IPC roundtrip would kill responsiveness |
| `app/lib/utils/mediaNavigation.ts` | 146 | Synchronous navigation state for media viewer — async IPC would break UX |
| `app/lib/utils/dateUtils.ts` | 124 | Small sync formatters called in render — async overhead not worth it |
| `app/lib/utils/fileTypeUtils.ts` | 115 | Maps file types to React icon components — inherently frontend |
| `app/lib/utils/webgl.ts` | 143 | WebGL shader/canvas code — can only run in browser |
| `app/lib/hooks/useUploadTicketAttachment.ts` | — | FormData/File multipart — Tauri invoke can't handle browser File objects |
| `app/components/page-sections/files/card-view/FileCard.tsx` | — | Image fetch for canvas thumbnail — DOM-dependent |

### 1.3 Already Migrated (Verified Working)

- Chart formatters → `chart_formatting.rs` (3 commands, 19 tests passing)
- IPFS resolver → `ipfs_resolver.rs` (3 commands, 8 tests passing)
- Notifications DB → `local_db.rs` (30 commands)
- Sync progress → `sync_progress.rs` (19 commands)
- All auth, session, blockchain, billing, VM, support, OAuth → Rust

---

## 2. Rust Backend Audit

### 2.1 Panic-Capable Code in Production

**`unwrap()` — 8 instances (non-test)**

| File | Line | Code | Risk |
|------|------|------|------|
| `builder_blocks/setup.rs` | 574 | `SqlitePool::connect(&db_url).await.unwrap()` | **HIGH** — crashes app if DB file is corrupted/locked/permissions denied |
| `builder_blocks/setup.rs` | 575 | `DB_POOL.set(pool.clone()).unwrap()` | LOW — only fails if called twice (impossible in normal flow) |
| `utils/sync.rs` | 7 | `ACTIVE_ACCOUNT_ID.lock().unwrap()` | **MEDIUM** — panics if another thread panicked while holding lock |
| `utils/sync.rs` | 14 | `ACTIVE_ACCOUNT_ID.lock().unwrap()` | Same as above |
| `utils/nebula.rs` | 430 | `SETUP_STATE.lock().unwrap()` | **MEDIUM** — mutex poison panic |
| `utils/nebula.rs` | 442 | `SETUP_STATE.lock().unwrap()` | Same |
| `utils/nebula.rs` | 490 | `SETUP_STATE.lock().unwrap()` | Same |
| `commands/chart_formatting.rs` | 59 | `NaiveDate::from_ymd_opt(2025,3,11).unwrap()` | NONE — hardcoded valid date |

**`expect()` — 7 instances (non-test)**

| File | Line | Code | Risk |
|------|------|------|------|
| `builder_blocks/setup.rs` | 541 | `.expect("main window not found")` | **HIGH** — crashes if window creation failed |
| `builder_blocks/setup.rs` | 562 | `dirs::home_dir().expect("Failed to get home directory")` | **HIGH** — fails on non-standard OS setups |
| `builder_blocks/setup.rs` | 567 | `create_dir_all(&db_dir).expect(...)` | **HIGH** — fails if disk full or permissions denied |
| `builder_blocks/setup.rs` | 570 | `OpenOptions...expect("Failed to create database file")` | **HIGH** — same |
| `main.rs` | 395 | `.expect("error while running tauri application")` | Unavoidable — top-level entry point |
| `lib.rs` | 15 | `.expect("error while running tauri application")` | Vestigial — `lib.rs` isn't used |
| `hcfs_drive.rs` | 457 | `Client::builder()...expect("Failed to build health check HTTP client")` | LOW — lazy static, TLS would have to be broken |

**Recommendation:** Replace `setup.rs` panics with `Result` propagation and show a user-facing error dialog on failure. Replace mutex `.unwrap()` with `parking_lot::Mutex` (doesn't poison) or `.unwrap_or_else(|e| e.into_inner())`.

### 2.2 Silently Swallowed Errors (`let _ =`)

**65 instances in production code.** Most are justified (fire-and-forget event emissions, optional cleanup). Problematic ones:

| File | Line | Code | Concern |
|------|------|------|---------|
| `utils/auth_tokens.rs` | 75-76 | `let _ = save_api_token(account_id, &token).await` | Token migration fails silently — auth may break later |
| `utils/auth_tokens.rs` | 96 | `let _ = sqlx::query("DELETE FROM objectstore_auth...")` | Credential cleanup fails silently |
| `commands/substrate_tx.rs` | 258 | `let _ = sqlx::query("DELETE FROM sync_paths...")` | First delete ignored but second propagated — inconsistent transaction |
| `utils/nebula.rs` | 1541-1556 | `let _ = Command::new("ping")...` | VPN health check result thrown away |

**Recommendation:** Add `warn!()` logging for all silently-ignored Results that affect data integrity. Cleanup failures (file deletion, event emission) are fine to ignore silently.

### 2.3 Logging

| Pattern | Count | Status |
|---------|-------|--------|
| `println!()` | 297 | **Should be `info!()`/`debug!()`/`warn!()`** |
| `eprintln!()` | 42 | **Should be `error!()`/`warn!()`** |
| `dbg!()` | 0 | Clean |
| `todo!()` / `unimplemented!()` | 0 | Clean |

**Top offenders:**

| File | `println!` count |
|------|-----------------|
| `utils/nebula.rs` | 130 |
| `commands/syncing.rs` | 69 |
| `builder_blocks/setup.rs` | 42 |
| `macos_bookmarks.rs` | 14 |
| `commands/blockchain.rs` | 11 |

**Recommendation:** Bulk replace `println!` → `info!` and `eprintln!` → `error!`. The tracing crate is already set up (`RUST_LOG=debug` works). This is ~30 minutes of mechanical work.

### 2.4 Vestigial Code

| File | Issue |
|------|-------|
| `lib.rs` | Contains unused `greet()` command — entire file is vestigial per CLAUDE.md |

---

## 3. Frontend Audit

### 3.1 Console Logging

**368 calls** across `app/` — `console.log`, `console.error`, `console.warn`.

**Top offenders:**

| File | Count |
|------|-------|
| `lib/hooks/useTraySync.ts` | 30+ |
| `lib/helpers/notificationsDb.ts` | 25 |
| `components/splash-screen/index.tsx` | 25 |
| `components/auth/LoginForm.tsx` | 20+ |
| `lib/hooks/useSyncEvents.ts` | 15+ |
| `components/page-sections/files/FilesContent.tsx` | 12 |
| `components/updater/UpdateChecker.tsx` | 11 |

**Recommendation:** Strip or gate behind `isDev` check. All labeled with context (`[TraySync]`, `[LoginForm]`) which is good for debug but noisy in production.

### 3.2 Type Safety

**`any` types: 20 instances**

- 12+ are `catch (e: any)` — acceptable (TypeScript catch is `unknown` by default, `any` is common)
- `app/lib/utils/links.ts:8` — `APP_LINKS: any` — should be `Record<string, string>`
- `app/components/page-sections/notifications/notificationStore.ts:32` — `n: any` — should be typed
- `app/components/ui/area-line-chart/index.tsx` — `t?: any` — chart library type gap

### 3.3 Security

| Issue | File | Line | Severity |
|-------|------|------|----------|
| **HTTP URL (not HTTPS)** | `app/lib/utils/links.ts` | 10 | **HIGH** — `"http://console.hippius.com/dashboard/billing?addCredits=true"` |
| Hardcoded `hipstats.com` | `app/lib/utils/staking.ts` | 33 | LOW — should be a constant |
| Hardcoded `hipstats.com` | `app/components/dashboard-title-wrapper/ProfileCard.tsx` | 43 | LOW — duplicate |

### 3.4 Event Listener Cleanup

**7 files use Tauri `listen()` — all 7 have proper cleanup.** No leaks found.

| File | Status |
|------|--------|
| `lib/hooks/useSyncEvents.ts` | Collects unlisteners in array, cleanup in return |
| `lib/polkadot-api-context/index.tsx` | Stores unlisten, cleans up in return |
| `(pages)/ConflictEventListener.tsx` | Promise array with `.then(u => u())` |
| `(pages)/SyncStatusHandler.tsx` | Cancelled flag + unlisten variable |
| `components/auth/LoginForm.tsx` | Sets unlisten variable, cleanup in return |
| `components/page-sections/files/FilesContent.tsx` | Array collection, cleanup in return |
| `components/page-sections/files/upload-files-flow/FileDropzone.tsx` | Dynamic import with proper collection |

### 3.5 Direct `fetch()` Calls

**2 files, both justified:**

1. `useUploadTicketAttachment.ts:66` — FormData multipart (can't use invoke)
2. `FileCard.tsx:20` — Image blob for canvas thumbnail (DOM-dependent)

### 3.6 TODO/FIXME Comments

**3 total** — all in `app/lib/utils/getPaginationPageList.ts` (minor pagination UX ideas). Non-blocking.

### 3.7 Empty Catch Blocks

**0 found.** All catch blocks have logging or error handling.

---

## 4. Configuration & Secrets

| Check | Status |
|-------|--------|
| `.env` in `.gitignore` | Yes — line 29: `src-tauri/.env` |
| `.env` committed to git | **No** — verified with `git ls-files` |
| `.env.example` exists | **No** — only test fixtures have examples |
| Hardcoded API URLs have env var fallback | Yes — `auth.rs` uses `HIPPIUS_API_BASE_URL` env var |
| API keys in source code | None found |

**Recommendation:** Add `src-tauri/.env.example` with placeholder values so new developers know what's needed.

---

## 5. Action Items

### P0 — Fix Before Production

| # | Item | Effort |
|---|------|--------|
| 1 | Fix HTTP → HTTPS in `app/lib/utils/links.ts:10` | 1 min |
| 2 | Replace `setup.rs` panics (lines 541, 562, 567, 570, 574-575) with Result propagation + error dialog | 1 hr |
| 3 | Replace mutex `.lock().unwrap()` in `sync.rs` and `nebula.rs` with `parking_lot::Mutex` or poison recovery | 30 min |

### P1 — Should Fix

| # | Item | Effort |
|---|------|--------|
| 4 | Replace 297 `println!()` + 42 `eprintln!()` with tracing macros | 1-2 hrs |
| 5 | Add `warn!()` logging for swallowed Results in `auth_tokens.rs`, `substrate_tx.rs` | 30 min |
| 6 | Migrate update checker (`checkForUpdates.ts`, 237 lines) to Rust | 3-4 hrs |
| 7 | Migrate `transformMarketplaceCredits.ts` (119 lines) + `storageCostUtils.ts` (59 lines) to Rust | 2-3 hrs |
| 8 | Strip or gate 368 `console.log` calls behind `isDev` | 1 hr |
| 9 | Delete vestigial `lib.rs` or strip it to empty | 1 min |

### P2 — Nice to Have

| # | Item | Effort |
|---|------|--------|
| 10 | Add `src-tauri/.env.example` | 5 min |
| 11 | Move `hipstats.com` to a constant | 10 min |
| 12 | Type `APP_LINKS` properly in `links.ts` | 5 min |
| 13 | Migrate `staking.ts` planck conversions to Rust | 30 min |

---

## 6. What's Clean

- **No SQL injection** — all queries use parameterized sqlx
- **No XSS** — no `dangerouslySetInnerHTML` or `innerHTML`
- **No secrets in git** — `.env` properly gitignored
- **No unsafe Rust** — only `macos_bookmarks.rs` (justified FFI, null-checked)
- **No unfinished code** — zero `todo!()`, `unimplemented!()`, `dbg!()`
- **Proper event cleanup** — all 7 Tauri listeners cleaned up
- **Proper error propagation** — consistent `Result<T, String>` + `.map_err()` pattern
- **Crypto in Rust only** — mnemonics, keys never touch frontend
- **Concurrency handled** — `Arc<Mutex<>>`, `OnceCell`, `Lazy` patterns correct
- **Static export works** — no SSR assumptions, all data via IPC
