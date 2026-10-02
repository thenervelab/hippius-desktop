---
paths:
  - "src-tauri/src/capture/**"
  - "app/capture-overlay/**"
  - "app/capture-controls/**"
  - "app/capture-camera/**"
  - "app/capture-preview/**"
  - "app/capture-area/**"
  - "app/components/capture/**"
  - "app/lib/capture/**"
  - "src-tauri/src/tray/**"
  - "app/components/page-sections/drive/highlightEntry.ts"
  - "app/components/page-sections/drive/useDriveHighlight.ts"
  - "app/tray-panel/TrayCaptureRow.tsx"
  - "macos/HippiusCapture/**"
---

# Screen capture

Screenshots and (on macOS) recordings of an area, a window or a whole display,
filed in `<drive>/Captures`, with a public share link copied unless
`CaptureOptions.copyLink` is off. Design and
phasing: `docs/plans/2026-09-22-screen-capture.md`. Behind
`SCREEN_CAPTURE_ENABLED = enabledFrom("beta")` (beta and staging, not
production), and behind Rust's `capture_support` for the platform:
**screenshots on macOS, Windows and Linux** (Windows and Linux on staging
only); **recording on macOS 13+** when
`HippiusCapture` is built, and on Windows 10 2004+ and Linux (X11 and
Wayland) in debug and staging builds only (`capture::rollout`, until each
platform's checklist passes).

**Windows and Linux parity plan:** `docs/plans/2026-10-01-capture-windows-linux.md`.
Read it before touching a non-macOS capture path. Its load-bearing decisions:
Windows and Linux record in a child process of the app
(`Hippius --capture-recorder`) speaking the Swift helper's JSON protocol
through one shared `HelperRecorder`; Windows = WGC + Media Foundation
fragmented MP4 + WASAPI, no ffmpeg; Linux = portals (`ashpd`, on the zbus 5
already in the graph) on Wayland, x11rb and `ximagesrc` on X11, GStreamer from
the distro for the file; Wayland has no overlay (the system picker chooses);
per-platform rollout lives in Rust (`capture::rollout`), not in new frontend
flags. Note: xcap 0.9.8's `wgc` feature has no GDI fallback.

**Phase 0 and 1 of that plan are in.** `recording/protocol.rs` holds the wire
types both ends use; `recording/helper.rs` is the platform-free
`HelperRecorder` (handshake, ids, deaths, salvage) that `macos.rs` drives the
Swift helper with and `windows.rs` / `linux.rs` will drive
`Hippius --capture-recorder` with (`helper::own_recorder_command`). The child
(`capture/recorder_child/`) is branched into at the very top of `main`
(`cli::argv_requests_recorder`), before `load_env` and the builder, or a
second window, tray and single-instance handler would start; pinned by
`capture_wiring.rs`. It serves the protocol with `timeline.rs` (the Swift
`place` rule: drop samples inside a pause, move later ones back by every
finished pause, by start time for audio), `sizing.rs` (`alignToPixels`,
`capped`, `videoBitRate`, pinned against `main.swift`'s literals) and a
`synthetic` test pattern through a text stand-in writer; a real `start` is
refused with `UnsupportedPlatform`'s line where no platform recorder has
landed (Linux; Windows has one, below).
Drive it by hand: `{"cmd":"start","id":1,"output":"/tmp/x.txt","synthetic":true}`.
**Rollout:** `rollout::floor(platform, feature)` is the lowest lane per row
(debug builds count as staging); `commands::capture_supported()` and
`recording::recording_unavailable()` both ask it, so a platform below its
lane reads exactly as unsupported. `SCREEN_CAPTURE_ENABLED` stays the one
frontend switch. Moving a row on is a one-line change once its manual
checklist passes; `release_lane_pins.rs` pins that production enables only
production rows and that Windows recording needs a signed installer to get
there. **Surfaces:** `support::Surfaces` (selection, modes, screenshotTimer,
systemAudio, microphoneUnavailableMessage, continuityHint, shortcut) is flattened into
`capture_support` and `OverlayContext`; the bar draws only Rust's `modes`,
hides the timer when `screenshotTimer` is false, hides "Record system audio"
when `systemAudio` is false and captions the mic row with Rust's line (it
used to hard-code "macOS 15"). The shared `StartCommand` carries the
recording's `systemAudio` and a window recording's `cameraWindowId` (the
bubble), so every recorder gets them.

**Phase 2 (Windows recording) is in code, not yet run on hardware.** The
child's platform-free pieces (`mixer`, `pcm`, `frame`, `pacing`, `plan`,
`pipeline`) are tested everywhere; `recorder_child/windows/` is WGC
(`windows-capture`) + WASAPI + a Media Foundation FMPEG4 sink writer. Rules:
every device has ONE owner thread (WGC's thread, one per WASAPI client, the
writer thread for the file; the camera belongs to the bubble's webview and
is filmed as a window, never opened by the recorder), because macOS's
shared capture session made the camera and the mic fight. All times are QPC
microseconds (WGC `SystemRelativeTime`, WASAPI QPC positions, pause), so one
`Timeline` places both. `started` waits for the first picture to build the
writer, so a missing encoder fails Start with its reason. App ids are xcap's
low 32 bits of the HMONITOR/HWND, sign-extended back in the child. The app
side probes Media Foundation once per launch on its own thread
(`mediaFeaturePackMissing`), lists mics through `--list-microphones`, reads
the ConsentStore for a blocked mic (`MIC_BLOCKED_WINDOWS`), and
`webview_media.rs` answers WebView2's `PermissionRequested` (camera, mic) for
`capture-camera` and `capture-overlay-*` and the app's own origin only,
pinned in `capture_wiring.rs`. `frame::to_nv12` converts a 4K or larger
picture in up to 4 row bands (`bands_for`), byte-identical to one thread
(pinned by `bands_give_the_same_bytes_as_one_thread`; spike W3's numbers
are in the plan's "Parity gaps" section). Not done: a GPU colour converter.
Run-time proof on real runners, not only compile checks: `ci.yml`'s
`capture-runtime-windows` / `capture-runtime-linux` drive the built binary
as the child (`tests/capture_recorder_runtime.rs`, `.claude/rules/testing.md`).
Cross-check from a Mac with the MSVC
headers from `xwin` (`CFLAGS_x86_64_pc_windows_msvc` with clang's own
include dir FIRST, or the MSVC intrinsics headers break aws-lc), and pass
`--target` before `--`, or clippy builds the build script for Windows.

**Phases 5 and 6 for Windows are in code, not yet run on hardware.**
The child's `--meter [endpointId]` (`meter.rs` pure, `windows/audio.rs`
WASAPI) is `recording::meter_command` on Windows, so `mic_meter` and the
one-owner rule work unchanged; `--list-cameras` is `MFEnumDeviceSources`.
System audio is process loopback excluding the app's tree on build 22000+
(`sources::system_audio_route`, the pid in `HIPPIUS_CAPTURE_APP_PID` set by
`recording::windows::helper_command`), plain loopback otherwise or on any
refusal. A device lost mid-recording is a non-fatal `device_lost` line,
kept apart from replies and deaths by `HelperRecorder` and sent to the pill
as `capture_device_lost` with Rust's line. `privacy.rs` puts
`privacyBlocked` / `cameraUnavailableMessage` in the overlay context and
`capture_open_privacy_settings` opens only the webcam or microphone page.
A window recording with the bubble runs a second WGC session on the
bubble's window and composites its latest picture into the window's
(`wgc::WithCamera`, `overlay.rs` keeps only the bubble's shape, since a
transparent margin can arrive black); both windows' pictures are kept even
while paused. A start failure the user cannot act on reads
`START_FAILED`, never an HRESULT. Plan: Phase 5 and 6 sections.

**Phase 3 (Linux screenshots) is in.** X11 = `capture/linux_x11/` (x11rb:
RandR monitors, EWMH windows front first, `GetImage` of the root; `model.rs`
is the pure half, tested everywhere; `os.rs` Linux only), re-exported by
`targets`, `screenshot` and `share`, so the overlay flow is Windows'. Rules
that fail silently there: **one scale per X screen** (GDK's: `GDK_SCALE`,
else the XSETTINGS `Gdk/WindowScalingFactor`, whole numbers only), every
value in physical root pixels (`COORDS_ARE_LOGICAL` false); **overlays are
made full screen** (`cover_whole_display`) or GNOME and KDE push them below
their panels and every area read back is shifted; **no content protection**,
so every Linux session sets `ui_in_grabs` and `settle_compositor` sleeps
`COMPOSITOR_SETTLE` before the grab; a window shot is the screen where the
window is (a covered window shows what covers it). Wayland =
`capture/linux_portal.rs`: `support::start_plan` sends a Wayland screenshot
past the overlay to `system_picker_screenshot` (session `Capturing` while
the desktop's tool is open; a cancel there is a quiet cancel, everything
else `fail_capture`); `settle` MOVES the portal's PNG into the capture
folder under the Hippius name, never follows a symlink, and says
`PORTAL_MISSING` / `PORTAL_FAILED` in Rust's words. The frontend branches
only on Rust's `selection` (one "Take a screenshot…" item, no capture bar)
and `shortcut.supported` / `unavailableMessage` (no keycaps, Settings shows
the line). The `rust-linux-test` CI job runs
the X server test under Xvfb. Pinned by `capture_wiring.rs`.

**Phase 4 (Linux recording) is in code, not yet run on Linux.** The child
(`recorder_child/linux/`) has one GStreamer pipeline and one pulling thread
per device (`capture.rs`: `ximagesrc` or the ScreenCast portal's
`pipewiresrc`; `pulsesrc` for the mic and `@DEFAULT_MONITOR@`), and writes
through an `appsrc` pipeline (`encoder.rs`) driven by the shared
`writer_loop.rs`; pause, mixing and held pictures are Rust's (`timeline`,
`mixer`, `pacing`), never pad probes on a live pipeline. The pure decisions
are `linux_plan.rs`, tested everywhere. Rules that fail silently: **every
pipeline uses `gst::SystemClock`** (`launch` sets it), since a buffer's
capture time is base time plus timestamp and pause reads the same clock;
`ximagesrc` corners are INCLUSIVE; the `size` capsfilter starts open and is
fixed from the first frame (`plan::output_size`); the writer's `appsrc`s
never block and the queues before `mp4mux` are unbounded, or the one writer
thread deadlocks between the tracks; the portal's PipeWire fd stays open for
the recording and the session is closed with it. The camera is opened here
only for camera only on Wayland (below), and the Linux mic meter is the child's `--meter` through the shared
`recorder_child/meter.rs` (Windows' and Linux's meters only open the device
and hand samples to its `serve`, so both print the Swift meter's lines),
stopped before the recorder opens the mic. A sound pipeline that fails
mid-recording ends only its thread and says `device_lost` with its source's
name, the same event Windows sends. The bubble's
`getUserMedia` exists on Linux only because `webview_media_gtk.rs` turns
WebKitGTK's media stream on and allows user-media and device-info requests,
for the capture windows and the app's own pages only (pinned in
`capture_wiring.rs`); `--list-cameras` names cameras as WebKitGTK does
(both are GStreamer's names). The app probes once
per launch (`--probe`, warmed at launch by `warn_if_helper_missing`) for
`codecsMissing` / `portalMissing`, and waits up to 5 minutes for `started` on
Wayland (the desktop's dialog). **Wayland records from the panel**
(`StartPlan::Panel`): one `capture-overlay-0` window with the bar alone,
no display watch, no countdown on the overlay (`countdownAfterPicker`: the
pill counts once the dialog is answered), Record resolved by
`support::system_picker_selection`; a cancel in the desktop's dialog is the
child's exact `PICKER_CANCELLED` refusal, which `fail_capture` ends quietly.
The restore token (`screencast_token.rs`, device-wide) is sent only for a
whole screen on a one-display machine: a restored session skips the dialog.
CI's `rust-linux-test` runs the ignored real-writer tests
(`capture::recorder_child::linux -- --ignored`). Cross-check from a Mac with
the fake `.pc` files: `cargo check` and `cargo clippy --lib --tests` for
`x86_64-unknown-linux-gnu` work; `-- -D warnings` rebuilds the build script
for the target and fails, so read the warnings instead.

**Phase 6 (Linux) is in code, not yet run on Linux.** The shortcut on X11
is the plugin's (`main.rs` registers it only where
`shortcut::plugin_grabs_keys`: never on Wayland, where an XWayland grab sees
only XWayland windows, and where the plugin's state is missing, so
`shortcut::apply` must not reach `global_shortcut()` there). On Wayland
`shortcut_portal.rs` binds through the GlobalShortcuts portal (one task owns
the connection and session; `Activated` for its own session path and id
goes to `on_shortcut`; Settings shows the desktop's trigger text, never
keycaps, since the desktop has the last word), gated by the lane's
`ShortcutPortal` row; without a portal `support::shortcut_for` says
`desktopSettings` with `shortcut.command` (`<exe> --capture`), which the
single-instance handler turns into `on_shortcut` WITHOUT showing the main
window, and `desktop_shortcut.rs` writes GNOME's custom keybinding at
Hippius's own path. Linux marks the tray icon like Windows and, since
AppIndicator sends no click, puts the recording's menu on it
(`tray_recording_menu.rs`, rewritten only on a state change; one listener
added once); the main window puts its menu back on
`capture_tray_icon_released`. The pill is filmed on Linux
(`support::pill_filmed`): compact until pointed at or focused, a one-time
note (`capture_controls_context`), and outside an X11 area recording
(`camera::pill_outside`). An X11 window recording composites the bubble
like Windows (`Video::start_with_camera`, `linux_x11::WindowReader`,
`overlay.rs`), from the XID the app stores when the camera opens.
`RecordingUnavailable::line` names only the missing packages on Linux; use
it, not `message`, for anything the user reads.

**Wayland area and camera only are in code, not yet run on Linux.**
*Area* (`area_pick.rs`, pure): offered wherever Wayland records; the panel's
Record is `system_picker_selection(Area)` (an empty rect) and
`begin_recording` sets `pickArea` (`support::picks_area_after_dialog`). The
child asks the portal for a monitor (the screen's restore token applies,
`screencast_token::applies`), reads it whole as BGRx (`capture::Held`) and
answers `start` with `area_still` (the first picture as JPEG, at most
2560 px, the stream's size in pixels, the portal's place for it when
given), holding every later picture back with no sound open and no file.
`draw_area` shows `capture-area` (own capability, provider-free route,
closed by `close_overlays`) full screen on the GTK monitor at the stream's
place (`monitor_for`, else the compositor's pick); the page sends the drawn
rect in CSS px with the picture's box, Rust maps it to stream pixels
(`stream_area` over `plan::area_pixels`: ratio = stream width over shown
width, so HiDPI and fractional scaling need nothing more), destroys the
window, waits two `COMPOSITOR_SETTLE`s (the window is in the stream until
the compositor drops it) and sends `crop`; the child then opens the sound
and the writer as a plain start would and cuts each picture in Rust
(`frame::to_nv12` reading the area's rows in place; nothing renegotiates).
`AreaStep` takes one area, only while drawing; a cancel at any step hands
the recorder back uncropped to `adopt_recorder`; five minutes undrawn ends
as quietly as a cancelled dialog. The pill counts after the crop, and may
sit inside the area (Wayland places no window). *Camera only*:
`support::camera_only(platform, recorder_camera)` is true on Wayland only
where the probe's `camera` found a camera source, `decodebin` and
`videoflip` (`Probe::records_camera`). `capture_confirm` gives a nominal
screen, `begin_recording` names the camera (`CameraPick`, the bar's id and
name) and asks no dialog, and `CameraState.recorderOwnsCamera` makes the
stage page close its stream for a placeholder (one owner per device). The
child finds the device in `GstDeviceMonitor` by id, then by
`camera_name_key`, else the default (`pick_camera`), makes the device's
own element (what WebKitGTK makes), retries a busy one for 3 s, tries
bounded caps then any, mirrors it like the stage and records it with the
same writer, mixer and pause. Pinned by `capture_wiring.rs`.

## Flow

**Start:** `capture_start(kind?, mode?)` opens an overlay per display; the one
under the pointer (`bar::bar_display`, cursor from `NSEvent.mouseLocation`
flipped to the displays' top-left points on macOS, Tauri's physical cursor on
Windows) draws the ⌘⇧5-style **capture bar** (`app/capture-overlay/CaptureBar`).
No kind/mode = the last used (`capture_options_v1`, device-wide). There is no
"single display, capture at once" shortcut any more: Capture does that.
`capture_start` never prompts for Screen Recording: it refuses with
`NotReady(ScreenRecordingPermission)` and the permission dialog takes over
(see "Screen Recording permission" below). Only
the bar's overlay takes focus. The frontmost app (pid) is remembered and
re-activated when the overlays close; the main window comes back per
`restore_plan` (hidden stays hidden, behind stays behind via `orderBack:`,
front only if it was key), and never mid-recording (it would be filmed). A
display watch (`spawn_display_watch`, 1.5 s) closes overlays of unplugged
displays, drops a pending area on them, opens overlays on new ones, moves the
bar, and re-reads the cached work areas.

**Choosing:** the bar switches mode with `capture_set_mode` (session event
`SetMode`, valid only while `Selecting`). An area drawn on any display is held
in Rust (`capture_set_pending`, broadcast as `capture_pending_changed` so the
other displays drop theirs) and taken by the bar's button (`capture_confirm` →
`bar::resolve_confirm`: area = the held one, screen = the display under the
pointer (`bar::display_under`, else the one the button is on: the keyboard is
on the bar's overlay, so Return must not take that display when the user
points at another), window = must be clicked).
**Window and entire screen are click-to-capture** (macOS's ⌘⇧4 then Space;
`app/capture-overlay/clickCapture.ts`): the pointer is a camera cursor (SVG
data URL, hotspot on the lens; a red record-dot lens for recordings), the
window under it is tinted and outlined with its app name (screen: the display
under it, tinted, "Click to capture this screen"), and ONE click calls
`capture_select` with that window or display; no bar button is needed. Space
swaps window and area (`spaceToggleMode`, only to a mode `offeredModes` allows
for the kind, never mid-drag, never with the camera alone, and never from a
focused bar control). The bar stays up in a slot with a plain cursor that
clears the hover on enter; its own pointer handlers stop a click reaching the
surface. The overlay only draws and reports: the window list is Rust's, and it
already drops every Hippius window by pid (`targets::is_pickable`), so the
overlay, bar, pill, card and camera can never be picked.
The countdown (`CaptureOptions::countdown_secs`: the screenshot timer 0/5/10,
`record_countdown_secs` 0/3/5 for recordings, both normalised in Rust) runs in
the overlay BEFORE it confirms. `capture_set_options` returns `SavedOptions
{ options, countdownSecs, cameraFilmed }` and IGNORES the bar's
`lastKind/lastMode` (the session's are kept; a stale bar copy flipped the next
shortcut's mode). The last area per display is Rust's
(`capture_last_areas_v1`, `bar::fit_area`), seeded as `pending` at start. The
window-mode refusal is `ConfirmError::NeedsWindowClick`; the bar shows Rust's
message. `capture_refresh_windows(displayId)` re-lists windows for live hover:
the overlay polls it every `WINDOW_REFRESH_MS` (700 ms, `pollWindows`, one
request at a time) only while `mode === "window"`, the page is visible and no
countdown or capture is running. The bar saves through `saveCaptureOptions`
and takes `countdownSecs` and `cameraFilmed` from Rust's answer; it never
works them out. The Options menu holds the drive, the screenshot timer or the
recording countdown (None / 3 / 5 seconds), "Record system audio"
(`systemAudio`, off by default like Loom: with speakers it records the voice
twice; offered only where Rust's `systemAudio` surface says this platform
can record it, and `begin_recording` asks for it only there), Show mouse clicks, and "Copy a share link after capture" (`copyLink`). Clicking the countdown numeral or
pressing Return while counting runs the waiting action at once. Camera only
is macOS, Windows and X11, and Wayland where the probe allows it
(`camera_only_supported` from `support::camera_only`, `for_system` turns
the screen back on elsewhere; Windows records the camera window's HWND, X11
its XID with the stage's margin cut by `videocrop`, Wayland has the
recorder open the camera itself); the sources panel shows the Screen switch only when
`cameraOnlyAvailable`, and the camera row says "Camera is only recorded with
the entire screen or an area." whenever `cameraFilmed` is false (a window
recording where the recorder cannot add the camera window:
`bar::window_recording_adds_camera`, everywhere but Wayland).

**Screenshot:** selection → pixels in memory (`screenshot::capture_image`) and
the card's JPEG from them (`thumbnail::from_image`) → preview card shown →
only then the PNG is written (`save_png`, fast compression) → delivery →
`capture_delivered` / `capture_failed`. Writing and re-decoding the PNG
before the card cost most of a second on Retina.

**Recording:** same selection (at least 2 GiB free under capture-tmp, checked
before the phase moves), then Rust starts the platform `Recorder` (macOS:
Swift helper over JSON stdin/stdout) → `/capture-controls` bar (timer / pause /
resume / stop / cancel / restart) → finalize MP4 → same delivery path.
Phases: `selecting` → `capturing` → `recording` ⇄ `paused` → `finalizing` →
`idle`. **The session ends at `Captured`**: the upload belongs to the preview
card (keyed by its id), so a new capture can start while a long one uploads.
Broadcast only via `capture_state_changed` as `PhaseEvent {..phase, seq}`,
emitted under the phase lock (`CaptureState::apply`) so events never arrive
out of order; `capture_state` returns the same shape for seeding.

**Session invariants (each pinned):** every failure after `Selected` ends in
ONE place, `fail_capture` (Failed, `capture_failed`, recorder cancelled, dir
removed, pill/overlays/unused card closed, windows restored, camera ended); a
`?` that skipped it once left the phase stuck and every later start refused.
A started recorder is taken only by `adopt_recorder`, which checks the phase
and stores it under the phase lock; a Cancel during "Starting recording…"
hands it back to be cancelled (otherwise the helper kept recording with no
UI). Cancel is refused in `Finalizing` (`AlreadySaving`): the stop task owns
the file. Stop stops the recorder BEFORE `end_camera` (camera only records the
camera window). Pause/resume run in `spawn_blocking`; the tick `try_lock`s the
recorder, and every capture lock recovers from poison (`lock`). Restart =
`Restart` event → back to `Capturing`, the kept `selection` restarted. Pinned
by the fake-`Recorder` harness in `commands.rs` and `tests/capture_wiring.rs`. Mic and
click rings come from the saved options, each gated on macOS 15
(`recording::microphone_supported` / `show_clicks_supported`; the helper reads
`showClicks`). **The card's picture is a frame of the saved file**
(`poster.rs`): at Stop the helper's `--poster <video> <seconds>...`
(`Poster.swift`, AVAssetImageGenerator, about 0.25 s) reads stills at
`poster::candidate_times` (1 s in, or the middle of a shorter one, then the
middle, then three quarters), Rust keeps the first that is not black
(`is_blank`) and `pick` falls back to the still of the selection taken as the
recorder starts. That start still missed the camera bubble (it moves into
what is filmed at that same moment) and gave a camera-only recording no
picture at all. On Windows and Linux `poster_command` is the recorder
child's `--poster` (`recorder_child/poster.rs` shared: clamp, 1120 px, JPEG,
the helper's line; `windows/poster.rs` Media Foundation Source Reader
in NV12, `linux/poster.rs` GStreamer preroll and accurate seeks), which is
the only picture a Wayland recording gets. The child stops after the first
lit still (software decode from the key frame must fit `poster::WAIT`); a
Linux machine with an encoder but no H.264 decoder gets no picture, and
`codecsMissing` does not say so.

**Camera and microphone** (`camera.rs`, `app/capture-camera`, label
`capture-camera`): the bar's Loom-style sources panel (Screen / Camera / Mic
rows, each a switch plus a device menu) saves
`CaptureOptions.{screen, camera, camera_device, camera_size, microphone_device}`
at once. **Only the camera window may call `getUserMedia`.** WebKit lets one
page per process capture: a page starting capture mutes every other page's
camera and mic (`WebProcessProxy::muteCaptureInPagesExcept`, Cocoa), and a
muted camera stays black until that page asks again, even after the other
let go; WebKit's mic also runs voice processing that alters what the
recorder hears from the same mic for a few seconds after it closes. So the
mic row's level meter (`MicMeter`) is the helper's (`HippiusCapture --meter
[deviceId]`, plain AVFoundation, by the helper's own id, no name matching;
on Windows `Hippius --capture-recorder --meter [endpointId]`, WASAPI),
run by `capture::mic_meter` (one process, a generation per start so a late
stop never ends its replacement) and sent as `capture_mic_level` (0..1,
`level_from_rms`). `meter_may_run` allows it only while choosing a
recording; `emit_phase` stops it on every other phase, before the recorder
opens the mic. The camera page covers a muted or not-yet-playing camera with
a placeholder (`showsPlaceholder`) and reopens one muted for
`MUTE_RECOVERY_MS`, at most `MUTE_RECOVERY_TRIES` in a row. Pinned by
`onlyCameraCaptures.test.ts`, `mic_meter::tests` and `capture_wiring.rs`.
`camera::wanted_shape` decides the window: while selecting it follows the
options live (so the bubble can be placed before recording); from Record on it
follows `recording_camera`, frozen in `select_inner` BEFORE the phase moves, so
a mid-recording option change never pulls the camera out of the video.
`sync_camera` applies it after every change; every ending calls `end_camera`.
Bubble = bottom-left, filmed with whatever is recorded; while choosing an
AREA recording it sits inside the drawn area's bottom-left
(`camera::bubble_in_area`). **At Record (`Capturing`) `sync_camera` moves a
bubble that is not wholly inside what is filmed** (`recording_bubble_frame` →
`camera::bubble_for_recording`: the area, the window's frame from xcap, or
the recorded display's usable corner), without the glide; one already inside
stays where the user put it. A **window recording** films one window, so the
bubble was left out while on screen: `begin_recording` passes its window
number (`RecordOptions.camera_window` → `cameraWindowId`) and the helper
records both windows. Hidden from the pill mid-recording the window is
`hide()`n (ordered out), never closed, so it keeps that number and its place;
a re-created window would not be in the recording's filter. Sized by
`CameraSize`: small 200 pt, large 340 pt (round, whole-point squares from
every placement and resize), full = the stage's 16:9
frame, which stays above the bar block (`BAR_BLOCK_HEIGHT`, it sits at a
higher level than the overlay). `sync_camera` holds `camera_lock` for its whole run. The hover strip on the
bubble (small / large / full / ×) calls `capture_camera_set_size` (saved,
then the window glides via `camera::resize_bubble`, which keeps a bubble in
its corner or grows it from its centre, always on screen) and
`capture_camera_dismiss` (camera off while choosing, bubble hidden
mid-recording). Both emit `capture_options_changed` so the bar never saves a
stale copy back. The strip exists only on a bubble that is not recording
(`stripShown`, from `CameraState.recording`, which Rust sets from Capturing a
recording on; the camera page follows no phase of its own): the camera window
is filmed, so a strip shown mid-recording was in the video; the pill hides
the bubble instead (no resizing mid-recording: the strip lives in the filmed
window). The × is "Turn camera off" while choosing and "Hide
camera" while recording (`cameraCloseLabel`). While choosing it is always mounted, faded until
hovered or focused, so Tab reaches it. Its third button is a toggle
(`sizeControls`): at full size it is "Exit full size" (Minimize2) back to the
round size from before (`nextRoundSize`), and Escape on the camera window
does the same before it would cancel; asking for full again did nothing, so
there was no way back. No native `title` on this window: the strip names the
hovered or focused button in its own `role="tooltip"` label. The `<video>` is
mirrored, so WebKit's start-playback button (shown on a paused or not yet
playing video) was a backwards triangle on the bubble; CSS cannot remove
WebKit's modern controls, so the video is `opacity-0` until `playing` (and
again on `pause`), and the page calls `play()` itself.
**The camera page is sized by its window, never by the video**: its root
is `fixed inset-0` and the frame's shape is `cameraFrameShape` (round:
`aspect-square`, capped at the window's height; full and stage: fill with
18 px corners). This page's `<html>`/`<body>` have no height, so an `h-full`
root took the camera's 16:9 picture as its height and the round bubble was a
pill, on screen and in every video; pinned by `cameraPage.test.tsx`.
Hover comes from Rust (`capture_camera_hover`, polling the
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
**External and iPhone devices:** macOS offers an iPhone as a Continuity
Camera only to a process whose Info.plist sets
`NSCameraUseContinuityCameraDeviceType`, so both carry it: `src-tauri/Info.plist`
(the camera window's `getUserMedia`) and the helper, which as a bare tool has
its plist (`macos/HippiusCapture/Info.plist`) linked in as `__TEXT,__info_plist`
by `Package.swift`'s `-sectcreate`; `embed-capture-helper.sh` refuses a helper
without it, pinned in `tests/capture_wiring.rs`. SwiftPM does not relink when
only that plist changes: touch a source file. The list modes run one
discovery, wait up to 1.5 s for the list to go quiet (0.4 s without a new
`wasConnectedNotification`) because remote devices can arrive a beat late,
then print. Names match through `deviceNameKey` (NFC, straight quotes, single
spaces), since a phone's name carries a curly apostrophe. The bar re-reads
both lists on menu open and on the overlay's `devicechange`.

only that plist changes: touch a source file. A phone's camera and
microphone are separate devices and reach a fresh process late, the
microphone often after the camera, so a one-shot list missed it. The list
modes hold a `DeviceWatch` (live discovery sessions, connect/disconnect
notifications, a Core Audio device-list listener) and wait up to 1.5 s for
0.4 s of quiet, or up to 3 s while a Continuity camera is listed without its
microphone. **Live lists:** `device_watch.rs` runs the helper's
`--watch-devices` from the bar's first device read until `close_overlays`
(stdin closing ends it; it also exits after 30 min) and every list it prints
replaces `native_cameras` and goes out as `capture_cameras` /
`capture_microphones`; the overlay's `devicechange` is only a bonus (WebKit
fires it only for a page holding a capture grant). Windows and Linux run the
recorder child's `--watch-devices` the same way (`watcher_command`; the
shared loop is `recorder_child/watch.rs`: settle 300 ms, 3 s poll, print
only on change, end on stdin close or 30 min). Windows nudges it from
`IMMNotificationClient` and `CM_Register_Notification` on the camera
interface classes, Linux from one `GstDeviceMonitor`'s bus; both re-read
with the list modes' own code, so ids stay what the recorder opens. Pinned in
`capture_wiring.rs`. Each device carries `continuity` (transport `ccwd` /
`ccwl` / `ccap`, since `isContinuityCamera` is false for the phone's
microphone), and a menu that lists none shows Rust's `continuityHint`
(macOS only). Menus show skeleton rows until the first list and one while a
read is in flight. `start` waits up to 3 s for a chosen microphone that is
not listed yet, then records the default with a stderr line, matching what
the bar shows for an unplugged choice. Names match through `deviceNameKey` (NFC, straight quotes, single
spaces), since a phone's name carries a curly apostrophe. `MicMeter`
reopens by name once the first grant names the microphones.
Hardened builds need the `com.apple.security.device.camera` entitlement or the
camera fails silently. The pill can hide a bubble (`capture_camera_toggle`),
never the stage.

**Share picker** ("Choose what to share", `share.rs`,
`app/capture-overlay/SharePicker`): the bar's "Choose window…" / "Choose
screen…" button opens Window / Entire screen tabs of live pictures, with the
frontmost window (or the bar's display) picked. `capture_share_targets(first)` answers
the list plus whatever pictures are ready within `INLINE_BUDGET` (300 ms);
the rest stream as `capture_share_art` batches tagged with a token, refreshed
every `REFRESH_EVERY` until `capture_share_done(token)` or the choosing ends.
A stale token's batch is ignored (`mergeShareArt`). Batches go to the bar's
overlay only (`emit_to`): they are pictures of every window. The list drops Hippius's
own windows, untitled ones, system chrome (`HIDDEN_OWNERS`), off-screen ones
and anything under 80x60 pt. Choosing calls the same `capture_select` as an
overlay click. While it is open the picker owns Return / Escape / arrows (the
overlay page skips its own key handler), traps Tab, returns focus to its
opener on close, and stops pointer events from reaching the selection
surface, or a click would pick the window under it. The grid is one Tab stop
(roving `tabIndex`); `gridStep` moves the pick in two dimensions.
Keep the logic module named `sharePickerState.ts`: a `sharePicker.ts` beside
`SharePicker.tsx` resolves as the component's import on a case-insensitive
disk.

**Preview card** (`app/capture-preview`, label `capture-preview`, `preview.rs`):
prewarmed hidden at `capture_start`, shown when the file exists, bottom-right
of the bar display's WORK area (`work_area`: NSScreen `visibleFrame`, not the
full display, or it sits under the Dock), `focused(false)` + content-protected +
`accept_first_mouse(true)` (never key, so without it every button needed two
clicks). Stays `AUTO_HIDE_MS` (10 s) once done, held while hovered (the timer bar
stays mounted and pauses, or the card changes height under the pointer).
It must fit 316 x 330 in every state: it sits at the window's bottom, so an
overflow clips the TOP (the close button first). Hence the 16:9 picture and
the one-line failure reason with the full text in `title`, and ONE row of
actions where no label wraps (`whitespace-nowrap` on every text button): one
primary that takes the spare room (Show in folder, or Upgrade / Retry), one
compact secondary sized to its label (Copy link / Create link / Retry /
Discard) and at most one 32 pt icon button with an `aria-label`. Show in
Finder / Explorer and Revoke link live in the "More" menu (opens upward over
the picture, focus on its first item, arrows move, Escape closes and refocuses
More); with Upgrade, Retry and Discard all present, Discard is the icon.
Pinned by `previewPage.test.tsx` across every state. It listens to upload progress only while `uploading` / `syncing`
(`wantsProgress`): it is prewarmed hidden at every capture start. The page
only draws the percent of a row joined on label + `relPath`; it never decides
from a progress row that a capture is done or failed (a "completed" row still
shows 99% until Rust says `uploaded`).
Rust owns its status (`uploading` → `syncing` / `uploaded` / `failed`),
keyed by a per-capture `id` so a late outcome never lands on a newer card; progress comes from `remote_upload_progress`.
Delivery tells the card twice (`deliver_and_announce`): `deliver::place`
puts the file in the drive and `announce_placed` makes the card `syncing`
(synced) or `uploaded` (direct) with `LinkState::Creating` ("Creating
link…") at once; only then `deliver::link_for` mints and `announce_link`
settles the link, keeping whatever status the upload reached. Telling the card
only after both held it on "Preparing upload" (= `uploading`) through the
whole upload and mint. A `syncing` card is moved on by Rust
(`spawn_sync_follow`, started at placement), from `sync_facts`: the live
session row, `recent_files` (completed rows leave the session) and the
engine's synced set (`finder_bridge::badges::is_synced`, looked up in NFC
and NFD, never scanned), matched by label + `preview::same_drive_path` (NFC,
`\` → `/`, leading `/` dropped, absolute paths ending in `relPath`, never
trimmed). A row whose upload is still encrypting reads `Encrypt`, so both
actions count. Bounded fallback: a `syncing` card with a public link, no row
anywhere and an idle engine for `LINK_FALLBACK_AFTER` (45 s) is marked
uploaded (`link_fallback_applies`). `PreviewCard.settled` (uploaded and the
link not `Creating`) is what the card's auto-hide waits for, so it never slides
away before it can say the link was copied.
Rust also owns `link` (`LinkState`), `linkText` ("Public link copied") and
`actions` (`CardActions`: retry, discard, copyLink, mintLink, revokeLink,
reveal, upgrade) through `PreviewCard::refreshed`; every change goes through
`update_card`. The card draws exactly those buttons and says `linkText` after
"Uploaded". `upgrade` (a `storageFull` failure) calls `capture_preview_upgrade`,
which brings the main window forward and emits `capture_open_plans`;
`CaptureHost` routes it to `BILLING_ROUTE`, where every upgrade prompt goes.
Reveal is labelled "Show in Finder" / "Show in Explorer" (`fileManagerLabel`). Failure copy is `deliver::failure_copy` (offline / storage full
/ Rust's own `Validation` text; never a transport error), with `reason` and
`retryable`. `capture_failed` carries `cardShowing`, and `CaptureHost` shows no toast
when it is true (the card already says it); the notification never names a
path. A failed card closed by the user is PARKED and comes back on the
next `capture_start`, until retried or discarded. On success there is NO
system notification (the card says it); a failure notifies as well. Show in
folder emits `capture_show_in_folder` → `driveFolderRoute(label, remote,
"Captures", fileName)` → the Drive page steps into the folder with the row's
own `generateFolderUrl`, then points the file out (see "Show in folder points
the file out" below). Retry re-runs `deliver_and_announce` on the kept file, to
the card's own `destination` (not whatever the capture drive is now).
`DriveContainer` handles each open request once (`shouldOpenFromUrl`, keyed on
the params, not the mount: the page stays mounted across clicks) and waits
one listing refresh for a subfolder that is not listed yet
(`resolvePendingFolder`: a first capture creates Captures). Folder names
compare in NFC and are never trimmed.

**Recording pill:** Escape does nothing there (the pill turns key when
clicked, so a stray Escape discarded recordings). The trash and Restart
(`capture_restart`, which throws the take away) act at once under
`DISCARD_CONFIRM_SECS` (5 s) and ask first from then on; "Keep recording"
and Escape at the question give focus back to the button that asked. There is
no mic mute: the helper has no command for it. The pill applies a phase only
when its `seq` is newer than the one it shows. It drags by
`data-tauri-drag-region` (`-webkit-app-region` is Electron-only), which needs
`core:window:allow-start-dragging` in `capture-controls.json`.

**Menu bar (Rust owns it; the webview never writes the title):** every
phase broadcast goes through `emit_phase`, which also calls
`show_phase_in_tray`: the title is the time for Recording ("◼ 00:15") and
Paused ("❚❚ 00:15") and EMPTY for every other phase (`tray_status::tray_title_for`).
It is written only when the text changes (`tray_needs_write` against
`tray_last`), so a screenshot never touches the status item.
Empty, never `None`: `tray-icon` ignores a `None` title on macOS, which is
what left a saved recording's time frozen in the menu bar. Windows has no
title, so the tooltip carries the time (`tray_text_for`), and Windows and
Linux (many panels show no label) get a red (paused: amber) dot on the
icon (`write_tray_glyph`, XP-15), redrawn on every write so a sync icon
swapped in by `useTraySync.ts` is covered within a second; at the end it
puts the plain icon back and emits `capture_tray_icon_released`, on which
the main window re-applies its own. Linux also swaps in the recording's
menu (`write_tray_menu`, only on a state change), which the main window
replaces with its own on that same event. The write is POSTED
to the main thread (`run_on_main_thread`), never awaited: it runs under the
phase lock and `set_title` blocks on the main thread, where a sync command may
be waiting for that lock. A late write is dropped by `seq`
(`newest_for_tray`). The icon is found by `tray_status::TRAY_ID`
(= `TRAY_ID` in `useTraySync.ts`). A left click reaches Rust's own tray
listener (`Builder::on_tray_icon_event` → `tray::panel::on_tray_icon_event`),
never a webview callback (see tray.md), which asks `commands::on_tray_click`:
`tray_status::tray_click_route` sends a signed-in click to the popover in
every phase; Recording/Paused also bring the pill back (without focus; never
a stop, the pill has Stop) and the popover opens content-protected. A
signed-out click goes to the main window, or only to the pill mid-recording. Pinned
by `tray_status` unit tests, the `commands.rs` session tests and
`tests/capture_wiring.rs`. The camera and card
pages keep the "an event beats a late first read" rule; the pill compares
`seq`.

**Sync queue Show in folder:** each row's folder button fires
`requestOpenDriveFolder(driveFolderRoute(label, remote, parentOf(path),
baseNameOf(path)))` (a window event, so the widget needs no router);
`TrayNavigationListener` navigates and `folderUrlForPath` opens a multi-level
path.

**Show in folder points the file out** (`openFile` param →
`DriveContainer` `highlightRequest` → `useDriveHighlight`, pure steps in
`drive/highlightEntry.ts`). Once the requested level is listed it finds the
file (exact name, NFC, never a folder) in the order the level is SHOWN: the
table's sort for a local level in list view (the comparators live in
`FilesTable`, which reports the sorted level via `onSortedLevel` only while a
request waits), the level as-is in card view, and for a server-paged remote
level Rust's `locate_remote_folder_entry`, which walks the server's pages
with the page size and sort on screen. Then it sets the page, scrolls the row
or card (`data-drive-entry`) to the centre, sets `data-drive-highlight` for
`HIGHLIGHT_MS` (brand tint plus outline in `globals.css`, its own `.dark`
colours, duration pinned to the constant) and focuses the row's first
control. It does NOT enter the table's bulk-selection mode. A file not listed
yet (just written) is looked for again on each listing refresh, nudged every
`HIGHLIGHT_RETRY_EVERY_MS`, for `HIGHLIGHT_WAIT_MS` after the level is ready,
then dropped quietly; a folder that never opens drops the request after
`HIGHLIGHT_OPEN_LIMIT_MS`. `shouldOpenFromUrl` keys on the file too, so a
second capture in the same folder is pointed out as well.

**Shortcut** (`shortcut.rs`, `tauri-plugin-global-shortcut`, macOS, Windows
and X11; Wayland in Phase 6 above):
default `CommandOrControl+Shift+2`, stored `capture_shortcut_v1` (`off` =
disabled). Registered from `CaptureHost` via `capture_sync_shortcut`. It
toggles, decided by `shortcut::action_for` in `commands::on_shortcut`:
recording/paused → stop, selecting → cancel, capturing/finalizing → focus,
signed out → main window forward, else emit `capture_shortcut_pressed` so a
start's refusals reach the same dialogs (`useStartCapture`). `logout_full`
calls `end_for_logout` first: cancels a live capture, forgets the cards,
unregisters the shortcut. A new
shortcut is registered before it is saved, so one another app holds is refused
and the old one stays; no modifier, macOS's ⌘⇧3–6 and Windows' own capture
keys (Win+Shift+S, Print Screen with or without Win or Alt, Win+Alt+R,
Win+Alt+Print Screen) are refused, each system's list only on that system
(`shortcut::reserved_by`, checked before the modifier rule so Print Screen
alone is named as Windows' key). The Windows default stays Ctrl+Shift+2 for
now (it collides with Windows Terminal and Excel); changing it is an open
product decision. A refusal
names another copy of Hippius when one is running (`shortcut::held_message`,
from NSWorkspace's running apps by bundle id or name; Windows says the plain
sentence). A saved shortcut that did not register at start-up is kept in
`CaptureState.shortcut_problem` and shown by Settings (`ShortcutSetting.problem`).

**Delivery is local-first for a drive synced here**: the file is moved into
`<local root>/Captures` (`free_name` never overwrites) and `trigger_sync_now`
uploads it, STARTED in a spawned task, never awaited (it runs a whole sync
round of every drive, the upload included); the card is `syncing` and
follows the sync engine. Uploading
it directly as well made the engine sync it back down, so it showed twice in
the sync queue. A PAUSED drive counts as remote (`own_local_path` filters
`is_paused`), or the card waited on sync forever. The move never overwrites
(the name is claimed with a hard link) and a cross-volume copy goes through a
hidden `.hippius-incoming-capture-*.part` the engine skips. Other drives
reuse, never re-implement, `upload_files_to_remote_folder_inner`. The link
(`deliver::mint`, only when `copyLink`) is `share_synced_file` for a synced
capture (records the share origin, so Drive shows and can revoke it) and
`share_external_file` otherwise; `capture_preview_mint_link` /
`capture_preview_revoke_link` (`hcfs_revoke_share`) reuse the same paths.
Pinned by `tests/capture_wiring.rs`. Temp under
`~/.hippius/capture-tmp/<one dir per capture>`, 0700; removed after the upload
lands, except a direct upload without a link keeps it (for Create link) until
its card closes. At launch (`reclaim_capture_tmp_at_launch`, its own
thread) empty folders older than 24 h and leftover-only ones (poster,
fragments) older than 7 days go; a folder holding a capture (`.mp4`/`.mov`/
`.png` that is not `poster.png`) is NEVER removed, since the helper keeps a
playable MP4 when the app dies mid-recording (`screenshot::is_orphan`).

## Rules that fail silently

- **Coordinates.** xcap points on macOS / physical on Windows; overlay CSS
  points. `geometry::crop_rect` rounds outward; area crop scale from the image.
- **Overlays and the control bar are `content_protected(true)`** or they film
  themselves. Overlays are raised to screen-saver level on macOS; every
  capture window gets `FullScreenAuxiliary` so it can show over a full-screen
  app without switching Spaces.
- **Placement.** Work areas are read once per capture (one main-thread hop)
  and cached per display (`work_areas`); nothing waits on AppKit when a window
  is placed. Windows places in physical pixels (`place`, from the area's
  `scale`): it has no global logical space. `show_without_focus` on Windows
  shows a hidden window unfocusable and leaves a visible one alone (a second
  plain `show` activates it). Overlays are `destroy`ed, not closed, so a quick
  restart can reuse the label.
- **Overlay / controls routes** have the tray panel's dev/export split and boot
  provider-free in `AppShell`. `AppShell`, `app/layout.tsx` and
  `app/not-found.tsx` are in every window's first chunk list, so none of
  them may import the app tree or a UI/hook/utils barrel statically
  (`FullAppShell` and `NotFoundContent` load through `next/dynamic`). One
  static import put 1.4 MB of polkadot, react-query and framer-motion into
  each overlay; pinned by `app/components/__tests__/appShellSplit.test.ts`.
- **Keyboard on the overlay.** An open bar menu owns the keyboard from a
  capture-phase window listener (Escape closes only the menu and refocuses
  its trigger; arrows / Home / End move; Return never reaches the page). The
  page ignores Return and arrows that start on a control (`isFromControl`),
  so Return on a focused bar button is the button's. Escape stops a running
  countdown; once the capture is in flight it cancels. The countdown's live
  region is always mounted.
- **Floating-window styling** comes from `app/lib/capture/glass.ts` (one
  glass, one accent, `GLASS_FOCUS`) and `floating-window.css` (transparent
  window, system font). Text on the glass is never below white/60; every
  `animate-*` carries `motion-reduce:animate-none`.
- **Capabilities** (`capture-overlay.json`, `capture-controls.json`) must match
  the window labels and hold `core:` permissions only. The pill is dragged
  (`data-tauri-drag-region`), so its capability has
  `core:window:allow-start-dragging`.
- **macOS Screen Recording** checked before capturing; grant needs relaunch
  (flow below). The macOS version is read once per launch, in ONE cache
  (`permissions::macos_version`, `(major, minor)`): the permission pane's
  name (`macos_major`) and the recording gates (`recording::macos_at_least`)
  both read it.
- **Refusals** matched on `subkind` in `classifyCaptureRefusal`.
- **Windows exclusion is read back, not assumed.** `content_protected` is
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, whose failure tao
  discards. `open_overlay` reads `GetWindowDisplayAffinity` back
  (`kept_out_of_captures`); below build 19041
  (`permissions::windows_build`, `RtlGetVersion`, read once) or on a failed
  read the session sets `ui_in_grabs`, and `finish_screenshot` then waits for
  the destroyed overlays to go, hides the card (`clear_screen_for_grab`) and
  runs `DwmFlush` twice before the pixels are read. Pinned by
  `capture_wiring.rs`.
- **Windows shots use Windows.Graphics.Capture** (xcap `wgc`, no GDI
  fallback in 0.9.8): GDI rendered a DPI-unaware app's window as its
  top-left fraction on a scaled monitor. Windows 10 may flash WGC's yellow
  border; spike W1 in the plan measures it on hardware.
- **Windows DPI:** every value is physical pixels divided by the display's
  OWN scale (`targets::to_logical_on`, `screenshot::area_scale`), and floating
  windows go back to physical pixels with the work area's own scale
  (`physical_frame`, `card_frame`). Mixed-DPI pairs, a monitor above or left
  of the primary and a window straddling a seam are pinned as unit tests on
  every OS.
- **Windows dev builds:** toast notifications need the AppUserModelID the
  installers register, so `pnpm tauri dev` on Windows silently drops the
  "Capture not uploaded" notice; the card's Failed state still shows.
- **Windows virtual desktops:** `visible_on_all_workspaces` is a no-op there,
  so the pill and card stay on the desktop they opened on when the user
  switches mid-capture. Accepted for now (plan XP-16).
- **Helper:** build with `macos/build-capture-helper.sh` (`--universal` for
  release). It is NOT a Tauri `externalBin`: `finalize-macos-release.sh`
  embeds it as `Contents/MacOS/HippiusCapture` and signs it with
  `macos/CaptureHelper.entitlements` (see macos-packaging.md). A release app
  looks ONLY there (`helper_candidates`); debug builds also try
  `macos/HippiusCapture/.build/{release,out/Products/Release,apple/...,debug}`.
  No helper = no working Record actions and no camera or microphone lists.
  It is NOT silent any more: `recording::recording_unavailable()` gives the
  reason (`RecordingUnavailable`: `helperMissing` / `osTooOld` /
  `unsupportedPlatform`, checked in that order of platform, then macOS 13,
  then helper, so an old Mac is told to update; plus `codecsMissing`,
  `portalMissing`, `mediaFeaturePackMissing` for the Linux and Windows
  recorders, and `osTooOld` names Windows 10 2004 on Windows), and `RecordingAvailability`
  (the reason plus Rust's line) is flattened into `capture_support` and the
  overlay context as `recordingUnavailable` / `recordingUnavailableMessage`.
  `disabledRecordingNote` (`app/lib/capture/modes.ts`) turns every reason
  but `unsupportedPlatform` into disabled Record modes with that line on the bar (`aria-disabled`, not
  `disabled`, so the tooltip shows; a click puts the line on the hint), in
  the Capture menu (a line above disabled items) and as a Settings row;
  `unsupportedPlatform` still hides them. `capture_start` / `capture_set_mode`
  refuse a recording with the same line. A release build logs a `warn` once
  at launch when the helper is missing (`warn_if_helper_missing`, own thread:
  `sw_vers`). Pinned by the `recording::tests` reason tests and the vitest
  bar, menu, host and Settings tests.
- **Local builds:** plain `pnpm tauri:build` has no helper (it only prints a
  notice after, `scripts/capture-helper-notice.mjs`); `pnpm build:mac-local`
  builds, embeds, re-signs and makes a DMG (see macos-packaging.md).
- **Destination** per account (`capture_destination_v1:<account_key>`); own
  drives only for now.

## Screen Recording permission (macOS)

`CGPreflightScreenCaptureAccess` turns true only in a process started after
the grant, and TCC keys the grant to the app's designated requirement: stable
for a certificate-signed app, the code hash for an ad hoc one, so every ad hoc
rebuild is a new app whose Settings entry may show "on" for an older build.
`permission_flow.rs` holds the decisions (unit-tested); `CapturePermissionDialog`
only draws what `capture_permission_status` answers (vitest per state):

- **`notAsked`** (nothing asked for THIS build, keyed by
  `CodeSignature::key()`: the team when signed, the cdhash when ad hoc, read
  once via `SecCodeCopySigningInformation`): "Allow" →
  `capture_request_permission` → `CGRequestScreenCaptureAccess`, macOS's
  prompt, which adds Hippius to the list switched off. A bare "asked once"
  flag used to survive rebuilds and `tccutil reset`, so the button opened
  Settings on a list without Hippius and the user had to press "+".
- **`asked`**: "Open System Settings". It calls `CGRequestScreenCaptureAccess`
  first (no UI while macOS has an answer on record; re-adds an entry removed
  since), then opens the pane.
- **"Relaunch Hippius"** is `capture_relaunch_for_permission`: records the
  build in `capture_screen_permission_relaunched_v1` while still denied, then
  `request_restart` (Tauri's restart, which frees the single-instance socket
  before the new process starts). The dialog never calls plugin-process.
- **`stale`**: that build was relaunched for the grant and is still denied.
  The dialog says to remove Hippius with the minus button and press Allow
  again; "Allow again" is `capture_reset_permission`: `tccutil reset
  ScreenCapture <bundle id>` (Hippius's own entry only, no privileges needed),
  then a fresh prompt. If `tccutil` fails the pane opens and the dialog gives
  the manual steps. Seeing the grant clears the relaunch marker.
- **`adHocSigned`** adds a line that this build loses the permission on
  every rebuild; `pnpm build:mac-local` avoids it by signing with a real
  identity (macos-packaging.md).
- **The helper needs no grant of its own.** It is a plain child process
  (`Command::spawn`, no launchd or XPC), so Hippius is its responsible process
  and TCC attributes its ScreenCaptureKit and microphone use to Hippius;
  `HippiusCapture` never appears in the list.

Pinned by `permission_flow::tests`, `CapturePermissionDialog.test.tsx` and
`tests/capture_wiring.rs` (the Settings path asks macOS before opening the
pane; the relaunch is recorded before the restart; the reset runs `tccutil`
before asking).

## The recording helper (`macos/HippiusCapture/Sources/main.swift`)

**Protocol.** One JSON object per line each way. Every command carries an
`id` the reply echoes; `wait_for` skips a reply with another id (a late
answer to an earlier command). `ready` and `stream_stopped` carry none.
`{"ok":false,"event":"stream_stopped","error","saved"}` is unprompted: the
stream ended on its own (display unplugged, window closed, permission
revoked, sleep) or the writer failed, and the helper has already finished the
file. The Rust reader thread records it (and a helper whose stdout closed) in
`Shared`; `Recorder::take_death` hands it out once; `tick_once` then spawns
`stop_inner` (never the `capture_stop` command) and ends the tick loop, and
the recorder's `stop()` salvages the file (`kept_after`: a
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
- **One audio track.** Browsers (the share link's page included) and most
  players play only a file's first audio track, so the microphone as a
  second track went unheard. `AudioMixer` mixes the microphone and, only when
  `systemAudio` is on, the system audio (`capturesAudio`) into one stereo
  48 kHz AAC track at 160 kbps: each source converted to float 48 kHz (a mono
  mic in both channels), placed by its retimed timestamp against the first
  frame, continuing from its last buffer unless that is off by more than
  50 ms, overlaps dropped, and handed out once every source reached a frame or
  one lags by 300 ms. The mic gets +6 dB (a built-in mic records speech near
  -33 dBFS) and a soft limiter above 0.8 stops clipping. No source = no audio
  track. Pinned by `a_recording_has_one_audio_track`.
- **A window recording with the camera** (`cameraWindowId`, not the window
  itself) is `SCContentFilter(display:including: [window, camera])` cut to the
  window's frame at start: only those two windows are drawn, but the video does
  not follow the window if it is moved. Without the camera it is
  `desktopIndependentWindow` as before.
- The camera stage is a window owned by the app (`owningApplication.processID
  == getppid()`), trimmed by `stageInset` (12 pt: the page's `p-1.5` margin
  plus the corner of `rounded-[18px]`) so its transparent corners and ring are
  not filmed as black. Pinned against `app/capture-camera/page.tsx` and
  `cameraDevices.ts` (`cameraFrameShape`).
- `--poster <video> <seconds>...` prints one line, `{"duration", "frames":
  [{"time", "jpeg": base64}]}`, each time clamped into the video, and exits;
  `poster::tests` pins the flag and the line against the Swift source.
- `recording::start` refuses below `MIN_FREE_BYTES` (2 GB) free with a message
  saying so.

Driving the helper by hand (JSON on stdin, probe with AVFoundation) is the
fastest check: a 3 s display recording, an area with pause/resume, and a
window recording must each finish with a playable file.

## Where Capture is offered

The shortcut; `CaptureButtons` (`app/components/capture/CaptureButtons.tsx`):
**Screenshot** and **Record**, each a normal toolbar button with a chevron
that opens its own Radix menu (no separate "…" button): the kind's modes
("Capture an area / a window / entire screen", `modeLabel` + `MODE_ICON`),
each `startCapture(kind, mode)`, then a separator, "Open capture bar" with the
shortcut's keycaps (`startCapture(kind)`: the bar on that kind's last mode)
and "Change capture drive…". The modes come from `offeredModes(kind,
captureModesAtom)`: Rust's `capture_support.modes` (`supportedModesOf`, set
by `CaptureHost`), else all three until it has answered. Rendered in
the folder list's toolbar (`DriveOnboarding`, `size="compact"`, 26px), the
in-drive toolbar (`DriveHeader`, every drive, a Viewer's shared drive included:
a capture is filed in the capture drive, not the open one) and Overview's Recent Files toolbar
(`DriveHeader`'s recent layout, just before Folder and File; never in the
shared home `PageHeader`, which Billing, Wallet, Referrals and Plans use too). Labels show at `@[52rem]` of the app's scroll
`@container`; below it the buttons are an icon and the chevron, named by
`aria-label` + `title`.
Record's state comes from ONE helper, `recordAvailability`
(`app/lib/capture/recordAvailability.ts`): hidden off macOS without recording,
shown `aria-disabled` with Rust's reason on a Mac without it (not `disabled`,
which would swallow the tooltip), and then it is a plain button, not a menu
trigger, so no menu opens. The reason is `capture_support.recordingUnavailable`
(`helperMissing` / `osTooOld` / `unsupportedPlatform`) with Rust's line in
`recordingUnavailableMessage`; `unsupportedPlatform` hides Record, the other two
disable it. The capture bar's Record modes and Settings show the same line. The tray popover has its labelled Capture button
(`TrayCaptureButton`, opens the bar on the last mode; its slot is held while
support is asked). Mode names and icons come from `app/lib/capture/modes.ts`.
Settings › Sync & Storage has the Capture card (shortcut, drive). Pinned by
`CaptureButtons.test.tsx`, `drive/__tests__/captureButtonsPlacement.test.tsx`,
`drive/__tests__/recentFilesCapture.test.tsx`
and `tests/capture_wiring.rs` (content protection, focus, capabilities, every
command registered, retry path). Each menu styles its own
`DropdownMenuContent` (theme has no `bg-popover`).
