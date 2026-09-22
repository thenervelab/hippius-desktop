---
paths:
  - "src-tauri/src/capture/**"
  - "app/capture-overlay/**"
  - "app/components/capture/**"
  - "app/lib/capture/**"
---

# Screen capture

Screenshots of an area, a window or a whole display, filed in `<drive>/Captures` with a public share link copied. Design and phasing: `docs/plans/2026-09-22-screen-capture.md`. Behind `SCREEN_CAPTURE_ENABLED = enabledFrom("staging")`, and behind Rust's `capture_support` for the platform: **macOS and Windows only** — xcap links PipeWire and XCB on Linux, which would add build packages to every release workflow and a runtime dependency to the `.deb`, so Linux reports unsupported until its desktop-portal path lands.

## Flow

`capture_start` → one overlay per display → `capture_select` / `capture_cancel` → screenshot on `spawn_blocking` → main window back → delivery in a spawned task → `capture_delivered` / `capture_failed` + an OS notification. The session (`session.rs`) is one-at-a-time and every phase change is broadcast as `capture_state_changed`; surfaces read that, never their own flags. A whole-screen capture on a single display skips the overlay.

**Delivery reuses, never re-implements**: the upload is `upload_files_to_remote_folder_inner` (so drive resolution, the storage gate and the upload-widget rows are the same as a dropped file) and the link is `share_external_file` (the Finder's path). Pinned by `tests/capture_wiring.rs`. The temp copy under `~/.hippius/capture-tmp/<one dir per capture>` is removed only after the upload lands; a failed upload keeps it and the notification names the path.

## Rules that fail silently

- **Coordinates.** xcap reports points on macOS and physical pixels on Windows; the overlay reports CSS points. `targets.rs` converts everything handed to the overlay; `geometry::crop_rect` rounds outward and clamps; the area crop's scale is read off the captured image (`image.width / display logical width`), not the display mode. Read as pixels, a Retina selection keeps a quarter of what the user framed and nothing errors.
- **Overlays are `content_protected(true)`** or they are in their own screenshot, and on macOS they are raised to the screen-saver level (`raise_above_menu_bar`), because Tauri's always-on-top sits below the menu bar.
- **The overlay route has the tray panel's dev/export split** (`capture-overlay` vs `capture-overlay.html`), boots provider-free in `AppShell`, and clears the root background in its own stylesheet at parse time.
- **The overlay capability (`capabilities/capture-overlay.json`) must match `OVERLAY_LABEL_PREFIX` and hold `core:` permissions only** — it sits over every app on screen. Pinned by `capture_wiring.rs`.
- **macOS Screen Recording is checked before capturing**, never discovered after: without it a capture returns the wallpaper with other apps blanked. The grant applies only after a relaunch, which `CapturePermissionDialog` says and offers.
- **Refusals are matched on `subkind`** (`CAPTURE_DESTINATION_UNSET`, `SCREEN_RECORDING_PERMISSION`) in `classifyCaptureRefusal`, because `NotReady` is silenced on several generic FE paths.
- **Events are listened for by string literal** (`listen("capture_delivered", …)`) and `capture/commands.rs` is in the IPC contract test's registry list, so a renamed event fails CI.
- **The destination is per account** (`capture_destination_v1:<account_key>` in `user_preferences`, a single namespace across accounts); own drives only for now, via `SyncFolderSelect`.

## Where Capture is offered

Inside a drive (the Drive toolbar), on the drive folder list (the Files page's `actions`, in the `showPlanCard` branch so it never appears twice), on Overview (the shared home `PageHeader`, opt-in via `showCapture` because that header is also Billing's, Wallet's, Referrals' and Plans'), and the tray. Not gated on the open drive's role: a capture goes to the capture drive, not the drive on screen. Pinned by `CaptureMenu.test.tsx` and `planCardWiring.test.ts`.

**`CaptureMenu` styles its own `DropdownMenuContent`** (background, border, item text, both themes). The shared primitive's base is `bg-popover`, a token this theme does not define, so an unstyled menu has NO background and its items are invisible in dark mode — which is how it first shipped.
