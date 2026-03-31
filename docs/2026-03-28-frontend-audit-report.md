# Frontend Audit Report — Hippius Desktop (Verified + Impact Analyzed)

**Date:** 2026-03-28
**Branch:** sync-engine
**Scope:** Full frontend review (`app/` directory) — structure, IPC alignment, state management, TypeScript quality, error handling, UI consistency, routing, dead code
**Verification:** Each finding verified against source code; false positives removed; impact analysis completed for all proposed fixes

---

## Executive Summary

The frontend is a ~704-file Next.js 15 + Tauri 2.0 application with 13 route pages, 200+ components, 80+ hooks, and 40+ Jotai atoms. Architecture is sound — component organization is clear, Radix UI is consistent, Tailwind design system is well-structured.

**50 initial findings → 43 validated → 27 actionable fixes assessed for safety.**

---

## Fix Safety Matrix

### SAFE — No Risk (can proceed immediately)

| # | Fix | Impact | Evidence |
|---|-----|--------|----------|
| 1 | Add React ErrorBoundary to `(pages)` layout | Purely additive. Works alongside `app/error.tsx`. No component relies on errors propagating past layout. | No `error.tsx` in `(pages)` dir; ErrorBoundary catches before Next.js boundary. |
| 13 | Delete `DemoIpfsUpload.tsx` | Zero references. Only a commented-out `{/* <NebulaTest /> */}` in home/index.tsx. Not in tests, config, or storybook. | Grep confirmed: 0 active imports across entire repo. |
| 14 | Delete commented debug code in `LoginForm.tsx` (lines 28-50) | No uncommented code references `dlRaw`, `dlLogs`, `dlParsed`, `addDlLog`. Comments stripped at build time. | Variable name grep: 0 uncommented references. |
| 15 | Remove commented imports in `wallet/index.tsx` (lines 6-7) | `StakeWidget` and `BridgeWidget` are commented out. Removing comments has zero runtime effect. | Files still exist but aren't imported anywhere. |
| 31 | Remove unused `mnemonic` from `WalletBalanceWidget` + `SendBalanceDialog` | `const mnemonic = ""` never changes. Passed to `SendBalanceDialog` but never destructured or used. Not passed to children. Only 1 caller. | `SendBalanceDialog` interface declares `mnemonic?` but function signature doesn't destructure it. |
| 32 | Remove commented `handleViewRewards` in `StakeWidget.tsx` | Dead commented code (lines 23-27). | No uncommented references. |
| 34 | Extract hardcoded URLs to `app/lib/constants/urls.ts` | Same URLs in `LoginForm.tsx:311,318` and `AccessKeyLoginForm.tsx:180,189`. Constants file exists, just missing these 2. | `URLS` object already has 12 entries. Add `TERMS_AND_CONDITIONS` and `PRIVACY_POLICY`. |
| 35 | Replace raw `rgb(247, 245, 245)` in `globals.css:167` | Standard scrollbar-thumb color. Not in gradient/animation context. Replace with `rgb(var(--grey-90))`. | CSS variables work in this property. |
| 17 | Add `.d.ts` for `window.__hippiusVpnWatcher` and `__hippiusSyncWatcher` | Type-only change. Create `app/lib/types/window.d.ts`. Eliminates 4 `@ts-expect-error` in `useTraySync.ts`. | No existing `global.d.ts`. Properties only used in `useTraySync.ts`. |
| 29 | Centralize TanStack Query key constants | All 30+ hooks use consistent patterns (static arrays or factory functions). Moving to `queryKeys.ts` doesn't change key shapes or invalidation behavior. | No dynamically generated keys that would break. |
| 42 | Reduce VPN polling from 2s to 5s | `VPNStatusIndicator` only mounts when VPN menu is open AND VPN is connected. `get_nebula_stats` returns cumulative byte counters — 2s is overkill. No other component depends on the refresh rate. Cleanup exists. | Component is conditionally rendered inside `VPNMenuContent`. |
| 20 | Add `.catch()` to clipboard promise chains | `CopyableText.tsx`, `DetailsCard.tsx`, `ReferralLinkaCard.tsx` — clipboard `.then()` without `.catch()`. Adding `.catch()` is purely defensive. | No code depends on clipboard rejection propagating. |

### SAFE WITH MINOR PRECAUTIONS

| # | Fix | Impact | Precaution |
|---|-----|--------|------------|
| 2 | Add try/catch to `syncProgressService.ts` | 14 thin wrappers with no error handling. Only 1 confirmed caller (`use-delete-file`) which ALREADY has its own try/catch. | For `recordDeletedFile`: must **re-throw** after logging — don't swallow, or caller's catch becomes dead code. For other functions (0 callers): safe to add freely. |
| 4 | Replace `any` types in `area-line-chart` | Only 1 consumer (`ChartTrends`). visx v3.12+ exports proper types (`ScaleType`, `AxisScale`, etc.). | Tighten generics incrementally. Verify `ChartTrends` still compiles after each type narrowing. |
| 16 | Fix double type casts in billing (`as unknown as Plan[]`) | Root cause: `CancelSubscriptionDialog` accepts `Plan[]` but data is `SubscriptionPlan[]`. `Plan` is a subset. | Change `CancelSubscriptionDialog` to accept `SubscriptionPlan[]` directly. Only 1 caller. No other types are ever passed. |
| 26 | Derive `unreadCountAtom` from `notificationsAtom` | Currently stored separately, manually synced. All 3 update sites set count = `notificationsAtom.filter(n => n.unread).length`. **Bonus:** `markReadAtom`/`markUnreadAtom` currently DON'T update the count — deriving fixes this bug. | Replace `atom<number>(0)` with `atom((get) => get(notificationsAtom).filter(n => n.unread).length)`. Remove 3 manual `set(unreadCountAtom, ...)` calls. Only read by `NotificationMenu`. |
| 39 | Add missing components to UI barrel export | 4 component groups safe to add (Input, Label, DropdownMenu, CircularProgress). | **Do NOT add AltTable** — `CopyableCell` imports `CopyText` from barrel, would create circular import. Fix `CopyableCell` to use direct import first. |
| 12 | Consolidate sync atoms into one file | 3 files → 1 file. No circular dependencies between them. No files that import these atoms also export symbols these atoms need. | 26 files need import path updates (mechanical). Test that all imports resolve after move. |
| 3 | Fix `add_contact` param naming (`walletAddress` → `wallet_address`) | Frontend sends `walletAddress`, Rust expects `wallet_address`. Tauri may or may not auto-convert. | **Test at runtime** before and after fix. If contacts currently work, Tauri IS auto-converting and the fix is cosmetic. If contacts are broken, this is a real bug fix. |

### NEEDS CARE — Review before proceeding

| # | Fix | Risk | What to check |
|---|-----|------|---------------|
| 6 | Replace `console.*` with logger utility | MEDIUM | `logger.warn`/`.error` are passthrough (same as `console.warn`/`.error`). `logger.debug`/`.info` are dev-only. **Some console.log calls in auth flow are intentional support diagnostics** (prefixed `[LoginForm]`, `[OAuth]`). Don't blindly replace — audit which logs are debug vs support. |
| 10 | Eliminate duplicate `userAddressAtom` | MEDIUM | `refreshNotificationsAtom` and `markAllReadAtom` read `userAddressAtom` via `get()` inside write-only atoms. Atoms can't access React context. Must restructure to **pass userAddress as parameter** to these action atoms. Requires changing caller signatures in `useNotifications.ts`. |
| 18 | Replace non-null assertions with null checks | MEDIUM | **Line 128 (`session.substrateAddress!`):** Real edge case — OAuth login without substrate info could make this null. Add explicit null check + early return. **Line 153 (`polkadotAddress!`):** Actually safe — function has `if (!polkadotAddress) return` guard at line 125. Low priority. |
| 21 | Add `aria-hidden` to decorative icons | HIGH | 6 icon components use `<img alt="">` without `aria-hidden`. BUT: **do not blindly add `aria-hidden="true"`** — some may be used as sole visual indicators in other contexts. Must audit ALL consumers of each icon. For splash-screen usage (with text labels): safe. For standalone usage: need `role="img"` + `aria-label` instead. |
| 47 | Remove `/bridge` route | MEDIUM | `/bridge` renders identical `<StakeBridge />` as `/stake`. No internal code links to `/bridge` (BridgeWidget already uses `/stake?tab=bridge`). **BUT:** cannot verify if external docs, emails, or marketing materials link to `/bridge`. Check git history and ask team before deleting. |

### NOT RECOMMENDED — Defer or document only

| # | Fix | Reason |
|---|-----|--------|
| 9 | Migrate auth state from React context to Jotai atoms | **UNSAFE** — Provider depends on React lifecycle for boot effect (session restore from DB), token refresh event listener, logout timer scheduling. Migrating breaks all three. Requires full architectural redesign. Document as tech debt. |
| 24 | Create route for `/settings` | **Not needed** — Settings is intentionally a modal (desktop-app UX pattern). Creating a route would be wasted since it opens a dialog anyway. Document as intentional design in CLAUDE.md. |
| 37 | Split `wallet-auth-context.tsx` (632 lines) | **RISKY** — Auth, sync init, session mgmt, token refresh, and timer scheduling are tightly coupled. Splitting requires understanding all interdependencies. Defer to dedicated refactoring sprint. |
| 36 | Split `useTraySync.ts` (1,220 lines) | **MEDIUM risk** — 9 responsibility areas, but hook dependencies between sections are complex. Needs careful dependency analysis before splitting. |
| 27 | Restructure notification store write-only atoms | **MEDIUM risk** — 10+ atoms, deeply integrated into notification UI across 12 files. Large blast radius for a pattern change. |

---

## Verified Findings Reference

### Removed (False Positives)

| # | Finding | Why removed |
|---|---------|-------------|
| 3 (original) | notificationsDb param mismatches for 5 commands | Backend signatures match frontend. No missing `account_id` params. Only `add_contact` has real naming issue. |
| 25 | No back button on `/wallet` | Unverifiable without Wallet component internals inspection. |
| 33 | Duplicate `NoEntriesFound` components | Three different domain-specific components (generic UI, S3 storage, file upload w/ drag-drop). Different props, different behavior. |
| 8 | Empty catch handlers | All intentional fire-and-forget for non-critical cleanup with documented fallbacks. |

### Downgraded

| # | Finding | Original → New | Why |
|---|---------|----------------|-----|
| 2 | Unguarded invoke() calls | Critical (70+) → High (~20) | wallet-auth-context has 12/13 guarded. Count inflated by syncProgressService thin wrappers. |
| 7 | Silent catch blocks | High → Medium | Many in notificationsDb where silent fallbacks are reasonable for non-critical ops. |
| 28 | Inconsistent localStorage persistence | Medium → Informational | Intentional hybrid: `syncEngineStatusAtom` needs controlled write timing that `atomWithStorage` can't provide. |
| 30 | Global interval on window | Medium → Informational | Cleanup exists. HMR-specific persistence pattern. |

### Informational (no action needed)

| # | Finding | Status |
|---|---------|--------|
| 8 | Empty catch handlers | Intentional fire-and-forget patterns |
| 28 | Inconsistent localStorage persistence | Intentional hybrid approach |
| 30 | Global interval on window | Has cleanup, HMR-specific |
| 23 | `/wallet` hidden from nav | Intentional — wallet split to `/stake` and `/unstake` |

---

## Summary Statistics

- **Total initial findings:** 50
- **After verification:** 43 (4 false positives, 3 downgraded)
- **Actionable fixes assessed:** 27
- **Safe to proceed immediately:** 13
- **Safe with minor precautions:** 7
- **Needs care (review first):** 5
- **Not recommended (defer):** 5
- **Informational (no action):** 4
