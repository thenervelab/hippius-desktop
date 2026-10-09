---
paths:
  - "src-tauri/src/capture/**"
  - "app/capture-overlay/**"
  - "app/capture-controls/**"
  - "app/capture-camera/**"
  - "app/capture-bubble-controls/**"
  - "app/capture-preview/**"
  - "app/capture-area/**"
  - "app/components/page-sections/settings/EditedImageSetting.tsx"
  - "app/components/page-sections/settings/Capture*.tsx"
  - "app/components/capture/**"
  - "app/components/page-sections/captures/**"
  - "app/components/page-sections/drive/driveRoute.tsx"
  - "app/lib/capture/**"
  - "src-tauri/src/tray/**"
  - "app/components/page-sections/drive/highlightEntry.ts"
  - "app/components/page-sections/drive/useDriveHighlight.ts"
  - "app/tray-panel/TrayTiles.tsx"
  - "macos/HippiusCapture/**"
---

# Screen capture

Screenshots and (on macOS) recordings of an area, a window or a whole display,
filed at the root of the account's own captures drive (`Hippius Captures`,
"Destination" below), with a public share link copied unless
`CaptureOptions.copyLink` is off. Design and
phasing: `docs/plans/2026-09-22-screen-capture.md`. Built into every lane
(`SCREEN_CAPTURE_ENABLED = true`, production included), and behind Rust's
`capture_support` for the platform, which is what keeps Windows and Linux
out of production. **No surface may read the flag alone**: the Captures nav
entry and page, the Settings section and the image editor entries go
through `useCaptureAvailability` (flag AND `captureSupportedAtom`, with
`captureSupportKnownAtom` so nothing redirects or resets before Rust has
answered), the tray through `useTrayCaptureView`; pinned by
`app/lib/capture/__tests__/captureProductionGates.test.tsx`. Platforms:
**screenshots on macOS, Windows and Linux**; **recording on macOS 13+**
when `HippiusCapture` is built, and on Windows 10 2004+ and Linux (X11 and
Wayland). Windows and Linux are on in debug, staging and beta builds and off
in production (`capture::rollout`, until each platform's hardware checklist
passes, and for Windows recording a signed installer).

**Windows and Linux parity plan:** `docs/plans/2026-10-01-capture-windows-linux.md`.
Read it before touching a non-macOS capture path. Its load-bearing decisions:
Windows and Linux record in a child process of the app
(`Hippius --capture-recorder`) speaking the Swift helper's JSON protocol
through one shared `HelperRecorder`; Windows = WGC + Media Foundation
fragmented MP4 + WASAPI, no ffmpeg; Linux = portals (`ashpd`, on the zbus 5
already in the graph) on Wayland, x11rb and `ximagesrc` on X11, GStreamer from
the distro for the file; Wayland has no live overlay (the system picker
chooses a recording, and the desktop's screenshot tool a screenshot, Phase 3 below);
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
`capped`, `videoBitRate`, the keyframe interval, pinned against `HippiusCapture.swift`'s literals) and a
`synthetic` test pattern through a text stand-in writer; a real `start` is
refused with `UnsupportedPlatform`'s line where no platform recorder has
landed (Linux; Windows has one, below).
Drive it by hand: `{"cmd":"start","id":1,"output":"/tmp/x.txt","synthetic":true}`.
**Rollout:** `rollout::floor(platform, feature)` is the lowest lane per row
(debug builds count as staging); `commands::capture_supported()` and
`recording::recording_unavailable()` both ask it, so a platform below its
lane reads exactly as unsupported, and the frontend needs no new flag. Moving a row on is a one-line change once its manual
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
window is (a covered window shows what covers it). **Wayland screenshots
go straight to the desktop's own tool** (`StartPlan::SystemPicker`,
`Surfaces.selection` = `systemPicker`, no screenshot modes, no timer,
`systemPickerNote` shown in the Capture menu and Settings): the portal
with `interactive = true` is GNOME Shell's screenshot UI, the one
selection step. Choosing on a still (below) is **off**
(`frozen_screenshot: false` everywhere): GNOME 46's portal answers the
non-interactive request with its own "Share this screenshot" dialog after
the whole screen was taken, and under XWayland with a scaled display the
overlay and the still did not line up (overlay offset and scaled down).
Kept wired for a desktop where it can be proven. The still's path, when
on (`frozen_shot.rs`, pure; `StartPlan::Frozen` from
`Surfaces.frozen_screenshot`): `frozen_screenshot` hides the card, waits two
`COMPOSITOR_SETTLE`s (the main window was hidden at start), asks the
Screenshot portal with `interactive = false` (`portal_still`: GNOME 42's
portal takes it at once with a flash and no dialog; newer portals ask once
and remember; the portal's file is moved into a capture folder by `settle`
and removed once read, so nothing is left under Pictures), cuts it into one
slice per GDK monitor (`monitor_slices`: one raster of the layout's
bounding box at one scale, refused when the two axes' scales disagree by
more than `SCALE_TOLERANCE`) and opens the ordinary overlay page full screen
on each monitor (`open_frozen_overlay`, `fullscreen_on_monitor` by GDK
index; display id = monitor index, bar on GDK's primary), which draws its
monitor's still behind everything (`capture_overlay_backdrop`, a JPEG data
URL read once; the context says only `frozen`). Area and entire screen
only (`modes.screenshot`; no window list), same keys, timer and instant
shortcut. `finish_screenshot` cuts the selection out of the still
(`take_from_still`, `pixels_for`: CSS px times the slice's pixels over the
monitor's logical width, so HiDPI and fractional scaling need nothing more;
the viewport is assumed to be the monitor's logical size). **The timer
counts over the live screen**: the page hides the still while counting (the
overlay is transparent) and `retakes` has Rust take a fresh still once the
overlays are gone, the frozen one if that fails (`cut_latest`). No display
watch and no bar follow (both read X11, which is XWayland there), and
`capture_confirm` takes the bar's display for Entire screen (no pointer on
Wayland). A refused or missing still, or one that does not fit the
monitors, hands over to `system_picker_screenshot` (`linux_portal.rs`,
`interactive = true`: session `Capturing` while the desktop's tool is
open; a cancel there is a quiet cancel, everything else `fail_capture`;
`settle` MOVES the portal's PNG into the capture folder under the Hippius
name, never follows a symlink, and says `PORTAL_MISSING` / `PORTAL_FAILED`
in Rust's words). `Surfaces.selection` is how a SCREENSHOT is chosen (the
Capture menu and tray branch on it; the desktop's tool on Wayland) and the
Rust-only `record_selection` how a recording is (the panel on Wayland);
the overlay page branches on its context's `panel` and `frozen`, never on
the platform, and `shortcut.supported` / `unavailableMessage` (no keycaps,
Settings shows the line). The bar switching kind on Wayland swaps the
windows (`support::switch_plan` → `swap_selection_windows`: a
screenshot's windows give way to the panel for Record, the panel to the
desktop's tool for a screenshot; the panel offers no screenshot modes, so
that is only a guard). The `rust-linux-test` CI job runs
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
`capture_wiring.rs`); it runs after the window is built, so a page that
already finished loading is loaded again (`needs_reload`: its document was
made without `navigator.mediaDevices`), and every answer is a `camera:` log
line. **WebKitGTK 2.50+ opens every camera through the Camera portal**
(`PipeWireCaptureDeviceManager`: `IsCameraPresent`, `AccessCamera`, the
portal's PipeWire fd; no V4L2 fallback, and nothing at all below PipeWire
0.3.64), and the portal asks once per app, host apps included, and keeps a
missed or dismissed question as "no". `camera_access.rs` holds a pre-check
that asks `AccessCamera` before the bubble opens, but it is **not wired**:
it was rolled back with the Linux recorder changes, so the bubble opens the
camera through WebKit's own request, `CameraState.access` stays `unknown`
and the bar's camera row carries no Linux line. The bubble still says why a
camera failed in plain words (`cameraProblem.ts`). Pinned by
`capture_wiring::linux_bubble_opens_the_camera_without_a_portal_pre_check`. `--list-cameras` names cameras as WebKitGTK does
(both are GStreamer's names). **Old PipeWire cannot open cameras:** with
`gstreamer1.0-pipewire` installed its device provider hides the V4L2 one in
`GstDeviceMonitor`, so WebKitGTK (and camera only) open every camera with
`pipewiresrc`, which below PipeWire 0.3.64 (Ubuntu 22.04 has 0.3.48) stops
with `not-negotiated` or freezes: a live track with no frame, the bubble on
its placeholder, while a browser (V4L2 directly) works. `camera_provider`
reads PipeWire's version from `libpipewire-0.3.so.0.<n>.0` and, below
0.3.64, sets `GST_PLUGIN_FEATURE_RANK=pipewiredeviceprovider:NONE` in `main`
before any thread (the monitor uses providers of rank MARGINAL and up); the
web processes and the recorder child inherit it, so the bar's names, the
bubble and the recorder still agree. A rank the user set wins. Pinned by
`camera_provider::tests` and `capture_wiring.rs`. The app probes once
per launch (`--probe`, warmed at launch by `warn_if_helper_missing`) for
`codecsMissing` / `portalMissing`, and waits up to 5 minutes for `started` on
Wayland (the desktop's dialog). The same probe reports `h264Decoder` /
`aacDecoder` (by caps, rank MARGINAL and up) for the file viewer's player
(`video_stream::decoder_missing_line`); asking for them runs the probe even
where the lane keeps recording off. **Wayland records from the panel**
(`StartPlan::Panel`): one `capture-overlay-0` window with the bar alone,
transparent and fitted to it (opened at `support::PANEL_FIRST_SIZE`; the
page's `usePanelFit` measures the bar and any open `role="menu"` and calls
`capture_panel_fit`, CSS pixels = logical pixels at every scale, clamped by
`panel_window_size`). The bar is at the window's top-left (`barLayout`
"panel"), the corner a resized Wayland window keeps, so its menus open
downward, nothing is sized in `vh`/`vw` (the window being fitted) and
shadows are the pill's tight one; the page draws no glass of its own (it
used to fill a fixed 520 x 600 window with a framed dark box). The bar's
toolbar and hint are the drag region,
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
(`tray_recording_menu.rs`, rewritten only on a state change; one listener,
`listen_to_recording_menu`, added at start-up in `main.rs` setup, every
click read against the phase now by `effect_for` and logged at `info`);
the main window puts its menu back on
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
place (`monitor_for`, else the compositor's pick), with an area already
drawn: the last one recorded (kept in stream pixels under
`area_pick::REMEMBERED_AREA_ID` in `capture_last_areas_v1`, fitted by
`bar::fit_area`), else a centred half of the screen
(`area_pick::initial_area`), handed to the page as fractions of the
picture (`AreaContext.initialArea`); the page sends the drawn
rect in CSS px with the picture's box, Rust maps it to stream pixels
(`stream_area` over `plan::area_pixels`: ratio = stream width over shown
width, so HiDPI and fractional scaling need nothing more), destroys the
window, waits two `COMPOSITOR_SETTLE`s (the window is in the stream until
the compositor drops it) and sends `crop`; the child then opens the sound
and the writer as a plain start would and cuts each picture in Rust
(`frame::to_nv12` reading the area's rows in place; nothing renegotiates).
`AreaStep` takes one area, only while drawing; a cancel at any step hands
the recorder back uncropped to `adopt_recorder`; five minutes undrawn ends
as quietly as a cancelled dialog. The pill counts after the crop. Before
the crop it is moved outside the area on the stream's monitor
(`place_pill_clear_of_stream_area`: `area_pick::area_on_monitor` then
`camera::pill_outside`, else the monitor's bottom centre), which works
where the compositor honours an app's window position (X11, XWayland:
GNOME Wayland included, below); a native Wayland client on GNOME is
placed by Mutter and may still find it inside the area. *Camera only*:
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

**GNOME Wayland can run the app as an XWayland client, but only when
`HIPPIUS_XWAYLAND=1` is set** (`utils::display_backend`; native Wayland by
default, since under XWayland on a scaled display the Wayland area overlay
and its still were drawn at the wrong size, and Linux recording regressed on
real machines). What follows is how it works when asked for. GTK's keep-above is an empty function on Wayland and
Mutter offers clients no keep-above and no layer-shell, so the pill and the
bubble fell behind any window raised mid-recording (the camera then missing
from the video); Mutter honours `_NET_WM_STATE_ABOVE` and window positions
from X11 clients. `display_backend::choose` (pure, tested everywhere) picks
XWayland only for a Wayland session (`rollout::linux_platform`, the
capture paths' own test) with `DISPLAY` set on a desktop whose
`XDG_CURRENT_DESKTOP` lists GNOME, and never when the user set
`GDK_BACKEND` or `HIPPIUS_WAYLAND_NATIVE=1`. `apply` runs in `main` after
the recorder child and CLI branches and before the builder, through
`gdk_set_allowed_backends("x11,wayland")`: XWayland first, Wayland if it
cannot connect, and NO environment variable, since `GDK_BACKEND` would push
the file manager and browser the app starts onto XWayland too. Rules that
fail silently: **the session stays Wayland** (`current_platform` reads only
`XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`, so screenshots, ScreenCast, the
GlobalShortcuts portal and every `LinuxX11` gate are unchanged: the X
connection sees only XWayland windows); never unset `WAYLAND_DISPLAY` to
force XWayland, it would flip every capture path to X11. The log carries the
choice (`display backend chosen`) and the display GTK opened
(`GTK display opened`). Cost: under Mutter's logical layout (fractional
scaling, `scale-monitor-framebuffer`) X11 clients are drawn at scale 1 and
stretched, so the whole app looks soft until `xwayland-native-scaling`
(GNOME 47+, experimental). Pinned by `display_backend::tests` and
`capture_wiring::gnome_wayland_connects_through_xwayland_before_gtk_starts`,
`an_xwayland_client_keeps_the_wayland_capture_paths`.

## Flow

**Start:** `capture_start(kind?, mode?, instant?)` opens an overlay per display; the one
under the pointer (`bar::bar_display`, cursor from `NSEvent.mouseLocation`
flipped to the displays' top-left points on macOS, Tauri's physical cursor on
Windows) draws the ⌘⇧5-style **capture bar** (`app/capture-overlay/CaptureBar`).
No kind/mode = the last used (`capture_options_v1`, device-wide); what a
start opens is `instant::start_choice`. **The shortcut is a one-step area
screenshot** (`instant.rs`, like macOS's Cmd+Shift+4 with "copy link"):
`on_shortcut` emits `ShortcutStart { instant: true }`, `CaptureHost` passes
it to `capture_start`, and the session's `instant` flag (in
`OverlayContext.instant` and the overlay URL's `&instant=1`, so the page is
a crosshair before its context loads) means no bar, no area seeded (Rust's
`pending` and the page's localStorage area both skipped), no timer
(`instant::countdown_secs`), and the drag's pointer-up calls
`capture_select` with the area at once. A click without a drag does
nothing; Escape cancels; Space before a drag swaps to window click, and
Space HELD during a drag moves the area (`overlaySelection::shiftDrag`,
both flows). The size label shows while dragging. It never moves the bar's
last kind/mode (`StartChoice.remember`, `remembers_mode_switch`). On
Wayland the shortcut opens the desktop's own tool, already one step. The buttons
and the tray keep the bar.
`capture_start` never prompts for Screen Recording: it refuses with
`NotReady(ScreenRecordingPermission)` and the permission dialog takes over
(see "Screen Recording permission" below). Only
the bar's overlay takes focus. The frontmost app (pid) is remembered and
re-activated when the overlays close; the main window comes back per
`restore_plan` (hidden stays hidden, behind stays behind via `orderBack:`,
front only if it was key), and never mid-recording (it would be filmed).
**The user can still bring it back mid-recording** (`own_windows.rs`,
`activation.rs`): the Dock's reopen shows it unless it is already up
(`on_app_reopen`; NOT `has_visible_windows`, which the pill makes true, so
the Dock click used to do nothing; never while `Selecting`/`Capturing`,
where it would land under the overlays and in the shot: the overlays keep
the keyboard, `reopen_shows_main`), Cmd+Tab sends no reopen so
`activation::watch` observes `NSApplicationDidBecomeActive` and
`on_app_activated` shows it during Recording/Paused/Finalizing unless a
mouse button is down (a click on the pill or card activates the app too) or
the tray popover is visible; and the main window's `Focused(true)` in those
phases (`on_main_window_focused`) forgets `restore_main`,
`main_was_focused` and `previous_app`, so Stop neither pushes it behind nor
hands the keyboard away. Once shown it is filmed like any app if it is in
what is recorded. **Linux and the dock** (`own_windows::main_away`,
`capture_window_focus_shows_main`): GNOME's dock and Alt+Tab raise the app's
first window, visible ones first (`shell_app_compare_windows`), and on
Wayland the pill and the bubble are ordinary windows of the app (GTK 3's
skip-taskbar is a no-op there), so with the main window hidden a dock click
only focused the pill. X11 honours skip-taskbar, so there the main window is
MINIMIZED, not hidden (the dock's one window; `restore_main_window`
unminimizes it at the end). Wayland keeps HIDING it: a minimized Wayland
window comes back only through an xdg-activation token, which mutter
refuses without fresh input, so the tray's Open Hippius and the end of the
recording would show "Hippius is ready" instead of the window. Instead
`focus_watch_gtk.rs` follows the pill, bubble, bubble controls and card
(GTK crossing events, an `Inferior` leave is not a leave; map time) and a
focus-in with the pointer elsewhere, more than `MAPPED_FOCUS_GRACE` after
the window was shown, brings the main window and calls
`on_main_window_focused`. Known gap: mutter's focus fallback (the focused
app's window closes and the always-on-top pill is next) reads the same and
brings the main window too. `main_on_screen` treats a minimized main window
as not on screen on Linux, so a capture never brings up a window the user
had minimized. The single-instance handler (Hippius launched again) also
calls `on_main_window_focused`, like the tray's Open Hippius. A
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
by the fake-`Recorder` harness in `commands.rs` and `tests/capture_wiring.rs`. No
statement locks one capture mutex twice: the first guard lives to the end
of the statement, so the second `lock` never returns (it hung every capture
at Record and then starved the async runtime); read a field once
(`CaptureState::recording_camera`), pinned by
`capture_wiring::no_capture_statement_locks_the_same_mutex_twice`. Mic and
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
`MUTE_RECOVERY_MS`, at most `MUTE_RECOVERY_TRIES` in a row. A stream (or a
`getUserMedia`) with no first frame in `NO_FRAMES_MS` is opened again once
(`afterNoFrames`), then the bubble shows "Camera unavailable" and lets the
camera go; never after the stream's first frame, since WebKit pausing a
picture is not a failure. **The page reports each step to the app log**
(`capture_camera_report`, `camera_report.rs`: `camera: <step>: <detail>`,
`warn` for `no-media-devices`, `error`, `no-frames`, `gave-up`,
`track-ended`, `track-muted`, else `info`; one line per step per second and
40 a minute, the rest counted): the cameras listed by name, the constraint
asked (device ids cut to 8 characters, `cameraReport.ts`), the error's name
and message, the track and the video. Grep `camera:` in `~/.hippius/logs`.
Pinned by `onlyCameraCaptures.test.ts`, `cameraPage.test.tsx`,
`cameraReport.test.ts`, `mic_meter::tests`, `camera_report::tests` and
`capture_wiring.rs`.
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
the bubble instead, and resizes it from its own menu (the strip lives in
the filmed window). The × is "Turn camera off" while choosing and "Hide
camera" while recording (`cameraCloseLabel`). Mid-recording the size is
changed from the PILL's camera menu or from the bubble's controls window
(below), never from the bubble's own page. While choosing it is always mounted, faded until
hovered or focused, so Tab reaches it. Its third button is a toggle
(`sizeControls`): at full size it is "Exit full size" (Minimize2) back to the
round size from before (`nextRoundSize`), and Escape on the camera window
does the same before it would cancel; asking for full again did nothing, so
there was no way back. No native `title` on this window: the strip names the
hovered or focused button in its own `role="tooltip"` label. The `<video>` is
mirrored, so WebKit's start-playback button (shown on a paused or not yet
playing video) was a backwards triangle on the bubble; CSS cannot remove
WebKit's modern controls, so the video is `opacity-0` until `playing` (and
again on `pause`), and the page calls `play()` itself. The video is
`pointer-events-none` (`VIDEO_TAKES_NO_POINTER`): WebKit drew a pause button
over a hovered picture mid-recording, dead (the click began a drag) and
filmed; the frame behind it is the drag region, and pause is the pill's
and the bubble controls'.
**The camera page is sized by its window, never by the video**: its root
is `fixed inset-0` and the frame's shape is `cameraFrameShape` (round:
`aspect-square`, capped at the window's height; full and stage: fill with
18 px corners). This page's `<html>`/`<body>` have no height, so an `h-full`
root took the camera's 16:9 picture as its height and the round bubble was a
pill, on screen and in every video; pinned by `cameraPage.test.tsx`.
Hover comes from Rust (`capture_camera_hover`, polling the
pointer against the frame every 100 ms, `spawn_camera_hover_watch`, macOS and
Windows) because a non-key window does not reliably get webview hover on
macOS. **Bubble controls mid-recording** (`bubble_controls.rs`, pure;
`app/capture-bubble-controls`, label `capture-bubble-controls`, its own
capability): Loom-style sizes (small / large / full toggle, only when
`resizeFromPill`) and pause / resume on a 148 x 60 pt strip over the
bubble's lower part (`bubble_controls::frame`, inside the circle at every
size), shown by the same watch while the pointer is on the bubble and the
bubble is still (`shown`: hidden while it is dragged or glides, back where
it stops). It is a WINDOW OF ITS OWN because the bubble's window is filmed;
the recording leaves it out: macOS by the helper (`filmed_own_windows` lists
the main window and the camera window's number only; a window recording
films only that window and the bubble), Windows by content protection
(`OwnWindow::BubbleControls`), Linux has none (`supported` = not
`pill_filmed`). Geometric polling, not the webview's hover, on every
platform: the controls cover part of the bubble, so the bubble's page sees
the pointer leave as it reaches them. Built hidden on first need while a
bubble is live (no load wait on the first hover), level 1002 above the
bubble on macOS, `focused(false)` + `accept_first_mouse(true)`, destroyed
by `end_camera` and when the camera window goes. It calls only the pill's
commands (`capture_camera_set_size`, `capture_pause` / `capture_resume`),
mirrors Rust's phase (by `seq`) and camera state, names the hovered button in
its own `role="tooltip"` line (no native `title`: a system tooltip is a
window), and is one Tab stop with arrow keys. Pinned by
`bubble_controls::tests`, `bubbleControlsPage.test.tsx` and
`capture_wiring::the_bubble_controls_are_never_filmed`. Screen off = **stage**: a
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
full display, or it sits under the Dock), `focused(false)` + content-protected except on macOS (`own_windows`) +
`accept_first_mouse(true)` (never key, so without it every button needed two
clicks). Stays `AUTO_HIDE_MS` (10 s) once done, held while hovered (the timer bar
stays mounted and pauses, or the card changes height under the pointer).
It must fit 316 x 346 in every state: it sits at the window's bottom, so an
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
actions count. The card waits for its own upload, never for the rest of the
sync: a `syncing` card with a public link whose file the engine has not
started on (no row yet, or `SyncRow::Queued`, a `Pending` row behind other
files) is marked uploaded at once (`link_finishes_card`), because minting the
link uploads the capture's own encrypted copy. A file the engine is uploading
right now (`Working`) shows that upload's progress instead. `PreviewCard.settled` (uploaded and the
link neither `Creating` nor `Failed`) is what the card's auto-hide waits for, so
it never slides away before it can say the link was copied, and a card whose
link failed stays up with Create link. `deliver::mint` tries a link three
times in all (`mint_retry_after`: 1 s, then 3 s) unless the drive is full, since
a request that did not get through is often fine a second later.
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
folder emits `capture_show_in_folder`; a capture in the captures drive
(`capturesDrive`: the destination's folder is the root) goes to
`capturesRoute(label, remote, fileName)`, the Captures page, whose pinned
container takes the same `openLabel` / `openFile` params; an older one in a
folder goes to `driveFolderRoute(label, remote, folder, fileName)` → the Drive
page steps into the folder with the row's own `generateFolderUrl`, then
points the file out (see "Show in folder points
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
and Escape at the question give focus back to the button that asked. The pill applies a phase only
when its `seq` is newer than the one it shows. It drags by
`data-tauri-drag-region` (`-webkit-app-region` is Electron-only), which needs
`core:window:allow-start-dragging` in `capture-controls.json`.

**Free plan length cap** (`allowance.rs`): Free plan recordings stop at
`FREE_MAX_RECORDING` (5 min of RECORDED time, the recorder's
`RecordedClock`, pauses left out); paid plans have no limit; screenshots are
untouched. `begin_recording` decides the tier once, before the recorder starts, from
the session's prefetched read (`capture_tier`; `recording_tier`, bounded by
`LOOKUP_WITHIN`), and stores the limit on
`CaptureState`; `tick_once` stops at it through `stop_inner`, exactly like
Stop, and the card gets `stopped_at_free_limit` (Rust's `notice`, Upgrade,
no auto-hide). The tier reads the plan through
`storage_overview::PlanReads`, the same fold the overview and sharing use;
the overview remembers it on every read, per account, in memory and in
`user_preferences`. **It fails open**: no fresh verdict uses the last one
kept, none ever seen means no cap. The pill shows Rust's `remainingSecs`
(on `PhaseEvent`, last minute only). Other recording limits read the same
`RecordingTier` / `recording_tier`.

**Free plan watermark** (`watermark.rs`): the Hippius mark and "Hippius"
(master `icons/watermark.png`, only its alpha read), white at 70 % over a
soft shadow, bottom-right, 3 % of the shorter side tall (18 to 44 px), 2 % in
(12 to 32 px), drawn once per size and blended over its own rectangle only.
Free tier only (`watermark::applies`), an unknown tier gets none (fail open,
like the length limit). The tier is read ONCE per capture: `prefetch_tier`
starts it at `capture_start`, `capture_tier` takes it before the recorder
starts (so the first frame has it) and before a screenshot's PNG is written;
the same verdict sets the length limit. Where it is drawn: screenshots in
`finish_screenshot` (and `stamp_portal_shot` for the desktop's tool);
Windows recordings in the child's `Pipeline` (`Nv12Stamp`, after the bubble
is composited, from `StartCommand.watermark`); Linux recordings carry NO
watermark for now (the Linux child ignores `watermark`, rolled back with
the recorder); macOS in the Swift
helper, which gets every size as an atlas (`watermarkAtlas`, written beside
the recording by `recording::macos::start` and removed once the helper
answered) and stamps each SCK frame once as it is appended. Pinned by
`watermark::tests` (including the Swift literals) and the protocol tests.

**Live controls** (`live_controls.rs`, pure; the pill's `PillMenu.tsx` only
draws): mid-recording the pill mutes and unmutes the microphone
(`capture_microphone_mute`), switches microphone (`capture_microphone_switch`)
and camera (`capture_camera_switch`), and resizes the bubble
(`capture_camera_set_size`, whose live branch is
`resize_bubble_while_recording`). `support_for(platform)` decides what is
offered: macOS all four; Windows the two camera ones (they only move and
re-point the filmed camera window; the recorder child answers the
microphone commands with `LIVE_MICROPHONE_UNSUPPORTED`); Linux none, since
the pill (and so a menu) is filmed there. The pill reads
the `capture_microphone_state` command and event
(`MicrophoneState`: `recorded`, `muted`, `deviceId`, `canMute`,
`canSwitch`) and `CameraState.switchFromPill` / `resizeFromPill`; it never
works them out. Rules: the recorder answers BEFORE the pill is told
(`change_microphone`), so a refused switch (a microphone that went away)
leaves the old one recording and showing, with Rust's line in the menu;
every start (a restart too) resets the microphone to heard on the device it
opened (`LiveMicrophone::started`), every ending to nothing (`end_camera`,
which also stops the device watch the menus start); a switch keeps the
mute. Both switches are saved as the bar's choice too. The camera is
switched by the camera page reopening it by name (only that page may call
`getUserMedia`; a short freeze in the video), asking again with `exact`
when WebKit opened another camera for the `ideal` id (`openedAnotherCamera`),
refused where the recorder holds the camera (Wayland camera only). The
pill's camera menu is on only while live, and the camera state sent at
Record is still `Capturing`, so `begin_recording` sends it again after
`adopt_recorder` (`announce_camera`); without it the pill had no camera
menu (pinned in `capture_wiring.rs`). A bubble resized mid-recording is
fitted inside what is filmed (`filmed_now`, `camera::resized_while_recording`:
full = `full_in`, the stage's 16:9 proportions centred in the filmed area,
no bar block to keep clear of; back to round = where it was before full),
so the file follows the window. **The menus grow the pill's own window**
(`capture_controls_menu`, `live_controls::pill_with_menu`: `MENU_HEIGHT`
taller, upward so the pill stays put, downward near the top of the screen,
and back on close), which is left out of the recording like the pill, so a
menu is never filmed. `open_controls` drops a menu left open. **The pill
never moves while a menu opens or closes.** Growing a webview's window
upward showed the pill a menu's height higher for a moment: the page was
laid out for the old size (and anchored to the top until the side came
back), and a webview keeps its old picture at the top of a grown window
until it draws again. So on macOS the page is laid out ONCE at
`page_height` (the pill with `MENU_HEIGHT` above and below,
`fixed_menu_room`) and never resized: every frame change of the pill goes
through `set_pill_frame`, which pins the WKWebView (no autoresizing) at
`page_top` inside the window in the same main-thread turn as the window's
`setFrame`, under `disableScreenUpdatesUntilFlush`, so a menu opening only
moves the window's edge over a page already drawn. **WebKit's automatic
content insets are off for that page** (`setObscuredContentInsets:` zero, and
`_setAutomaticallyAdjustsContentInsets:` NO / `_setTopContentInset:` 0 where
they exist): left on, WebKit took the room sticking out above the window
for a title bar and cut it off the viewport (`innerHeight` 360, not 660),
so the closed pill was laid out a menu's height lower, below its window,
and never showed (`live_controls::automatic_top_inset`; pinned by
`live_controls::tests::the_pill_row_is_inside_its_window_in_every_menu_state`
and `capture_wiring::the_pill_page_viewport_is_its_whole_frame`). The page keeps the room
as two fixed slots (`menuRoom` from `capture_controls_context`) and every
state's root is `fixed inset-0` centred, so the pill sits in the middle,
where the window shows it. Elsewhere (`menuRoom` 0) the page is the window's
size: it asks `capture_controls_menu_side` first, anchors the pill to the
edge that stays put (`flushSync`, one frame), then asks for the room, and
lets go of the edge only once the window has shrunk back. Pinned by
`live_controls::tests::the_pill_stays_on_the_same_points_while_a_menu_opens_and_closes`,
`controlsPage.test.tsx` and
`capture_wiring::the_pill_never_moves_while_a_menu_opens_or_closes`. The pill window is 380 pt wide for the extra buttons. Pinned by
`live_controls::tests`, `camera::tests`, `controlsPage.test.tsx` and
`capture_wiring.rs`.

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
a stop, the pill has Stop) and the popover opens content-protected except on
macOS, where the helper leaves it out of the video (`own_windows`). A
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
signed out → main window forward, else emit `capture_shortcut_pressed`
(`ShortcutStart { instant: true }`: the one-step area screenshot, above) so
a start's refusals reach the same dialogs (`useStartCapture`; the drive
picker's resume keeps `instant`). `logout_full`
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
`CaptureState.shortcut_problems[kind]` and shown by Settings (`ShortcutSetting.problem`).
**Two shortcuts** (`ShortcutKind`, IPC param `kind`, absent = screenshot):
Record defaults to `CommandOrControl+Alt+Shift+2`, stored
`capture_record_shortcut_v1`; a press emits `ShortcutStart { instant: false,
kind: "recording" }` (the bar on Record, on the last mode) and toggles like
the screenshot one (`on_shortcut_of`). The plugin's one handler tells them
apart by the keys (`kind_pressed` over `REGISTERED`); `apply` unregisters only
that kind's keys, never `unregister_all`. `check_not_taken` refuses one the
other's keys before anything registers; `resolve` makes a never-set Record
off when the screenshot already has its default's keys (upgrade). Record is
registered only where `recording_supported()`. On Wayland Record is never
bound by the portal: `support::record_shortcut_for` says `desktopSettings`
with `<exe> --record` (`cli::argv_requests_record` → `on_record_shortcut`).
Pinned by `shortcut::tests` and `capture_wiring::the_record_shortcut_is_wired_like_the_screenshot_one`.

**Delivery is local-first for a drive synced here**: the file is moved into
`<local root>/<folder>` (the root for the captures drive; `free_name` never
overwrites; `CaptureDestination::upload_folder` is `None` for the root on the
direct path) and `trigger_sync_now`
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

**Free plan recording allowance** (`recording_allowance.rs`): 25 recordings
on a limited plan (`LIMITED_TIERS`, Free only; screenshots never counted).
**Decided when a recording STARTS, never after**: ONE gate,
`require_can_start`, refuses with `NotReady(RecordingLimitReached)` before
anything records, called by `capture_start` (kind Recording: tray, menus,
record shortcut), `select_inner` (the bar's Record, clicks, share picker,
camera only), `capture_restart` (before the take is discarded; it notifies,
the pill has no room) and `capture_check_recording_start` (the bar asks
before its countdown). Pinned by
`capture_wiring::every_recording_start_path_goes_through_the_one_gate`. The
count is the server listing of the account's own captures drive
(`list_remote_folder_files_inner`, label from `destination` when own, else
`CAPTURES_DIR_NAME`), files named like `Recording YYYY-MM-DD at HH.MM.SS`
`.mp4/.webm/.mov` with an optional ` (N)` (`is_recording_name`), so console
uploads and other devices count. Cached per account on
`CaptureState.recording_counts` for `COUNT_TTL` (30 s), warmed when the bar
opens; a delivered recording counts at once (`note_delivered`, until listed
or `PENDING_FOR`); a completed sync of the drive, a remote folder delete and
a sync reset drop it. **Fails open**: unknown plan or unreadable count
(error, `COUNT_WITHIN` timeout) never blocks; a paid last-known tier skips the
listing; a count at the limit is confirmed by a fresh `recording_tier`. The
FE only draws: `RecordingLimitDialog` (main window, via `useStartCapture`) and
`capture-overlay/RecordingLimitPanel` (Upgrade = `capture_limit_upgrade`),
in Rust's words (`recordingLimit.ts`, pinned to `LIMIT_TITLE`/`LIMIT_BODY`).
Nothing is held any more; `held_recordings.rs` keeps only the way out for
recordings an earlier build sealed under `~/.hippius/held-recordings`
(`release_held` once per sign-in from `capture_sync_shortcut`, as many as
`release_count` allows, delivered like fresh ones).

## Rules that fail silently

- **Coordinates.** xcap points on macOS / physical on Windows; overlay CSS
  points. `geometry::crop_rect` rounds outward; area crop scale from the image.
- **Content protection hides a window from EVERY capture**, Google Meet and
  Zoom included, so it is scoped (`own_windows::content_protected`): the
  overlays (bar, countdown, hints) are protected everywhere, since they are
  on screen while a screenshot is read. On macOS the pill, the card and the
  tray popover are NOT protected: the helper leaves Hippius out of a screen
  or area recording with ScreenCaptureKit (`excludingApplications: [parent]`,
  `exceptingWindows` = `ownWindowsFilmed`: the main window and the bubble;
  windows opened later, the bubble's controls among them, are left out too,
  verified by hand), and
  `finish_screenshot` hides a visible card first (`hide_card_for_grab`).
  Windows keeps protection on all of them (WGC cannot leave windows out);
  Linux has none. Overlays are raised to screen-saver level on macOS; every
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
- **Capabilities** (`capture-overlay.json`, `capture-controls.json`,
  `capture-camera.json`, `capture-bubble-controls.json`) must match
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
- **Captures drive** (`capture/setup.rs`, `destination.rs`): captures have
  a drive of their own, never a folder in the user's other drives. Stored per
  account as `capture_destination_v2:<account_key>` with `folder` empty (the
  drive's root). `v1` rows (a folder in another drive, picked in a dialog the
  first capture forced open) are never read: those accounts are asked once,
  and their old captures stay where they are. **Rust decides when to ask**
  (`setup::next_step`): stored drive → deliver; a chosen folder whose drive
  failed (`capture_drive_pending_v1`) → try again; nothing → the capture is
  kept in `~/.hippius/capture-waiting/<account_key>` (`kept_waiting`) and
  `keep_here` calls `ask_for_location` AFTER the file is kept: main window
  forward + `capture_drive_setup_needed`, which `CaptureHost` turns into
  `CaptureDriveDialog`. The dialog only draws `capture_drive_status`
  (`ready` / `needsSetup` / `pending`), `capture_drive_location` (a picked
  folder, checked) and calls `capture_drive_create`. The folder is
  `Documents/Hippius Captures` (`suggested_dir`; the home folder when
  Documents is inside a drive); a picked folder gets `Hippius Captures` made
  inside it (`folder_for_choice`), so the user's own folder is never uploaded
  whole. `check_location` refuses a folder inside or around another drive, a
  member drive and `~/.hippius`, and takes an own drive already synced at
  that exact folder (a setup cut short after the row was written).
  `permission_note` warns before macOS's Documents/Desktop/Downloads prompt;
  `folder_refused_copy` explains a refusal. The drive is added through
  `add_local_sync_folder` (Sync a Folder's path) under `ENSURE_LOCK`; a
  `Validation` refusal goes back to the dialog, anything else (plan full, no
  encryption password, offline) saves the folder as pending, keeps captures
  in it (`kept_in_chosen`, Retry, Reveal, Upgrade, no Discard, not parked)
  and the next capture or Retry tries again. On success
  `commands::redeliver_kept_card` sends the card's capture like Retry (link
  and all) BEFORE `move_waiting` moves the rest in, skipping that file;
  pinned in `capture_wiring.rs`. Settings and the Capture menus' "Captures
  folder…" open the same dialog to move it: the new folder becomes the
  captures drive and the old one stays a drive with its captures in it. The
  bar's Options menu only names it (`capture-save-to`). Delivery only ever
  removes the temp folder via `remove_temp_dir` (a kept capture's parent is
  the user's folder), pinned in `capture_wiring.rs`.
- **Captures page** (`/captures`, sidebar under Drive, `featureFlag:
  "capture"`): `CapturesView` reads `capture_drive_status`. Ready: Drive's own
  `DriveContainer`, pinned through `DriveRouteContext` (`driveRoute.tsx`:
  `basePath` for folder links and navigation, `pinned` opens it straight in
  and skips the folder list and its fallback, `hideBreadcrumbRoot`, and the
  page's `emptyState` at the pinned root), keyed on the drive. Before it
  exists: an empty state with Screenshot / Record and "Set up the folder
  now", plus Rust's pending sentence or the waiting count.

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

## The recording helper (`macos/HippiusCapture/Sources/HippiusCapture.swift`)

**Protocol.** One JSON object per line each way. Every command carries an
`id` the reply echoes (mid-recording also `mute` → `muted`, `unmute` →
`unmuted`, `switch_microphone` with `microphoneDeviceId`, absent = the
default → `microphone_switched`, or the helper's refusal: "This recording
has no microphone.", "That microphone is not connected."; Swift literals
pinned by `the_microphone_controls_speak_the_helpers_words`); `wait_for` skips a reply with another id (a late
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
  edge. H.264 High, sRGB tagged BT.709.
- **Rate control is an average, a keyframe every 4 s** (`videoBitRate`,
  `keyframeSeconds`; `sizing::RateControl` for Windows and Linux): 5 Mbps at
  1080p by the square root of the pixel count, 1..10 Mbps (Retina 9.6, 4K 10),
  so a 10-minute recording is at most about 375 MB at 1080p and 725 MB at
  Retina. A keyframe is most of a still screen's bytes, which is why 4 s and
  not 2. The Mac encoder gets the average ONLY: `AVVideoQualityKey` is
  accepted for H.264 on Apple Silicon but overrides the average with no
  ceiling (a busy Retina screen measured 40 Mbps) and Intel lacks it;
  VideoToolbox `DataRateLimits` switches the rate control and softened text
  on every keyframe. Windows asks for peak-constrained VBR (average, twice
  it, GOP) through `SetInputMediaType`'s encoding parameters, falling back to
  the same encoder untuned before the software one (`writer::ATTEMPTS`);
  Linux gives each encoder the average with its own default rate control
  and a keyframe every 2 s (`linux_plan::KEYFRAME_FRAMES`): the VBR /
  constant-quality modes with a ceiling were rolled back with the other
  Linux recorder changes. Pinned by `sizing` and `linux_plan`
  tests (Swift literals included) and `writer.rs` tests on Windows.
- Pause cuts time out: samples are retimed on the writer queue by the host
  time of every finished pause (`place`), video and audio alike, and samples
  inside a pause are dropped. SCK timestamps are host-clock time. The last
  frame is repeated at Stop so a still screen does not end the video early.
- `movieFragmentInterval` is 2 s, so a killed helper leaves a playable file;
  stdin closing (the app died) FINISHES the file and keeps it. Only `cancel`
  deletes.
- **Index first.** `shouldOptimizeForNetworkUse = true` writes the finished
  file as `ftyp, moov, mdat` (checked with these exact writer settings: without
  it the file was `ftyp, mdat, moov`). With the index last, a browser asks
  for the end of the file before the first frame, and share links can only be
  read from the start, so the whole recording downloaded before it played.
  Windows (`MFTranscodeContainerType_FMPEG4`) writes fragmented files whose
  index is already first. Linux writes fragmented files too (`mp4mux
  fragment-duration`, so a killed recorder leaves a playable file). A
  rewrite at Stop with the index first (`qtdemux ! mp4mux faststart=true`)
  and an NV12/I420 capsfilter before the encoder were tried and rolled
  back: recordings failed on real GNOME Wayland machines while CI's Xvfb
  run passed. Pinned by `recordings_put_their_index_first`
  (`recorder_child/plan.rs`).
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
- **Mute writes silence, never a gap.** A muted microphone stays open and
  each of its buffers is mixed at zero gain (`silent`), decided by the
  buffer's own capture time against the mute spans (host time, like
  pauses), so the track stays continuous and in step with the picture and
  system audio goes on. Dropping the buffers instead would leave the mixer
  waiting on the microphone and a hole players close up, so the sound would
  drift ahead of the video. `switch_microphone` sets
  `microphoneCaptureDeviceID` on the kept `SCStreamConfiguration` and calls
  `updateConfiguration` on the running stream; while the device changes no
  microphone buffers arrive, and the mixer's resync places the first new one
  by its timestamp with silence before it (a built-in microphone switches in
  well under a second; an iPhone's took about 3.5 s in a hand test). Pinned
  by `a_muted_or_switched_microphone_keeps_one_continuous_track`; driven for
  real by the ignored `mutes_and_switches_the_microphone_for_real`.
- **A screen or area recording leaves Hippius out** (`withoutOwnWindows`):
  `SCContentFilter(display:excludingApplications: [the parent app],
  exceptingWindows: ownWindowsFilmed)`, from a listing with
  `onScreenWindowsOnly: false` (the main window may be hidden at start).
  With no `ownWindowsFilmed` the whole app is left out; with the parent not
  listed nothing is (stderr line). This, not `sharingType = .none`, keeps the
  pill, card and popover out of the video, so other apps' screen sharing
  still shows them. Pinned by `capture_wiring.rs`.
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

## Screenshot editor

`capture/editor.rs` + `app/components/capture/editor/`. **The editor is a
full-screen layer of the main window, never a window of its own** (no
label, capability, route or `WebviewWindowBuilder`): every way in stores the
session, then `show_in_main_window` hides the tray popover, brings the main
window forward (`show_main_window`) and emits `capture_editor_open` (the
session id) to it. `ScreenshotEditorHost` (mounted in `app/(pages)/layout.tsx`
next to `CaptureHost`) listens, also asks `capture_editor_context` on mount
so a reload shows the open picture again, and renders `EditorApp` (its own
`next/dynamic` chunk) as a Radix modal at `z-[1000]` over whatever page is up,
so closing leaves the user where they were; focus is trapped and returns on
close. Ways in: the card's Edit (`actions.edit`, decided in
`PreviewCard::decide_actions`: a placed PNG/JPEG screenshot whose link is not
`Creating`; the card's picture opens it, and More has "Edit screenshot"),
Drive's "Edit image" (`capture_editor_open_file`: own drive synced here,
`path_in_drive` plus a canonical `starts_with`; or, when the file is not on
disk and the caller passes its server `fileId`, `open_remote_file`: own
drives only (`is_member` refused), downloaded through `cache_remote_file` and
saved back as `SaveTarget::Remote` into the file's own folder, with an EMPTY
`temp` so the save never writes the edit into the content-keyed preview
cache; pinned by `capture_wiring` and `a_server_file_is_split_into_its_folder_and_name`)
and the tray's Annotate. One
editor at a time: a second open shows the first again and is refused, so
unsaved edits are never replaced. The session records the account that
opened it; `capture_editor_context` forgets one opened by another account.
Rust reads the file ONCE into the session (`original`), so a card closing
meanwhile (which removes a direct upload's temp copy) cannot take the picture
away; a direct screenshot's temp copy is kept with its card
(`keep_temp_after_upload`'s `editable`) for exactly this.

The page is a pure model (`app/lib/capture/editor/`: `model.ts` document and
undo, `gesture.ts` press/drag/release per tool, `view.ts` crop, fit and zoom,
`pixels.ts`, `render.ts`) drawn on one canvas, hand-rolled rather than Konva
or Fabric (no dependency, React 19.2 here and react-konva 19.3 wants 19.3).
Layout: dark chrome on fixed tokens in both themes (`bg-black-600` backdrop,
`black-primary-bg` pills, active tool `bg-primary-50`); a top bar
(`editor-top-bar`, `TITLEBAR_BAND_H_54` tall, `titlebarClearanceClass` so the
macOS traffic lights of the overlay title bar have their 80px; the bar and the
name are `data-tauri-drag-region`, buttons never) with Close + file name left
and `SaveActions` right (Copy image, then a split Save: the main part saves by
the preference and is labelled by `saveLabel`, the chevron offers Save copy and
Replace original; with "Ask" both open `SaveDialog` on the picked way via
`initialMode`); the actions are `shrink-0` so the name truncates first. ONE
floating pill toolbar (`EditorToolbar`: every tool, a colour dot opening colour
and thickness, undo, redo) on its OWN row below the bar, centred, scrolling
sideways when narrow: it used to be absolutely centred over the bar, where it
covered Copy image and Save on any window `lg` or wider. Then a selection bar beside the selected annotation
(`SelectionBar`, positioned by `selectionAnchor`), and the zoom pill
(`ZoomPill`, 100% = one picture pixel per screen pixel) at the bottom. Keys
are handled on the layer and never reach the page (`stopPropagation`); Esc
steps back: colour panel, selection, crop, then close (asking "Discard
changes?" with Keep editing focused when there are edits). **Blur and
pixelate are written into the exported pixels** before the PNG is encoded
(`exportPng`: drawImage, getImageData, `applyRedactions`, putImageData, then
the drawings), and blur pixelates first so it cannot be deconvolved; the
on-screen picture runs the same code. **Blur is sized by the box, not only the
picture** (`blurCell`: at least the picture's `redactionBlock`, at most
`BLUR_CELLS_ACROSS` = 2 cells across the box's short side, capped at 3 blocks),
because a fixed half-block left bold text readable through it; pinned by the
`blur hides text` cases in `pixels.test.ts`, which measure contrast one letter
stroke apart. **The selected annotation's handles and body win over every tool
but crop and text** (`grabSelected` in `press`): a handle resizes, the body
moves (anywhere inside a box shape, only on the shaft of an arrow or line, so a
new arrow can still start beside one), and only a press elsewhere starts a new
shape; `cursorAt` shows which. Pinned by `a drawing tool and the shape it just
drew` in `gesture.test.ts`.

**Save is copy or replace, and Rust refuses a save in a drive that names
neither** (`requested_mode`, header `x-editor-save-mode`), so a page that did
not ask can never write over a file. The page asks in `SaveDialog` ("Save as
a copy" first and selected, "Replace the original", "Remember my choice"),
unless the user's `SavePreference` (`user_preferences` key
`capture_editor_save_mode`, also Settings › Screenshots & Recording, `EditedImageSetting`)
says which. The option descriptions are Rust's (`copy_note`, `replace_note`):
the public-link warning only when the file has a link (`drive_shared`, read
at open). **A copy** (`save_copy`) is a new file beside the original:
`write_beside` stages a hidden `.hippius-incoming-capture-*.part` and moves it
with `persist_noclobber` to the first free `unique_copy_name` ("<name>
(edited).<ext>", then "(edited 2)"...), never touching the original, its
card or its links; a remote capture's copy is uploaded under a name the
server does not list in that folder. **A replace** writes with
`replace_atomically` (hidden staging file, then rename) and nudges sync, or
re-uploads a remote capture through `upload_files_to_remote_folder_inner`.
**A file share is a snapshot copy, so the link cannot keep its URL**: on
replace, a card's link is re-minted from the edited file (`deliver::mint`)
and the old one revoked, even when the new mint fails (the usual reason to
edit is to hide something); a Drive file's existing links are left alone (a
password or expiry cannot be recreated here) and the outcome says they still
show the earlier picture. Save sends the PNG as the raw body with the session
in `x-editor-session` (`session_for` refuses a stale one); Rust validates it
(`decode_checked`: PNG signature, 16384 px a side, 200 MiB) and re-encodes a
JPEG as JPEG. After a save the host shows Rust's `SaveOutcome` as a toast,
calls `notifyFilesMutated`, and offers "Copy link" only when `saved_link`
says there is a link to the SAVED picture (`capture_editor_copy_saved_link`:
the card's new link, or the tray's quick-link path for a file synced here;
never a Drive file whose links still show the old picture). Pinned by
`editor::tests`, `preview::tests::only_a_placed_screenshot_can_be_edited`,
`capture_wiring::the_screenshot_editor_is_wired_end_to_end`, the
`app/lib/capture/editor/__tests__` suites, `editorApp.test.tsx`,
`ScreenshotEditorHost.test.tsx` and `EditedImageSetting.test.tsx`.

**Annotate from the tray** (`capture_annotate_*`, editor.rs). "Latest
screenshot" is decided in Rust each time (`find_latest`): the card still
showing when its Edit is offered (card origin, link replaced on save), else
the newest PNG/JPEG in the capture folder of a drive synced here
(`newest_editable`, hidden files skipped; opened through
`capture_editor_open_file`). "Choose image…" is `capture_annotate_pick`:
Rust shows the dialog itself (`tauri_plugin_dialog`, filter png/jpg/jpeg,
starting in the capture folder synced here, else Pictures, else Desktop,
`picker_start`) and reads only the path it answers with, so there is NO IPC
that takes a path to read; one dialog at a time (`PICKING`). A picked file
inside one of the account's own unpaused drives synced here
(`locate_in_drives`, canonical paths, deepest root wins) goes through
`capture_editor_open_file`, i.e. Drive's own checks and save. Any other file
(outside every drive, or in a paused or shared drive) is `EditorOrigin::Picked`
+ `SaveTarget::NewCapture`: Save never writes it, it writes
`edited_copy_name` ("<name> (edited).<ext>", Windows-illegal characters made
`-`) into a fresh capture temp folder and hands it to
`commands::deliver_as_new_screenshot` (`open_preview` +
`deliver_and_announce`), so it gets a card, upload and link exactly like a
fresh screenshot. Failures to open are a notification (the popover is gone).
Pinned by the `editor::tests` locate/name/newest/picker tests and
`capture_wiring::the_screenshot_editor_is_wired_end_to_end` (no path
argument, dialog source, new-capture branch before any write).

## Where Capture is offered

The shortcut; `CaptureButtons` (`app/components/capture/CaptureButtons.tsx`):
**Screenshot** and **Record**, each a normal toolbar button with a chevron
that opens its own Radix menu (no separate "…" button): the kind's modes
("Capture an area / a window / entire screen", `modeLabel` + `MODE_ICON`),
each `startCapture(kind, mode)` (the screenshot "Capture an area" item
carries the shortcut's keycaps, since the shortcut is that in one step),
then a separator, "Open capture bar" (`startCapture(kind)`: the bar on that
kind's last mode)
and "Captures folder…" (the captures drive dialog). The modes come from `offeredModes(kind,
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
Settings › Screenshots & Recording (section `capture`, after Sync & Storage,
shown where `useCaptureAvailability` is `available`, kept while `unknown`) holds every
capture setting: `CaptureShortcutSetting` per kind, the captures folder,
`EditedImageSetting`, and `CaptureOptionsSetting` (copy link, open link,
recording countdown, system audio, read fresh through `capture_get_options`
before each `capture_set_options`). Layout, in that order: the shortcuts as
side-by-side tiles (`layout="tile"`, keys at `ShortcutKeys` size `lg`), the
captures folder row (with "Show in Finder" / "Show in folder" through
`reveal_drive_in_finder` only for a drive synced here), the options as a grid
of cards (`layout="cards"`, `@container` columns so they follow the tab's
width), then `EditedImageSetting`; each setting's icon sits in a
`SettingIcon` chip. Pinned by
`CaptureButtons.test.tsx`, `drive/__tests__/captureButtonsPlacement.test.tsx`,
`drive/__tests__/recentFilesCapture.test.tsx`
and `tests/capture_wiring.rs` (content protection, focus, capabilities, every
command registered, retry path). Each menu styles its own
`DropdownMenuContent` (theme has no `bg-popover`).
