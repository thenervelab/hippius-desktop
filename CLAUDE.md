# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hippius Desktop is a Tauri 2.0 desktop application combining a Next.js 15 frontend with a Rust backend. It provides decentralized file sync (via hcfs-client), IPFS monitoring, Polkadot blockchain integration, VPN management (Nebula), and VM provisioning.

## Development Commands

```bash
pnpm install                  # Install dependencies
pnpm dev                      # Frontend dev server (localhost:3000)
pnpm tauri:dev                # Full desktop dev (builds frontend + opens Tauri window)
pnpm build                    # Next.js static export to ./out
pnpm tauri:build              # Platform-specific desktop installers
pnpm lint                     # Lint frontend
pnpm test                     # Frontend tests (Vitest)
```

### Rust Backend

```bash
cd src-tauri
cargo build                   # Build backend
cargo test                    # Run all Rust tests
cargo test --test <name>      # Run specific test file
cargo clippy -- -D warnings   # Lint Rust code
```

**Note**: `SQLX_OFFLINE=true` is required for building (uses offline SQLx mode).

## Architecture

### Frontend (app/)

- **Framework**: Next.js 15 with App Router, React 19, static export (`output: "export"`)
- **State**: Jotai atoms (`app/lib/global-atoms/`)
- **Data Fetching**: TanStack Query hooks (`app/lib/hooks/api/` — 30+ hooks)
- **Auth**: `app/lib/wallet-auth-context.tsx` — mnemonic-based challenge auth + OAuth (Google/GitHub/Apple)
- **UI**: Radix UI components, TailwindCSS
- **API Config**: `app/lib/config.ts` — all API endpoints and constants

**Key routes** (`app/(pages)/`): dashboard, files, wallet, billing, stake, bridge, referrals, tokens, vm (create/instance-details), support, notifications.

### Backend (src-tauri/)

- **Entry Point**: `src/main.rs` — all Tauri commands registered via `tauri::generate_handler![]`
- **HCFS Drive**: `src/hcfs_drive.rs` — wrapper around hcfs-client `Drive`, manages global `HCFS_DRIVE` instance, file watcher (notify crate), and sync loop (30s heartbeat, 5s debounce)
- **Sync State**: `src/sync_shared.rs` — shared cancellation token and sync status
- **Blockchain Tracking**: `src/user_profile_sync.rs` — tracks files on-chain via `user_profiles`/`file_paths` DB tables
- **Commands**: `src/commands/` — Tauri IPC handlers:
  - `syncing.rs` — initialize/stop/trigger sync, save/get HCFS config
  - `file_commands.rs` — add/remove/list/export files
  - `accounts.rs` — account management, import/export, reset
  - `substrate_tx.rs` — blockchain transactions (balance transfers, sync path)
  - `objectstore_auth.rs` — S3 auth token management
  - `indexer.rs`, `vpn_enabled.rs`, `types.rs`

### Frontend-Backend Communication

Frontend calls Rust via Tauri's `invoke()`:
```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { param: value });
```

### HCFS Sync Architecture

The old S3/CAS/manifest sync engine has been **fully replaced** by hcfs-client. Key points:

- **hcfs-client** handles all sync, encryption (BIP-39 mnemonic), and file operations
- Single global `HCFS_DRIVE` instance (`Arc<Mutex<Option<HcfsDriveManager>>>`)
- File watcher triggers sync on local changes (5s debounce)
- Heartbeat sync every 30 seconds
- All files encrypted — no public/private separation at HCFS level
- Events emitted: `hcfs_sync_started`, `hcfs_sync_completed`, `hcfs_sync_error`, `hcfs_upload_progress`, `hcfs_download_progress`, `hcfs_encrypt_progress`, `hcfs_decrypt_progress`, `hcfs_scan_progress`, `hcfs_fetch_progress`
- Frontend listens via `useSyncEvents` hook

### VPN/Nebula Integration

Managed entirely through Tauri commands: download, install, verify, start, stop Nebula. Status tracked in SQLite (`vpn_status`, `nebula_binary_status`, `nebula_certificate` tables).

### Database (SQLite via SQLx)

Schema defined in `src/builder_blocks/setup/`. Key tables: `hcfs_config`, `sync_paths`, `objectstore_auth`, `vpn_status`, `nebula_*`, `sub_accounts`, `wss_endpoint`, `security_scoped_bookmarks` (macOS).

## Key Files

| Purpose | Location |
|---------|----------|
| Tauri config | `src-tauri/tauri.conf.json` |
| Next.js config | `next.config.ts` |
| API endpoints & constants | `app/lib/config.ts` |
| Auth state & session mgmt | `app/lib/wallet-auth-context.tsx` |
| HCFS Drive wrapper | `src-tauri/src/hcfs_drive.rs` |
| Command registration | `src-tauri/src/main.rs` |
| DB schema setup | `src-tauri/src/builder_blocks/setup/` |
| Sync event listener | `app/lib/hooks/useSyncEvents.ts` |

## Path Aliases (tsconfig.json)

```
@/*            → ./*
@/components/* → ./app/components/*
@/lib/*        → ./app/lib/*
@/services/*   → ./app/lib/services/*
@/data/*       → ./app/data/*
@/config/*     → ./app/config/*
```

## Build Environment

- **Node**: v18+ (use `nvm use 18` if needed)
- **pnpm**: v9.12.3+
- **Rust**: Edition 2024
- **hcfs-client**: Git dependency from `ssh://git@github.com/thenervelab/hcfs.git` (pinned rev)
- **SQLx**: Offline mode (`SQLX_OFFLINE=true`)
- `src-tauri/.env` must exist (bundled as Tauri resource, loaded via dotenvy)

## Gotchas

- `src-tauri/src/lib.rs` is a vestigial Tauri template file — actual app entry is `main.rs`
- `user_profile_sync.rs` uses `user_profiles`/`file_paths` DB tables for blockchain file tracking — separate from HCFS sync
- Old sync engine test files (`src-tauri/tests/hippius_*.rs`) were removed during hcfs-client migration
- The deep-link scheme is `hippiusapp://`
