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

- **`app/components/sidebar/SidebarSearch.tsx`** — the sidebar field is a _trigger_: clicking it (or ⌘/Ctrl+F from anywhere) opens `SidebarSearchModal`, a screen-centered command palette, not an anchored dropdown. This component owns only the trigger chrome (collapsed icon button / expanded pill with the ⌘F hint) and the `UnifiedMediaDialog` a selected file opens into, fed `previewList` so prev/next navigation walks the list the file came from. It mounts the SAME dialog the drive page mounts — see "Unified file preview".

  The viewer resolves its media URL through `useViewableFileUrl` (`app/lib/hooks/useViewableFileUrl.ts`), which serves a synced file straight from disk (`convertFileSrc(source)` — unchanged, no network) but for a **cloud-only** search hit (no local `source`, or a `pending` hit that carries a server `fileId`) calls the `cache_remote_file` IPC to download + decrypt it into a preview cache. A local file is told apart from a not-yet-downloaded search hit by the **`fileId`** field: disk-walk entries never carry one, so local previews/downloads are never rerouted. The same `fileId` gate drives `downloadFile.ts` (cloud-only → `download_remote_file`; else the local `export_file`).

- **`app/components/sidebar/SidebarSearchModal.tsx`** — the centered palette portalled to `<body>`. Owns the query, the account-wide **cloud** search (`useGlobalFileSearch` → the `search_files` IPC → the HCFS server's `/search_files` endpoint, the same call the web console's file search makes), and the empty-state "last uploads" list (`useRecentUploads` → `get_recent_uploads`, capped to `RECENT_LIMIT`).

  The search hits the server (not local disk), so files uploaded from other devices — or under drives not configured here — are found too; this replaced `useGlobalRecursiveFileSearch`, which fanned the local `search_user_files_recursive` IPC across drives and therefore only ever surfaced already-synced files. It is mounted only while open, so the recent-uploads fetch is lazy. Supports ArrowUp/Down + Enter selection, Esc / overlay-click close, and a body scroll lock.

  "Last uploads" and search results render with one row component (both are `FormattedUserFile[]`): icon, then name with the file size as a muted subtitle below it, then the upload date right-aligned (via `formatUploadedDate` — "Just now" only for the first ~20s, then "45s ago" / "5m ago" / "3h ago" / "2d ago" for the last week, short absolute date otherwise). NOTE: `mergeUploadFeed` drops a _completed_ live-snapshot row once the server list includes that file, so the row uses the server's real `createdAt` instead of the live row's per-merge `Date.now()` stamp — otherwise a just-finished file lingering in the snapshot renders "Just now" forever.

- **`app/lib/hooks/useRecentUploads.ts`** — wraps `get_recent_uploads`. Account-wide "last uploads" from the HCFS server, so it includes uploads made from other devices — unlike `useRecentFiles` (`get_recent_files`), which reads this device's sync-activity log and is empty on a fresh launch. The home view uses `useRecentFiles`; the sidebar palette uses this.
- **`app/components/sidebar/sidebarSearchState.ts`** — pure `getSidebarSearchView()` resolver mapping `{hasQuery, isFetching, resultCount, recentLoading, recentCount}` → one of `recent | recent-loading | recent-empty | results | skeleton | no-results`. Unit-tested: available rows win over a loading state; the empty message only shows once the relevant query settles.
- **`app/components/ui/search-input/index.tsx`** — shared search input uses the Figma light/dark pill styling and shows a clear icon when text is present.

## Files table: expanded folder rows and viewer scoping

**Row rendering is memoized and must stay that way.** Top-level rows render through `DriveFileRow` (`files-table/index.tsx`), a `React.memo` component whose comparator checks `row.original` — never the react-table `Row` wrapper, which is recreated on every data change. Volatile handlers/props reach rows through `rowCtxRef` (and cells through `cellCtxRef`), so a memo-skipped row can never strand a stale closure. Passing a per-render closure or object directly as a `DriveFileRow` prop reintroduces the bug this exists to fix: with hundreds of loaded rows (remote pagination), every appended page re-reconciled every row's subtree and froze list-view scrolling — card view never had the bug because `FileCard` was memoized. The same reason is why `visibleRows` slices to `files.length`: sorting runs over the full list, but only the container's scroll window is rendered.

`app/components/page-sections/drive/files-table/ExpandedFolderRows.tsx` handles inline expand/collapse in the files table, using `useNestedFolderListing`, `AnimatedTableAccordion`, and `useInfiniteScroll`.

**Viewer gallery scoping**: opening a previewable file from an expanded subtree passes that folder's full sorted listing as `previewSiblings` through every open path (the shared `PreviewTrigger` on the name cell, the action-menu "View" item via `createTableItems`'s trailing param, and right-click → View via the context-menu's `previewList`). `useFileViewShared` stores `selectedFile` + `previewList` as ONE state value (pure transition in `shared/viewerSelection.ts`, unit-tested: close always clears the list; an open without a list never inherits one), and `DriveContent` feeds `UnifiedMediaDialog` `allFiles={previewList ?? filteredData}` — so the viewer's thumbnail rail and prev/next walk the folder the file lives in, not the page's top-level rows. Strip/arrow navigation re-passes the current list (`handleViewerNavigate`) to stay in scope.

This is needed because nested rows' `actualFileName` is the full drive-relative path, which never matches the top-level page list, so the old wiring showed the parent folder's thumbnails with no active item and dead prev/next.

## Unified file preview

**There is exactly ONE dialog entry point for a previewable file**: `UnifiedMediaDialog` (`app/components/page-sections/drive/file-preview/`). Call sites choose a **file and the sibling list it came from**; they must never decide which renderer or dialog to mount. Before this, `DriveContent`, `SidebarSearch`, the card menu and the context menu each carried their own `selectedFileType === "video" | "image" | "PDF"` ladder, so a new format opened in some surfaces and silently did nothing in others.

The chain:

`filePreviewType.ts` (classify) → `UnifiedMediaDialog` (chrome) → `UnifiedFilePreview` (dispatch) → one renderer body.

- **`app/lib/utils/filePreviewType.ts`** — the single classifier. `derivePreviewType(name, mime?)` resolves extension table → legacy-Office (recognised, deliberately null) → the existing image/video/PDF groups → MIME hint, in that order. **The extension always wins over the MIME**: a `.docx` served as `text/html` must open the Word renderer, not the HTML frame, or the sender picks the renderer. A name with no dot is never classified (`md`, `html`, `.gitignore` are not Markdown/HTML). `previewByteCap` gives each type its ceiling; `previewNeedsBytes` says whether it reads bytes or streams a URL. Pinned by `app/lib/utils/__tests__/filePreviewType.test.ts`.
- **`mediaNavigation.ts` delegates to the same classifier**, so the gallery (thumbnail rail, prev/next) and the dialog can never disagree — when they did, a newly supported format opened on click but was skipped by the arrow keys and absent from the rail.
- **Every gating call site asks `isPreviewableFileName`**: the files-table name cell and action menu, `ExpandedFolderRows`, the card view's click + menu, the right-click menu's "View", and `NameCell`'s hover affordance. Adding a format is a one-line change to `PREVIEW_EXTENSIONS` plus a renderer — never a sixth copy of a type list.

### Where the bytes come from

Two paths, and the split is deliberate:

- **Media (image / video / PDF) streams from a URL** via `useViewableFileUrl` — unchanged. This is what preserves HEIC conversion, Live Photo motion, video seeking and the Linux PDF fallback, and it keeps large media out of a JS buffer.
- **Everything else reads bytes through Rust**: `read_preview_bytes` (`src-tauri/src/media_preview.rs`) → `previewBytes.ts` → `usePreviewResource`. Rust validates the path against the account's registered sync roots or the preview cache (the same `validate_preview_source` gate the Live Photo command uses — without it the command is an arbitrary filesystem reader), clamps the renderer's requested cap to its own `MAX_PREVIEW_READ_BYTES` ceiling, and **rejects an over-cap file rather than truncating it** (half a DOCX is a corrupt DOCX). The over-cap copy lives in Rust (`PREVIEW_TOO_LARGE`) and reaches the UI through the structured `{ kind, message }` error — never string-matched. Bytes come back as `tauri::ipc::Response` (raw), because the JSON path would encode a 25 MiB document as ~75 MiB of digits.

`usePreviewResource` is the one lifecycle for every byte-backed renderer, so these hold for all of them: an obsolete load is aborted on file change; **a late response is dropped rather than painted over the file now on screen**; and `dispose` runs on replacement, unmount, *and* on a parse that finishes after cancellation. `RenderedFilePreview` is its DOM-renderer sibling (docx-preview paints nodes rather than returning elements): it clears the body and style containers before every render and again on teardown.

### Untrusted content rules

A synced file is untrusted input rendered inside the app's own WebView. Each rule below is load-bearing:

- **HTML gets two independent layers**: `sanitizeHtmlDocument` (`app/lib/utils/preview/sanitizeMarkup.ts`) strips script, event handlers, document-embedding elements, remote subresources and remote CSS `url()`/`@import`; the result then renders in an iframe with **`sandbox=""`** (no `allow-scripts`, no `allow-same-origin`) via **`srcdoc`**. `srcdoc` rather than a `blob:`/`asset:` URL so no navigable URL to the file's content ever exists. Never navigate the main WebView to it.
- **SVG is its own preview type, never `image`** — it is a script-capable document. It is sanitised, then rendered as a `data:` URL in an `<img>`: an `<img>` never executes SVG script or follows its external references, and a `data:` document is an opaque origin if it is ever opened elsewhere (a same-origin `blob:` would not be).
- **Markdown must not render raw HTML.** `rehype-raw` is deliberately absent, which is what leaves an embedded `<script>` inert as text. Do not add it. Non-`http(s)`/`mailto` links are flattened to plain text.
- **DOCX links are sanitised** after docx-preview renders (its only file-controlled script vector), and `renderAltChunks` stays off (alt chunks embed arbitrary foreign content, HTML included).
- **PPTX slides are scrubbed** after rendering — pptx-viewer's table path goes through `innerHTML` — and font names are stripped before rendering because they are interpolated into `style="…"` strings.
- **Nothing is sent to a third-party viewer.** All rendering is local and offline.
- **Every format has a byte cap and a render cap.** Caps are in `filePreviewType.ts` (bytes, re-enforced in Rust) and `spreadsheetFormat.ts` / `PresentationPreview.tsx` (rendered cells and slides). The spreadsheet grid virtualises rows, so `MAX_TABLE_COLUMNS` is the bound that matters for the DOM.

### Byte caps: size them by what the renderer does, not by what the format looks like

A cap is not a security dial to be turned down; it is a statement about **where the bytes are spent**. Two formats that read alike can be an order of magnitude apart:

| Renderer does… | Formats | Cap |
|---|---|---|
| Builds one React element per token, on the main thread | `markdown` | 1 MiB |
| …same, plus a span per highlighted token | `json` | 2 MiB |
| Hands the browser one text node to lay out | `text` | 8 MiB |
| Hands the browser a document to parse (natively, twice: sanitiser + frame) | `html` | 25 MiB |
| Parses a zip archive in JS | `spreadsheet` / `document` / `presentation` | 20 / 25 / 40 MiB |

**Markdown and HTML sharing one constant was a real bug** — an ordinary `index.html` a few MB in size refused to open with "too large to preview" while the renderer that would have shown it was never reached. Markdown's 1 MiB is justified by the element-per-token walk; that reasoning has never applied to HTML, which the browser parses natively. Same fix as hippius-console#722. Pinned by the "does not hold HTML to Markdown's cap" and "ranks the caps by how the renderer actually spends the bytes" tests.

**Every renderer takes its cap from `previewByteCap(type)`, never from the constant directly.** The switch is the single source of truth; a renderer that imports a constant is how one format silently keeps another's limit (that is precisely how the console's `fetchPreviewText` would have kept rejecting HTML at 1 MiB after its own cap was raised).

**No per-format cap may exceed `RUST_PREVIEW_READ_CEILING_BYTES`** (64 MiB, mirroring `MAX_PREVIEW_READ_BYTES` in `media_preview.rs`). Above it, Rust refuses the read and the user is told "too large" for a file inside its own cap — the same failure one layer down. Pinned from both sides: `filePreviewType.test.ts` and `preview_read_ceiling_clears_every_per_format_cap`.

### Renderers and why each library

| Type | Renderer | Library |
|---|---|---|
| image / video / PDF | `ImagePreviewBody` / `VideoPreviewBody` / `PdfPreviewBody` | none (WebView) — decomposed from the old dialogs, behaviour unchanged |
| DOCX | `DocumentPreview` → `RenderedFilePreview` | `docx-preview` — paginated Word pages with a floating pager |
| XLSX / CSV | `SpreadsheetPreview` → `SpreadsheetGrid` | `xlsx` (SheetJS) — Google-Sheets chrome (see below) |
| PPTX | `PresentationPreview` | `pptx-viewer` — real SVG slides, filmstrip, pager, speaker notes. **The stage is `items-start`, not centred**: the current slide's top edge must line up with thumbnail 1's top, and centring only looked right for a deck long enough to fill the filmstrip's height. The pager anchors to a shrink-wrapping box around the slide so it sits at the slide's bottom, not the stage's. |
| MD | `MarkdownPreview` | `react-markdown` + `remark-gfm` |
| JSON / TXT / HTML / SVG | `JsonPreview` / `PlainTextPreview` / `HtmlPreview` / `SvgPreview` | none |

- **Two spreadsheet parsers, in this order, and both are needed.** ExcelJS is tried first for XLSX because it is the only one of the two that reports **fonts, borders, alignment, merges, column widths, row heights and frozen panes** — the community SheetJS build reports fills and values only, so an ExcelJS-less path previews a styled workbook as unstyled text. ExcelJS also *fails* on some valid files (namespace-prefixed OOXML: 2 of 3 sample files), and it fails by returning an **empty model rather than throwing**, so `parseWithExcelJs` treats "no sheets" as an error to make the fallback fire. SheetJS is that fallback, and the only parser for CSV.
- **SheetJS is pinned from `cdn.sheetjs.com`, not npm.** The npm `xlsx` package is stale at 0.18.5 with unpatched prototype-pollution and ReDoS advisories, which is unacceptable for parsing untrusted files.
- **Cells are addressed from row 1 / column A of the *sheet*, never of its data.** A worksheet whose used range is `E1:E1000` must render in column E with A–D empty; normalising the range to column 0 moved everything to column A, so the header letters no longer matched the file. Both parsers take the range's *end* (`e.r + 1` / `e.c + 1`) as the extent and read at absolute indices. Pinned by the "keeps a cell in its real column" test.
- **Only right/bottom borders are drawn**, and `foldBorders` pushes each cell's left/top onto its neighbour — otherwise a box drawn around a range shows two of its four sides.
**The spreadsheet grid is light-mode only, in both app themes.** A sheet is a document with its own paper, like a Word page or a slide: neither the Hippius console nor Google Sheets has a dark spreadsheet, and a dark grid would fight the cell fills that come out of the file, which are authored for a white sheet. `SpreadsheetPreview` forces it with `dark:` overrides on `PreviewCard` (twMerge lets them beat the base card's dark classes), and `SpreadsheetGrid` hard-codes the Sheets palette (`#f8f9fa` headers, `#5f6368` header text, `#e0e0e0` gridlines, `#d3e3fd` active header, `#1a73e8` selection) instead of using theme tokens. The viewer chrome *around* the sheet still follows the user's theme. Do not add `dark:` variants inside the grid.

The grid supplies the Sheets chrome — a formula bar (address + `fx` + value), lettered/numbered headers with the selected row and column highlighted, click-to-select with the blue ring, gridlines continuing past the data to the edge of the viewer (`viewportFillCount`), text spilling over empty neighbours, sticky frozen panes, Arial 13px — and renders the cell styling the parser found: fills, font colour/family/size, bold/italic/underline/strike, horizontal and vertical alignment, wrapping and borders. Alignment falls back to the value's *type* when the file specifies none (the SheetJS path never does), and `readableTextColor` derives a legible font colour on that path only, where a dark fill would otherwise be near-black on near-black. `fontStack` adds metric-compatible stand-ins for Office fonts, which ship on none of the three platforms.

**Rows are virtualised** (`OVERSCAN_PX`, binary-searched offsets, spacer rows), which is what lets `MAX_TABLE_ROWS` be generous — it bounds the parsed model in memory, not the DOM. `MAX_TABLE_COLUMNS` is much tighter because columns are **not** virtualised: every column renders on every visible row. A merged range whose anchor scrolled above the window is force-rendered from `sheet.merges`, or the cells it covers leave a hole.

- **`isZipArchive` guards the XLSX path.** SheetJS's reader sniffs its input and will parse arbitrary bytes as delimited text, so a `.xlsx` that is not a zip would render as a confident one-cell "spreadsheet" of its own raw contents instead of erroring.
- All three heavy libraries are **dynamically imported** inside their renderer, so they stay out of the main bundle for the sessions that never open one.

### Failure posture

`PreviewFallback` (`PreviewState.tsx`) is the one error surface and **always carries Download**. It covers four causes the user cannot distinguish: no renderer, over cap, unreadable, corrupt. `onOpenExternally` is added only where a system viewer genuinely helps — the Linux PDF path, which is preserved exactly (WebKitGTK has no PDF viewer, so Linux goes straight to the handoff rather than a blank frame). **Legacy `.doc`/`.xls`/`.ppt`/OpenDocument are recognised but reported as unsupported** with their own message; they are not OOXML and must never be mislabelled as previewable.

### Adding a format

1. Add the extension to `PREVIEW_EXTENSIONS` and a cap to `previewByteCap`.
2. Add the renderer to `BYTES_RENDERERS` in `UnifiedFilePreview` (or the media branch).
3. Extend `filePreviewType.test.ts` and `UnifiedFilePreview.test.tsx`.

Nothing else changes — every trigger, menu, gallery and hover affordance already routes through the classifier.

## Live Photo / HEIC preview

`src-tauri/src/media_preview.rs` owns detection and extraction of mobile's 24-byte `HIPPIUSLIVE` trailer into the existing preview cache. Rust's `get_platform_info` is the source of truth for `supportsLivePhotoMotion`: Linux renders the LIVE badge disabled immediately with an explanatory tooltip, while supported WebViews use frame-verified playback. `app/lib/hooks/usePreparedImagePreview.ts` adapts the extracted paths for the viewer; `useThumbnail.ts` and the viewer convert HEIC to temporary JPEGs locally, only for display. The app never shells out to a system media converter.

Four rules govern the unsupported tooltip, each of which was independently load-bearing:

1. **It must out-rank the viewer overlay.** `LivePhotoToggle` (`file-preview/ImagePreviewBody.tsx`) portals its tooltip to `document.body`, so it escapes the `FileViewerLayout` dialog's stacking context. It derives its `zIndex` from the exported `FILE_VIEWER_OVERLAY_Z_INDEX` (`file-viewer/FileViewerLayout.tsx`, re-exported from the barrel) rather than hard-coding a number — a hard-coded `z-[200]` under the overlay's 999 renders the explanation invisible behind the full-screen viewer. The message is also mirrored onto the button's `aria-label`, because Radix marks body-level siblings of an open modal `aria-hidden`.
2. **Hover must be wired on BOTH event families.** WebKitGTK (the Linux WebView) does not dispatch mouse-driven Pointer Events, so an `onPointerEnter`-only tooltip never opens there and the badge reads as dead. `LivePhotoToggle` binds `onPointerEnter`/`onMouseEnter` (opening is idempotent, so a platform firing both is harmless) and the matching leave handlers, sharing one `hideUnsupportedTooltip` that keeps a keyboard-focused badge's tooltip up. It additionally carries the reason as a native `title`, dropped the instant the styled tooltip opens so the two never stack.
3. **Explicit colors, not theme tokens.** The tooltip uses `bg-[#0A0A0A]/85 text-white` (matching the badge chrome) rather than `bg-primary`/`text-primary-foreground` — this theme defines `primary` as a nested scale with no `DEFAULT` key, so those two classes generate nothing and the tooltip renders as bare unstyled text over the photo.
4. **`getLivePlaybackError` treats Rust's `os` as authoritative** and only falls back to a user-agent sniff when it is empty (the pre-IPC first frame): every WebView UA string is Linux-ish, so ORing the two mislabels macOS/Windows.

Pinned by `file-preview/__tests__/LivePhotoToggle.test.tsx`, which asserts the tooltip's z-index is greater than the exported overlay constant instead of matching a magic number, and pins the mouse-only path and the `title` handoff.

## Home page overview cards (no charts)

The home page's two chart cards were removed by product decision in favor of TWO small mobile-style cards: a **storage card** (used vs effective capacity, progress bar — `app/components/page-sections/home/storage-overview/`) and a **plan card** (subscribed plan / credits balance / subscribe CTA — `.../home/plan-overview/`), plus the **shared `ui/plan-chip`** component that renders the "Active Plan"/"Credits" cell in BOTH page headers (`home/PageHeader.tsx` and the global `ui/page-header` used by Files / VM / Notifications) — neither header carries its own plan logic anymore.

- **One IPC owns the decision**: `get_storage_overview` (`src-tauri/src/billing/storage_overview.rs`) composes used bytes (the same indexer row `get_drive_storage_stats` reads, via the shared `queries.rs::fetch_drive_storage_stats`), the active Stripe subscription, and the credit balance, and resolves the **capacity-source priority chain in Rust, once**: `subscription` (allowance from `credits_per_billing` via `calculate_storage_capacity`) → `credits` (capacity = `used + credits-buyable storage`, where the balance prices the *free* space) → `none`. All three surfaces render from this ONE `source` field and cannot disagree. Percent is computed and clamped to `[0,100]` in Rust (over-quota after a downgrade must not overflow the bar); unit math is decimal SI GB end-to-end — never mix in 1024-based units.
- **Failure posture is asymmetric on purpose**: an indexer failure ERRORS (the storage card renders "Couldn't load storage" — a failed fetch must never read as a confident "0 B used"), while subscription/credits fetch failures fail SOFT (chain falls through), mirroring `get_subscription_data`.
- **FE is a pure projection**: `useStorageOverview` (poll cadence mirrors `useDriveStorageStats`; `STORAGE_OVERVIEW_QUERY_KEY` is invalidated by `useSyncEvents` after transfers) + the unit-tested resolvers in `storage-overview/storageOverviewState.ts` — `getStorageOverviewView` (skeleton → error → no-plan → usage), `getPlanView` (skeleton → plan → credits → none, shared by the plan card AND the chip), `getUsageTone` (brand < 80% ≤ amber < 95% ≤ red), `getCapacitySourceLabel` (a credits-derived total is always labelled "Based on your credit balance", never as a plan). **The skeleton latches to first settle** so the chip/cards never flash "No active plan" while the decision is merely loading.
- `AvailableCreditsChart` (line/area renderer) SURVIVES at `.../home/available-credits/AvailableCreditsChart.tsx` — it is shared by the wallet's `TransactionOverviewGraph` and billing's `CreditGraph` (a wiring guard in `chartAnimation.test.ts` pins its path); only the home cards died. It formats y-axis ticks in **credit** units by default, so any non-credit caller MUST pass `yTickFormat`. The Rust chart commands (`get_drive_storage_chart`, `get_credit_balance_chart`) stay registered; billing's "Drive Credit Usage" card (`get_drive_credits_chart`) is untouched.
