---
paths:
  - "src-tauri/src/capture/**"
  - "app/capture-overlay/**"
  - "app/capture-controls/**"
  - "app/capture-camera/**"
  - "app/capture-preview/**"
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
`capture-camera`): the bar's Loom-style sources panel (Screen / Camera / Mic
rows, each a switch plus a device menu) saves
`CaptureOptions.{screen, camera, camera_device, camera_size, microphone_device}`
at once. The mic row's level meter (`MicMeter`) opens the mic in the overlay
webview, found by name (`inputIdByName`); it unmounts with the bar before
the countdown so it never holds the device while recording.
`camera::wanted_shape` decides the window: while selecting it follows the
options live (so the bubble can be placed before recording); from Record on it
follows `recording_camera`, frozen in `select_inner` BEFORE the phase moves, so
a mid-recording option change never pulls the camera out of the video.
`sync_camera` applies it after every change; every ending calls `end_camera`.
Bubble = bottom-left, filmed with the screen (not filmed by a window
recording, which is one window only), sized by `CameraSize`: small 200 pt,
large 340 pt (round), full = the stage's 16:9 frame. The hover strip on the
bubble (small / large / full / ×) calls `capture_camera_set_size` (saved,
then the window glides via `camera::resize_bubble`, which keeps a bubble in
its corner or grows it from its centre, always on screen) and
`capture_camera_dismiss` (camera off while choosing, bubble hidden
mid-recording). Both emit `capture_options_changed` so the bar never saves a
stale copy back. Hover comes from Rust (`capture_camera_hover`, polling the
pointer against the frame) because a non-key window does not reliably get
webview hover on macOS. Screen off = **stage**: a
centred 16:9 window that `capture_confirm` records as `Selection::Window` by
its NSWindow `windowNumber`. **The camera window is the one capture window that
is NOT content-protected** (a protected one films as black), sits at level 1001
above the overlays, and opens without focus. **Devices:** the helper lists
cameras (`--list-cameras`, so the bar has them before any camera opened) and
microphones (`--list-microphones`: AVFoundation plus Core Audio inputs, the
system default marked and first; macOS 14's `.external` type covered cameras
only, which is why USB and virtual mics were missing). The webview's
`deviceId`s never match those ids, so `capture_camera_state` carries
`deviceName` and the camera page finds the camera by name
(`resolveCameraId`), opening the default first only when the webview cannot
name cameras yet; it reopens on `devicechange` or an ended track, keeping a
still-correct stream. `capture_set_cameras` remains the fallback list where
the system has none (`camera_list`, never a mix: the two id spaces would list
a camera twice). The mic is chosen by `microphoneCaptureDeviceID` (macOS 15).
Hardened builds need the `com.apple.security.device.camera` entitlement or the
camera fails silently. The pill can hide a bubble (`capture_camera_toggle`),
never the stage.

**Share picker** ("Choose what to share", `share.rs`,
`app/capture-overlay/SharePicker`): the bar's Choose… button opens Window /
Entire Screen tabs of live pictures. `capture_share_targets(first)` answers
the list plus whatever pictures are ready within `INLINE_BUDGET` (300 ms);
the rest stream as `capture_share_art` batches tagged with a token, refreshed
every `REFRESH_EVERY` until `capture_share_done(token)` or the choosing ends.
A stale token's batch is ignored (`mergeShareArt`). The list drops Hippius's
own windows, untitled ones, system chrome (`HIDDEN_OWNERS`), off-screen ones
and anything under 80x60 pt. Choosing calls the same `capture_select` as an
overlay click. While it is open the picker owns Return / Escape / arrows (the
overlay page skips its own key handler) and stops pointer events from
reaching the selection surface, or a click would pick the window under it.
Keep the logic module named `sharePickerState.ts`: a `sharePicker.ts` beside
`SharePicker.tsx` resolves as the component's import on a case-insensitive
disk.

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
- **Helper:** build with `macos/build-capture-helper.sh` (`--universal` for
  release). It is NOT a Tauri `externalBin`: `finalize-macos-release.sh`
  embeds it as `Contents/MacOS/HippiusCapture` and signs it with
  `macos/CaptureHelper.entitlements` (see macos-packaging.md). A release app
  looks ONLY there (`helper_candidates`); debug builds also try
  `macos/HippiusCapture/.build/{release,out/Products/Release,apple/...,debug}`.
  No helper = no Record actions and no camera or microphone lists, silently.
- **Destination** per account (`capture_destination_v1:<account_key>`); own
  drives only for now.

## The recording helper (`macos/HippiusCapture/Sources/main.swift`)

**Protocol.** One JSON object per line each way. Every command carries an
`id` the reply echoes; `wait_for` skips a reply with another id (a late
answer to an earlier command). `ready` and `stream_stopped` carry none.
`{"ok":false,"event":"stream_stopped","error","saved"}` is unprompted: the
stream ended on its own (display unplugged, window closed, permission
revoked, sleep) or the writer failed, and the helper has already finished the
file. The Rust reader thread records it (and a helper whose stdout closed) in
`Shared`; `Recorder::take_death` hands it out once; `spawn_tick_loop` then
calls `capture_stop`, whose `stop()` salvages the file (`kept_after`: a
finished file, or at least `MIN_PARTIAL_BYTES` of fragments) and delivers it.
stderr lines are diagnostics and are logged at `warn`.

**Media rules that fail silently:**
- ScreenCaptureKit sends `.idle` screen samples with no picture whenever the
  screen is still. Appending one fails the writer for good, so only
  `SCFrameStatus.complete` frames with an image buffer are appended.
- A plain CLI has no window-server connection: `SCContentFilter(
  desktopIndependentWindow:)` aborts in `CGS_REQUIRE_INIT` unless
  `CGMainDisplayID()` ran first (top of `main`).
- Size is in pixels, `sourceRect` in points: the output is the region times
  the backing scale (`pointPixelScale` on 14+, the display mode on 13),
  aligned outward to even pixels (`alignToPixels`) and capped at a 3840 long
  edge. H.264 High, keyframe every 2 s, bit rate by pixel count (about 14 Mbps
  at 1080p, 2..28 Mbps), sRGB tagged BT.709.
- Pause cuts time out: samples are retimed on the writer queue by the host
  time of every finished pause (`place`), video and audio alike, and samples
  inside a pause are dropped. SCK timestamps are host-clock time. The last
  frame is repeated at Stop so a still screen does not end the video early.
- `movieFragmentInterval` is 2 s, so a killed helper leaves a playable file;
  stdin closing (the app died) FINISHES the file and keeps it. Only `cancel`
  deletes.
- The camera stage is a window owned by the app (`owningApplication.processID
  == getppid()`), trimmed by `stageInset` (12 pt: the page's `p-1.5` margin
  plus the corner of `rounded-[18px]`) so its transparent corners and ring are
  not filmed as black. Pinned against `app/capture-camera/page.tsx`.
- `recording::start` refuses below `MIN_FREE_BYTES` (2 GB) free with a message
  saying so. The macOS version is read once (`macos_version`, `OnceLock`).

Driving the helper by hand (JSON on stdin, probe with AVFoundation) is the
fastest check: a 3 s display recording, an area with pause/resume, and a
window recording must each finish with a playable file.

## Where Capture is offered

The shortcut; Drive toolbar menu ("Open capture bar" + preselecting items),
Files list (showPlanCard branch), Overview (`showCapture`), tray popover button
(opens the bar on the last mode). Record modes only when
`capture_support.recording`. Settings › Sync & Storage has the Capture card
(shortcut, drive). Pinned by `tests/capture_wiring.rs` (content protection,
focus, capabilities, every command registered, retry path).
`CaptureMenu` styles its own `DropdownMenuContent` (theme has no `bg-popover`).
