# Remove Nebula VPN Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fully remove the Nebula VPN feature from Hippius Desktop — the Rust `nebula/` module, all 13 Tauri IPC commands, the VPN UI surfaces, the splash-screen Nebula phases, and the four legacy SQLite tables. Splash stays as a simplified update-check + launch beat.

**Architecture:** Cut from outermost mounts inward so each commit compiles and lints cleanly. Replace `finish_setup` (currently in `nebula::manager`) with a new minimal command before deleting Nebula module. Drop the 4 SQLite tables idempotently at startup (`DROP TABLE IF EXISTS`) so existing users get a clean state on next launch.

**Tech Stack:** Tauri 2.0, Rust (workspace pinned to 1.92.0), Next.js 15 + TypeScript, SQLx (offline mode `SQLX_OFFLINE=true`), pnpm, ESLint, cargo clippy.

**Worktree:** `.worktrees/remove-nebula` (branch `chore/remove-nebula`, stacked on `sync-engine`)

**Reference design:** `docs/plans/2026-05-08-remove-nebula-vpn-design.md`

---

## Pre-flight

Before starting any task, ensure baseline is clean:

```bash
cd /Users/georgiosdelkos/Documents/GitHub/Bitensor/hippius-desktop/.worktrees/remove-nebula
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
pnpm lint    # one pre-existing warning in app/components/page-sections/files/files-table/index.tsx:959 — ignore
```

Confirm `src-tauri/.env` exists (must, per CLAUDE.md). If missing, copy from main worktree.

---

## Task 1: Add `finish_setup` placeholder command outside the Nebula module

**Files:**
- Create: `src-tauri/src/splash.rs`
- Modify: `src-tauri/src/main.rs` (`pub mod` list, IPC registration)

**Step 1: Create the placeholder module**

Write `src-tauri/src/splash.rs`:

```rust
//! Splash-screen lifecycle commands.
//!
//! Until 2026-05 the splash's terminal "Launching App" phase invoked
//! `nebula::manager::finish_setup`, which kicked off Nebula auto-start.
//! After Nebula removal there is no terminal work, but the splash UI
//! still expects a command to call so it can transition off-screen —
//! hence this no-op stub. Keeping the command (instead of dropping the
//! invoke from the FE) lets the splash retain its existing two-beat
//! shape without conditional logic.

/// Splash terminal handshake. Always succeeds; exists so the FE has a
/// command to await before dismissing the splash.
#[tauri::command]
pub async fn finish_setup() -> Result<(), String> {
    Ok(())
}
```

**Step 2: Register the new module in `main.rs`**

In `src-tauri/src/main.rs`, add `pub mod splash;` next to the other `pub mod` declarations (around line 22 alongside `pub mod nebula;`).

In the `tauri::generate_handler![]` block, add `crate::splash::finish_setup` immediately above the existing `crate::nebula::manager::finish_setup` line (~line 217). Both will coexist temporarily; Task 2 retargets the FE, Task 3 deletes the Nebula one.

**Step 3: Verify compile**

```bash
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: clean compile. If a duplicate-handler-name error fires, either Tauri allows the duplicate (different paths) or rename the new fn to `finish_splash` and adjust Task 2 accordingly.

**Step 4: Commit**

```bash
cd .worktrees/remove-nebula
git add src-tauri/src/splash.rs src-tauri/src/main.rs
git commit -m "feat: add splash finish_setup placeholder command"
```

---

## Task 2: Point splash UI at the new `finish_setup`

**Files:**
- Modify: `app/components/splash-screen/SplashContent.tsx`

**Step 1: Confirm Tauri can resolve duplicate handler names**

If Task 1 had to rename to `finish_splash`, swap the FE call here too. Otherwise the FE invocation `invoke("finish_setup")` resolves to whichever handler Tauri registered first; the order in `generate_handler![]` puts `splash::finish_setup` ahead of `nebula::manager::finish_setup`, so the no-op runs.

**Step 2: Smoke test the splash**

```bash
SQLX_OFFLINE=true RUST_LOG=info pnpm tauri:dev
```

Expected: splash advances through phases without errors; `finish_setup` returns `Ok(())` immediately.

Stop the dev server.

**Step 3: Commit**

If no FE changes were needed (handler name collision allowed):

```bash
git commit --allow-empty -m "chore: confirm splash invokes new finish_setup placeholder"
```

If `finish_splash` rename was required:

```bash
git add app/components/splash-screen/SplashContent.tsx
git commit -m "refactor: point splash at non-Nebula finish_setup"
```

---

## Task 3: Remove all Nebula IPC registrations and the shutdown handler

**Files:**
- Modify: `src-tauri/src/main.rs`

**Step 1: Strip the Nebula command registrations**

In `src-tauri/src/main.rs`, delete lines 204-218 (`// VPN / Nebula` comment + 13 `crate::nebula::*` lines, leaving the new `crate::splash::finish_setup`).

Use `mcp__illu__context` with `symbol_name: "main"` `path: "src-tauri/src/main.rs"` first to confirm exact line numbers — they shift as the file evolves.

**Step 2: Strip the `RunEvent::ExitRequested` Nebula branch**

Delete lines ~407-449 of `main.rs` (the entire `tauri::RunEvent::ExitRequested { api, .. } => { ... }` arm). Tauri will exit directly without the deferred-stop dance.

The match becomes:

```rust
app.run(|app_handle, event| {
    match event {
        // macOS dock icon click with no visible windows. Mirrors the
        // tray's "Open Hippius" action.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { has_visible_windows, .. } => {
            // ... unchanged ...
        }

        _ => {}
    }
});
```

**Step 3: Strip the startup Nebula blocks**

Delete lines ~661-689 (autoconnect query, `vpn_status` reset, `stop_nebula`-on-startup, `verify_nebula_setup`). The post-cleanup-call section becomes:

```rust
            if let Err(e) = crate::notifications::crud::cleanup_duplicate_welcome_notifications(&pool).await {
                warn!("Welcome notification cleanup failed (non-fatal): {}", e);
            }

            info!("Database initialized successfully");
        });
        Ok(())
    })
}
```

**Step 4: Update stale comments referencing Nebula**

- Line 8: `//! and starts platform-specific services (Nebula VPN, deep links).` → `//! and starts platform-specific services (deep links).`
- Lines 481-489: Update the `on_window_event` doc comment to remove Nebula references. The macOS quit paths still hit `RunEvent::ExitRequested`, just without Nebula cleanup.

**Step 5: Verify compile**

```bash
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: errors about `app_state.nebula`, `app_state.nebula_stopped`, `crate::nebula::*` references in `app_state.rs` and elsewhere. That's expected — Task 4 cleans those.

If the only errors are inside `app_state.rs` / `error.rs` / `nebula/`, proceed. Otherwise investigate.

**Step 6: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "chore: remove Nebula IPC commands and shutdown handler"
```

---

## Task 4: Drop `NebulaState` from `AppState` and `AppError::Nebula`

**Files:**
- Modify: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/error.rs`

**Step 1: Strip `app_state.rs`**

Use `mcp__illu__context` `symbol_name: "AppState"` to read current state.

Remove:
- Line 14: `use crate::nebula::state::NebulaState;`
- Line 44: `pub nebula: NebulaState,`
- Lines 85-90: doc comment + `pub nebula_stopped: AtomicBool,`
- Line 141: `nebula: NebulaState::new(),`
- Line 165: `nebula_stopped: AtomicBool::new(false),`

If `AtomicBool` is no longer used, remove the `use std::sync::atomic::AtomicBool;` import too. If `AtomicU32` (or other atomics) still used by `syncs_in_progress`, keep the broader import.

**Step 2: Strip `error.rs`**

Remove:
- Lines 28-29: `#[error("VPN error: {0}")] Nebula(String),`
- Line 152: `Self::Nebula(_) => "Nebula",` from the `kind()` match arm.
- Lines 414-417: `display_nebula_error` test fn.
- Line 464: `AppError::Nebula("vpn".into()),` from any test fixture vector.
- Line 482: `"Nebula",` from any expected-kinds test vector.

**Step 3: Verify compile**

```bash
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: errors about unresolved `crate::nebula` paths in main.rs (already cleared), or in remaining `nebula/*.rs` files (still present). Check no new errors elsewhere.

**Step 4: Run unit tests on the touched files**

```bash
cd src-tauri
cargo test --lib error::
```

Expected: pass. The Nebula-specific tests are gone; the remaining error tests still cover other variants.

**Step 5: Commit**

```bash
cd ..
git add src-tauri/src/app_state.rs src-tauri/src/error.rs
git commit -m "chore: remove NebulaState from AppState and AppError::Nebula"
```

---

## Task 5: Delete the `nebula/` module

**Files:**
- Modify: `src-tauri/src/main.rs` (remove `pub mod nebula;`)
- Modify: `src-tauri/src/lib.rs` (remove `pub use ... nebula` re-exports if any)
- Delete: `src-tauri/src/nebula/mod.rs`
- Delete: `src-tauri/src/nebula/manager.rs`
- Delete: `src-tauri/src/nebula/vpn.rs`
- Delete: `src-tauri/src/nebula/state.rs`

**Step 1: Inspect `lib.rs` for re-exports**

```bash
rg -n "nebula" src-tauri/src/lib.rs
```

If `lib.rs` re-exports the nebula module for integration tests, remove that line.

**Step 2: Remove `pub mod nebula;` from `main.rs`**

Around line 22.

**Step 3: Delete the directory**

```bash
git rm -r src-tauri/src/nebula/
```

**Step 4: Verify clean compile + clippy**

```bash
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all -- -D warnings
```

Expected: clean. If clippy fires on any newly-unused imports anywhere (e.g. `tracing::error` if only `Nebula` paths used it), trim them.

**Step 5: Run the full Rust test suite**

```bash
cd src-tauri
SQLX_OFFLINE=true cargo test
```

Expected: all tests pass. Tests in `tests/` may touch `AppState` — they should still compile because the deleted fields aren't part of any public test fixture.

**Step 6: Commit**

```bash
cd ..
git add -A
git commit -m "chore: delete src-tauri/src/nebula module"
```

---

## Task 6: One-shot drop of legacy SQLite tables

**Files:**
- Modify: `src-tauri/src/utils/schema.rs`

**Step 1: Locate the schema entry points**

Use `mcp__illu__context` `symbol_name: "ensure_table_schema"` `path: "src-tauri/src/utils/schema.rs"` to view the current implementation.

**Step 2: Add `drop_legacy_nebula_tables`**

Insert this helper function in `schema.rs` (placement: above `ensure_table_schema` is fine). Use the existing module's import style (likely `sqlx::SqlitePool`).

```rust
/// One-shot cleanup of the legacy Nebula VPN tables.
///
/// Idempotent — `DROP TABLE IF EXISTS` is a no-op once the tables
/// are gone. TODO: remove this helper after a few releases when
/// virtually no installed binaries still have these tables on disk.
async fn drop_legacy_nebula_tables(pool: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    for table in [
        "vpn_status",
        "nebula_binary_status",
        "nebula_certificate",
        "autoconnect_vpn_enabled",
    ] {
        sqlx::query(&format!("DROP TABLE IF EXISTS {table}"))
            .execute(pool)
            .await?;
    }
    Ok(())
}
```

Call it once at the top of `ensure_table_schema` (or whichever function bootstraps the DB on app launch), before the rest of the schema work:

```rust
pub async fn ensure_table_schema(pool: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    drop_legacy_nebula_tables(pool).await?;
    // ... existing logic ...
}
```

**Step 3: Remove the 4 entries from `EXPECTED_TABLES`**

Delete lines 17-21 (`"vpn_status"`, `"nebula_binary_status"`, `"nebula_certificate"`, `"autoconnect_vpn_enabled"`).

**Step 4: Remove the 4 schema definitions**

Delete the schema definition blocks for these tables (~lines 76-130). After Step 3 they're orphan literal strings; the `ensure_table_schema` call sites for each go too.

**Step 5: Remove the 3 seed inserts**

Delete the `INSERT OR IGNORE INTO vpn_status / nebula_binary_status / autoconnect_vpn_enabled` queries (~lines 145-153). The `nebula_certificate` table had no seed insert.

**Step 6: Verify compile + clippy**

```bash
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all -- -D warnings
```

**Step 7: Run schema-adjacent tests**

```bash
cd src-tauri
SQLX_OFFLINE=true cargo test --lib utils::schema
```

Expected: pass. If there are integration tests that assert the table list, they need updating — adjust them in this commit.

**Step 8: Commit**

```bash
cd ..
git add src-tauri/src/utils/schema.rs
git commit -m "chore: drop legacy Nebula SQLite tables on startup"
```

---

## Task 7: Simplify the splash screen

**Files:**
- Modify: `app/components/splash-screen/SplashContent.tsx`
- Modify: `app/components/splash-screen/atoms.ts` (if it references removed phases)
- Modify: `app/components/splash-screen/SplashScreen.tsx` (if it references removed phases)
- Modify: `app/components/splash-screen/index.tsx` (if it references removed phases)

**Step 1: Strip the 4 Nebula phases from `SplashContent.tsx`**

Delete the keys `checking_nebula`, `downloading_nebula`, `installing_nebula`, `verifying_nebula` from the phases map (~lines 33-66). Delete the `installing_nebula.subStatus` dynamic setter (~line 83).

Final phases: only `check_updates` (line 22) and `finish_setup` (~line 68).

**Step 2: Skim adjacent files for stale references**

```bash
rg -n "nebula|Nebula|installing_nebula|checking_nebula|verifying_nebula|downloading_nebula" app/components/splash-screen/
```

Remove any matches — phase keys, atom slots, type unions.

**Step 3: Lint and typecheck**

```bash
pnpm lint
npx tsc --noEmit -p tsconfig.json
```

Expected: clean (modulo the pre-existing `files-table/index.tsx:959` warning).

**Step 4: Smoke test the splash visually**

```bash
SQLX_OFFLINE=true pnpm tauri:dev
```

Expected: splash shows "Checking for Updates" → "Launching App 🚀" → app loads. No Nebula-related text or phases.

Stop the dev server.

**Step 5: Commit**

```bash
git add app/components/splash-screen/
git commit -m "chore: simplify splash to update-check + launch only"
```

---

## Task 8: Remove all Nebula UI surfaces

**Files:**
- Modify: `app/components/dashboard-title-wrapper/BlockChainStats.tsx`
- Modify: `app/components/page-sections/settings/SettingsDialogContent.tsx`
- Modify: `app/lib/hooks/useTraySync.ts`
- Modify: `app/lib/hooks/__tests__/useTraySync.test.tsx`
- Modify: `app/components/vm/instance-details/networks-info.tsx`
- Modify: `app/components/vm/instance-details/virtual-machine-info.tsx`
- Delete: `app/components/dashboard-title-wrapper/vpn-menu/` (whole dir, 6 files)
- Delete: `app/components/page-sections/settings/VPNSettings.tsx`
- Delete: `app/components/DemoIpfsUpload.tsx`

**Step 1: Strip the title-bar VPN icon**

In `BlockChainStats.tsx`:
- Remove `import VPNMenu from "./vpn-menu";` (line 6)
- Remove `<VPNMenu />` (line 17)
- Skim layout — if a flex gap or wrapper looks unbalanced after removal, adjust.

**Step 2: Strip the VPN settings tab**

In `SettingsDialogContent.tsx`:
- Remove `import VPNSettings from "./VPNSettings";` (line 15)
- Remove `"VPN Settings"` from the `tabName` array (~line 91)
- Remove the `{activeTab === "VPN Settings" && (...)}` branch (~line 210)

**Step 3: Strip VPN bits from `useTraySync.ts`**

Remove:
- `import { vpnConnectedAtom } from "@/components/dashboard-title-wrapper/vpn-menu/vpnAtoms";` (line 33)
- `const VPN_TOGGLE_ID = "vpn-toggle";` (line 43)
- `let vpnToggleItem: MenuItem | null = null;` (line 64)
- The logout-cleanup VPN comment (line 125)
- `const setVpnConnected = useSetAtom(vpnConnectedAtom);` (line 182)
- The whole VPN toggle creation block (~lines 275-330)
- The whole "VPN Helper Functions" section (~lines 683-770)
- Any closure reference to `vpnStateSetter` / `vpnToggleItem` outside those blocks

After deletion, run:
```bash
rg -n "vpn|VPN|nebula|Nebula" app/lib/hooks/useTraySync.ts
```
Expected: no matches.

**Step 4: Strip VPN test cases from `useTraySync.test.tsx`**

Remove `describe`/`it` blocks that mock or assert VPN behavior. Use `rg "vpn|VPN" app/lib/hooks/__tests__/useTraySync.test.tsx -n` first to scope.

**Step 5: Hide `nebula_ip` rows in VM views**

In `app/components/vm/instance-details/networks-info.tsx`:
- Remove the `<InfoRow ... value={instanceData?.nebula_ip || "—"} />` row (~line 35).

In `app/components/vm/instance-details/virtual-machine-info.tsx`:
- Remove the three `nebula_ip: instanceData.nebula_ip` props passed to children (~lines 95, 114, 130).

Skim `instance-details/index.tsx`, `instances-table/instances-columns.tsx`, `instances-table/index.tsx` for stragglers; remove any.

Leave `nebula_ip: string | null` on the TypeScript types in `useVMInstances.ts:17` and `useVMInstanceDetails.ts:22` — server still returns the field.

**Step 6: Delete the directories and orphan files**

```bash
git rm -r app/components/dashboard-title-wrapper/vpn-menu/
git rm app/components/page-sections/settings/VPNSettings.tsx
git rm app/components/DemoIpfsUpload.tsx
```

**Step 7: Lint and typecheck**

```bash
pnpm lint
npx tsc --noEmit -p tsconfig.json
```

Expected: clean. If TS reports unresolvable imports anywhere else, grep:
```bash
rg "vpn-menu|VPNSettings|DemoIpfsUpload|vpnAtoms|VPNMenu|VPNSwitch|VPNStatusIndicator|VPNIconButton|VPNMenuContent" app/
```
Remove the offending references.

**Step 8: Run vitest**

```bash
pnpm test 2>&1 | tail -40
```

Expected: pass (minus the deleted VPN test cases).

**Step 9: Commit**

```bash
git add -A
git commit -m "chore: remove Nebula UI surfaces"
```

---

## Task 9: Prune historical doc + final sweep

**Files:**
- Delete: `docs/plans/2026-03-28-defer-nebula-permissions.md`

**Step 1: Delete the historical plan doc**

```bash
git rm docs/plans/2026-03-28-defer-nebula-permissions.md
```

**Step 2: Final repo-wide sweep**

```bash
rg -n "nebula|Nebula" src-tauri/src/ app/ | head -40
```

Expected matches (acceptable):
- `nebula_ip: string | null` in TS API types — leave as designed.

Anything else: investigate and remove or document why it stays.

```bash
rg -n "vpn|VPN" src-tauri/src/ app/ | head -40
```

Expected matches (acceptable):
- None ideally. If anything pops, evaluate.

**Step 3: Final build smoke**

```bash
SQLX_OFFLINE=true cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all -- -D warnings
SQLX_OFFLINE=true cargo test --manifest-path src-tauri/Cargo.toml
pnpm lint
npx tsc --noEmit -p tsconfig.json
pnpm test
```

Expected: all green (modulo pre-existing `files-table/index.tsx:959` lint warning).

**Step 4: Manual smoke test**

```bash
SQLX_OFFLINE=true pnpm tauri:dev
```

Verify:
1. **Splash:** "Checking for Updates" → "Launching App 🚀" → login screen. No Nebula text.
2. **Title bar:** No VPN icon next to BlockChainStats.
3. **Settings dialog:** No "VPN Settings" tab.
4. **Tray menu:** No "VPN: Turn On/Off" item.
5. **VM instance details:** Network info renders without a Nebula IP row; no console errors.
6. **Cmd+Q (macOS):** App exits immediately with no shutdown delay.
7. **Relaunch:** No errors in logs about missing tables. (Optional: `sqlite3 ~/.hippius/<account>/hippius.db ".tables"` — should not list `vpn_status`, `nebula_binary_status`, `nebula_certificate`, `autoconnect_vpn_enabled`.)

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: prune Nebula tests and historical plan doc"
```

---

## Task 10: Update CLAUDE.md references

**Files:**
- Modify: `CLAUDE.md` (project-level)
- Modify: `src-tauri/CLAUDE.md` (if Nebula mentioned)

**Step 1: Strip Nebula mentions from CLAUDE.md**

Per the project's coding rules ("update the CLAUDE.md"), remove:
- Project overview line: `It provides encrypted file sync, blockchain wallet management, VM provisioning, VPN (Nebula), and billing` → drop "VPN (Nebula),"
- The `nebula/` bullet under "Backend Structure (src-tauri/src/)"
- Any sub-state references mentioning `NebulaState` in Key Patterns "Global state in Rust"
- The "Permission escalation" paragraph if it's tied to Nebula only

Run `rg -n "Nebula|nebula|VPN|vpn" CLAUDE.md` to find every mention.

**Step 2: Lint pass**

```bash
pnpm lint
```

**Step 3: Commit**

```bash
git add CLAUDE.md src-tauri/CLAUDE.md
git commit -m "docs: strip Nebula references from CLAUDE.md"
```

---

## Wrap-up

After Task 10, push the branch and open the PR:

```bash
git push -u origin chore/remove-nebula
gh pr create --base sync-engine --title "chore: remove Nebula VPN feature" --body "$(cat <<'EOF'
## Summary
- Remove the Rust `nebula/` module and 13 Tauri IPC commands
- Remove all VPN UI surfaces (title-bar icon, settings tab, tray toggle, splash phases, VM nebula_ip row)
- Drop 4 legacy SQLite tables idempotently on startup
- Simplify splash to update-check + launch only

Stacked on `sync-engine`. Design doc: `docs/plans/2026-05-08-remove-nebula-vpn-design.md`.

## Test plan
- [x] `cargo check`, `cargo clippy --all -- -D warnings`, `cargo test`
- [x] `pnpm lint`, `tsc --noEmit`, `pnpm test`
- [x] Manual smoke: splash, title bar, settings, tray, VM details, Cmd+Q, relaunch
EOF
)"
```

---

## Notes for executor

- **Worktree-aware paths:** Every command assumes `cwd` is the worktree root unless explicitly `cd src-tauri`. Use absolute paths if running tools from elsewhere.
- **illu-first exploration:** Before reading any Rust file, query illu (`mcp__illu__context`, `mcp__illu__query`). Use Read only for config files and TS sources where illu coverage is thinner.
- **Line numbers drift:** The line numbers in this plan reflect the worktree state at design time. Re-grep before editing if a previous task in the sequence has shifted the file.
- **Per-task gates:** Don't skip the verify-compile / verify-tests step inside each task. The whole point of the per-commit ordering is that errors stay localized.
- **Rust discipline:** This plan is mostly deletion, not new Rust generation, so the `rust_preflight` / `axioms` / `quality_gate` flow is overhead here. The one new function (`drop_legacy_nebula_tables` in Task 6) is trivial enough that the discipline is satisfied by a brief docs read on `sqlx::SqlitePool::execute` if uncertain.
