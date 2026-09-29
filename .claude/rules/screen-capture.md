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

**Start:** `capture_start(kind?, mode?)` opens an overlay per display; the one
under the pointer (`bar::bar_display`, cursor from `NSEvent.mouseLocation`
flipped to the displays' top-left points on macOS, Tauri's physical cursor on
Windows) draws the ⌘⇧5-style **capture bar** (`app/capture-overlay/CaptureBar`).
No kind/mode = the last used (`capture_options_v1`, device-wide). There is no
"single display, capture at once" shortcut any more: Capture does that.

**Choosing:** the bar switches mode with `capture_set_mode` (session event
`SetMode`, valid only while `Selecting`). An area drawn on any display is held
in Rust (`capture_set_pending`, broadcast as `capture_pending_changed` so the
other displays drop theirs) and taken by the bar's button (`capture_confirm` →
`bar::resolve_confirm`: area = the held one, screen = the display the button is
on, window = must be clicked). Window/screen clicks still call `capture_select`.
The countdown (timer for screenshots, always 3 s for recordings,
`CaptureOptions::countdown_secs`) runs in the overlay BEFORE it confirms.

**Screenshot:** selection → pixels in memory (`screenshot::capture_image`) and
the card's JPEG from them (`thumbnail::from_image`) → preview card shown →
only then the PNG is written (`save_png`, fast compression) → delivery →
`capture_delivered` / `capture_failed`. Writing and re-decoding the PNG
before the card cost most of a second on Retina.

**Recording:** same selection, then Rust starts the platform `Recorder`
(macOS: Swift helper over JSON stdin/stdout) → `/capture-controls` bar
(timer / pause / resume / stop / cancel) → finalize MP4 → same delivery path.
Phases: `selecting` → `capturing` → `recording` ⇄ `paused` → `finalizing` →
`delivering` → `idle`. Broadcast only via `capture_state_changed`. Mic and
click rings come from the saved options, each gated on macOS 15
(`recording::microphone_supported` / `show_clicks_supported`; the helper reads
`showClicks`). A still of the first frame is taken before the recorder starts,
for the card.

**Camera and microphone** (`camera.rs`, `app/capture-camera`, label
`capture-camera`): the bar's recording row (Screen / Camera / Mic chips) saves
`CaptureOptions.{screen, camera, camera_device, microphone_device}` at once.
`camera::wanted_shape` decides the window: while selecting it follows the
options live (so the bubble can be placed before recording); from Record on it
follows `recording_camera`, frozen in `select_inner` BEFORE the phase moves, so
a mid-recording option change never pulls the camera out of the video.
`sync_camera` applies it after every change; every ending calls `end_camera`.
Bubble = 200 pt round window, bottom-left, filmed with the screen (not filmed
by a window recording, which is one window only). Screen off = **stage**: a
centred 16:9 window that `capture_confirm` records as `Selection::Window` by
its NSWindow `windowNumber`. **The camera window is the one capture window that
is NOT content-protected** (a protected one films as black), sits at level 1001
above the overlays, and opens without focus. The webview opens the camera
(`getUserMedia`, wry grants it) and reports device names via
`capture_set_cameras`, since only it can name `deviceId`s. Microphones are
listed by the helper (`--list-microphones`), chosen by
`microphoneCaptureDeviceID` (macOS 15). Hardened builds need the
`com.apple.security.device.camera` entitlement or the camera fails silently.
The pill can hide a bubble (`capture_camera_toggle`), never the stage.

**Preview card** (`app/capture-preview`, label `capture-preview`, `preview.rs`):
prewarmed hidden at `capture_start`, shown when the file exists, bottom-right
of the bar display's WORK area (`work_area`: NSScreen `visibleFrame`, not the
full display, or it sits under the Dock), `focused(false)` + content-protected +
`accept_first_mouse(true)` (never key, so without it every button needed two
clicks). Stays `AUTO_HIDE_MS` (10 s) once done, held while hovered.
Rust owns its status (`uploading` → `syncing` / `uploaded` / `failed`),
keyed by a per-capture `id` so a late outcome never lands on a newer card; progress comes from `remote_upload_progress`. On success there is NO
system notification (the card says it); a failure notifies as well. Show in
folder emits `capture_show_in_folder` → `driveFolderRoute(label, remote,
"Captures")` → the Drive page steps into the folder with the row's own
`generateFolderUrl`. Retry re-runs `deliver_and_announce` on the kept file.

**Menu bar:** while recording, the tray title shows the time and a tray click
calls `capture_stop` (`app/lib/tray/trayCaptureState.ts`). Title writes go
through one serial queue seeded from `capture_state` and drop stale ones:
async `setTitle` calls finish out of order, and a late "❚❚ 00:10" once stayed
in the menu bar after the recording was saved.

**Sync queue Show in folder:** each row's folder button fires
`requestOpenDriveFolder(driveFolderRoute(label, remote, parentOf(path)))`
(a window event, so the widget needs no router); `TrayNavigationListener`
navigates and `folderUrlForPath` opens a multi-level path.

**Shortcut** (`shortcut.rs`, `tauri-plugin-global-shortcut`, macOS/Windows):
default `CommandOrControl+Shift+2`, stored `capture_shortcut_v1` (`off` =
disabled). Registered from `CaptureHost` via `capture_sync_shortcut`; the
handler only emits `capture_shortcut_pressed` so refusals reach the same
dialogs (`useStartCapture` brings the main window forward for them). A new
shortcut is registered before it is saved, so one another app holds is refused
and the old one stays; no modifier and macOS's ⌘⇧3–6 are refused.

**Delivery is local-first for a drive synced here**: the file is moved into
`<local root>/Captures` (`free_name` never overwrites) and `trigger_sync_now`
uploads it; the card is `syncing` and follows the sync engine's row. Uploading
it directly as well made the engine sync it back down, so it showed twice in
the sync queue. Other drives reuse, never re-implement,
`upload_files_to_remote_folder_inner`; both then `share_external_file`.
Pinned by `tests/capture_wiring.rs`. Temp under
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

The shortcut; Drive toolbar menu ("Open capture bar" + preselecting items),
Files list (showPlanCard branch), Overview (`showCapture`), tray popover button
(opens the bar on the last mode). Record modes only when
`capture_support.recording`. Settings › Sync & Storage has the Capture card
(shortcut, drive). Pinned by `tests/capture_wiring.rs` (content protection,
focus, capabilities, every command registered, retry path).
`CaptureMenu` styles its own `DropdownMenuContent` (theme has no `bg-popover`).
