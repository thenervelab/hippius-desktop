# Remove Nebula VPN from Hippius Desktop

**Date:** 2026-05-08
**Status:** Design approved, ready for implementation
**Scope:** Full delete — no feature flag, no dormant code

## Goal

Remove every Nebula/VPN surface from Hippius Desktop in a single PR. Users see no VPN UI; the Rust `nebula/` module is gone; legacy SQLite tables are dropped on next launch.

## What disappears

### Backend (Rust, ~2,700 LOC)

- `src-tauri/src/nebula/` module (`manager.rs`, `vpn.rs`, `state.rs`, `mod.rs`)
- 13 Tauri IPC commands: `get_nebula_ip`, `get_nebula_stats`, `get_nebula_status`, `get_nebula_binary_installed_status`, `get_vpn_status`, `toggle_vpn_status`, `get_autoconnect_status`, `toggle_autoconnect_status`, `check_nebula_requirements`, `download_nebula`, `install_nebula`, `verify_nebula`, `setup_nebula_background`. (`finish_setup` is replaced, not removed — see below.)
- `AppError::Nebula(..)` variant + its tests
- `AppState.nebula` (`NebulaState`) and `AppState.nebula_stopped` (`AtomicBool`)
- The `RunEvent::ExitRequested` deferred-exit handler in `main.rs` that stops Nebula then re-requests exit
- Startup blocks in `main.rs`: `vpn_status` reset, autoconnect query, `stop_nebula`-on-startup, `verify_nebula_setup`
- 4 SQLite tables (one-shot dropped at next launch): `vpn_status`, `nebula_binary_status`, `nebula_certificate`, `autoconnect_vpn_enabled`

### Frontend (TS)

- `app/components/dashboard-title-wrapper/vpn-menu/` directory (5 files + atoms)
- `<VPNMenu />` mount in `BlockChainStats.tsx`
- `app/components/page-sections/settings/VPNSettings.tsx` and its tab in `SettingsDialogContent.tsx`
- VPN bits in `app/lib/hooks/useTraySync.ts` (toggle menu item, helper functions, `vpnConnectedAtom` subscription) and matching tests in `useTraySync.test.tsx`
- 4 Nebula phases in `app/components/splash-screen/SplashContent.tsx` (`checking_nebula`, `downloading_nebula`, `installing_nebula`, `verifying_nebula`)
- `nebula_ip` row in VM views (`networks-info.tsx`, `virtual-machine-info.tsx`)
- `app/components/DemoIpfsUpload.tsx` (orphan, only consumer is Nebula commands)

### Docs

- `docs/plans/2026-03-28-defer-nebula-permissions.md`

## What stays

- **Splash screen, simplified:** `check_updates` phase + final "Launching App" beat. A new minimal `finish_setup` command (no Nebula auto-start) replaces the old one.
- **`nebula_ip` field on TS API types** (`useVMInstances.ts`, `useVMInstanceDetails.ts`): the remote VM API still returns it. Hide the row in UI; leave the typed field.

## Database cleanup strategy

Add `drop_legacy_nebula_tables(pool)` to `src-tauri/src/utils/schema.rs`, called once from `ensure_table_schema()` (or its caller) before the rest of schema bring-up. Idempotent via `DROP TABLE IF EXISTS`. Existing users' rows are deleted irreversibly — acceptable because the tables hold only status flags, no encryption keys or user data.

```rust
async fn drop_legacy_nebula_tables(pool: &SqlitePool) -> Result<(), sqlx::Error> {
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

Mark with a TODO to remove the helper itself after a few releases — otherwise it becomes vestigial.

## Implementation order

Each commit must compile and pass lint. The Rust delete fans out from `main.rs` registrations toward the module itself; the TS delete fans out from outermost mounts toward the directories.

1. **`feat: add splash finish_setup placeholder command`** — new `src-tauri/src/splash.rs` with a no-op `finish_setup`, registered in `main.rs` alongside the existing Nebula one.
2. **`refactor: point splash at non-Nebula finish_setup`** — `SplashContent.tsx` references the new command.
3. **`chore: remove Nebula IPC commands and shutdown handler`** — delete the 13 IPC registrations, the `RunEvent::ExitRequested` Nebula branch, and the startup blocks.
4. **`chore: remove NebulaState from AppState and AppError::Nebula`** — drop fields, imports, error variant, and the `display_nebula_error` test.
5. **`chore: delete src-tauri/src/nebula module`** — `pub mod nebula;` line and the directory. `cargo build && cargo test && cargo clippy --all -- -D warnings`.
6. **`chore: drop legacy Nebula SQLite tables on startup`** — add `drop_legacy_nebula_tables`, remove the 4 entries from `EXPECTED_TABLES`, the 4 schema definitions, and the 3 seed inserts.
7. **`chore: simplify splash to update-check + launch only`** — strip the 4 Nebula phases from `SplashContent.tsx`.
8. **`chore: remove Nebula UI surfaces`** — title-bar icon, settings tab, tray VPN bits, VM `nebula_ip` rows, `vpn-menu/` directory, `DemoIpfsUpload.tsx`.
9. **`chore: prune Nebula tests and historical plan doc`** — VPN-specific test cases in `useTraySync.test.tsx`, `docs/plans/2026-03-28-defer-nebula-permissions.md`.
10. **Final pass:** `pnpm lint && tsc --noEmit && pnpm tauri:build` smoke + manual smoke (below).

## Verification

### Build gates

- `cd src-tauri && cargo check`
- `cargo clippy --all -- -D warnings`
- `cargo test`
- `cargo fmt --all`
- `pnpm lint`
- `tsc --noEmit`
- `pnpm tauri:build`

### Manual smoke

1. **Fresh install (macOS):** launch → splash shows update check + launch beat only → login works → no VPN icon in title bar → no VPN tab in settings → tray menu has no VPN toggle.
2. **Upgrade install:** launch once → 4 legacy tables dropped → app functions → relaunch → no errors, no table re-creation.
3. **VM details page:** instance loads, network info renders without the Nebula IP row, no console errors.
4. **Logout/login cycle:** no shutdown delay (deferred-exit Nebula dance is gone).

## Risks

- **Faster shutdown** is a behavior change. Nothing else in `AppState` currently requires async cleanup at exit, so the early-exit path needs no replacement guard. Confirm during smoke.
- **DB drop is irreversible.** If a user rolls back to an older binary, the old binary will recreate empty tables via existing `INSERT OR IGNORE` seeds. No data corruption — defaults restored.
- **Splash flicker** possible with only 2 phases on cold start. Flag if seen; not in scope for this PR.
- **Tray test coverage drops** in `useTraySync.test.tsx` — acceptable, the code under test is gone.

## Out of scope

- Cleaning up the VM API server contract (`nebula_ip` field on the wire).
- Release notes / changelog updates.
