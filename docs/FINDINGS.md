# Architecture Findings: Frontend Logic That Should Be in Rust

> Audit Date: 2026-03-11
> Branch: sync-engine

## Overview

A huge amount of business logic, security-sensitive operations, and API communication lives in JavaScript instead of Rust. This document catalogs every instance, organized by severity.

---

## CRITICAL: Cryptographic Operations in JavaScript

**Files:** `app/lib/wallet-auth-context.tsx`, `app/lib/services/authService.ts`, `app/lib/helpers/crypto.ts`

The most dangerous issue — **private keys and mnemonics live in JavaScript memory**:

- BIP-39 mnemonic derived into sr25519 keypair via `@polkadot/keyring` in the browser
- Ethereum account derived from mnemonic via `viem/accounts.mnemonicToAccount()`
- Challenge-response auth (request challenge → sign → verify) runs entirely in JS
- Mnemonic held in `sessionMnemonicRef` (a React ref) for the entire session
- Passcode encryption uses `CryptoJS.AES` — the mnemonic is AES-encrypted and stored in IndexedDB
- Silent token refresh re-derives the mnemonic → Ethereum account → signs new challenge, all in JS

**What Rust should do:** All key derivation, signing, and mnemonic handling should happen in Rust. The frontend should only ever send a passcode to Rust and get back a "success/fail" — never touching key material.

---

## CRITICAL: Blockchain Transactions Signed in Browser

**Files:** `app/lib/hooks/useStaking.ts`, `app/components/page-sections/wallet/SendBalanceDialog.tsx`

- Staking operations (`bond`, `unbond`, `withdrawUnbonded`, `nominate`) call `tx.signAndSend(walletManager.polkadotPair)` directly in React hooks
- Balance transfers construct and sign extrinsics in the browser
- Amount conversions (`toPlancks()`) happen client-side with no backend validation
- The polkadot keypair is a JS object accessible to any code running in the webview

**What Rust should do:** Expose Tauri commands like `stake_bond(amount)`, `transfer_balance(dest, amount)` that handle signing internally. The frontend sends the intent, Rust signs and submits.

---

## HIGH: 30+ Direct HTTP API Calls from Frontend

**Location:** `app/lib/hooks/api/` (30+ files), `app/lib/services/authService.ts`, `app/lib/services/oAuthService.ts`

The frontend makes direct `fetch()` calls to your backend API for essentially everything outside of sync:

| Category | Endpoints | Example Hooks |
|----------|-----------|---------------|
| VM Management | 12 endpoints | `useCreateVM`, `useVMInstances`, `useStartVM`, `useStopVM`, `useRebootVM`, `useTerminateVM` |
| Billing & Credits | 11 endpoints | `useCredits`, `useBillingTransactions`, subscription management |
| SSH Keys | 6 endpoints | `useSSHKeys`, `useCreateSSHKey`, `useDeleteSSHKey` |
| S3 / Object Store | 9 endpoints | `useApiBuckets`, bucket CRUD, object CRUD |
| Auth | 4+ endpoints | Challenge-response, OAuth token exchange |
| Referrals | 3 endpoints | `useReferralLinks`, `useUserReferrals` |
| Notifications | 2 endpoints | `useNotificationSettings` |
| User Profile | 2 endpoints | Profile metadata |

**Problems:**
- Auth tokens passed in JS `Authorization` headers — any XSS can steal them
- No request signing or HMAC validation (the HMAC_SECRET is **hardcoded in `config.ts`** line 68 — defeating its purpose)
- Business logic like pagination, filtering, error handling scattered across 30 hooks
- Token management duplicated everywhere

**What Rust should do:** Every API call should be a Tauri command. Rust holds the auth token, makes HTTP requests, and returns typed data. The frontend never sees raw tokens.

---

## HIGH: Secrets & Tokens in Browser Storage

**Files:** `app/lib/wallet-auth-context.tsx`, `app/lib/helpers/sessionStore.ts`, `app/lib/helpers/hippiusDesktopDB.ts`

Sensitive data scattered across multiple browser storage mechanisms:

| Storage | What's Stored |
|---------|--------------|
| `localStorage` | OAuth session (token, provider, user info), token expiry, sync engine stopped state |
| `sessionStorage` | OAuth PKCE state, redirect URLs |
| IndexedDB (sql.js) | Encrypted mnemonic, passcode hash, auth token, token expiry, userId |

- The auth token exists in **3 places** simultaneously (localStorage, IndexedDB, in-memory)
- `localStorage` is trivially readable by any JS in the webview
- Encrypted mnemonic + passcode hash are both in IndexedDB — compromise one, compromise both

**What Rust should do:** Use the OS keychain (via Tauri's secure storage or `keyring` crate) for all sensitive data. No tokens or encrypted keys in browser storage.

---

## HIGH: Hardcoded Secret in Source Code

**File:** `app/lib/config.ts:68`

```typescript
HMAC_SECRET: "X5Ppyz3aMHw3PVFitlA587TiingYrB3R",
```

A shared HMAC secret is hardcoded in frontend code. Anyone can read it from the bundle. This should be in the Rust backend (loaded from `.env`), and HMAC signing should happen server-side.

---

## MEDIUM: Polkadot RPC Connection Managed in Frontend

**Files:** `app/lib/polkadot-api-context/index.tsx`, `app/lib/hooks/api/useHippiusBalance.ts`

- WebSocket connection to `wss://rpc.hippius.network` created and managed in React context
- Block header subscription, reconnect logic, grace periods — all in JS
- Balance queries, staking info queries (10+ sequential `api.query` calls), referral lookups — all from React hooks
- Block timestamp caching in `blockTimestampUtils.ts`

**What Rust should do:** Manage the Substrate connection in Rust using `subxt` or similar. Expose queries as Tauri commands. The frontend already gets the WSS endpoint from Rust (`get_wss_endpoint`) but then connects from JS anyway.

---

## MEDIUM: OAuth PKCE Flow in Frontend

**File:** `app/lib/services/oAuthService.ts` (406 lines)

Full PKCE implementation in JavaScript:
- Code verifier generation (43 chars, `Math.random()`-based — not cryptographically secure)
- SHA-256 challenge derivation
- PKCE state stored in `sessionStorage`
- Token exchange via `axios.post()` from browser

**What Rust should do:** Generate PKCE verifier/challenge in Rust (using proper CSPRNG), handle the callback, exchange the code server-side, and store the token securely.

---

## MEDIUM: Sync Progress Tracked in localStorage

**File:** `app/lib/services/syncProgressService.ts` (999 lines!)

A nearly 1000-line service that:
- Generates session IDs with `Math.random()` (weak)
- Tracks per-file upload/download progress in localStorage JSON
- Manages "recent files" with 1-hour expiry, cleaned up every 60 seconds
- Calculates overall sync percentage

Meanwhile, Rust already has `get_sync_activity` returning a ring buffer of recent transfers. This is duplicated effort.

**What Rust should do:** Maintain all sync progress state. The frontend should just query it or receive events.

---

## MEDIUM: Frontend Polling Instead of Events

Several hooks poll Rust commands on tight intervals instead of using Tauri's event system:

| Hook | Interval | Command |
|------|----------|---------|
| `useSyncActivity` | 3 seconds | `get_sync_activity` + `get_sync_engine_health` |
| `useHippiusBalance` | 30 seconds | Polkadot RPC query |
| `useVMInstances` | 30 seconds | HTTP API call |
| `useAddCreditEvent` | 30 seconds | HTTP API call |

**What Rust should do:** Push events when state changes rather than requiring constant polling.

---

## MEDIUM: Dual Database Systems

The app runs **two separate SQLite databases**:

1. **Rust-side:** `~/.hippius/hippius.db` (via SQLx) — sync paths, HCFS config, VPN state, etc.
2. **Frontend-side:** IndexedDB-backed sql.js database — wallet, sessions, auth tokens

This is confusing and fragile. The sql.js database has its own write queue (`dbWriteQueueAtom`) to prevent clobbering, migrations for adding auth columns, etc.

**What Rust should do:** Consolidate everything into the Rust SQLite database. The frontend sql.js DB should not exist.

---

## LOW: IPFS Stubs Returning Mock Data

**Commands:** `get_ipfs_node_info`, `get_ipfs_bandwidth`, `get_ipfs_peers`

These Rust commands return hardcoded mock data. The frontend renders graphs from it. Either implement them or remove the dead code.

---

## Summary: What Should Move to Rust

| Priority | What | Current Location | Lines of JS |
|----------|------|-----------------|-------------|
| **Critical** | Key derivation, signing, mnemonic handling | wallet-auth-context.tsx, crypto.ts | ~300 |
| **Critical** | Blockchain transaction signing | useStaking.ts, SendBalanceDialog | ~400 |
| **High** | All HTTP API calls (30+ hooks) | app/lib/hooks/api/ | ~2000+ |
| **High** | Auth token storage & management | sessionStore.ts, hippiusDesktopDB.ts | ~500 |
| **High** | Challenge-response auth flow | authService.ts | ~315 |
| **Medium** | Polkadot RPC connection & queries | polkadot-api-context, hooks | ~500 |
| **Medium** | OAuth PKCE flow | oAuthService.ts | ~406 |
| **Medium** | Sync progress tracking | syncProgressService.ts | ~999 |
| **Medium** | Session timeout logic | sessionStore.ts | ~270 |
| **Low** | IPFS mock data | 3 Rust stubs | N/A |

**Total: ~5,700+ lines of business logic that should be in Rust.**

After migration, the frontend should be a thin UI layer: render data from Tauri commands, send user intents back as commands, and listen to events for real-time updates. No tokens, no keys, no HTTP calls, no crypto.
