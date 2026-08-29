---
paths:
  - "src-tauri/src/tray/**"
  - "app/tray-panel/**"
  - "app/lib/tray/**"
  - "app/lib/hooks/useTraySync.ts"
  - "app/components/tray/**"
---

# System tray and popover panel

Backend: `tray/geometry.rs` (pure, OS-agnostic anchoring math — which screen edge the panel drops from, on-screen clamping, fully unit-tested) and `tray/panel.rs` (the borderless `tray-panel` window lifecycle + `toggle_tray_panel` / `hide_tray_panel` IPC).

## Tray popover panel

The native tray menu is replaced by a borderless, transparent, always-on-top webview window (label `tray-panel`, route `/tray-panel`) anchored to the tray icon, opened on **left-click**.

**Right-click shows a small native context menu** (Open Files / Open Virtual Machines / Quit Hippius) built by `buildTrayContextMenu` in `useTraySync.ts` and attached to the icon with `showMenuOnLeftClick: false` so it never hijacks the left click; "Open Hippius" is omitted because the popover already has that button. The context menu's Open Files/VM items are tracked in the module-level `openFilesItem`/`openVmItem` so the existing login-status watcher enables/disables them.

Flow: the tray icon's `action` callback in `useTraySync.ts` (`handleTrayClick`) forwards the icon's screen `rect` to the Rust `toggle_tray_panel` command; Rust resolves the monitor under the icon, computes placement via the pure `tray::geometry::compute_panel_position` (drop below when the icon is in the top half of its work area — macOS menu bar / top taskbar — else rise above; centre on the icon and clamp on-screen; all physical px), then positions+shows the reused window (or hides it if already visible — a toggle).

### Linux: no popover, menu opens the main window

Tauri's `tray-icon` crate fires no left-click `action` event on Linux, the app cannot self-position a window under Wayland, and there is no native vibrancy — so the rich popover is a **macOS/Windows-only** feature and Linux never shows it. On Linux the icon is built with `showMenuOnLeftClick: true` and the context menu leads with an **"Open Hippius"** item whose action simply **reveals the main window** (`openHippiusFromTray` → `openAppWindow`).

The Linux branch is gated on `isLinuxPlatform`, detected **synchronously** from `navigator.userAgent` (`detectLinuxPlatform`) — NOT the async `get_platform_info` IPC, which when late/failed left the flag `false` and silently dropped both the menu item and `showMenuOnLeftClick`, breaking the Linux tray entirely. `handleTrayClick` stays attached but is a harmless no-op on Linux.

**Windows** keeps the icon-anchored popover (its left-click `action` fires); off macOS the FE (`page.tsx` `cardSurface`) paints an **opaque** card + hairline border instead of the macOS translucent/vibrancy card (a 0.7-alpha card over the transparent window otherwise shows the desktop through). The native window shadow is macOS-only (`.shadow(cfg!(target_os = "macos"))`); the vibrancy `effects` call is left unconditional (Tauri no-ops it off macOS). `toggle_tray_panel` still takes `Option<TrayIconRect>` with a `fallback_anchor` (top-right) for the `None` case, but Linux no longer drives it.

### Key details

- **Linux/Windows window close actually quits.** `prevent_close()` is macOS-only (hide-to-tray). On Linux/Windows, `CloseRequested` must not cancel the close: doing so and then `exit(0)` from inside the GTK/WebKit handler orphans `/usr/bin/Hippius` in state S (H-003). Both the window X and tray Quit go through `tray::panel::quit_desktop`, which destroys `PANEL_LABEL` *then* `exit(0)` so the prewarmed hidden webview cannot keep the event loop alive. Pinned by `tests/window_close_wiring.rs`.
- **Click-outside dismissal**: the global `on_window_event` handler in `main.rs` calls `tray::panel::on_panel_blur` on `WindowEvent::Focused(false)` for the panel, which hides it and records `AppState.tray_panel_hidden_at`. `toggle_tray_panel` consults that timestamp against `REOPEN_COOLDOWN_MS` so clicking the icon of an open panel (blur → hide → toggle) reads as a dismiss, not an immediate re-open.
- **Sync vs static-export URL**: `build_panel` picks `tray-panel` under `cfg!(dev)` (Next dev server serves the route) and `tray-panel.html` otherwise (the no-`trailingSlash` static export emits that file at the dist root; Tauri's directory fallback would otherwise look for the non-existent `tray-panel/index.html`).
- **Transparency**: requires `app.macOSPrivateApi: true` in `tauri.conf.json` **and** the `macos-private-api` Cargo feature on `tauri`. The `tray-panel` window label is added to the `default` capability's `windows` list. The native window shadow is disabled because on a transparent window it is computed from the rectangular bounds (a dark rectangle around the rounded card); the card's CSS `box-shadow` provides the shadow instead.
- **The card must NOT fill the window edge-to-edge.** It is wrapped in a transparent, full-window padded shell (`.tray-panel-shell` = `h-screen w-screen` + asymmetric padding: small top so the card hugs the icon, larger sides/bottom where the downward shadow casts) and fills the padded area via flex (`flex-1 min-h-0`). When the card was `w-screen h-screen` it matched the rectangular window exactly, so its `box-shadow` rendered entirely outside the window and was clipped everywhere except the four rounded-corner notches; since every shadow layer offsets downward, the bottom corners filled with dark triangles. The shell's padding turns those notches into transparent desktop and gives the shadow room to render as real elevation; the shadow's reach (offset + blur) is kept within the padding on each side so it is never hard-clipped at the window edge.
- **Theming & shared UI**: the popover follows the user's System/Light/Dark preference via the `.dark` class applied by `AppThemeProvider`, which the tray-panel branch of `AppShell` also mounts, reproduces the app background-image tone as a CSS gradient (light + dark), and reuses the app's shared `Button`, `HippiusLogo`, `BoxSimple` and `boring-avatars` identicon plus the sidebar's search-pill styling. The live chain block number under the account address is mirrored from the `block_number_updated` broadcast (`app.emit` reaches every window), avoiding a panel-local block subscription.
- **Window isolation**: `AppShell` renders the popover with no app providers, so it never creates a second tray icon or duplicates background work.
- **Notification bell**: the popover bell shows the live unread badge (via `get_unread_count` keyed by the account address — the same DB value the top-bar bell shows) and, on click, focuses the main window and emits `hippius:tray-open-notifications`, which the top-bar `NotificationMenu` listens for. The popover deliberately does NOT render the notifications menu itself — that component runs notification-_generator_ hooks (`useCreditsNotification`, `useFilesNotification`, `useNotifications`), so mounting it in a second window would duplicate notifications and API polls.
- **Signed-out behavior**: the popover only opens when signed in. The gate is in the **frontend** `handleTrayClick`, which checks `isAuthenticatedLatest` — a module-level mirror of the auth context's `isAuthenticated`, kept in sync by `useTrayInit`. When signed out it calls `openAppWindow()` instead of `toggle_tray_panel`. This is synchronous (no network) and matches the visible UI. **Do not** gate this on Rust's `AuthInfo.substrate_address` — that stays populated for a session restored from disk even while the UI is logged out, so it would wrongly open the popover. `toggle_tray_panel` performs no auth check itself.

### Known limitations

1. On **Linux** the rich popover is not shown at all; a true Linux popover would need a layer-shell surface Tauri's tray doesn't expose.
2. On macOS a plain always-on-top window activates the app on click (an `NSPanel` non-activating window is the eventual fix).

The old unattached full in-memory `Menu`/submenu machinery has been removed; `useTraySync.ts` attaches only the small `buildTrayContextMenu` right-click menu and drives the icon from the pure `tray/trayIconState.ts`.

## Tray panel UI (`app/tray-panel/page.tsx`)

A top-level route so it skips the `(pages)` sidebar layout. Self-contained: talks to the backend only via `invoke`, fetches its feed through `app/lib/tray/useTrayPanelData.ts`, and reuses shared app components (`NoEntriesFound` empty state, `Button`, `HippiusLogo`, `boring-avatars`).

It addresses the main window by its `"main"` label and drives it via events rather than navigating itself: **Open Hippius** just reveals main; the **bell** emits `hippius:tray-open-notifications`; **Search Files** emits `hippius:tray-focus-search` (focuses the sidebar `SidebarSearch`); the empty-state **Upload a File** CTA emits `hippius:tray-open-files` (navigates main to `/files` via `TrayNavigationListener`). It deliberately does NOT `router.push` a protected route from the popover webview, and uses a **static** `import { emit }` (not a dynamic `import()`) — a dynamic import in the isolated panel webview can fail to load its chunk and surface as a runtime/"internal server" error.

Above the date-grouped upload list (under the "Your Uploads" heading) it renders a **sync-progress summary** (`SyncSummary`) — percent + status word ("In Progress" / "Complete" / "Failed" / "Preparing") + a synced-vs-remaining line — driven by the pure `app/lib/tray/traySyncSummary.ts::getTraySyncSummary` resolver (mirrors the sidebar `SyncStatusDialog`; returns `null` when idle). The live snapshot it reads is exposed from `useTrayPanelData` (seeded via `sp_get_snapshot`, updated by `sync_progress_snapshot` events).

## Tray sync state cleanup

The tray-icon watcher in `useTraySync.ts` keeps module-level latch state (`latchedComplete`, `latchedSnapshot`, `lastSyncSummarySignature`) so a completed sync's icon survives the backend resetting its snapshot to an empty cycle; the latch *transition* logic itself is the pure, unit-tested `app/lib/tray/trayIconState.ts::deriveTrayIconState` (the watcher just stores its result). These are explicitly cleared in the `useTrayInit` logout cleanup effect to prevent stale data from a previous account appearing after account switch.
