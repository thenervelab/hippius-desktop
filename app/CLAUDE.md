# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Next.js 15 frontend for the Hippius Desktop Tauri app. React 19 with App Router, static export mode (`output: "export"`). Provides file sync management, wallet/billing, VM provisioning, VPN control, and blockchain integration.

## Development Commands

```bash
pnpm dev              # Dev server at localhost:3000
pnpm build            # Static export to ../out
pnpm lint             # ESLint
pnpm test             # Vitest
```

## Provider Hierarchy

Root layout (`layout.tsx`) wraps all pages in this order (outermost → innermost):

1. **`<Providers>`** (`components/providers/`) — TanStack Query, Jotai, PolkadotApiProvider, ParallaxProvider
2. **`<WalletAuthProvider>`** (`lib/wallet-auth-context.tsx`) — auth context, sync initialization
3. **`<UpdateChecker>`** — app auto-updater
4. **`<PreAuthProvider>`** (`components/auth/PreAuthProvider.tsx`) — billing auth after login
5. **`<NavigationLoaderProvider>`** — page transition state
6. **`<SplashWrapper>`** — splash screen on startup

## Authentication

Two auth modes managed by `WalletAuthProvider`:

- **Mnemonic login** (`login()`) — derives sr25519 keypair + Ethereum account from BIP-39 mnemonic, performs challenge-response auth via `authService`, then calls `tryAutoInitSync()` to start HCFS sync
- **OAuth** (`setOAuthSession()`) — Google/GitHub/Apple via `oAuthService.ts`, stores session in localStorage (`hippius_oauth_session`, `hippius_oauth_session_expiry`)

Session restoration on boot checks OAuth localStorage first, then falls back to mnemonic session from IndexedDB (`hippiusDesktopDB.ts`).

Key context values: `isAuthenticated`, `polkadotAddress`, `authType`, `oauthSession`, `walletManager.polkadotPair`, `sessionTimeRemaining`.

## State Management

| Layer | Tool | Location |
|-------|------|----------|
| Global UI state | Jotai atoms | `lib/global-atoms/`, `lib/store/syncAtoms.ts`, `components/sidebar/sideBarAtoms.ts` |
| Server/API state | TanStack Query | `lib/hooks/api/` (29 hooks) |
| Auth state | React Context | `lib/wallet-auth-context.tsx` |
| Blockchain connection | React Context | `lib/polkadot-api-context/` |
| File selection | React Context | `contexts/FileSelectionContext.tsx` |
| Local persistence | IndexedDB | `lib/helpers/hippiusDesktopDB.ts` (wallet, session, notifications, onboarding, address book) |

### Key Atoms

- `polkadotApiAtom` — `{ api, isConnected, blockNumber }`
- `unpinAtoms` — refetch triggers for unpinned files and sync paths
- `syncStatusAtom` / `syncPercentAtom` — sync progress state
- `trayUpdateInProgressAtom` / `lastTrayUpdateTimeAtom` — tray update coordination

## Backend Communication

All Rust commands called via Tauri IPC:
```typescript
import { invoke } from "@tauri-apps/api/core";
const result = await invoke("command_name", { param: value });
```

Sync events from Rust listened via Tauri event system:
```typescript
import { listen } from "@tauri-apps/api/event";
listen("hcfs_sync_completed", (event) => { ... });
```

File writes to disk use the Tauri FS plugin (not `invoke`):
```typescript
import { writeFile } from "@tauri-apps/plugin-fs";
```

## HCFS Sync Integration

Entry point: `lib/hooks/useHcfsSync.ts`

- **`tryAutoInitSync(accountId, mnemonic?)`** — exported standalone function (not a hook), called from `WalletAuthProvider` after login. Reads HCFS config from DB, calls `initialize_sync` Rust command.
- **`useHcfsSync()`** — hook for UI with `setupAndInitialize()` (first-time setup with server URL + password), `checkConfig()`, and `mnemonicToBackup` state.
- **`useSyncEvents()`** — listens to 5 Tauri events: `hcfs_sync_started`, `hcfs_sync_completed`, `hcfs_sync_error`, `hcfs_upload_progress`, `hcfs_download_progress`. Returns `isSyncing`, `uploadProgress`, `downloadProgress`, `lastOutcome`, `lastError`.
- **`useSyncActivity()`** — polls `get_sync_activity` command every 3 seconds, returns formatted activity rows.

Config utilities in `utils/hcfsConfigUtils.ts` and `utils/syncPathUtils.ts`.

## Routing

```
app/
├── layout.tsx                    # Root layout (providers, auth, splash)
├── login/page.tsx                # Login page (redirects if authenticated)
├── auth/callback/page.tsx        # OAuth callback handler
└── (pages)/                      # Authenticated routes
    ├── layout.tsx                # Sidebar + OnBoardingGuard wrapper
    ├── page.tsx                  # Dashboard (/)
    ├── files/page.tsx            # File manager (supports ?folder= param)
    ├── wallet/page.tsx
    ├── billing/page.tsx
    ├── billing/plans/page.tsx
    ├── stake/page.tsx
    ├── unstake/page.tsx
    ├── bridge/page.tsx
    ├── referrals/page.tsx
    ├── tokens/page.tsx
    ├── notifications/page.tsx
    ├── support/page.tsx
    └── vm/
        ├── page.tsx              # VM list
        ├── create/page.tsx       # VM creation wizard
        └── instance-details/page.tsx
```

The `(pages)` layout wraps content with `<Sidebar>` and `<OnBoardingGuard>` (forces onboarding completion for new users).

## Component Organization

```
components/
├── auth/           # LoginForm, OAuthButtons, AccessKeyLoginForm, onboarding/
├── sidebar/        # Sidebar, NavItem, NavData (route definitions)
├── page-sections/  # Per-page content: files/, home/, wallet/, settings/, billing/,
│                   # stake-bridge/, vm/, notifications/, referrals/, support/, etc.
├── ui/             # 50+ shared UI components (Radix-based + custom)
├── providers/      # Root Providers wrapper
├── splash-screen/  # Splash screen with animations
├── updater/        # Auto-update checker + dialogs
├── tray/           # System tray navigation listener
├── vm/             # VM create wizard, instances table, SSH keys
└── dashboard-title-wrapper/  # Page header with notifications + VPN menu
```

## Helpers & Services

**`lib/helpers/`**:
- `hippiusDesktopDB.ts` — IndexedDB for wallet records, sessions, notifications, onboarding state
- `sessionStore.ts` — session save/get/clear, API auth token storage
- `crypto.ts` — mnemonic encryption/decryption with passcode
- `validateMnemonic.ts` — BIP-39 validation
- `notificationsDb.ts`, `addressBookDb.ts`, `onboardingDb.ts` — specialized DB schemas

**`lib/services/`**:
- `authService.ts` — challenge-response auth (`requestChallenge`, `verifySignature`, `getSession`)
- `oAuthService.ts` — OAuth flow for Google/GitHub/Apple

**`utils/`** (50+ files):
- `syncPathUtils.ts` — sync folder path getters/setters via Tauri invoke
- `hcfsConfigUtils.ts` — HCFS config save/get/initialize via Tauri invoke
- `downloadFile.ts`, `downloadFolder.ts` — file export from sync folder
- `fileTypeUtils.ts`, `fileFilterUtils.ts` — file type detection and filtering
- `formatBytes.ts` — size formatting
- `ipfsUrlResolver.ts` — IPFS gateway URL generation
- `cn.ts` — Tailwind `clsx`/`twMerge` utility
- `tauri.ts` — Tauri environment detection

## Path Aliases (tsconfig.json)

```
@/*            → ./*
@/components/* → ./app/components/*
@/lib/*        → ./app/lib/*
@/services/*   → ./app/lib/services/*
@/data/*       → ./app/data/*
@/config/*     → ./app/config/*
```

## API Configuration

All API endpoints defined in `lib/config.ts`:
- `API_CONFIG.baseUrl` — `https://api.hippius.com`
- `IPFS_GATEWAY` — `https://relay-fr.hippius.network`
- `S3_ENDPOINT` — `https://s3.hippius.com`
- `HCFS_CONFIG.defaultServerUrl` — `https://57.129.36.43:9999`

## Patterns & Conventions

- **UI components** built on Radix UI primitives with TailwindCSS styling
- **Toast notifications** via Sonner (`sonner` package), positioned bottom-right
- **Page sections** in `components/page-sections/<feature>/` — each page delegates to a section component
- **API hooks** follow pattern: `use<Resource>` returning TanStack Query result, defined in `lib/hooks/api/`
- **File uploads**: Browser File → `writeFile` (Tauri FS plugin) → `add_file` Tauri command → hcfs-client auto-syncs
- **Tray menu** (`useTraySync.ts`, 1000+ lines) — dynamically built system tray with VPN toggle, sync status, recent activity; auto-updates every 2-3 seconds

## Gotchas

- `get_sync_path` is called with `isPublic: true` as legacy convention — HCFS encrypts all files uniformly, public/private distinction is deprecated
- `useTraySync.ts` is ~1100 lines — tray menu is rebuilt on every state change
- `hippiusDesktopDB.ts` appears in both `lib/helpers/` and `utils/` — the helpers version is the primary one
- Polkadot API context has exponential backoff reconnection (100ms–5000ms with jitter)
- Session timeout uses chunked `setTimeout` to handle delays > 24.8 days (`MAX_DELAY = 2_147_483_647`)
