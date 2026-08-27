---
paths:
  - "app/**"
---

# Frontend structure and conventions

Next.js is configured with `output: "export"` — **no server-side rendering**. All data fetching happens client-side via Tauri IPC or TanStack Query. There is no server redirect; feature gates use the client-side `app/components/FeatureDisabledRedirect.tsx`.

Path aliases (tsconfig.json): `@/components/*` → `app/components/*`, `@/lib/*` → `app/lib/*`, `@/services/*` → `app/lib/services/*`.

## Layout

- **`app/(pages)/`** — Next.js route groups: files, wallet, stake/unstake, vm, billing, notifications, support, referrals, bridge. Also contains invisible event-listener components mounted in the layout: `SyncEventLogger`, `ConflictEventListener`, `MigrationChecker`, `SyncFilesHandler`.
- **`app/lib/wallet-auth-context.tsx`** — Central auth provider (login, session restore, logout, token refresh). Wraps the entire app.
- **`app/components/AppShell.tsx`** — Top-level shell that branches the provider tree by route: the full app for the main window, but a minimal provider-free tree for the `/tray-panel` route so the popover never boots a second tray/auth/updater stack. Branches on `usePathname()` so the decision is identical between static-export prerender and hydration.
- **`app/components/auth/LeftCarouselPanel.tsx`** — Auth carousel panel. Uses `carouselCrop.ts` to lock the video crop to the initial frame size so window resizing does not reveal more or less of the clip.
- **`app/lib/global-atoms/`** — Jotai atoms for global state (polkadot API, sync status, migration).
- **`app/lib/store/jotaiStore.ts`** — Standalone Jotai store (`appStore`) used outside React (e.g. tray sync).
- **`app/lib/hooks/`** — `useHcfsSync` (sync init), `useSyncEvents` (event listeners), `useSyncProgress`, `useStagedChanges` (conflict review), `useTraySync`.
- **`app/lib/utils/`** — including `hcfsConfigUtils.ts` (sync config) and `syncPathUtils.ts` (path CRUD).

## Theme selection (System/Light/Dark)

Tailwind runs `darkMode: "selector"` — `dark:` variants apply under the `.dark` class on `<html>`, **NOT** the OS media query.

The class is owned by `AppThemeProvider` (`app/lib/theme-context.tsx`): a Jotai `atomWithStorage` persists the preference to localStorage under the console's same `hippius-theme` key (raw value, "system" stored as absence; missing/invalid → "system" via the pure, unit-tested `app/lib/theme.ts`), resolves it against `prefers-color-scheme` (live-tracked while on "system"), and toggles `.dark` + `style.colorScheme` on the root.

The provider is mounted in **both** `AppShell` branches — full app AND the provider-free tray-panel popover — so every webview window follows the preference independently from the shared localStorage (its `subscribe` relays cross-window `storage` events). An inline boot script in `app/layout.tsx` (first child of `<body>`, mirrors the same parse/resolve rules, `<html suppressHydrationWarning>`) applies the class before first paint so a forced theme never flashes the OS theme.

The picker lives in settings → **Appearance** (`AppearanceSettings.tsx`: `SettingsCard` + the shared `SegmentedControl`, sonner toast on change). Theme preference is deliberately FE-only presentation state (localStorage, not the Rust `user_preferences` table) and pre-auth surfaces need it too.

**Rules for new code**: read theme via `useAppTheme()` (`resolvedTheme`/`themePreference`) — NEVER `window.matchMedia("(prefers-color-scheme: dark)")` directly, and raw CSS must key off `.dark` instead of `@media (prefers-color-scheme: dark)`.

## UI feature flags

Build-time boolean constants in `app/lib/featureFlags.ts` gate user-visible surfaces; flipping a flag is a one-line release change and deletes no code.

- `VPN_FEATURE_ENABLED = false` hides **all** legacy VPN UI — the top-bar VPN menu (`TopBarActions`), the "VPN Settings" item in `SettingsSidebar`, and the VPN section on the settings page. The implementation is intact; set the flag to `true` to restore it. Note the backend `get_vpn_status` command is not registered, so re-enabling the menu also needs that command wired up.
- `WALLET_FEATURE_ENABLED = false` removes the Wallet sidebar entry (via the pure `filterNavSections` in `NavData.tsx`, unit-tested), redirects `/wallet` to the overview, and hides the settings-page "Wallets" surface — the settings sidebar item (via the pure `filterSettingsNavItems` in `sidebar/settingsNavGating.ts`, which also owns the VPN item's gating) and the `WalletSettings` section render.
- `VM_FEATURE_ENABLED = false` renders the "Virtual Machines" sidebar sub-item disabled with an orange "Coming Soon" tag (`NavItem.tsx`), redirects `/vm`, `/vm/create` and `/vm/instance-details`, and omits the tray context menu's "Open Virtual Machines" item (`useTraySync.ts`, null-safe watcher).
- `REFERRALS_COMING_SOON = true` keeps the referrals page reachable but behind the blurred `ComingSoon` overlay.
- `VM_VPN_ENABLED = false` (independent of `VPN_FEATURE_ENABLED`) hides the per-VM "Connect via VPN" surface (`VmVpnConnect.tsx` via `useVpn`); it pairs with the off-by-default `netbird-vpn` Cargo feature.
- `SHARED_DRIVES_ENABLED = false` — see the shares rules file.

## User preferences

Generic key-value store in SQLite (`user_preferences` table) accessed via `get_user_preference` / `save_user_preference` Rust commands. Frontend wrapper in `app/lib/utils/userPreferencesDb.ts` provides typed helpers including `getLastBrowseDirectory()` / `saveLastBrowseDirectory()` which remember the last directory browsed in file/folder pickers (fallback chain: last browse dir → home dir → OS default). Used by `FileDropzone`, `FolderUploadDialog`, and `FolderToFolderUploadDialog`.

## In-app file mutations must call `notifyFilesMutated`

`app/lib/utils/fileMutationEvents.ts` is the single invalidation funnel every mutation hook uses on success. Two audiences need waking and they refresh by different mechanisms: the TanStack-cached lists (drive table, recent files) via `refetchQueries`, and the nested folder listings (`useNestedFolderListing` in `DriveContainer`'s subfolder view and in `ExpandedFolderRows`), which are plain `useState` + `invoke("list_sync_folder_grouped")` and only react to the `hippius:files-mutated` window event.

Hand-rolling the pair per hook is how they drift: `useDeleteFile` refetched the queries but never dispatched the event, so deleting the last entry of a subfolder left the deleted row on screen until the user navigated out and back. That case cannot self-heal on `sync_files_completed_changed` either — a delete with no file content to propagate ends the cycle `NoChanges`, which emits no `SyncCompleted`. Pinned by `app/lib/hooks/__tests__/useDeleteFile.test.tsx`. **Route new mutations through the funnel** rather than adding another private copy of the refetch set.

## Sidebar search

- **`app/components/sidebar/SidebarSearch.tsx`** — the sidebar field is a _trigger_: clicking it (or ⌘/Ctrl+F from anywhere) opens `SidebarSearchModal`, a screen-centered command palette, not an anchored dropdown. This component owns only the trigger chrome (collapsed icon button / expanded pill with the ⌘F hint) and the preview dialogs a selected file opens into (Video/Image/PDF, gated on `selectedFileType`, fed `previewList` so prev/next navigation walks the list the file came from).

  Those dialogs resolve their media URL through `useViewableFileUrl` (`app/lib/hooks/useViewableFileUrl.ts`), which serves a synced file straight from disk (`convertFileSrc(source)` — unchanged, no network) but for a **cloud-only** search hit (no local `source`, or a `pending` hit that carries a server `fileId`) calls the `cache_remote_file` IPC to download + decrypt it into a preview cache. A local file is told apart from a not-yet-downloaded search hit by the **`fileId`** field: disk-walk entries never carry one, so local previews/downloads are never rerouted. The same `fileId` gate drives `downloadFile.ts` (cloud-only → `download_remote_file`; else the local `export_file`).

- **`app/components/sidebar/SidebarSearchModal.tsx`** — the centered palette portalled to `<body>`. Owns the query, the account-wide **cloud** search (`useGlobalFileSearch` → the `search_files` IPC → the HCFS server's `/search_files` endpoint, the same call the web console's file search makes), and the empty-state "last uploads" list (`useRecentUploads` → `get_recent_uploads`, capped to `RECENT_LIMIT`).

  The search hits the server (not local disk), so files uploaded from other devices — or under drives not configured here — are found too; this replaced `useGlobalRecursiveFileSearch`, which fanned the local `search_user_files_recursive` IPC across drives and therefore only ever surfaced already-synced files. It is mounted only while open, so the recent-uploads fetch is lazy. Supports ArrowUp/Down + Enter selection, Esc / overlay-click close, and a body scroll lock.

  "Last uploads" and search results render with one row component (both are `FormattedUserFile[]`): icon, then name with the file size as a muted subtitle below it, then the upload date right-aligned (via `formatUploadedDate` — "Just now" only for the first ~20s, then "45s ago" / "5m ago" / "3h ago" / "2d ago" for the last week, short absolute date otherwise). NOTE: `mergeUploadFeed` drops a _completed_ live-snapshot row once the server list includes that file, so the row uses the server's real `createdAt` instead of the live row's per-merge `Date.now()` stamp — otherwise a just-finished file lingering in the snapshot renders "Just now" forever.

- **`app/lib/hooks/useRecentUploads.ts`** — wraps `get_recent_uploads`. Account-wide "last uploads" from the HCFS server, so it includes uploads made from other devices — unlike `useRecentFiles` (`get_recent_files`), which reads this device's sync-activity log and is empty on a fresh launch. The home view uses `useRecentFiles`; the sidebar palette uses this.
- **`app/components/sidebar/sidebarSearchState.ts`** — pure `getSidebarSearchView()` resolver mapping `{hasQuery, isFetching, resultCount, recentLoading, recentCount}` → one of `recent | recent-loading | recent-empty | results | skeleton | no-results`. Unit-tested: available rows win over a loading state; the empty message only shows once the relevant query settles.
- **`app/components/ui/search-input/index.tsx`** — shared search input uses the Figma light/dark pill styling and shows a clear icon when text is present.

## Files table: expanded folder rows and viewer scoping

`app/components/page-sections/drive/files-table/ExpandedFolderRows.tsx` handles inline expand/collapse in the files table, using `useNestedFolderListing`, `AnimatedTableAccordion`, and `useInfiniteScroll`.

**Viewer gallery scoping**: opening a previewable file from an expanded subtree passes that folder's full sorted listing as `previewSiblings` through every open path (name-cell dialog triggers, the action-menu "View" item via `createTableItems`'s trailing param, and right-click → View via the context-menu's `previewList`). `useFileViewShared` stores `selectedFile` + `previewList` as ONE state value (pure transition in `shared/viewerSelection.ts`, unit-tested: close always clears the list; an open without a list never inherits one), and `DriveContent` feeds the dialogs `allFiles={previewList ?? filteredData}` — so the viewer's thumbnail rail and prev/next walk the folder the file lives in, not the page's top-level rows. Strip/arrow navigation re-passes the current list (`handleViewerNavigate`) to stay in scope.

This is needed because nested rows' `actualFileName` is the full drive-relative path, which never matches the top-level page list, so the old wiring showed the parent folder's thumbnails with no active item and dead prev/next.

## Live Photo / HEIC preview

`src-tauri/src/media_preview.rs` owns detection and extraction of mobile's 24-byte `HIPPIUSLIVE` trailer into the existing preview cache. Rust's `get_platform_info` is the source of truth for `supportsLivePhotoMotion`: Linux renders the LIVE badge disabled immediately with an explanatory tooltip, while supported WebViews use frame-verified playback. `app/lib/hooks/usePreparedImagePreview.ts` adapts the extracted paths for the viewer; `useThumbnail.ts` and the viewer convert HEIC to temporary JPEGs locally, only for display. The app never shells out to a system media converter.

Four rules govern the unsupported tooltip, each of which was independently load-bearing:

1. **It must out-rank the viewer overlay.** `LivePhotoToggle` (`ImageDialog.tsx`) portals its tooltip to `document.body`, so it escapes the `FileViewerLayout` dialog's stacking context. It derives its `zIndex` from the exported `FILE_VIEWER_OVERLAY_Z_INDEX` (`file-viewer/FileViewerLayout.tsx`, re-exported from the barrel) rather than hard-coding a number — a hard-coded `z-[200]` under the overlay's 999 renders the explanation invisible behind the full-screen viewer. The message is also mirrored onto the button's `aria-label`, because Radix marks body-level siblings of an open modal `aria-hidden`.
2. **Hover must be wired on BOTH event families.** WebKitGTK (the Linux WebView) does not dispatch mouse-driven Pointer Events, so an `onPointerEnter`-only tooltip never opens there and the badge reads as dead. `LivePhotoToggle` binds `onPointerEnter`/`onMouseEnter` (opening is idempotent, so a platform firing both is harmless) and the matching leave handlers, sharing one `hideUnsupportedTooltip` that keeps a keyboard-focused badge's tooltip up. It additionally carries the reason as a native `title`, dropped the instant the styled tooltip opens so the two never stack.
3. **Explicit colors, not theme tokens.** The tooltip uses `bg-[#0A0A0A]/85 text-white` (matching the badge chrome) rather than `bg-primary`/`text-primary-foreground` — this theme defines `primary` as a nested scale with no `DEFAULT` key, so those two classes generate nothing and the tooltip renders as bare unstyled text over the photo.
4. **`getLivePlaybackError` treats Rust's `os` as authoritative** and only falls back to a user-agent sniff when it is empty (the pre-IPC first frame): every WebView UA string is Linux-ish, so ORing the two mislabels macOS/Windows.

Pinned by `files-table/__tests__/LivePhotoToggle.test.tsx`, which asserts the tooltip's z-index is greater than the exported overlay constant instead of matching a magic number, and pins the mouse-only path and the `title` handoff.

## Home page overview cards (no charts)

The home page's two chart cards were removed by product decision in favor of TWO small mobile-style cards: a **storage card** (used vs effective capacity, progress bar — `app/components/page-sections/home/storage-overview/`) and a **plan card** (subscribed plan / credits balance / subscribe CTA — `.../home/plan-overview/`), plus the **shared `ui/plan-chip`** component that renders the "Active Plan"/"Credits" cell in BOTH page headers (`home/PageHeader.tsx` and the global `ui/page-header` used by Files / VM / Notifications) — neither header carries its own plan logic anymore.

- **One IPC owns the decision**: `get_storage_overview` (`src-tauri/src/billing/storage_overview.rs`) composes used bytes (the same indexer row `get_drive_storage_stats` reads, via the shared `queries.rs::fetch_drive_storage_stats`), the active Stripe subscription, and the credit balance, and resolves the **capacity-source priority chain in Rust, once**: `subscription` (allowance from `credits_per_billing` via `calculate_storage_capacity`) → `credits` (capacity = `used + credits-buyable storage`, where the balance prices the *free* space) → `none`. All three surfaces render from this ONE `source` field and cannot disagree. Percent is computed and clamped to `[0,100]` in Rust (over-quota after a downgrade must not overflow the bar); unit math is decimal SI GB end-to-end — never mix in 1024-based units.
- **Failure posture is asymmetric on purpose**: an indexer failure ERRORS (the storage card renders "Couldn't load storage" — a failed fetch must never read as a confident "0 B used"), while subscription/credits fetch failures fail SOFT (chain falls through), mirroring `get_subscription_data`.
- **FE is a pure projection**: `useStorageOverview` (poll cadence mirrors `useDriveStorageStats`; `STORAGE_OVERVIEW_QUERY_KEY` is invalidated by `useSyncEvents` after transfers) + the unit-tested resolvers in `storage-overview/storageOverviewState.ts` — `getStorageOverviewView` (skeleton → error → no-plan → usage), `getPlanView` (skeleton → plan → credits → none, shared by the plan card AND the chip), `getUsageTone` (brand < 80% ≤ amber < 95% ≤ red), `getCapacitySourceLabel` (a credits-derived total is always labelled "Based on your credit balance", never as a plan). **The skeleton latches to first settle** so the chip/cards never flash "No active plan" while the decision is merely loading.
- `AvailableCreditsChart` (line/area renderer) SURVIVES at `.../home/available-credits/AvailableCreditsChart.tsx` — it is shared by the wallet's `TransactionOverviewGraph` and billing's `CreditGraph` (a wiring guard in `chartAnimation.test.ts` pins its path); only the home cards died. It formats y-axis ticks in **credit** units by default, so any non-credit caller MUST pass `yTickFormat`. The Rust chart commands (`get_drive_storage_chart`, `get_credit_balance_chart`) stay registered; billing's "Drive Credit Usage" card (`get_drive_credits_chart`) is untouched.
