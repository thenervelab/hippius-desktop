---
paths:
  - "src-tauri/src/capture/**"
  - "app/capture-overlay/**"
  - "app/capture-controls/**"
  - "app/components/capture/**"
  - "app/lib/capture/**"
  - "macos/HippiusCapture/**"
---

# Screen capture

Screenshots and (on macOS) recordings of an area, a window or a whole display,
filed in `<drive>/Captures` with a public share link copied. Design and
phasing: `docs/plans/2026-09-22-screen-capture.md`. Behind
`SCREEN_CAPTURE_ENABLED = enabledFrom("staging")`, and behind Rust's
`capture_support` for the platform: **screenshots on macOS and Windows**;
**recording on macOS 13+** when `HippiusCapture` is built. Linux reports
unsupported until its desktop-portal path lands. Windows recording is stubbed
behind the `Recorder` trait (`capture_support.recording == false`).

## Flow

**Screenshot:** `capture_start` → overlay(s) → `capture_select` /
`capture_cancel` → PNG on `spawn_blocking` → delivery → `capture_delivered` /
`capture_failed`.

**Recording:** same selection, then Rust starts the platform `Recorder`
(macOS: Swift helper over JSON stdin/stdout) → `/capture-controls` bar
(timer / pause / resume / stop / cancel) → finalize MP4 → same delivery path.
Phases: `selecting` → `capturing` → `recording` ⇄ `paused` → `finalizing` →
`delivering` → `idle`. Broadcast only via `capture_state_changed`.

**Delivery reuses, never re-implements**: `upload_files_to_remote_folder_inner`
+ `share_external_file`. Pinned by `tests/capture_wiring.rs`. Temp under
`~/.hippius/capture-tmp/<one dir per capture>`; removed only after upload lands.

## Rules that fail silently

- **Coordinates.** xcap points on macOS / physical on Windows; overlay CSS
  points. `geometry::crop_rect` rounds outward; area crop scale from the image.
- **Overlays and the control bar are `content_protected(true)`** or they film
  themselves. Overlays are raised to screen-saver level on macOS.
- **Overlay / controls routes** have the tray panel's dev/export split and boot
  provider-free in `AppShell`.
- **Capabilities** (`capture-overlay.json`, `capture-controls.json`) must match
  the window labels and hold `core:` permissions only.
- **macOS Screen Recording** checked before capturing; grant needs relaunch.
- **Refusals** matched on `subkind` in `classifyCaptureRefusal`.
- **Helper:** build with `macos/build-capture-helper.sh`; embed release apps
  with `macos/embed-capture-helper.sh`. Rust resolves it next to `current_exe`
  or under `macos/HippiusCapture/.build/`.
- **Destination** per account (`capture_destination_v1:<account_key>`); own
  drives only for now.

## Where Capture is offered

Drive toolbar, Files list (showPlanCard branch), Overview (`showCapture`),
tray (screenshot area). Record items only when `capture_support.recording`.
`CaptureMenu` styles its own `DropdownMenuContent` (theme has no `bg-popover`).
