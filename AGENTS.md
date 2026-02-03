# Hippius Desktop - AI Coding Instructions

## Architecture Overview

Hippius is a **Tauri 2.0 desktop app** combining a Next.js 15 frontend with a Rust backend. It's a decentralized storage and sync client connecting to IPFS nodes and a Substrate-based blockchain.

```
Frontend (Next.js 15, React 19)  ←→  Tauri IPC  ←→  Rust Backend
         ↓                                              ↓
      Polkadot API                             S3-compatible Storage
      (blockchain)                             IPFS Gateway
```

### Key Service Boundaries

- **Frontend** (`app/`): UI, state management (Jotai), blockchain API via `@polkadot/api`
- **Rust Backend** (`src-tauri/src/`): File sync engine, encryption, S3/IPFS operations
- **Tauri Commands**: Bridge between frontend/backend via `invoke()` calls

## Critical Patterns

### Frontend-Backend Communication

All Rust functions exposed to frontend use `#[tauri::command]` and are called via:

```typescript
import { invoke } from "@tauri-apps/api/core";
await invoke("command_name", { param1: value });
```

Commands are registered in [src-tauri/src/main.rs](src-tauri/src/main.rs) via `invoke_handler`.

### State Management

- **Jotai atoms** for global state: See [app/lib/global-atoms/](app/lib/global-atoms/)
- **React Query** (`@tanstack/react-query`) for API data fetching
- **Polkadot API** context: [app/lib/polkadot-api-context/](app/lib/polkadot-api-context/) manages blockchain connection
- **Wallet auth**: [app/lib/wallet-auth-context.tsx](app/lib/wallet-auth-context.tsx) handles authentication (mnemonic or OAuth)

### Sync Engine Architecture

The sync engine in Rust implements multiple delete policies defined in [src-tauri/src/sync_engine.rs](src-tauri/src/sync_engine.rs):

- `MirrorLocalDeletes`: Remote mirrors local deletions
- `RestoreFromRemote`: Deleted files restored from remote
- `LocalOnlyDeletes`: Remote acts as backup
- `UploadOnly`: No downloads, conflicts renamed

### File Organization

- `app/(pages)/` - Route-based pages with protected layout
- `app/components/ui/` - Reusable UI components using CVA + Tailwind
- `app/lib/hooks/` - Custom hooks for data fetching and state
- `src-tauri/src/commands/` - Rust commands organized by domain

## Development Commands

```bash
pnpm dev            # Next.js dev server only (web preview)
pnpm tauri dev      # Full desktop app with hot reload
pnpm tauri build    # Production build with installers
cargo test --test hippius_policy_harness  # Run sync policy tests
```

### Testing Sync Policies

Integration tests in `src-tauri/tests/` use a Docker-based S3 mock. See [hippius_policy_harness.rs](src-tauri/tests/hippius_policy_harness.rs) for test setup patterns.

## Code Conventions

### TypeScript/React

- Use `"use client"` directive for client components
- Prefer Jotai atoms over React Context for cross-component state
- UI components use `cva` (class-variance-authority) for variant styling
- Hooks in `app/lib/hooks/` follow `use{Feature}` naming

### Rust

- Commands return `Result<T, String>` for error handling via Tauri
- Use `tokio` for async operations
- Database access via `sqlx` with SQLite (local storage)
- Encryption uses `sodiumoxide` (libsodium bindings)

### Styling

- Tailwind CSS with custom design tokens in [tailwind.config.ts](tailwind.config.ts)
- Custom colors: `grey-*`, `primary-*`, `error-*` scales
- Component styles may use CSS modules alongside Tailwind

## External Integrations

| Service     | Config Location                                             | Purpose               |
| ----------- | ----------------------------------------------------------- | --------------------- |
| Hippius API | [app/lib/config.ts](app/lib/config.ts)                      | Backend API endpoints |
| S3 Storage  | `STORAGE_S3_CONFIG` in config.ts                            | File storage          |
| Blockchain  | WSS endpoint stored in Rust, fetched via `get_wss_endpoint` | Substrate chain       |
| IPFS        | `IPFS_NODE_CONFIG` (localhost:5001)                         | Local IPFS node       |

## Important Notes

- **Static Export**: Next.js configured for `output: "export"` for Tauri compatibility
- **Deep Links**: App handles `hippiusapp://` URLs for OAuth callbacks
- **Local DB**: SQLite database managed via `@tauri-apps/plugin-fs` and `sql.js` (frontend) + `sqlx` (Rust)
- **Version Sync**: Keep `package.json` and `src-tauri/Cargo.toml` versions aligned
