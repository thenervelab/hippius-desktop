# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hippius Desktop is a Tauri 2.0 desktop application combining a Next.js 15 frontend with a Rust backend. It provides decentralized file sync with S3, IPFS, and Polkadot blockchain integration.

## Development Commands

```bash
# Install dependencies
pnpm install

# Frontend-only development (hot reload at localhost:3000)
pnpm dev

# Full desktop development (builds frontend, opens Tauri window)
pnpm tauri:dev

# Production builds
pnpm build          # Next.js static export to ./out
pnpm tauri:build    # Platform-specific desktop installers

# Linting
pnpm lint
```

## Testing

### Rust Integration Tests
```bash
cd src-tauri

# Run a specific test file
cargo test --test hippius_upload_only_s3_race

# Run all tests
cargo test
```

Key test files in `src-tauri/tests/`:
- `hippius_policy_harness.rs` - Base testing framework
- `hippius_upload_only.rs` - Conflict detection tests
- `hippius_upload_only_s3_race.rs` - S3 race condition tests
- `hippius_mirror_local_deletes.rs` - Mirror delete policy tests
- `hippius_restore_from_remote.rs` - Restore mode tests

### Frontend Tests
```bash
pnpm test   # Vitest
```

## Architecture

### Frontend (app/)
- **Framework**: Next.js 15 with App Router, React 19
- **State**: Jotai atoms (`app/lib/global-atoms/`)
- **Auth Context**: `app/lib/wallet-auth-context.tsx` - manages wallet/mnemonic auth
- **API Hooks**: `app/lib/hooks/api/` - 30+ TanStack Query hooks
- **UI**: Radix UI components, TailwindCSS
- **Config**: `app/lib/config.ts` - API endpoints and constants

### Backend (src-tauri/)
- **Entry Point**: `src/main.rs` - Tauri command registration
- **Sync Engine**: `src/sync_engine.rs` (89KB) - core sync logic with conflict detection
- **Commands**: `src/commands/` - Tauri IPC handlers
  - `ipfs_commands.rs` - IPFS operations
  - `accounts.rs` - encryption keys, account management
  - `syncing.rs` - sync control
  - `substrate_tx.rs` - blockchain transactions
- **S3 Client**: `src/utils/s3_client.rs` - AWS SDK integration
- **Database**: SQLite via SQLx (schema in `src/builder_blocks/setup/`)

### Frontend-Backend Communication
Frontend calls Rust via Tauri's `invoke()`:
```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { param: value });
```
Commands are registered in `main.rs` using `tauri::generate_handler![]`.

### Sync Architecture
Four deletion policies defined in sync engine:
- `UploadOnly` - never delete remote files
- `MirrorLocalDeletes` - delete remote when local deleted
- `RestoreFromRemote` - restore deleted local files from remote
- `LocalOnlyDeletes` - delete local files not in remote

Conflict detection uses CID (Content ID) and ETag comparison. See `CONFLICT_DETECTION_LOGIC.md` for detailed documentation.

## Key Files

| Purpose | Location |
|---------|----------|
| Tauri config | `src-tauri/tauri.conf.json` |
| Next.js config | `next.config.ts` |
| API endpoints | `app/lib/config.ts` |
| Auth state | `app/lib/wallet-auth-context.tsx` |
| Sync engine | `src-tauri/src/sync_engine.rs` |
| Test harness | `src-tauri/tests/hippius_policy_harness.rs` |

## Path Aliases

```typescript
@/* → ./*
@/components/* → ./app/components/*
@/lib/* → ./app/lib/*
@/services/* → ./app/lib/services/*
@/data/* → ./app/data/*
```

## Build Environment

- **Node**: v18+
- **pnpm**: v9.12.3+
- **Rust**: Edition 2024
- **SQLx**: Offline mode (SQLX_OFFLINE=true)
