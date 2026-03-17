# Managed State Refactor — Replace Global Statics with Tauri Managed State

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace `DB_POOL: OnceCell<SqlitePool>` and other scattered global statics with Tauri's `app.manage()` / `tauri::State<T>` dependency injection, making dependencies explicit in function signatures.

**Architecture:** Create an `AppState` struct holding `SqlitePool` and register it via `app.manage()` during setup. Migrate command files one at a time to accept `tauri::State<AppState>` instead of calling `DB_POOL.get()`. Non-command code (utilities, sync engine) that can't receive `tauri::State` will use `app.state::<AppState>()` from the `AppHandle` they already receive, or keep a focused global where architecturally necessary (e.g., `HCFS_DRIVES` which is accessed from both sync callbacks and commands).

**Tech Stack:** Rust, Tauri 2.0, SQLx, tokio

---

## Scope & Boundaries

### In scope (this plan)
- `DB_POOL: OnceCell<SqlitePool>` → `tauri::State<AppState>` (76 call sites, 12 files)
- `AUTH_STATE: Lazy<Mutex<AuthState>>` → managed state
- `ACTIVE_ACCOUNT_ID: Lazy<Mutex<Option<String>>>` → fold into `AppState`

### Out of scope (keep as globals — architectural reasons)
- **`HCFS_DRIVES`** — `tokio::sync::Mutex`, accessed from long-running sync loop via `AppHandle`. Moving to managed state gains nothing since sync loop already uses `AppHandle`.
- **`SYNC_LOOP_HANDLE`** — tightly coupled to `HCFS_DRIVES`, same reasoning.
- **`SYNC_PROGRESS`** — accessed only from its own Tauri commands (self-contained module). Could migrate later but low value.
- **`HCFS_SYNC_STATES`, `PENDING_ACTIVITY`, `SYNC_ENGINE_HEALTH`** — accessed from sync progress callbacks (non-command code without AppHandle). Architectural change needed to thread AppHandle through hcfs-client callbacks. Defer.
- **`GLOBAL_CANCEL_TOKEN`, `REVIEW_MODE_ENTERED_AT`, `CONSECUTIVE_SYNC_FAILURES`, `TOKEN_REFRESH_IN_PROGRESS`** — atomic flags, no benefit from managed state.
- **`SYNC_IN_PROGRESS`, `SYNC_CHANGES_PENDING`, `SYNC_REVIEW_MODE`** — atomic bools, same.
- **`BLOCK_SUB_*`** — self-contained module, atomics + tokio Mutex.
- **`SUBSTRATE_CLIENT`** — lazy-initialized RwLock cache, not a Tauri command dependency.
- **`PKCE_STATES`, `SETUP_STATE`, `PING_TASK_HANDLE`, `HEALTH_CLIENT`** — module-private, small scope.
- **`MIGRATION_*`** — temporary migration code, will be removed entirely.

### Why these three?
`DB_POOL` is the biggest win: 76 call sites, 12 files, used in every command domain. `AUTH_STATE` is the second most cross-cutting global (used in auth, syncing, session). `ACTIVE_ACCOUNT_ID` is tiny but always set/read alongside auth state — natural to co-locate.

---

## Task 1: Create `AppState` struct and register it

**Files:**
- Create: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/builder_blocks/setup.rs`

**Step 1: Create `src-tauri/src/app_state.rs`**

```rust
//! Centralized application state managed by Tauri.
//!
//! Registered via `app.manage(AppState::new(pool))` during setup.
//! Command handlers receive it as `tauri::State<'_, AppState>`.

use sqlx::sqlite::SqlitePool;
use sp_core::sr25519;
use std::sync::Mutex;

pub struct AuthInfo {
    pub sr25519_pair: Option<sr25519::Pair>,
    pub substrate_address: Option<String>,
    pub eth_address: Option<String>,
}

impl Default for AuthInfo {
    fn default() -> Self {
        Self {
            sr25519_pair: None,
            substrate_address: None,
            eth_address: None,
        }
    }
}

pub struct AppState {
    pub db: SqlitePool,
    pub auth: Mutex<AuthInfo>,
    pub active_account_id: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(db: SqlitePool) -> Self {
        Self {
            db,
            auth: Mutex::new(AuthInfo::default()),
            active_account_id: Mutex::new(None),
        }
    }

    /// Get the DB pool reference (convenience method).
    pub fn pool(&self) -> &SqlitePool {
        &self.db
    }
}
```

**Step 2: Register `AppState` in setup.rs**

In `builder_blocks/setup.rs`, after `DB_POOL.set(pool.clone()).unwrap();` (line 576), add:

```rust
app_handle.manage(crate::app_state::AppState::new(pool.clone()));
```

This keeps `DB_POOL` working during the incremental migration — both coexist until all call sites are migrated.

**Step 3: Add `mod app_state;` to main.rs**

Add `mod app_state;` to the module declarations (after `mod api_client;`).

**Step 4: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`
Expected: Clean compile, no errors.

**Step 5: Commit**

```
feat: add AppState struct with Tauri managed state
```

---

## Task 2: Migrate `commands/vpn_enabled.rs` (4 call sites — smallest file, good pilot)

**Files:**
- Modify: `src-tauri/src/commands/vpn_enabled.rs`

**Step 1: Change all 4 command functions**

Replace:
```rust
let pool = DB_POOL.get().ok_or("Database pool not available")?;
```
With:
```rust
// Add parameter: state: tauri::State<'_, crate::app_state::AppState>
let pool = state.pool();
```

Each of the 4 commands (`get_vpn_status`, `toggle_vpn_status`, `get_autoconnect_status`, `toggle_autoconnect_status`) gets `state: tauri::State<'_, crate::app_state::AppState>` added to its parameter list.

Remove the `use crate::DB_POOL;` import if it becomes unused.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`
Expected: Clean compile. Tauri automatically injects `State` params — no changes needed in `main.rs` handler registration.

**Step 3: Commit**

```
refactor: migrate vpn_enabled commands to managed state
```

---

## Task 3: Migrate `commands/substrate_tx.rs` (5 call sites)

**Files:**
- Modify: `src-tauri/src/commands/substrate_tx.rs`

**Step 1: Add `state: tauri::State<'_, crate::app_state::AppState>` to these commands:**
- `get_sync_path`
- `get_wss_endpoint` (line ~222 uses `if let Some(pool) = DB_POOL.get()` pattern)
- `remove_sync_path`
- `set_sync_path`
- `transfer_balance_tauri`

Replace `DB_POOL.get().ok_or(...)` with `state.pool()`.
For the `if let Some(pool) = DB_POOL.get()` pattern, replace with `let pool = state.pool();`.

Remove the `use crate::DB_POOL;` import if unused.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate substrate_tx commands to managed state
```

---

## Task 4: Migrate `commands/session.rs` (10 call sites)

**Files:**
- Modify: `src-tauri/src/commands/session.rs`

**Step 1: Add `state: tauri::State<'_, crate::app_state::AppState>` to all command functions that use `DB_POOL`.**

All 10 commands use the same pattern: `let pool = DB_POOL.get().ok_or("Database not initialized")?;`
Replace with `let pool = state.pool();`

Remove the `use crate::DB_POOL;` import.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate session commands to managed state
```

---

## Task 5: Migrate `commands/auth.rs` (4 call sites) + `AUTH_STATE` usage

**Files:**
- Modify: `src-tauri/src/commands/auth.rs`

**Step 1: Replace `DB_POOL.get()` calls with `state.pool()`**

Add `state: tauri::State<'_, crate::app_state::AppState>` to commands that use `DB_POOL`:
- `login_with_mnemonic` (line ~173)
- `unlock_with_passcode` (line ~352)
- `set_passcode` (line ~438)
- `refresh_auth_token` (line ~591)

**Step 2: Replace `AUTH_STATE` usage with `state.auth`**

Find all `AUTH_STATE.lock()` calls in this file and replace with `state.auth.lock()`.

The locking pattern stays the same — just the source changes from a global to the managed state.

**Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 4: Commit**

```
refactor: migrate auth commands to managed state (DB + AuthState)
```

---

## Task 6: Migrate `commands/local_db.rs` (30 call sites — largest file)

**Files:**
- Modify: `src-tauri/src/commands/local_db.rs`

**Step 1: Add `state: tauri::State<'_, crate::app_state::AppState>` to ALL commands**

This file has 30 `DB_POOL.get()` calls. Every command function gets the state param.
Replace all with `let pool = state.pool();`.

Remove the `use crate::DB_POOL;` import.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate local_db commands to managed state
```

---

## Task 7: Migrate `commands/syncing.rs` (9 call sites)

**Files:**
- Modify: `src-tauri/src/commands/syncing.rs`

**Step 1: Add state param to commands that use `DB_POOL`**

Commands to modify (those that call `DB_POOL.get()`):
- `save_hcfs_config`
- `get_hcfs_config`
- `initialize_sync`
- `stop_sync`
- `stop_drive`
- `get_remote_storage_stats`
- `get_device_name`
- `set_device_name`
- Any others that use `DB_POOL.get()` directly

Some of these commands already take `app: AppHandle` — that's fine, they can take both `app` and `state` params.

**Note:** The `initialize_sync` function also reads `AUTH_STATE` — replace with `state.auth.lock()`. Similarly replace any `ACTIVE_ACCOUNT_ID` reads/writes with `state.active_account_id.lock()`.

Remove the `use crate::DB_POOL;` import if fully unused.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate syncing commands to managed state
```

---

## Task 8: Migrate `commands/file_commands.rs` (1 call site)

**Files:**
- Modify: `src-tauri/src/commands/file_commands.rs`

**Step 1: Add state param to `resolve_file_path`** (the command that uses `DB_POOL`)

Replace `DB_POOL.get().ok_or(...)` with `state.pool()`.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate file_commands to managed state
```

---

## Task 9: Migrate `commands/accounts.rs` (4 call sites)

**Files:**
- Modify: `src-tauri/src/commands/accounts.rs`

**Step 1: Add state param to commands**

These use `match crate::DB_POOL.get() { Some(pool) => ..., None => ... }` pattern.
Replace with `let pool = state.pool();` and remove the None branch.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate accounts commands to managed state
```

---

## Task 10: Migrate `commands/migration.rs` (1 call site)

**Files:**
- Modify: `src-tauri/src/commands/migration.rs`

**Step 1: Migrate the `DB_POOL.get()` call**

Line ~768 uses `if let Some(pool) = DB_POOL.get()` inside an async block. This is likely inside a `tokio::spawn` — if so, it can't receive `tauri::State` (not `Send`). Instead, extract the pool reference before spawning:

```rust
let pool = state.pool().clone(); // SqlitePool is Clone (cheap Arc clone)
tokio::spawn(async move {
    // use pool directly
});
```

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: migrate migration commands to managed state
```

---

## Task 11: Migrate non-command code — `substrate_client.rs` (2 call sites)

**Files:**
- Modify: `src-tauri/src/substrate_client.rs`

**Step 1: Change `get_current_wss_endpoint` and `update_wss_endpoint` to accept `&SqlitePool`**

These are NOT Tauri commands — they're utility functions called from commands. Change their signatures:

```rust
pub async fn get_current_wss_endpoint(pool: &SqlitePool) -> Result<String, String> { ... }
pub async fn update_wss_endpoint(pool: &SqlitePool, new_endpoint: String) -> Result<(), String> { ... }
```

Then update callers to pass `state.pool()` or the pool they already have.

Also update `get_substrate_client` — it calls `get_current_wss_endpoint`. It will need to accept a `&SqlitePool` param too, and its callers (in `commands/blockchain.rs`, `block_subscription.rs`) will pass it through.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: thread SqlitePool through substrate_client functions
```

---

## Task 12: Migrate non-command code — `utils/auth_tokens.rs` (5 call sites)

**Files:**
- Modify: `src-tauri/src/utils/auth_tokens.rs`

**Step 1: Change all functions to accept `&SqlitePool` param**

Functions to change:
- `save_api_token(pool: &SqlitePool, account_id: &str, token: &str)`
- `get_api_token(pool: &SqlitePool, account_id: &str)`
- `is_token_expiring(pool: &SqlitePool, account_id: &str, margin_secs: i64)`
- `save_s3_credentials(pool: &SqlitePool, ...)`
- `get_s3_credentials(pool: &SqlitePool, ...)`
- `ensure_s3_credentials(pool: &SqlitePool, ...)`

Remove internal `DB_POOL.get()` patterns. Update all callers to pass the pool.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: thread SqlitePool through auth_tokens utility functions
```

---

## Task 13: Migrate `utils/sync.rs` — fold into AppState

**Files:**
- Modify: `src-tauri/src/utils/sync.rs`

**Step 1: Replace `ACTIVE_ACCOUNT_ID` global with AppState**

Change `set_active_account` and `current_account_id` to accept `&AppState`:

```rust
use crate::app_state::AppState;

pub fn set_active_account(state: &AppState, account_id: &str) {
    let mut guard = state.active_account_id.lock().unwrap();
    *guard = Some(account_id.to_string());
}

pub fn current_account_id(state: &AppState) -> Result<String, String> {
    state.active_account_id
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No active account set".to_string())
}
```

Remove the `ACTIVE_ACCOUNT_ID` static. Update callers to pass `&state` or extract from AppHandle.

**Step 2: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 3: Commit**

```
refactor: fold ACTIVE_ACCOUNT_ID into AppState
```

---

## Task 14: Migrate remaining `AUTH_STATE` usages outside auth.rs

**Files:**
- Modify: any file still importing `AUTH_STATE` from `auth_state.rs`

**Step 1: Find remaining AUTH_STATE usages**

Run: `rg "AUTH_STATE" src-tauri/src/ --files-with-matches`

For each file:
- If it's a Tauri command: add `state: tauri::State<'_, AppState>` and use `state.auth.lock()`
- If it's a utility function: add `&AppState` param and pass from caller

**Step 2: Once all usages are migrated, delete `src-tauri/src/auth_state.rs`**

Remove `mod auth_state;` from `main.rs`.

**Step 3: Verify it compiles**

Run: `cd src-tauri && cargo build 2>&1 | head -30`

**Step 4: Commit**

```
refactor: remove auth_state.rs, AUTH_STATE fully replaced by AppState
```

---

## Task 15: Remove `DB_POOL` global

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/builder_blocks/setup.rs`

**Step 1: Verify no remaining `DB_POOL` usages**

Run: `rg "DB_POOL" src-tauri/src/`

If any remain, migrate them first (go back to the relevant task).

**Step 2: Remove the global from main.rs**

Delete:
```rust
use once_cell::sync::OnceCell;
use sqlx::sqlite::SqlitePool;
pub static DB_POOL: OnceCell<SqlitePool> = OnceCell::new();
```

**Step 3: Update setup.rs**

Remove the `DB_POOL.set(pool.clone()).unwrap();` line. The pool is now only managed via `app.manage(AppState::new(pool))`.

**Step 4: Remove `once_cell` from Cargo.toml if no other usages remain**

Run: `rg "once_cell" src-tauri/src/` — if still used by other globals (HCFS_DRIVES etc.), keep it.

**Step 5: Verify it compiles and tests pass**

Run: `cd src-tauri && cargo build && cargo test 2>&1 | tail -20`

**Step 6: Commit**

```
refactor: remove DB_POOL global, all DB access via managed AppState
```

---

## Task 16: Update `setup.rs` to use AppHandle for DB init

**Files:**
- Modify: `src-tauri/src/builder_blocks/setup.rs`

**Step 1: In the async setup block, after creating the pool, register state via AppHandle**

The setup already has `let app_handle = app.handle().clone();`. Change to:

```rust
let pool = SqlitePool::connect(&db_url).await.unwrap();
app_handle.manage(crate::app_state::AppState::new(pool.clone()));

// Rest of setup uses pool directly (it's local)
ensure_table_schema(&pool).await?;
```

This was already done in Task 1, but now DB_POOL is gone so this is the sole path.

**Step 2: Verify VPN/Nebula setup code that used DB_POOL in setup.rs still works**

The setup code after DB init uses `pool` directly (local variable), not `DB_POOL`. Confirm this is still the case.

**Step 3: Commit (if any changes needed)**

```
refactor: clean up setup.rs after DB_POOL removal
```

---

## Task 17: Final verification

**Step 1: Full build**

Run: `cd src-tauri && cargo build 2>&1`

**Step 2: Clippy**

Run: `cd src-tauri && cargo clippy --all -- -D warnings 2>&1`

**Step 3: Tests**

Run: `cd src-tauri && cargo test 2>&1`

**Step 4: Verify no remaining global DB access**

Run: `rg "DB_POOL|OnceCell<SqlitePool>" src-tauri/src/` — should return nothing.

**Step 5: Verify AUTH_STATE is gone**

Run: `rg "AUTH_STATE" src-tauri/src/` — should return nothing.

**Step 6: Commit any remaining fixes, then final commit**

```
chore: final cleanup after managed state migration
```

---

## Notes for implementer

1. **`tauri::State` is automatically injected** — you do NOT need to change `generate_handler![]` or any frontend `invoke()` calls. Tauri sees `State<T>` in the function signature and passes it automatically.

2. **`SqlitePool` is cheaply cloneable** (it's an `Arc` internally). When you need to pass it into a `tokio::spawn`, clone it first: `let pool = state.pool().clone();`

3. **`tauri::State` is not `Send`** — you cannot hold it across `.await` points inside a `tokio::spawn`. Extract what you need first.

4. **Order matters** — `app.manage()` must be called before any command that uses `State<AppState>` is invoked. Since DB init happens in `setup()` which runs before commands, this is fine. BUT: setup spawns an async task, so there's a race. The `manage()` call must happen synchronously in setup, not in the spawned task. This means we need to restructure: create pool synchronously (blocking), then manage it, then spawn async task for schema migration. OR use an `Arc<OnceCell<AppState>>` pattern. **Investigate this during Task 1.**

5. **Incremental approach** — Tasks 2-14 can be done in any order. Each task is independently compilable because `DB_POOL` still exists during the migration. Only Task 15 removes it (after all call sites are migrated).
