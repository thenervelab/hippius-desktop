# Screen capture on Windows and Linux: the plan to macOS parity

**Status:** Phase 0 done. Phases 1 and 2 done in code; their hardware
checklists are still to run, so Windows screenshots and Windows recording
stay on staging in `capture::rollout`. Phase 3 (Linux screenshots) done in
code and type-checked for Linux from macOS; its checklist needs real Linux
sessions, so Linux stays on staging. Phase 4 (Linux recording) done in
code, type-checked and linted for Linux from macOS; its checklist needs real
Linux sessions, so Linux recording stays on staging too. Phases 5 and 6 are
done in code for Windows (cross-checked from a Mac, not yet run on a Windows
PC; their checklist rows are below), and Phase 5's Linux part (the camera in
WebKitGTK, the camera list, camera only on X11, `device_lost`) is done in code
the same way as Phase 4; Phase 6 is not started for Linux. Windows and Linux
recording stay on staging. Written against `feat/screen-capture` at 8a4e21f2;
Phases 0 and 1 merged with the permission, external-device, button-menu and
camera/audio work at 2fd6e468.
**Scope:** every capture feature the macOS app has (screenshots, the capture
bar, recording, microphone and system audio, the camera, the pill and the
tray timer, the shortcut, the preview card, permissions), brought to Windows
and Linux as far as each platform allows, plus what packaging, CI and testing
need.
**Reads with:** `docs/plans/2026-09-22-screen-capture.md` (the design),
`.claude/rules/screen-capture.md` (how it works today), and the capture audit's
cross-platform findings (XP-1 to XP-21, quoted below where they matter).

## Summary

Windows is close. Screenshots already run there on staging (xcap, the same
overlays, the same card), most of the latent Windows items from the audit are
fixed (focus-stealing `show`, physical placement, taskbar hover, pill shadow,
the macOS-only permission URL), and every API recording needs is in the
`windows` crate the app already carries. The work is a recorder built on
Windows.Graphics.Capture, Media Foundation and WASAPI, plus a WebView2
permission handler for the camera and the mic meter.

Linux is two platforms. On **X11** the macOS flow ports almost as is: overlays
can cover the screen, windows can be listed and read, and recording can read
the screen directly. On **Wayland** (the default on Ubuntu, Fedora and KDE) an
app can neither see other windows nor draw over them, so the system picker
(xdg-desktop-portal) chooses what to capture and the capture bar becomes a
small ordinary window. Recording goes through the ScreenCast portal and
PipeWire into GStreamer, which WebKitGTK already makes every Hippius install
carry.

The one structural decision: **Windows and Linux record in a child process of
the app itself** (`Hippius --capture-recorder`), speaking the exact JSON
protocol the macOS Swift helper speaks. Rust's `MacosRecorder` becomes a shared
`HelperRecorder`. That keeps crash safety (a GPU driver or a GStreamer plugin
that dies takes the recorder, not the app, and the file survives), keeps one
session protocol for three platforms, and needs no extra binary to build, sign
or package.

Effort: about **13 to 16 engineer-weeks** for everything, in seven phases.
Windows screenshots can go to beta after about one week; Windows recording is
the largest single item.

### Feature by platform

Effort: **S** up to 3 days, **M** 1 to 2 weeks, **L** 3 weeks or more.
"Wayland" means GNOME 46+ and KDE Plasma 6; "X11" means any EWMH window
manager with a compositor.

| Feature | Windows 10 2004+ / 11 | Linux X11 | Linux Wayland |
|---|---|---|---|
| **Screenshots: area, window, screen** | Today: xcap GDI. Move window shots to WGC (XP-1) so DPI-unaware apps come out whole. UX same as macOS. **S** | x11rb (already in the dependency graph): RandR for displays, EWMH for windows, `GetImage` on the root. Overlays hidden before the grab. UX same as macOS. **M** | Screenshot portal, `interactive=true`: the desktop's own screenshot UI picks area, window or screen. No Hippius overlay, no hover, no timer. **S** |
| **Multi-display, HiDPI, mixed scaling** | Already physical pixels end to end (verified in the audit). Hardware check only. **S** | One X screen, one global scale; physical pixels. **S** | The portal returns pixels at the output's scale; nothing for Hippius to map. **S** |
| **Capture bar and overlays** | Already works (transparent, topmost, content-protected). **none** | Same overlays; no content protection, so they close and the compositor settles before the grab. **S** | A small normal window (`capture-panel`) with the bar's controls, for recordings only. Screenshots skip it. **M** |
| **Share picker thumbnails** | Already works (xcap). **none** | Same picker, thumbnails from x11rb. **S** | Not offered: the portal's picker replaces it. **none** |
| **Countdown** | Same. **none** | Same. **none** | Recording: counted in the pill after the portal picker returns. Screenshot timer hidden. **S** |
| **Own windows out of the capture** | `WDA_EXCLUDEFROMCAPTURE` (content protection), honoured by WGC; runtime check that it held (XP-2). **S** | Not possible. Pill and card are filmed in a full-screen recording; placed outside an area recording. **accept** | Not possible. Window recordings never include them; screen recordings do. **accept** |
| **Recording: area, window, screen** | WGC per monitor or HWND; area cropped on the GPU. **L** | `ximagesrc` (screen, area by coordinates, window by XID). **M** (on top of the Linux recorder) | ScreenCast portal (monitor or window, chosen in the system picker). Area: not in v1 (spike L6). **L** |
| **Pause with retimed timeline** | Samples dropped and retimed in the child from the QPC clock (the same rule as macOS `place`). **in L above** | Same retiming in a GStreamer pad probe. **in L above** | Same. |
| **Crash-safe output** | Media Foundation fragmented MP4 (`MFTranscodeContainerType_FMPEG4`); stdin EOF finishes the file. **in L above** | `mp4mux` fragmented (2 s), or Matroska then remux (spike L3). | Same. |
| **Pixel resolution, bitrate** | Native pixels, long edge capped at 3840, macOS's `videoBitRate` and even-pixel alignment ported to Rust and shared. **in L above** | Same. | Same. |
| **MP4, H.264 + AAC** | Media Foundation encoders, no ffmpeg bundled. N editions need the Media Feature Pack (detected, explained). | GStreamer from the distro; encoder chosen at run time (VA-API, x264, OpenH264; AAC from libav or fdk). Missing codec = Record disabled with the package to install. | Same. |
| **Microphone + device list + meter** | WASAPI capture in the child; list via the child's `--list-microphones`; meter in WebView2 once permission is handled (XP-7). **M** | PulseAudio/PipeWire source through GStreamer; list via `GstDeviceMonitor`; meter in WebKitGTK once media stream is enabled. **M** | Same as X11. |
| **System audio** | WASAPI loopback of the default output; Windows 11 excludes Hippius's own sounds (process loopback). **S** | The default sink's `.monitor` source. **S** | Same. |
| **Camera bubble** | `getUserMedia` in WebView2 with a `PermissionRequested` handler for the camera window; bubble filmed (not protected). **S** | WebKitGTK: `enable-media-stream` plus a `permission-request` handler. Always-on-top and placement work. **M** | Same webview work; the bubble is a normal window the compositor places and does not keep on top. **accept** |
| **Camera only (stage)** | Record the stage window by HWND (XP-10). **S** | Record the stage window by XID. **S** | Not in v1 (the user would have to pick the Hippius window in the portal). |
| **Recording pill** | Works (focus fix already in). Content-protected, so never filmed. **S** | Works; filmed in full-screen recordings. **S** | Normal window, compositor-placed; filmed in screen recordings; the desktop's own "screen is being shared" indicator also stops it. **S** |
| **Tray timer and click** | No tray title: tooltip carries the time (done) plus a recording icon (XP-15). Left click reaches the pill (works). **S** | AppIndicator label shows the time; no click event, so the menu grows Stop / Pause / Show controls while recording. **S** | Same; stock Fedora GNOME has no tray at all. |
| **Global shortcut** | Works (plugin). Change the default: Ctrl+Shift+2 belongs to Windows Terminal and Excel (XP-6). **S** | Works (plugin, X11 grab). **S** | GlobalShortcuts portal where it exists (KDE, GNOME 48+); elsewhere a desktop keyboard shortcut running `hippius --capture`. **M** |
| **Preview card, delivery, Show in folder** | Works; verify placement and `accept_first_mouse`. **S** | Works; `reveal_path` already uses `xdg-open`. **S** | Delivery works. Card placement is the compositor's and GNOME may not raise it: spike L4 picks card or notification. **S** |
| **Permissions, first run** | None for the screen; camera and mic follow Settings > Privacy (read from the ConsentStore, deep link to `ms-settings:`). **S** | None. **none** | The portal asks every time unless a restore token is kept; Hippius keeps it. **S** |
| **Packaging** | Nothing new to bundle. Code signing is the gap (the app is unsigned today). | deb `Recommends` GStreamer plugins. | Same, plus `xdg-desktop-portal` and a backend. |

## What is true today (the starting line)

- `CAPTURE_SUPPORTED = cfg!(any(target_os = "macos", windows))`. Windows
  screenshots are live wherever `SCREEN_CAPTURE_ENABLED` is (staging). Linux
  hides every surface, and every capture IPC answers a plain `Validation`.
- `recording::windows` is a stub; `recording_unavailable()` says
  `UnsupportedPlatform` on Windows and Linux, which hides Record.
- Fixed since the audit: XP-4 (`show_without_focus` on Windows), XP-5
  (physical `place`), XP-12 (one `macos_version` cache), XP-13 (untitled
  windows are chrome on Windows), XP-17 (no DWM shadow on the pill off macOS),
  XP-20 (the permission URL refuses off macOS).
- Still open and in this plan: XP-1 (xcap without `wgc`), XP-2 (no runtime
  check that exclusion held), XP-6 (default shortcut), XP-7 (webview media
  permissions), XP-10 (stage window id off macOS), XP-11 (the mic caption names
  macOS 15), XP-15 (no visible tray cue on Windows), XP-16 (virtual desktops),
  XP-21 (dev toasts on Windows).
- CI builds Windows NSIS (staging, beta) and NSIS + MSI (production), Linux
  `.deb` only, on `ubuntu-22.04`. No lane builds rpm or AppImage. Windows builds
  are not Authenticode-signed (`certificateThumbprint: null`). `ci.yml`'s
  `rust-windows` runs `cargo check` only, and only for promotion PRs.

## Decisions and why

### 1. Record in a child process of the app, over the Swift helper's protocol

Options weighed:

| | In-process Rust | Separate sidecar binary | **Child process of the app binary** |
|---|---|---|---|
| A crashing GPU encoder or GStreamer plugin | Kills Hippius mid-upload | Kills only the recorder | Kills only the recorder |
| Crash-safe file when the app dies | Only if fragments were written | stdin EOF finishes the file | stdin EOF finishes the file |
| Reuses `HelperRecorder` and the JSON protocol | No | Yes | Yes |
| Build, sign, package | Nothing new | `externalBin` per platform, a second signing target, new release pins | Nothing new |
| Can be driven by hand like the Swift helper | No | Yes | Yes (`Hippius --capture-recorder`) |

The child is the app's own executable started with `--capture-recorder`,
branched at the very top of `main` before Tauri's builder (the same place
`cli::argv_requests_version` is checked today), so no window, tray,
single-instance or deep-link handler starts in it. It reads commands on stdin
and writes events on stdout exactly as `macos/HippiusCapture` does:
`ready`, then `{"cmd":"start","id":1,...}` answered by
`{"ok":true,"event":"started","id":1,"width":..,"height":..}`, `pause`,
`resume`, `stop`, `cancel`, the unprompted `stream_stopped {error, saved}`,
and stdin closing means "finish the file and keep it". `--list-microphones`,
`--list-cameras` and a new `--probe` (codec and portal availability, one JSON
object) are one-shot modes.

On Linux the ScreenCast portal session belongs to the D-Bus connection that
opened it, so the child owning it is right: if the child dies, the desktop's
"sharing" indicator goes away with it.

Rejected alternatives: `windows-capture`'s own `VideoEncoder` (it uses the WinRT
`MediaTranscoder`, writes a plain MP4 whose `moov` comes last, so a crash loses
the recording; its video timestamps come straight from the frame, so pause
cannot be retimed; its audio clock is a sample counter that would drift from
the video after a pause). Bundling ffmpeg (see decision 4).

### 2. Windows: WGC for pixels, Media Foundation for the file, WASAPI for sound

- **Frames:** `windows-capture` 2.0.1 (MIT) for the WGC session plumbing: it
  takes the HMONITOR and HWND ids the app already uses
  (`Monitor::from_raw_hmonitor`, `Window::from_raw_hwnd`), exposes the D3D11
  texture and the QPC timestamp, and turns the cursor and border on or off. If
  it gets in the way it is about 400 lines of `windows` crate code to replace.
- **File:** our own `IMFSinkWriter` with
  `MF_TRANSCODE_CONTAINERTYPE = MFTranscodeContainerType_FMPEG4` (fragmented
  MP4: playable after a kill), `MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS` with a
  DXGI device manager (hardware H.264 where the GPU has it, Microsoft's
  software encoder otherwise), H.264 High, GOP 60 at 30 fps, BT.709 tags, AAC
  48 kHz. We set every sample time, so pause retiming is ours.
- **Colour conversion and scaling:** a D3D11 video processor converts BGRA to
  NV12 and scales to the capped size on the GPU. Letting the sink writer insert
  its CPU colour converter is the fallback for adapters without one (WARP in a
  VM).
- **Area:** the monitor is captured and the area copied out with
  `CopySubresourceRegion`, in pixels from the area's `scale` (the same maths
  `screenshot.rs` uses).
- **Window:** WGC on the HWND; a resized window is letterboxed into the size it
  started at (the output size cannot change mid-file).
- **Audio:** `wasapi` 0.24 (MIT) or the `windows` crate directly. Mic: shared
  mode capture on the chosen endpoint. System: loopback on the default render
  endpoint; on Windows 11 (build 22000+) process loopback with
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on the app's pid, so
  Hippius's own sounds are left out. Both are resampled to 48 kHz and **mixed
  into one AAC track** (see decision 6). WASAPI packets carry QPC positions,
  the same clock as WGC frames, so one retiming rule covers both.
- **Screenshots:** turn on xcap's `wgc` feature (XP-1). Note that the feature is
  a compile-time switch in xcap 0.9.8 with **no** GDI fallback (the audit
  assumed one): monitors and windows both go through WGC. Spike W1 measures the
  cost; if monitor shots get slower or flash a border on Windows 10, window
  shots move to our own one-frame WGC grab and xcap stays on GDI for monitors.
- **Floor:** Windows 10 2004 (build 19041): `WDA_EXCLUDEFROMCAPTURE` and
  `IsCursorCaptureEnabled` need it. Below it, capture reports `osTooOld` with a
  Windows sentence. Windows 10 shows WGC's yellow border around what is being
  recorded (not in the video); Windows 11 turns it off
  (`IsBorderRequired(false)`).

Verified on this repo's toolchain (rustc 1.95.0,
`cargo check --target x86_64-pc-windows-msvc`): `windows-capture` 2.0.1,
`xcap` 0.9.8 with `wgc`, `wasapi` 0.24, `webview2-com` 0.38.2 and
`windows` 0.62.2 with `Win32_Media_MediaFoundation` all compile together, and a
spike calling `MFCreateSinkWriterFromURL` with the FMPEG4 container, H.264 and
AAC media types, `SetWindowDisplayAffinity` / `GetWindowDisplayAffinity`, and a
WebView2 `add_PermissionRequested` handler allowing `CAMERA` and `MICROPHONE`
type-checks. `windows-capture` and xcap share one `windows` 0.62.2. Tauri's own
handles (`window.hwnd()`) come from `windows` 0.61, so they cross into 0.62 code
as raw pointers.

### 3. Linux: portal on Wayland, direct X11 on X11, GStreamer for the file

- **Session detection:** `XDG_SESSION_TYPE` and `WAYLAND_DISPLAY`, read once,
  exposed as `capture_support.linuxSession` (`"x11"` / `"wayland"`). The app
  runs as a native Wayland client there (nothing sets `GDK_BACKEND`), and
  forcing XWayland would not help: X11 calls cannot see Wayland windows.
- **Portals:** `ashpd` 0.13.13 (MIT, MSRV 1.87) with
  `default-features = false, features = ["tokio", "screenshot", "screencast", "global_shortcuts"]`.
  It uses zbus 5, which the Linux build **already** carries (19.0, through
  `notify-rust`, `tauri-plugin-opener` and `tauri-plugin-single-instance`), so
  no second zbus. Verified: a spike calling `Screenshot::request().interactive(true)`,
  `Screencast::create_session` / `select_sources` (monitor and window,
  embedded cursor, `PersistMode::ExplicitlyRevoked`) / `start` /
  `open_pipe_wire_remote` and reading `restore_token` passes
  `cargo check --target x86_64-unknown-linux-gnu`.
- **X11 screenshots:** `x11rb` 0.13.2 (already in the graph via `arboard`, pure
  Rust, add the `randr` feature). Not xcap on Linux: it links libpipewire,
  libgbm, libEGL and xcb (libwayshot), needs clang for bindgen in every Linux
  job, and its Wayland path is the non-interactive portal, which is the wrong UX.
- **Recording:** GStreamer through `gstreamer` 0.25 (MIT/Apache, MSRV 1.92, fine
  for 1.95; baseline GStreamer 1.14, Ubuntu 22.04 has 1.20). Pipelines:
  Wayland `pipewiresrc fd=<portal fd> path=<node>`; X11 `ximagesrc`
  (`startx/starty/endx/endy` for an area, `xid` for a window). Then
  `videoconvert ! videoscale` (cap 3840) `! <h264 encoder> ! h264parse` and
  `pulsesrc` for mic and monitor into `audiomixer ! audioresample ! <aac encoder>`,
  into `mp4mux fragment-duration=2000 ! filesink`.
- **Encoder chosen at run time** from what the distro installed, first found
  wins: H.264 `vah264enc` / `vaapih264enc` (hardware), `x264enc`
  (plugins-ugly), `openh264enc` (Fedora's default through the Cisco repo);
  AAC `avenc_aac` (gstreamer1.0-libav), `fdkaacenc` (Fedora's fdk-aac-free),
  `voaacenc`. No H.264 or no AAC encoder: `recordingUnavailable =
  codecsMissing` with the install line for the distro in Rust's message.
- **Why no extra runtime library:** WebKitGTK already links libgstreamer and the
  base libraries, so a Hippius `.deb` already pulls them in. `gstreamer-rs`
  only links libgstreamer-1.0 and GLib. Spike L0 confirms with `ldd`.

### 4. No bundled ffmpeg, no bundled x264

- Windows: Media Foundation's H.264 and AAC encoders ship with Windows (except
  N and KN editions without the Media Feature Pack, which `--probe` detects
  with `MFTEnumEx` and names). The OS vendor carries the patent licences.
- Linux: the distro's GStreamer plugins, declared as `Recommends`. Nothing
  GPL or patent-encumbered is redistributed by Hippius. Bundling an LGPL ffmpeg
  would not help (it has no H.264 encoder without x264, which is GPL, or
  OpenH264, whose patent cover only applies to Cisco's own binaries).
- AppImage (not shipped today): Tauri's `bundleMediaFramework` would copy
  GStreamer in, but must not copy `x264enc`; an AppImage would record only with
  the host's encoder plugins. Out of scope until an AppImage lane exists.

### 5. UX differences we accept

- **Wayland has no overlay selection.** Screenshots go straight to the
  desktop's screenshot UI (GNOME's Shell screenshot UI, KDE's dialog), which
  has area, window and screen. Recordings open the small capture panel for the
  sources, then the desktop's screen-share picker.
- **Linux has no content protection.** On X11 and Wayland a full-screen
  recording films the pill and the camera bubble (the bubble is wanted; the
  pill is not). The pill collapses to a compact dot on Linux and says once
  that it is visible in screen recordings; the tray menu and the shortcut stop
  the recording without it. An area recording on X11 places the pill outside
  the area.
- **Windows has no tray title.** The tooltip carries the time (done) and the
  icon swaps to a recording glyph.
- **Wayland does not honour position or always-on-top.** The pill, the camera
  bubble, the panel and the card go where the compositor puts them. KDE lets
  the user pin a window above others from its menu; GNOME from the window
  menu (Alt+Space, "Always on Top").
- **Wayland area recording** is not in v1 (spike L6 looks at cropping a monitor
  stream to a drawn area).
- **Show clicks** stays macOS-only (`show_clicks_supported` false elsewhere).

### 6. One mixed audio track on Windows and Linux

The macOS helper used to write system audio and the microphone as **two** AAC
tracks. Browser `<video>` elements and most web players play only the first
audio track, so a recording shared by link was heard without its narration.
macOS now mixes them into one stereo 48 kHz 160 kbps AAC track (`AudioMixer`
in `main.swift`: mic +6 dB with a soft limiter, system audio only when the
user turns on `systemAudio`, off by default). Windows and Linux do the same:
one stereo 160 kbps AAC track (mic centred, the system mix ducked 6 dB while
the mic is active is a later nicety).

### 7. Rust owns every platform difference

Per CLAUDE.md, the frontend never checks the platform to decide what capture
does. `capture_support` and `OverlayContext` grow what the bar needs:

```
selection:          "overlay" | "systemPicker"   // Wayland = systemPicker
modes:              { screenshot: [..], recording: [..] }   // what may be offered
screenshotTimer:    bool                          // false on Wayland
systemAudio:        bool                          // can record it; the user turns it on (CaptureOptions.systemAudio)
microphoneUnavailableMessage: Option<String>      // XP-11; Rust's sentence
cameraOnly:         bool                          // already there
shortcut:           { supported, via: "plugin" | "portal" | "desktopSettings" }
recordingUnavailable: + "codecsMissing" | "portalMissing" | "mediaFeaturePackMissing"
```

`RecordingUnavailable::OsTooOld` gets a per-platform message ("Screen recording
needs Windows 10 version 2004 or later."). `recordAvailability` and
`disabledRecordingNote` keep treating every reason except `unsupportedPlatform`
as "shown disabled with Rust's line", so a Linux box missing a codec sees Record
disabled with the package to install, not a vanished button.

## Rollout gating

`SCREEN_CAPTURE_ENABLED = enabledFrom("staging")` stays the one frontend kill
switch for the whole feature. Per-platform readiness is Rust's, inside
`capture_support` and `capture_start`, so a lane never shows a half-ready
platform:

- New `capture::rollout` with a table of the lowest channel each
  (platform, feature) is on, compared with `release_channel::current()`.
  Debug builds count as staging, so `pnpm tauri dev` shows everything built.
- A platform feature below its floor reports exactly what it reports today when
  unsupported: `supported: false` for screenshots, `UnsupportedPlatform` for
  recording. No new frontend path.
- Pinned by a table test (every platform and feature has a row) and a
  `release_lane_pins.rs` test that production never enables a row still
  marked staging-only.

| Platform / feature | After its phase lands | After its manual matrix passes | Production |
|---|---|---|---|
| Windows screenshots | staging (already) | beta | with the macOS release |
| Windows recording | staging | beta | one beta cycle later, and only once the installer is signed |
| Linux X11 screenshots | staging | beta | with Linux recording or before |
| Linux Wayland screenshots | staging | beta | same |
| Linux recording (both) | staging | beta | one beta cycle later |
| Wayland shortcut portal | staging | beta | with Linux recording |

## Phases

The order is the one asked for, with two changes the evidence argued for:

1. A short **Phase 0** first. The helper protocol, `capture_support`'s new
   fields and the rollout gate are shared by every later phase, and CI has no
   Windows clippy or tests to catch the new `cfg(windows)` code.
2. **Windows microphone, system audio and camera move into Windows recording
   (Phase 2)** instead of the later parity phase. The audio clock is part of the
   recorder's timeline: pause retiming, A/V sync and the fragment writer are
   designed once with audio in them or reworked later. The camera on Windows
   is one permission handler. A Windows recorder without a mic would also not
   be worth a beta.

### Phase 0: groundwork (S, 3 to 4 days)

**Status: done.** Deviations: the protocol types live in
`recording/protocol.rs` (both `helper.rs` and the child use them), not in
the child's folder. The child's `--probe` is left to Phase 2's `probe.rs`
(it has nothing to report yet); `--list-microphones` / `--list-cameras`
answer `[]`. `capture_support.shortcut` exists, but Settings does not read
`via` until Phase 6. `selection` is typed in the frontend and always
`overlay`, so nothing branches on it yet. Verified on macOS only: the
Windows lane runs on CI with this change; `--capture-recorder` was driven by
hand on macOS and through the in-process pipe tests on every OS.

**Scope**
- Split `recording/macos.rs` into `recording/helper.rs` (`HelperRecorder`,
  `StartCommand`, `read_events`, `wait_for`, `Death`, `Shared`, all platform
  free and unit-tested) and a thin `recording/macos.rs` (`helper_command()`:
  the Swift binary path, `os_supports_recording`). `recording/windows.rs` and a
  new `recording/linux.rs` return `current_exe()` + `--capture-recorder`.
- The child's skeleton: `src-tauri/src/capture/recorder_child/mod.rs` (stdin
  loop, protocol types shared with `helper.rs` through one `protocol.rs`),
  `timeline.rs` (pause retiming as a pure function of sample times and pause
  intervals), `sizing.rs` (`videoBitRate` and `alignToPixels` from
  `main.swift`, same numbers, with tests pinning them against the Swift
  constants), `synthetic.rs` (a test source: moving frames and a tone). Wired
  from `main.rs` before the builder (`cli::argv_requests_recorder`).
- `capture_support` / `OverlayContext` fields from decision 7, with today's
  values on every platform (no behaviour change yet), and XP-11's
  `microphoneUnavailableMessage` into `CaptureBar`'s caption.
- `capture::rollout` and its tests.
- XP-10's honest message: `capture_confirm` refuses camera-only with the
  recording line when the platform cannot record, before looking for a window.
- CI: `ci.yml` `rust-windows` runs `cargo clippy --all-targets -- -D warnings`
  and `cargo test --lib capture::` (not only `cargo check`), and runs on
  `staging`-targeted PRs that touch `src-tauri/src/capture/**`.

**Rust / frontend split:** all Rust except `CaptureBar` reading the mic
message and the bar honouring `modes`, `screenshotTimer` and `selection`
(still overlay everywhere at this point).

**Tests:** `helper.rs` unit tests moved from `macos.rs` (they run on every
OS now); `timeline.rs` table tests (pause at start, back-to-back pauses, audio
packets straddling a pause, a pause longer than the file); `sizing.rs`
parity tests; the child's protocol loop driven with the synthetic source in a
unit test (start, pause, resume, stop, cancel, stdin EOF) producing a
non-empty file through a fake writer; vitest for the bar caption and modes.

**Done when:** macOS behaviour and every existing test unchanged; the Windows
lane runs clippy and the capture tests green; `Hippius --capture-recorder`
answers `ready` and the synthetic `start`/`stop` on all three OSes.

### Phase 1: Windows screenshots to release quality (S to M, 1 week)

**Status: code done, hardware checklist pending.** Deviations: the default
shortcut is NOT changed (an open decision, below); the refused list adds
Alt+Print Screen and Win+Alt+Print Screen (Windows' own active-window and
Game Bar screenshot keys) to the four named. `wgc` is on without spike W1's
numbers, since the checklist runs on the same hardware: if W1 shows slower
monitor shots or a border on Windows 10, window shots move to our own
one-frame WGC grab as planned. Windows screenshots move to beta in
`capture::rollout` only once the checklist passes.

**Scope**
- xcap `features = ["wgc"]` (XP-1), gated by spike W1's numbers.
- XP-2: after each overlay is built, `GetWindowDisplayAffinity` must read
  `WDA_EXCLUDEFROMCAPTURE`; if not (older build, a driver that refuses it),
  the overlays are closed and the compositor given two frames (`DwmFlush`)
  before the grab, and the card and bar are hidden during it.
- OS floor: read the build once (`RtlGetVersion`, cached like
  `macos_version`); below 19041 screenshots still work (they close the
  overlays first) but recording will say `osTooOld`.
- XP-6: default shortcut on Windows becomes `Alt+Shift+2` for new users;
  `validate` refuses Windows's own `Win+Shift+S`, `Win+PrtSc`, `PrtSc` and
  `Win+Alt+R` (Game Bar) with a sentence like macOS's. Existing saved
  shortcuts are kept.
- XP-21: in dev on Windows the failure toast may not show; the rules say so.
- XP-16: note in the rules that pill and card do not follow a virtual desktop
  switch.
- Hardware verification of what the audit could only read: mixed DPI (150 %
  laptop left of a 100 % monitor, and the reverse, and a monitor above),
  DPI-unaware window shots, full-screen apps, HDR displays (WGC returns an
  8-bit SDR frame by default; check the shot is not washed out).

**Files:** `src-tauri/Cargo.toml`, `capture/commands.rs` (`open_overlay`,
`capture_blocking`), `capture/shortcut.rs`, `capture/permissions.rs`
(Windows build), `capture/screenshot.rs`.

**Packaging / CI:** none beyond Phase 0.

**Tests:** `shortcut::validate` refusals per platform; a wiring pin that
Windows overlays check affinity; `targets` tests unchanged.

**Manual checklist (Windows 11 x64 hardware, then the ARM VM for smoke):**
area, window and screen shots on each monitor of a mixed-DPI pair; a window
straddling two monitors; a DPI-unaware app (an old Win32 tool) window shot is
whole; a minimised window is not offered; the bar's display follows the
pointer; no dim band or bar in any shot; card placement bottom-right of the
work area above the taskbar on each monitor, the taskbar on the left and top
too; Show in Explorer selects the file; shortcut from inside a full-screen
app; the capture tray button; signed out shortcut brings the main window.

**Done when:** the checklist passes on hardware and the ARM VM, and Windows
screenshots move to beta in `capture::rollout`.

### Phase 2: Windows recording (L, 3 to 4 weeks)

**Status: code done, hardware checklist pending.** Verified only by cross
checks from a Mac (`cargo check` and `cargo clippy --all-targets -D warnings`
for `x86_64-pc-windows-msvc`, with the MSVC headers from `xwin`) and by the
platform-free tests on macOS. Nothing in it has run on Windows yet. The
rollout row is unchanged: Windows recording shows in debug and staging
builds only, never on beta or production.

**What landed**
- `recorder_child/` platform-free pieces, tested on every OS: `mixer.rs`
  (the Swift `AudioMixer` ported, numbers pinned against `main.swift`),
  `pcm.rs` (any WASAPI mix format to stereo 48 kHz float, linear
  resampling carried across packets), `frame.rs` (BGRA to BT.709 limited
  NV12, letterboxed into the fixed output size), `pacing.rs` (30 fps gate,
  the held last frame with its true duration, a still picture rewritten
  once a second, repeated at Stop), `plan.rs` (area pixels via
  `alignToPixels`, even and capped output, the stage inset) and
  `pipeline.rs` (origin on the first picture, the mixer, exact 100 ns audio
  times from frame counts, behind an `Encoder` trait with a fake in tests).
  The child's session is a `Live` trait; `serve` is unchanged otherwise.
- `recorder_child/windows/`: `wgc.rs` (windows-capture 2.0.1 on the HMONITOR
  or HWND from the app's ids, sign-extended back from xcap's 32 bits; cursor
  on; border off from build 22000 with a retry on the default if refused;
  `MinimumUpdateInterval` from 26100; area cropped on the GPU with
  `CopySubresourceRegion` via `buffer_crop`; Hippius's own window (the stage)
  trimmed by the 12 px inset at its DPI; at most 4 pictures queued for the
  writer, the rest dropped), `writer.rs` (FMPEG4 sink writer, NV12 in, H.264
  High, `MF_MT_MAX_KEYFRAME_SPACING` 60, `video_bit_rate`, BT.709 tags, AAC
  160 kbps from 16-bit PCM; hardware transforms first, software on a setup
  failure), `audio.rs` (one WASAPI shared client per device on its own
  thread, 48 kHz stereo float with `AUTOCONVERTPCM`, the mix format and
  `pcm.rs` otherwise, QPC-stamped packets), `devices.rs`
  (`--list-microphones`), `probe.rs` (`--probe`: build, H.264 and AAC
  encoders, hardware H.264), `self_test.rs` (`--self-test` and a Windows-only
  unit test: synthetic 3 s, 1 s pause, 2 s through the real writer, read back
  with `IMFSourceReader`), `com.rs` (COM, MF startup, `SetThreadExecutionState`
  keep-awake, the QPC clock).
- Session (`windows/mod.rs`): every device has one owner. WGC's own thread
  owns the capture, one thread per audio device owns its WASAPI client, the
  writer thread owns the sink writer and the pipeline, and the camera is
  never opened by the recorder (the bubble's webview owns it and is filmed
  as a window), so screen, system audio, microphone and camera run side by
  side; a device that cannot open is left out with a stderr line instead of
  failing the recording. `started` is answered once the first picture has
  made the writer (so a missing encoder fails Start with its reason). A
  closed window or unplugged display (`on_closed`), or a writer error,
  finishes the file and says `stream_stopped` with `saved`; a lost
  microphone ends only its thread. Stop is time-boxed at 30 s; Cancel drops
  the writer unfinished and deletes the file; stdin EOF is still "finish and
  keep" through `serve`.
- App side: `recording::windows` starts the child with `CREATE_NO_WINDOW`;
  `recording_unavailable` = lane, then build 19041 (`osTooOld`), then the
  encoders from an in-process probe cached per launch
  (`mediaFeaturePackMissing`); `microphone_supported` and `list_microphones`
  go through the child; `systemAudio` is offered on Windows;
  `camera_only_supported` is true on Windows and `camera_window_id` returns
  the camera window's HWND; `webview_media.rs` answers WebView2's
  `PermissionRequested` with Allow for CAMERA and MICROPHONE on
  `capture-camera` and `capture-overlay-*` only, for the app's own origin
  only; a microphone blocked by the ConsentStore (`Deny` in the device or
  the `NonPackaged` switch, HKCU or HKLM) dims the mic row with a Windows
  sentence.

**Deviations from the scope above** (the ones marked *closed* were done
with Phase 5 and 6, below)
- No `gpu.rs`: BGRA to NV12 and any scaling run on the CPU (`frame.rs`) after
  a GPU crop. Fine at 1080p30 by arithmetic; spike W3 decides whether 4K30
  needs the D3D11 video processor.
- *Closed.* No process loopback: system audio was plain endpoint
  loopback, so Hippius's own sounds were recorded too.
- *Closed.* The camera bubble was not added to a window recording (WGC
  takes one item, so it needs two captures composited).
- *Closed.* No button to `ms-settings:privacy-*`, and a blocked camera had
  no surface (the bubble stayed black).
- *Closed.* XP-15 (a recording glyph on the tray icon): the icon is created
  and swapped by the main window (`useTraySync.ts`), so Rust's writes had to
  be designed not to fight it.
- The CI self-test runs as a unit test (`cargo test --lib capture::` already
  runs on the Windows lane) instead of a separate `--self-test` step; it
  skips itself where the runner has no Media Foundation encoders.
- *Closed.* `--list-cameras` printed `[]` on Windows, and the bar's
  microphone meter never moved there (`recording::meter_command` was
  macOS-only).

**Needs a Windows PC to know** (none of this could be exercised from a Mac)
- that WGC starts from the child for a monitor, a window and the stage, and
  the border/interval fallbacks behave (W2);
- the sink writer accepts NV12 at odd-but-even sizes on hardware encoders
  (W3) and the software fallback triggers when it does not;
- a killed child leaves a playable fragmented MP4 (W4);
- AUTOCONVERTPCM is honoured by real drivers, loopback goes quiet without
  stalling the mic, and A/V stay in sync over an hour (W5);
- the WebView2 handler fires (bubble shows the camera, meter moves) and the
  ConsentStore reading matches the Settings switches;
- the stage inset and the HWND sign-extension are right on a real machine.

**Windows hardware test checklist** (Windows 11 x64 at 150 % with an
external 100 % monitor, then Windows 10 22H2, then the ARM VM for smoke; a
debug or staging build, since beta and production do not offer Record)
1. `Hippius.exe --capture-recorder --probe` prints the build and
   `h264Encoder`/`aacEncoder` true; `--list-microphones` lists every input
   with the default marked; `--self-test` prints `"ok":true`.
2. Record button shows (not hidden, not disabled) on a debug build; on a
   Windows N VM without the Media Feature Pack it is disabled with the
   Media Feature Pack line.
3. Entire screen, 10 s, each monitor: plays in the card, Edge, Chrome,
   Firefox and the Drive preview; the pill, overlay and card are not in the
   video; the camera bubble is.
4. Area on the 150 % monitor and on the 100 % one: the video is exactly the
   drawn area (compare a screenshot of the same area).
5. A window recording: resize the window mid-recording (letterboxed, never
   stretched); close the window (the card delivers what was recorded, the
   pill ends); a DPI-unaware app's window comes out whole.
6. Unplug the recorded monitor mid-recording: the file is kept and delivered.
7. Pause and resume three times in a 2 minute take; the duration equals the
   recorded time and a clap stays in sync after each resume.
8. Microphone only, system audio only (a YouTube video), both: one audio
   track (check with `ffprobe` or MediaInfo), the mic louder than before;
   a 44.1 kHz and a 16 kHz (Bluetooth hands-free) headset; unplug the USB
   mic mid-recording (recording goes on, stderr says so in the log).
9. Silence on the speakers for 30 s with the mic on: the narration does not
   lag or drop (loopback sends nothing while silent).
10. Camera bubble small, large and full with Entire screen and Area; camera
    only (Screen off): the stage is recorded without its transparent margin
    or black corners.
11. Turn off "Let desktop apps access your microphone" in Settings: the bar's
    mic row is dimmed with the Windows line; turn it back on, reopen the bar.
12. Kill `Hippius.exe --capture-recorder` in Task Manager after 20 s: the
    file in `%USERPROFILE%\.hippius\capture-tmp` plays at least 18 s.
    Quit the app mid-recording the same way: the child finishes the file.
13. Sleep the laptop mid-recording, wake it: the recording ends or goes on,
    and either way the file plays.
14. 5 min and 60 min recordings at 1080p30 and 4K30: CPU in Task Manager,
    file size near 14 Mbps (1080p) / 28 Mbps (4K), A/V offset at the end.
    Repeat on an NVIDIA or AMD machine (hardware encoder) and in the ARM VM
    (software encoder).
15. Windows 10: the yellow border shows around the recorded item and is not
    in the video; no console window flashes when recording starts.
16. Run each case in light and dark mode; check the pill and card at 1280x720
    and at 200 %.

**Original scope**
- `recorder_child/windows/`: `wgc.rs` (sessions for monitor, window, area;
  cursor on; border off on Windows 11; 30 fps cap by dropping frames closer
  than 33 ms, or `MinimumUpdateInterval` on 24H2), `gpu.rs` (video processor:
  crop, scale, BGRA to NV12), `writer.rs` (FMPEG4 sink writer, H.264 and AAC
  types, bitrate from `sizing.rs`, BT.709, last frame repeated at Stop like
  macOS), `audio.rs` (WASAPI mic, loopback or process loopback, resample, mix),
  `devices.rs` (`--list-microphones`: endpoint id, FriendlyName, default
  first), `probe.rs` (encoders present, OS build).
- Pause: frames and packets inside a pause are dropped; every later sample is
  retimed by the pauses before it (`timeline.rs`), video and audio alike.
- Stream death: a closed window (`GraphicsCaptureItem.Closed`), a monitor
  unplugged, a device lost or a writer error emits `stream_stopped` with
  `saved`, after finishing the file. stdin EOF finishes and keeps the file;
  only `cancel` deletes. Finishing is time-boxed (30 s).
- Keep the display awake while recording (`SetThreadExecutionState` in the
  child).
- Rust side: `recording::windows` wires `HelperRecorder` to the child;
  `recording_unavailable` becomes OS build >= 19041, encoders present
  (`mediaFeaturePackMissing` otherwise); `microphone_supported` and
  `list_microphones` go through the child; `camera_window_id` on Windows
  returns the camera window's HWND (XP-10), which is also xcap's window id, so
  camera only works (`camera_only_supported` true on Windows).
- XP-7 on Windows: a `PermissionRequested` handler added through
  `WebviewWindow::with_webview` (`controller().CoreWebView2()`) on the
  `capture-camera` and `capture-overlay-*` webviews only, allowing `CAMERA` and
  `MICROPHONE` for the app's own origin; every other kind and every other
  window keeps WebView2's default. Camera or mic blocked by Windows privacy
  settings (the ConsentStore `NonPackaged` value is `Deny`) becomes a clear
  line with a button to `ms-settings:privacy-webcam` /
  `ms-settings:privacy-microphone`.
- The pill and bubble: verify never focused on the second show, pill
  content-protected (never filmed), bubble not (filmed), bubble inside the area
  for area recordings.
- XP-15: the tray icon swaps to a recording glyph while Recording / Paused
  (Rust, next to `show_phase_in_tray`).

**Rust / frontend split:** all of the above is Rust. Frontend: nothing new
beyond Phase 0's fields (the bar, pill, card and menus already read Rust's
state and reasons).

**Packaging:** nothing new in the installer (the recorder is the app binary).
The NSIS and MSI size grows by the new code only (estimate under 1.5 MB
compressed). WebView2 already ships through the bootstrapper.

**CI:** `ci.yml` Windows job runs `Hippius --capture-recorder --self-test`
(synthetic source through the real Media Foundation writer: encode 3 s, pause
1 s, resume 2 s, stop; then read the file back with `IMFSourceReader` and
assert duration 5 s within 0.2 s, one video and one audio stream, H.264 and
AAC, even dimensions). Hosted runners have no interactive desktop for WGC, so
WGC itself is manual.

**Tests:** `timeline.rs` and `sizing.rs` (Phase 0); `helper.rs` session tests
with a fake child for death, EOF and id echo; `commands.rs` fake-`Recorder`
harness unchanged; `capture_wiring.rs` pins: the permission handler is
attached to the camera and overlay labels only, the pill stays
content-protected, the camera does not.

**Manual checklist:** screen, window and area recordings of 10 s, 5 min and
60 min; pause and resume three times, then check duration and lip-sync against
a clap; kill the child (Task Manager) and the app mid-recording, then play the
file left in `capture-tmp`; unplug the recorded monitor; close the recorded
window; sleep the laptop mid-recording; mic on each device, system audio with
a YouTube video, both together; a 44.1 kHz and a 16 kHz headset; camera bubble
small, large, full and camera only; mixed-DPI area on the 150 % monitor; CPU
and file size at 1080p30 and 4K30 on Intel, AMD and NVIDIA; the result plays in
Chrome, Edge, Firefox and the Drive preview with sound; the Windows 10 yellow
border is not in the video; Windows N without the Media Feature Pack shows the
reason.

**Done when:** the checklist passes on x64 hardware with at least two GPU
vendors, the ARM VM plays its own recordings (software encoder path), and
Windows recording moves to beta.

### Phase 3: Linux screenshots (M, 1.5 to 2 weeks)

**Status: code done, Linux checklist pending.** Linux X11 and Wayland
screenshots are in; `capture::rollout` keeps both on staging (debug builds
count as staging), so beta and production still report Linux unsupported.

What landed, and where it differs from the scope below:
- `capture/linux_x11/` (not `capture/targets/linux_x11.rs`): `model.rs` is
  the pure half (RandR monitors to displays, the XSETTINGS
  `Gdk/WindowScalingFactor` parser and `GDK_SCALE` rule, EWMH window
  filtering front first with frame extents, `_NET_WM_STATE_HIDDEN`,
  `_NET_WM_DESKTOP` and furniture window types, `ZPixmap` to RGBA for 32,
  24 and 16 bpp in either byte order, clipping to the root), tested on
  every OS; `os.rs` is the x11rb connection (Linux only). `targets`,
  `screenshot` and `share` re-export it on Linux, so `commands.rs` runs the
  same overlay flow it runs on Windows.
- **HiDPI on X11:** one scale for the whole screen, GDK's (`GDK_SCALE`,
  else the XSETTINGS window scale, else 1; whole numbers only, as GDK 3 on
  X11). Every display gets that scale, so a mixed 100/200 % pair reads as
  both at the screen's scale, which is what the webview draws at.
- **Overlays on X11 are made full screen** (`cover_whole_display`) after
  they are shown: GNOME and KDE keep ordinary windows clear of their panels,
  which would shift the overlay and every area read back by the panel's
  height. There is no content protection, so `ui_in_grabs` is set for every
  Linux session and `settle_compositor` waits `COMPOSITOR_SETTLE` (120 ms,
  pending spike L1) after the overlays are gone and the card is hidden.
- **Window shots read the screen where the window is**, so a covered window
  comes out as what is on top (XComposite is a later nicety, as planned).
  The frame includes the window manager's decorations (`_NET_FRAME_EXTENTS`).
- **Share picker on X11:** one root grab per refresh, every picture cropped
  from it. No app icons on Linux yet (the tile shows the app name).
- `capture/linux_portal.rs`: the Wayland flow. `support::start_plan` sends
  a Wayland screenshot past the overlay: `capture_start` hides Hippius's own
  windows, prepares the card hidden, and spawns `system_picker_screenshot`,
  which holds the session in `Capturing` while the desktop's tool is open.
  `settle` turns the portal's answer into the capture: `file://` URIs are
  percent-decoded byte for byte (`localhost` accepted, other hosts and
  schemes refused, a symlink never followed), PNGs are MOVED (rename, else
  copy then remove) under the Hippius name, other formats re-encoded to PNG
  and the original removed. Cancelled = a quiet cancel; no portal =
  `PORTAL_MISSING` (names `xdg-desktop-portal` and the backends); anything
  else = `PORTAL_FAILED` with the D-Bus detail logged only. ashpd is on with
  `screenshot` only; Phase 4 adds `screencast`.
- **Surfaces:** Wayland reports `selection: systemPicker`, no screenshot
  modes, no timer, recording modes `window` and `screen` (for Phase 4), a
  `systemPickerNote` and `linuxSession`. Linux X11 and Wayland report
  `shortcut.supported: false` with `shortcut.unavailableMessage` (Phase 6
  brings the shortcut).
- **Frontend:** on `systemPicker` the Screenshot menu is one item ("Take a
  screenshot…") with Rust's note and the drive item, no "Open capture bar".
  Where the shortcut is unsupported no keycaps show and Settings shows
  Rust's line instead of the shortcut controls; on Wayland Settings also
  says the desktop's tool takes the screenshot.
- **Card on Wayland (spike L4):** not decided on hardware. The card is kept
  as is; the compositor places it (usually centred) and GNOME may show
  "Hippius is ready" instead of raising it. If the checklist shows that,
  switch to a notification with the link copied and a "Show in folder"
  action.
- **Packaging:** deb `recommends` `xdg-desktop-portal` and
  `xdg-desktop-portal-gnome | xdg-desktop-portal-kde |
  xdg-desktop-portal-wlr` (never `depends`: X11 needs no portal).
- **CI:** `rust-linux` installs `xvfb` and runs the `#[ignore]`d X server
  test (`xvfb-run -a cargo test --lib capture::linux_x11 -- --ignored`):
  displays listed, a screen grab at the display's pixel size, a root grab,
  the pointer.

**Verified so far:** `cargo check --lib --target x86_64-unknown-linux-gnu`
from macOS (fake `.pc` files and a no-op C compiler stand in for the Linux
system libraries; this type-checks every Rust line, links nothing). On
macOS: `cargo clippy --all-targets -- -D warnings`, `cargo test --lib
capture::` (the pure X11, portal, surfaces and Phase 4 plan tests included),
`capture_wiring` and `release_lane_pins`; vitest, eslint and `tsc` for the
menu and Settings. Clippy with the crate's lints on the Linux-only files
(`linux_x11/os.rs`, the Linux share picker, the portal call) for the Linux
target through a stand-alone crate that includes them.
**Not verified anywhere yet:** any real X server or portal, and clippy of
the whole crate for Linux (from macOS clippy builds `build.rs` for the
target and fails on `tauri_build`; CI's `rust-linux` runs it natively), nor
the Linux test run itself (CI's `rust-linux` and its new Xvfb step).

**Linux checklist** (every row in light and dark mode; the card and the
Settings card at the smallest window and at 200 %):

*Ubuntu 24.04, GNOME, Wayland session (the default):*
1. `capture_support` answers `linuxSession: "wayland"`, `selection:
   "systemPicker"`; the Screenshot menu has one item, the note, no capture
   bar; Record is hidden.
2. "Take a screenshot…": GNOME's screenshot UI opens. Take an area, then a
   window, then a screen: each lands in `<drive>/Captures` with a link
   copied, and `~/Pictures/Screenshots` has no new file.
3. Press Escape in GNOME's UI: no toast, no card, the main window comes
   back as it was, and Screenshot works again at once.
4. Note where the card appears and whether it is raised (spike L4).
5. Remove `xdg-desktop-portal-gnome` (or stop the portal): the toast says
   to install the portal, and the session ends.
6. A 200 % display, and a 100 % plus 200 % pair: the file is at each
   output's full pixels.
7. Settings > Sync & Storage > Capture: the Screenshots line and the
   shortcut line show; there is no Change button for a shortcut.

*Ubuntu 24.04, "Ubuntu on Xorg" session:*
1. `linuxSession: "x11"`, `selection: "overlay"`; the menu has the three
   modes and "Open capture bar" with no keycaps.
2. The overlay covers the whole display, top bar and dock included; the
   bar opens on the display under the pointer.
3. Area: drag a rectangle over known content; the file is exactly that
   region (check edges against a grid image), with no dim band, bar or card
   in it.
4. Window: hover highlights the frontmost window under the pointer
   (title bar included); a minimised window, a window on another
   workspace, the top bar and the dock are never offered; Hippius's own
   windows are never offered.
5. Screen: click-to-capture each display of a two-display setup, one left
   of the other and then one above; each file is that display only.
6. Share picker: both tabs fill with live pictures and refresh; picking a
   window or screen captures it.
7. `GDK_SCALE=2` (or Settings > Displays at 200 %): the overlay is not
   half size or offset, and an area crop matches what was framed.
8. Disable the compositor if the desktop allows it (or use a non-compositing
   window manager): note what the overlay looks like (spike L1, the
   transparent window needs a compositor).
9. Time from click to card; if the shot ever shows the overlay fading out,
   raise `COMPOSITOR_SETTLE` (spike L1).

*Fedora 42 KDE Plasma 6, Wayland (the default):*
1. KDE's screenshot dialog opens; area, window and screen each deliver;
   the temp file KDE wrote is gone afterwards.
2. Cancel in KDE's dialog: a quiet cancel.
3. The card's placement and raising (spike L4).

*KDE Plasma X11 and XFCE (X11), if a VM is at hand:*
1. The overlay covers the panel; the window list skips the panel and the
   desktop; `_NET_FRAME_EXTENTS` frames are right (KDE draws server-side
   decorations).
2. XFCE with its compositor off: transparency fails; record what the user
   sees.

*Everywhere:* Show in folder opens Nautilus, Dolphin or Thunar on the right
folder; a failed upload's card offers Retry; signed out, Screenshot is not
offered.

**Done when** (unchanged): the checklist passes and Linux screenshots move
to beta in `capture::rollout` (both `LinuxX11` and `LinuxWayland`
`Screenshots` rows; they can move separately).

**Scope**
- `CAPTURE_SUPPORTED` true on Linux; xcap stays macOS and Windows only.
- `capture/targets/linux_x11.rs`: displays from RandR `GetMonitors` (physical
  pixels, primary, names), windows from `_NET_CLIENT_LIST_STACKING` with
  `_NET_WM_NAME`, `_NET_WM_PID`, `_NET_FRAME_EXTENTS`, `_NET_WM_STATE_HIDDEN`,
  front first; own pid dropped. Shots by `GetImage` of the root window cropped
  to the display, area or window frame (so occluded windows come out as what
  is on top, like a macOS screen area; acceptable for v1, window shots of
  covered windows are a later nicety through XComposite).
- X11 overlays: the same `open_overlay`, placed in physical pixels
  (`COORDS_ARE_LOGICAL` false). Before the grab: close the overlays, bar and
  card, wait for the compositor (two frames, measured in spike L1), then grab.
- `capture/linux_portal.rs`: Wayland screenshots. `capture_start(screenshot)`
  on Wayland skips overlays and panel and calls the Screenshot portal with
  `interactive(true)`. The returned file is moved (not copied) into a fresh
  capture dir under its Hippius name, then the usual card and delivery. A
  cancelled portal ends the session as a cancel, not a failure. The screenshot
  timer is hidden (`screenshotTimer: false`).
- Share picker on X11 with x11rb thumbnails; not offered on Wayland.
- Card on Wayland per spike L4 (the card as a normal window, or a notification
  with the link copied and a "Show in folder" action).
- `capture_support.linuxSession`, `selection`, `modes` filled in for Linux.
- Settings copy for Linux ("Wayland uses your desktop's screenshot tool").

**Rust / frontend split:** Rust decides the flow per session; the frontend
already hides what `modes` excludes. The Capture menu on Wayland shows
"Screenshot" (one item: the portal picks the mode) and the Record items.

**Packaging:** deb `Recommends: xdg-desktop-portal, xdg-desktop-portal-gnome |
xdg-desktop-portal-kde | xdg-desktop-portal-wlr` (present on every mainstream
desktop). No new build packages (x11rb and ashpd are pure Rust).

**CI:** Linux clippy and tests already run on every Rust PR. Add an
`xvfb-run` test that lists displays and grabs the root through
`linux_x11.rs` (Xvfb has RandR).

**Tests:** EWMH parsing and window filtering from recorded property fixtures;
portal URI to path handling (`file://` with percent-encoding, a URI outside
the home directory); the move-not-copy rule; the Wayland session skipping
overlays (session test with a fake portal).

**Manual checklist:** Ubuntu 24.04 GNOME Wayland (portal UI: area, window,
screen; cancel), Ubuntu 24.04 "Ubuntu on Xorg" (overlay flow, hover, share
picker, two displays), Fedora KDE Wayland (KDE's dialog), a 200 % display and a
mixed 100/200 % pair on X11 (single scale) and on Wayland; the file is gone
from `~/Pictures` if the portal put it there; Show in folder opens Nautilus,
Dolphin and Thunar on the right folder; the card's behaviour per L4.

**Done when:** the checklist passes and Linux screenshots move to beta.

### Phase 4: Linux recording (L, 3 to 4 weeks)

**Status: code done, Linux checklist pending.** Verified only from a Mac:
`cargo check` and `cargo clippy --lib --tests` (pedantic, no warnings) for
`x86_64-unknown-linux-gnu` with fake `.pc` files and a no-op C compiler (this
type-checks every Linux line, gstreamer-rs and ashpd included, and links
nothing), plus the platform-free tests on macOS. Nothing in it has run on
Linux yet. The rollout rows are unchanged: Linux recording shows in debug and
staging builds only, never on beta or production.

**What landed**
- **Platform-free, tested on every OS:** `recorder_child/linux_plan.rs`
  (encoder order and every installed candidate in turn, the `--probe`
  answer and its `codecsMissing` / `portalMissing` decision, the capture and
  writer pipeline texts, X11 rectangles from RandR displays with the crop
  through `plan::area_pixels`, what the portal is asked, why a stream ended,
  the microphone list without monitors), `recorder_child/writer_loop.rs`
  (the writer thread generic over `pipeline::Encoder`: first picture fixes
  the size and answers Start, `Ended` finishes and says `stream_stopped`
  with `saved`, Stop / Cancel, at most 4 pictures waiting) and
  `recorder_child/meter.rs` (50 ms RMS windows, the Swift meter's exact
  lines). `capture/screencast_token.rs` decides and stores the restore
  token. `support::Surfaces` gains `recordCountdown`, `StartPlan::Panel`,
  `system_picker_selection` and `countdown_secs`.
- **The recorder child on Linux** (`recorder_child/linux/`): `capture.rs`
  (one GStreamer pipeline and one pulling thread per device: the picture,
  the microphone, the system's sound; every pipeline on the monotonic system
  clock, so a buffer's time is base time plus timestamp, and pause / resume
  read the same clock), `encoder.rs` (`appsrc` into H.264, one AAC track,
  `mp4mux fragment-duration=2000`; times set on every buffer; installed
  encoders tried in order, so a VA encoder that cannot start falls back to
  x264 or OpenH264), `portal.rs` (ScreenCast: monitor or window, embedded
  pointer where offered, persist only a monitor, the PipeWire fd kept open;
  Inhibit idle on both sessions; both closed with the recording so the
  desktop's indicator goes), `devices.rs`, `probe.rs`, `meter.rs`,
  `self_test.rs` and `mod.rs` (the `Live` session).
- **One owner per device.** The camera is never opened by the recorder (the
  bubble's webview owns it and is filmed as a window); the mic meter is the
  child in `--meter` mode, stopped before the recorder opens the same
  microphone (`mic_meter::meter_may_run`); screen, system audio, microphone
  and camera therefore run side by side. A device that will not open is left
  out with a stderr line; a chosen microphone that is gone records the
  default; a sound device lost mid-recording ends only its thread.
- **App side:** `recording::linux` probes once per launch on its own thread
  (warmed at launch by `warn_if_helper_missing`), lists microphones and
  starts the meter through the child, and waits up to 5 minutes for
  `started` on Wayland (the user is in the desktop's dialog). Linux
  microphone and system audio are offered whenever Linux records. The
  protocol carries `restoreToken` in `start` and `started`, and a refusal of
  exactly `PICKER_CANCELLED` ends the session quietly (`fail_capture` emits
  nothing).
- **Wayland panel:** `capture_start` opens one `capture-overlay-0` window
  (the overlay page, so the overlay capability and media permission apply)
  at 520 x 600, centred by the compositor, with no display watch. The page
  draws the bar alone on the glass (draggable, `core:window:allow-start-dragging`
  added to `capture-overlay.json`), no selection surface, no window polling,
  no Choose button, no countdown; `capture_confirm` turns Record into
  `Selection::Window { 0 }` or `Selection::Screen { 0 }` and the child asks
  the portal for that kind.
- **Packaging and CI:** deb `recommends` the GStreamer plugins (base, good,
  bad, ugly, libav, pipewire); `rust-ci-setup` and the three release lanes'
  Linux legs install `libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev`;
  `rust-linux` installs the encoder plugins and runs the ignored recorder
  tests (`cargo test --lib capture::recorder_child::linux -- --ignored`: a
  paused take read back at 5 s with one H.264 and one AAC track, and the
  test binary run as a writer, SIGKILLed after 6 s, whose file must play at
  least 4 s). Pinned in `release_lane_pins.rs` and `capture_wiring.rs`.

**Deviations from the scope below**
- **Pause is retimed in Rust, not in pad probes.** Each device has its own
  capture pipeline ending in an `appsink`, and the file is written by an
  `appsrc` pipeline: Rust places samples on `timeline.rs`, mixes with the
  same `mixer.rs` Windows uses and holds still pictures (`pacing.rs`). One
  live pipeline with `audiomixer` would drop retimed audio as late, and a
  device that fails would fail the whole pipeline.
- **No separate `x11.rs` / `pipeline.rs` / `audio.rs`:** the X11 decision is
  `linux_plan::x11_source`, the pipelines are `capture.rs` and `encoder.rs`.
- **The restore token is device-wide, not per account,** and sent only for a
  whole screen on a machine with one display: a restored session skips the
  dialog, so with two displays (or a window) it would record the old choice
  unasked with no way to pick another.
- **No countdown on Wayland** (`recordCountdown: false`): the desktop's
  dialog comes between Record and the recording, so a count before it would
  end at a dialog. The plan's "countdown in the pill after the picker" is
  left for Phase 6.
- **No poster on Wayland:** Hippius cannot read the screen there, so the
  card of a Wayland recording has no picture.
- **Not done:** the pill's compact form and one-time "visible in screen
  recordings" note, placing the pill outside an X11 area recording, the
  bubble in a window recording (`WINDOW_RECORDING_ADDS_CAMERA` stays macOS
  only), camera only on Wayland (no window ids there), Wayland area
  recording (spike L6), the staging `rpm` bundle, and the `codecsMissing`
  line names every package rather than the missing one (the probe logs
  exactly which elements are missing). The camera on Linux (the WebKitGTK
  permission, `--list-cameras`, camera only on X11) landed with Phase 5's
  Linux part, below.

**Needs real Linux sessions to know** (none of this ran from a Mac)
- that `gst::parse::launch` accepts every pipeline text with the distro's
  plugins, `ximagesrc` honours the inclusive corners and `xid`, and
  `pipewiresrc fd=… path=…` negotiates with GNOME's and KDE's streams
  (spike L3, including DMA-BUF-only streams);
- that renegotiating the `size` capsfilter after the first frame takes,
  and a resized window letterboxes (`videoscale add-borders`);
- that `mp4mux` fragments survive SIGKILL in Firefox, Chrome and the Drive
  preview (CI covers it once `rust-linux` runs it);
- pulsesrc timestamps against the system clock over an hour (A/V sync),
  `@DEFAULT_MONITOR@` on PipeWire, PulseAudio and with Bluetooth outputs;
- the portal: the dialog for monitor and window, restore tokens (L7), the
  desktop's "stop sharing" ending the file with `saved`, cancel being quiet;
- the panel window on GNOME and KDE (transparent corners, dragging,
  focus), the Inhibit portal keeping the screen on;
- the probe's timing on a first run (registry build) and the `codecsMissing`
  line on a minimal install.

**Linux recording checklist** (a debug or staging build; every row in
light and dark mode, the panel and pill at the smallest window and 200 %)

*All sessions:*
1. `hippius --capture-recorder --probe` prints `gstreamer: true`, both
   encoders and an empty `missing`; on Wayland `screencastPortal: true`.
   `--list-microphones` lists every input, the default first, no
   "Monitor of" entries. `--self-test` prints `"ok":true`.
2. `--meter` prints `ready` then a level about every 50 ms that moves when
   you speak; closing stdin (Ctrl+D) exits at once.
3. Remove `gstreamer1.0-plugins-ugly` and `gstreamer1.0-libav` (or on
   Fedora the OpenH264 plugin), restart: Record shows disabled with the
   packages line, in the bar, the Capture menu and Settings.

*Ubuntu 24.04, "Ubuntu on Xorg":*
1. Entire screen, 10 s, each display of a two-display setup (side by side,
   then one above): plays in Firefox, Chrome and the Drive preview with
   sound; the pill is visible in the video (accepted), the bubble too.
2. Area on a `GDK_SCALE=2` screen: the video is exactly the drawn area.
3. Window: move and resize it mid-recording (letterboxed, never stretched);
   close it: the card delivers what was recorded.
4. Pause and resume three times in 2 minutes: duration equals the recorded
   time, a clap stays in sync.
5. Microphone only, system audio only (a YouTube video), both: one audio
   track (`ffprobe`), mic louder than system; a USB mic unplugged
   mid-recording (recording goes on); a Bluetooth headset in HFP.
6. The mic meter moves in the bar for each microphone; Record right after
   (the meter stops first, the recording has the mic).
7. Camera bubble small, large and full over Entire screen and Area.
8. `kill -9` the `--capture-recorder` child after 20 s: the file in
   `~/.hippius/capture-tmp` plays at least 18 s.

*Ubuntu 24.04, GNOME, Wayland (the default):*
1. Record opens the panel (centred): sources, Window / Entire screen,
   Options without a countdown; Record opens GNOME's sharing dialog.
2. Pick a screen: GNOME's top-bar indicator shows; Stop delivers the file.
   Record again: on one display no dialog the second time; on two displays
   the dialog shows every time.
3. Window mode: pick a window; it is recorded even when covered; close it:
   the file is delivered.
4. Cancel in GNOME's dialog: no toast, no card, the main window comes back.
5. Stop sharing from the top-bar indicator mid-recording: the file is
   delivered like a Stop.
6. Leave it recording for 15 minutes with the screen idle: it does not
   blank (Inhibit).
7. Remove `xdg-desktop-portal-gnome` (or stop the portal): Record says the
   portal line.

*Fedora 42 KDE Plasma 6, Wayland:*
1. KDE's sharing dialog, monitor and window; the tray's sharing indicator
   stops it; OpenH264 + fdk-aac path (`--probe` names them).
2. Restore token honoured on the second recording (one display).

*An x86_64 machine with Intel graphics:* `vah264enc` is chosen, CPU stays
low at 1080p30; on a machine without VA, x264 is used.

**Original scope**
- `recorder_child/linux/`: `portal.rs` (ScreenCast session in the child:
  monitor or window per the mode, embedded cursor, persist mode 2, the restore
  token handed back in `started` and passed in the next `start`), `x11.rs`
  (`ximagesrc` for screen, area and window by XID), `pipeline.rs` (encoder
  selection, `mp4mux` fragments, bus errors to `stream_stopped`), `audio.rs`
  (`pulsesrc` for the chosen source and for the default sink's monitor,
  `audiomixer`), `devices.rs` (`GstDeviceMonitor`, `Audio/Source`, default
  first, monitors excluded from the mic list), `probe.rs`.
- Pause and retiming per spike L3: pad probes drop buffers inside a pause and
  shift later ones by the pauses before them (the same `timeline.rs`), rather
  than PAUSED/PLAYING state changes, which `pipewiresrc` handles unevenly.
- The portal's own "stop sharing" (GNOME's top-bar indicator, KDE's) ends the
  stream: `stream_stopped` with `saved: true`, delivered like a Stop.
- Keep the session awake: the Inhibit portal (`ashpd::desktop::inhibit`) for
  idle while recording.
- Rust side: `recording::linux` wires `HelperRecorder`; `recording_unavailable`
  = portal present on Wayland (`portalMissing`), encoders present
  (`codecsMissing`, message names `gstreamer1.0-plugins-ugly
  gstreamer1.0-libav` on Debian/Ubuntu and `gstreamer1-plugin-openh264` on
  Fedora); the restore token stored per account in `user_preferences`.
- Wayland panel: `capture-panel` window (the bar's controls without a
  selection surface, reusing `CaptureBar` in a `panel` layout). Record there
  opens the portal picker; the countdown runs in the pill after the picker
  returns and before the first buffer is written.
- Pill on Linux: compact by default, a one-time note that it shows in screen
  recordings; placed outside an X11 area recording.

**Rust / frontend split:** frontend gets the `panel` layout of `CaptureBar`
and the pill's compact form; every decision (panel or overlay, which modes,
countdown after picker) is Rust's through `OverlayContext`.

**Packaging:** deb `Recommends: gstreamer1.0-pipewire, gstreamer1.0-plugins-base,
gstreamer1.0-plugins-good, gstreamer1.0-plugins-ugly, gstreamer1.0-libav`
(`Recommends`, not `Depends`: apt installs them by default, a minimal system can
still install Hippius and gets the `codecsMissing` line). Build: CI and release
Linux jobs add `libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev` to the
apt line (`rust-ci-setup` and the three `tauri-*.yml` Linux legs). Optional
`rpm` bundle on staging only, so Fedora can be tested from an artifact, with
`Recommends: gstreamer1-plugins-good, gstreamer1-plugin-openh264,
gstreamer1-plugins-bad-free, gstreamer1-plugin-libav, pipewire-gstreamer`; no
updater entry for it.

**CI:** Linux job runs `--capture-recorder --self-test` with
`videotestsrc`/`audiotestsrc` through the real encoder selection and
`mp4mux`, then `gst-discoverer-1.0` asserts duration and streams (the runner
installs `gstreamer1.0-plugins-ugly gstreamer1.0-libav` for it). A second
self-test kills the child with SIGKILL after 5 s and asserts the file still
plays at least 4 s. `release_lane_pins.rs`: every Linux leg installs the
GStreamer dev packages; the deb's `recommends` list is what this plan names.

**Tests:** encoder selection table (given the element factories present, which
pipeline string); portal response parsing; restore token round trip; device
list tidying (monitors excluded, default first); death mapping (bus error,
EOS from the portal, child exit).

**Manual checklist:** as Phase 2's, on Ubuntu 24.04 GNOME Wayland, Ubuntu on
Xorg, Fedora KDE Wayland; plus: the portal remembers the choice the second
time; stopping from the desktop's sharing indicator delivers the file; a
window recording of a window that is then closed; Intel VA-API and a machine
without VA; `codecsMissing` on a minimal install; files play in Firefox and
Chrome with sound.

**Done when:** the checklist passes on the VMs and one x86_64 machine, and
Linux recording moves to beta.

### Phase 5: camera, microphone and audio parity (M, 1.5 to 2 weeks)

**Status (Linux): code done with Phase 4, Linux checklist pending** (verified
the same way: Linux `cargo check` and `clippy --lib --tests` from a Mac, the
pure tests on macOS).
- `capture/webview_media_gtk.rs`: on the camera and overlay windows only
  (the same `allows_capture_devices` gate as WebView2's), WebKitGTK's media
  stream is turned on and `UserMediaPermissionRequest` /
  `DeviceInfoPermissionRequest` are allowed for the app's own pages
  (`is_app_origin`), denied for any other page; every other request returns
  to WebKitGTK's default. Pinned in `capture_wiring.rs`.
- `--list-cameras` on Linux: `GstDeviceMonitor` `Video/Source`, by the names
  WebKitGTK shows (it lists through GStreamer too), id = PipeWire's
  `node.name` or the V4L2 path (`linux_plan::cameras`); `recording::list_cameras`
  asks the child, so the bar lists cameras before the bubble opens.
- Camera only on X11 (`support::camera_only`, false on Wayland):
  `camera_window_id` reads the camera window's XID on the GTK thread
  (`gdkx11`), the child records it with `ximagesrc xid=` and, when the
  window's `_NET_WM_PID` is the app's (the stage), cuts `STAGE_INSET` at the
  screen's scale from each edge with `videocrop` (`linux_plan::stage_inset`).
- `device_lost` on Linux: a sound pipeline that fails mid-recording ends
  only its own thread and says `device_lost` with its source's name, the
  same protocol event Windows sends, so the pill shows the same Rust line.
- Not done on Linux: label matching fixtures recorded from real devices,
  and the empty-state text about Bluetooth headsets' HFP profile.

**Linux camera checklist** (with the recording checklist's machines)
1. The camera bubble shows the camera on Ubuntu 22.04 and 24.04 (WebKitGTK
   2.4x) and Fedora; spike L5: no `getUserMedia` error in the camera page.
2. The camera menu lists the built-in and a USB camera before the bubble
   ever opened, and picking one opens that one in the bubble (names match).
3. A phone through v4l2loopback (DroidCam) and a PipeWire camera node are
   listed and open.
4. X11: Screen off (camera only) records the stage without its margin or
   black corners, small and full sizes, at 100 % and `GDK_SCALE=2`.
5. Wayland: the Screen switch is not offered.


**Status (Windows): code done, hardware checklist pending** (Linux: above).
Cross-checked from a Mac only (`cargo check` and `cargo clippy
--all-targets -D warnings` for `x86_64-pc-windows-msvc` with the xwin
headers; the platform-free halves tested on macOS). Windows recording
stays on staging in `capture::rollout`.

**What landed (Windows)**
- **Microphone meter:** `Hippius --capture-recorder --meter [endpointId]`
  (`recorder_child/meter.rs` for the pure part: the 50 ms level window, the
  Swift helper's exact lines, stdin EOF as the stop; `windows/audio.rs::
  run_meter` opens the same WASAPI client the recording uses).
  `recording::meter_command` starts it on Windows, so `capture::mic_meter`
  and the bar's `MicMeter` work unchanged. One owner per device holds as on
  macOS: `emit_phase` stops the meter on every phase but choosing a
  recording, before the recorder opens the microphone. The webview never
  opens the microphone, so there is no system prompt to put behind a click
  (NT-16's rule is moot on Windows: a desktop app gets no prompt at all).
- **Cameras listed natively:** `--list-cameras` is Media Foundation's
  video capture sources (`MFEnumDeviceSources`, symbolic link as id,
  friendly name, the first marked default since Windows has none), which
  include USB, Phone Link's connected camera and frame-server virtual
  cameras. `recording::list_cameras` reads it on Windows, so the bar lists
  cameras before the bubble ever opened. The bubble still finds the camera
  by name in WebView2's list; `deviceIdByName` now tries an exact match on
  the label without WebView2's trailing " (vvvv:pppp)" USB id before the
  contains match, so "USB Camera" never opens a "USB Camera 2 (...)"
  listed first. Pinned with Windows label fixtures in `devices.test.ts`.
- **Process loopback (Windows 11):** system audio is
  `ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK)` with
  `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on the app's pid
  (passed to the child as `HIPPIUS_CAPTURE_APP_PID`; WebView2's processes
  are children of the app, so its tree covers what the webviews play). The
  client is asked for 48 kHz float, then 16-bit PCM, in event mode; a
  packet without a QPC position is stamped from the clock when read, less
  its length (`sources::packet_time_us`). Below build 22000, without the
  pid (the child driven by hand), or on any refusal it falls back to plain
  loopback of the default output, with a stderr line.
- **Hot-plug:** a microphone or system audio that goes away mid-recording
  ends only its thread, as before, and now says so: the child emits a
  non-fatal `{"ok":true,"event":"device_lost","device":"microphone"}`,
  `HelperRecorder` keeps it apart from replies and deaths,
  `Recorder::take_lost_device` hands it to the tick, and the pill gets
  `capture_device_lost` with Rust's line (`recording::device_lost_message`):
  the mic icon turns into an amber crossed-out one carrying the line (a
  muted-speaker icon for system audio) and a live region announces it.
- **Privacy switches:** the bar's camera row says
  `privacy::CAMERA_BLOCKED_WINDOWS` when the ConsentStore blocks the camera
  for desktop apps, and a blocked camera or microphone row offers **Open
  Settings** (`capture_open_privacy_settings`, which opens only the webcam
  or microphone page, chosen in Rust). The overlay context carries
  `privacyBlocked` and `cameraUnavailableMessage`.
- **The bubble in a window recording:** the child runs a second WGC
  session on the bubble's window and keeps the latest picture of each
  window (`wgc::WithCamera`); the bubble is drawn into the recorded
  window's picture where it sits on screen (`DWMWA_EXTENDED_FRAME_BOUNDS`
  of both windows), whenever either changes, so a talking head keeps
  moving over a still window, and not while the pill has hidden it. Only
  the bubble's shape is drawn (`overlay::bubble_shape`: the page's 6 px
  margin left out, the 2 px ring kept, round for a square window and
  20 px corners otherwise, edge-smoothed), so a transparent margin handed
  over as black never shows. `WINDOW_RECORDING_ADDS_CAMERA` is true on
  Windows; at Record the bubble is moved inside the window
  (`camera::window_region`: xcap's physical frame in the units of the
  display holding the window's centre).

**Deviations**
- Lists still refresh on menu open and the overlay's `devicechange` only;
  there is no Windows `--watch-devices` (`IMMNotificationClient` /
  `MFCreateDeviceSourceActivate` notifications). The plan said a
  list-per-menu-open design does not need one; a USB mic plugged in while
  the menu is open appears on the next open.
- The bubble in a window recording is composited on the CPU (a copy of the
  window's picture per output frame, at most 30 a second). Fine by
  arithmetic at 1080p; spike W3 decides whether a 4K window needs the GPU.
- `device_lost` is not sent by the macOS helper; the pill simply never
  hears one there.

**Needs a Windows PC to know**
- that WebView2's camera labels match Media Foundation's names for the
  built-in camera, a USB camera, OBS's virtual camera and a Phone Link
  camera;
- that process loopback activates from the unpackaged child, honours the
  float format (or the 16-bit fallback), reports QPC positions, and really
  leaves Hippius's own sounds (a notification, the preview card) out;
- that WGC delivers the transparent bubble window with alpha, and that the
  extended frame bounds line the bubble up with what WGC films at 100, 150
  and 200 %;
- that `IsWindowVisible` goes false when the pill hides the bubble.

**Windows checklist additions** (debug or staging build, Windows 11 x64,
then Windows 10 22H2 where noted)
1. `Hippius.exe --capture-recorder --list-cameras` lists the built-in
   camera, a USB camera and (Windows 11) a Phone Link camera with the phone
   connected; the bar's camera menu shows the same names before the bubble
   has opened. Pick each: the bubble opens that camera, not another.
2. `Hippius.exe --capture-recorder --meter` prints `ready` then a level
   about every 50 ms, rising when you speak; closing its stdin (Ctrl+Z,
   Enter) ends it at once. In the bar, the meter beside the microphone row
   moves for the default mic and for each listed mic; press Record and the
   meter process is gone from Task Manager before the recording's child
   opens the mic.
3. Windows 11, Record system audio on, a YouTube video playing and a file
   uploading so Hippius shows its card: the video's sound is in the file,
   Hippius's own sounds are not, and the log has no "not available"
   line. Windows 10: everything played is recorded (no process loopback
   there).
4. Unplug the USB mic 10 s into a recording: the pill's mic icon turns
   amber with "The microphone was disconnected. The recording goes on
   without it." as its label; the recording continues and the file has the
   sound up to the unplug.
5. Settings, Privacy & security, Camera, "Let desktop apps access your
   camera" off: reopen the bar; the camera row says Windows is blocking the
   camera, Open Settings opens that page. Same for the microphone. Turn
   both back on and reopen the bar: the lines are gone.
6. Window recording with the camera bubble, small, large and full: the
   bubble is in the video where it was on screen, round (or rounded) with
   its ring and no black corners, its video moving while the recorded
   window is still; hide it from the pill mid-recording and it leaves the
   video; drag the bubble off the window and it is cut at the window's
   edge. Repeat on the 150 % display.

**Original scope**
- Linux webviews: through `with_webview` on the camera and overlay/panel
  windows, `WebKitSettings::set_enable_media_stream(true)` (wry never turns it
  on, so `getUserMedia` does not exist there today) and a `permission-request`
  handler allowing `UserMediaPermissionRequest` and
  `DeviceInfoPermissionRequest` (device labels, needed to match devices by
  name) for those windows only. Everything else keeps WebKitGTK's default
  (deny).
- The bubble on Linux: transparent, undecorated, always-on-top on X11 (works),
  a normal window on Wayland. Camera only on X11 records the stage by XID;
  on Wayland `cameraOnly` is false in v1.
- Device matching: the mic and camera names from the child
  (`--list-microphones`, `--list-cameras` from `GstDeviceMonitor` /
  Media Foundation `MFEnumDeviceSources`) against the webview's labels,
  through the existing `deviceIdByName`. Pinned with recorded label fixtures
  from each OS (WebView2 labels carry a "(xxxx:yyyy)" USB id suffix on some
  cameras; strip it when matching).
- Hot-plug: a device unplugged mid-recording keeps recording without it and
  the pill says so (child emits a non-fatal `device_lost` event).
- The mic meter only opens the device after a click on Linux and Windows too,
  where the first `getUserMedia` may show a system prompt (NT-16's rule).
- External and phone devices, per "External and phone cameras and
  microphones" below: USB and Bluetooth devices, Windows 11 Phone Link's
  connected camera, and PipeWire/PulseAudio sources all listed; the lists
  refresh on menu open and on `devicechange`.

**Tests:** label matching fixtures; `capture_wiring.rs` pins for the Linux
permission handler scoped to the camera and overlay labels and for media
stream being enabled only there.

**Manual checklist:** built-in and USB cameras on each OS; bubble sizes and
dragging; camera-only on Windows and X11; mic meter moves for each device;
unplug the mic mid-recording; a Bluetooth headset mic; an Android phone as a
Windows 11 connected camera (Phone Link) appears, opens in the bubble and
disappears when the phone disconnects; a USB mic plugged in while the bar is
up appears without reopening it; on Linux, a PipeWire virtual source and a
phone camera through v4l2loopback (DroidCam) are listed.

**Done when:** the sources panel behaves the same on all three OSes within the
accepted Wayland limits.

### Phase 6: shortcuts, tray and polish (M, 1 to 1.5 weeks)

**Status (Windows): code done, hardware checklist pending. Linux: not
started** (the Wayland and X11 shortcut and the Linux tray menu are Phase
4 and 6 Linux work).

**What landed (Windows)**
- **XP-15, the tray's recording mark, from Rust.** `show_phase_in_tray`
  draws a red dot (amber while paused, the pill's colours) on the app's
  tray icon when it writes a recording's time, on Windows only
  (`tray_status::TRAY_ICON_MARKS_RECORDING`: macOS and Linux show the time
  as the title). Each second's write redraws it, so a sync icon
  `useTraySync.ts` swaps in mid-recording is covered again within a second;
  when the recording ends Rust puts the plain icon back and emits
  `capture_tray_icon_released`, on which `useTraySync` re-applies the sync
  icon it last asked for (only the main window knows whether a sync is
  running). `useTraySync` still never reads the capture phase. The marked
  icon is drawn once per glyph from the bundled `TrayIcon.png`
  (`tray_status::marked_icon`, 64 px, pure and tested on every OS).
- **Copy review.** Every Windows sentence Rust says was reread as end-user
  copy: a recording that cannot start no longer shows an HRESULT
  (`recorder_child::start_failure_for_user`: Rust's own lines pass through,
  anything else reads "Recording could not start. Try again, and restart
  Hippius if it keeps happening.", the detail in the log); the camera and
  microphone privacy lines end with a full stop now that Open Settings
  follows them. The OS floor, Media Feature Pack, shortcut refusal and
  lost-device lines were already plain.
- **XP-16** stays accepted and documented (the pill and card do not follow
  a virtual desktop switch on Windows).

**Deviations**
- The Windows default shortcut is still Ctrl+Shift+2; changing it remains
  an open product decision (below), not a code task.
- Settings does not read `shortcut.via` yet: Windows is always `plugin`,
  and the Linux values arrive with Linux Phase 6.

**Needs a Windows PC to know**
- that `TrayIcon::set_icon` with a 64 px RGBA image looks right on a 100 %
  and a 200 % taskbar, light and dark, and that the main window's icon is
  back (syncing or synced) after the recording.

**Windows checklist additions**
7. Record 20 s with a sync running: the tray icon shows the red dot,
   amber while paused, the tooltip carries the time; on Stop the dot goes
   and the syncing icon is back (not the plain one). Repeat with no sync
   running: the plain icon comes back.
8. Light and dark taskbar, 100 % and 200 %: the dot reads on both.
9. Start a recording on a machine where WGC refuses (a remote desktop
   session, say): the failure says "Recording could not start. ..." with
   no code in it, and the log has the HRESULT.
10. A full-screen game on the second monitor, start a recording there from
    the shortcut: the pill appears on that monitor and is not in the video.

**Original scope**
- Wayland shortcut: the GlobalShortcuts portal (KDE Plasma 5.27+, GNOME 48+,
  Hyprland) through ashpd, bound once with the portal's own dialog, with its
  `Activated` signal feeding `commands::on_shortcut`. Where the portal is
  missing (Ubuntu 24.04's GNOME 46), Settings shows the command to bind in the
  desktop's keyboard settings: `hippius --capture`, handled by the existing
  single-instance argv path, and on GNOME offers to add it for the user
  (`org.gnome.settings-daemon.plugins.media-keys custom-keybindings`).
  `capture_support.shortcut.via` tells Settings which of the three applies.
- X11: register `tauri-plugin-global-shortcut` on Linux too (it grabs keys on
  X11); `main.rs` registers it when the session is X11.
- Linux tray: no click event, so while Recording / Paused the menu gains
  "Stop recording", "Pause" / "Resume" and "Show recording controls"; the
  AppIndicator label carries the time (`tray_title_for`). Rust decides the
  items (`tray_status::menu_items_for(phase)`).
- Windows: XP-16 decision (accept, documented) and a check that the pill
  follows the user to a full-screen game's monitor.
- Copy review: every Windows and Linux sentence Rust says (reasons, Settings
  help, the pill's note), reviewed as end-user copy.

**Tests:** `shortcut::action_for` unchanged; `via` selection table; tray menu
items per phase; single-instance `--capture` routing.

**Manual checklist:** shortcut on KDE Wayland (portal dialog, rebind), GNOME
48 (Fedora 42), Ubuntu 24.04 (desktop settings route), X11; tray menu while
recording on Ubuntu (AppIndicator) and KDE; Windows tray icon and tooltip.

**Done when:** every entry point (button, tray, shortcut) works on every
supported desktop, or Settings says what to do instead.

### Effort

| Phase | Effort | Calendar with one engineer |
|---|---|---|
| 0 Groundwork | S | 3 to 4 days |
| 1 Windows screenshots | S to M | 1 week |
| 2 Windows recording (with mic, system audio, camera) | L | 3 to 4 weeks |
| 3 Linux screenshots | M | 1.5 to 2 weeks |
| 4 Linux recording | L | 3 to 4 weeks |
| 5 Camera, mic and audio parity (Linux-heavy) | M | 1.5 to 2 weeks |
| 6 Shortcuts, tray, polish | M | 1 to 1.5 weeks |
| **Total** | | **about 13 to 16 weeks** |

Phases 3 and 4 do not depend on Phase 2 beyond Phase 0, so a second engineer
could take Linux in parallel from week 2 and bring the calendar to about 9
weeks.

## What each installer gains

| Installer | Bundles | Declares | Size |
|---|---|---|---|
| Windows NSIS / MSI | Nothing new: the recorder is the app binary; Media Foundation, WGC and WASAPI are Windows | Nothing | + about 1 to 1.5 MB compressed (new code, `windows` features) |
| Linux `.deb` | Nothing new | `Recommends`: `xdg-desktop-portal` and a backend, `gstreamer1.0-pipewire`, `gstreamer1.0-plugins-base`, `-good`, `-ugly`, `gstreamer1.0-libav` | + about 1.5 to 2.5 MB (gstreamer-rs, ashpd). On a desktop install most recommended packages are already present; on a minimal one apt adds up to about 25 MB (mostly `libav*` and `x264`) |
| Linux `.rpm` (new, staging only) | Nothing new | `Recommends`: `gstreamer1-plugins-good`, `gstreamer1-plugin-openh264`, `gstreamer1-plugins-bad-free`, `gstreamer1-plugin-libav`, `pipewire-gstreamer` | as deb |
| AppImage | Not built today; if added, recording relies on the host's GStreamer encoders | | |
| macOS | Unchanged | | |

**Code signing.** Windows builds are unsigned today. An unsigned installer
works, but SmartScreen warns on every new version, and an unsigned binary that
records the screen and microphone is the kind Defender heuristics look at
harder. Recommended before Windows recording reaches production: Azure Trusted
Signing (cheapest, integrates with Tauri's `bundle.windows.signCommand`) or an
OV certificate on a hardware token or cloud HSM. EV no longer buys instant
SmartScreen reputation. Linux packages need no signing for this (an apt
repository would, separately). The child process is the same signed
executable, so nothing extra to sign.

## CI changes, in one place

- `ci.yml` `rust-windows`: `clippy -D warnings`, `cargo test --lib capture::`,
  the recorder self-test; triggered for PRs touching `src-tauri/src/capture/**`
  on any base, not only promotions (Phase 0, 2).
- `ci.yml` `rust-linux` and `rust-ci-setup`: GStreamer dev packages, the
  GStreamer plugins for the self-test, `xvfb` for the X11 test (Phase 3, 4).
- `tauri-staging.yml`, `tauri-beta.yml`, `tauri-build.yml` Linux legs: the
  GStreamer dev packages; staging also `--bundles deb,rpm` (Phase 4, optional).
- Windows legs: `signCommand` once a certificate exists; `verify` step that the
  signature is present.
- `release_lane_pins.rs` new pins: the Linux legs install the GStreamer dev
  packages; `tauri.conf.json`'s deb `recommends` holds the plan's list;
  `capture::rollout` never enables a staging-only row in production; the
  Windows legs sign once a thumbprint or `signCommand` is configured.

## Testing

### Automated, by layer

| Layer | What | Where it runs |
|---|---|---|
| Pure Rust | `timeline` retiming, `sizing` bitrate and alignment, encoder selection, device tidying, EWMH parsing, portal URI handling, rollout table, `capture_support` per platform | every OS, `cargo test --lib capture::` |
| Protocol | `helper.rs` against a fake child (ids, death, EOF, timeouts); the child's loop against the synthetic source | every OS |
| Real encoders | `--capture-recorder --self-test`: synthetic source through Media Foundation (Windows) or GStreamer (Linux), pause in the middle, a SIGKILL variant on Linux | `rust-windows`, `rust-linux` |
| X11 | display listing and root grab under `xvfb-run` | `rust-linux` |
| Wiring pins | `capture_wiring.rs`: permission handlers scoped by label, content protection per window, commands registered, rollout gate used by `capture_start` | every OS |
| Frontend | vitest: `CaptureBar` modes, panel layout, captions from Rust, pill compact form, Settings shortcut `via` | `pnpm test` |
| Lanes | `release_lane_pins.rs` additions | every OS |

WGC, portals, real devices and compositor behaviour cannot run on hosted
runners; they are the manual matrix.

### Manual matrix

| Machine | Why |
|---|---|
| Windows 11 24H2 **x64 hardware**, laptop at 150 % plus an external 100 % monitor, Intel iGPU; ideally a second box with NVIDIA or AMD | mixed DPI, hardware encoders, real webcam and mic, performance |
| Windows 10 22H2 x64 (hardware or a VM on x64) | the yellow border, no process loopback, the floor |
| The existing UTM **Windows 11 ARM64** VM (build 26100) | functional smoke under x64 emulation with the software encoder and WARP; single display; no camera unless a USB webcam is passed through |
| UTM **Ubuntu 24.04 ARM64** (GNOME 46), both the Wayland and "Ubuntu on Xorg" sessions, two virtio displays | the main Linux target, portal flow and X11 flow, shortcut fallback |
| UTM **Fedora 42 KDE ARM64** (Plasma 6, Wayland) | KDE portal, GlobalShortcuts portal, OpenH264 and fdk-aac path |
| Fedora 42 Workstation ARM64 (GNOME 48), optional | GNOME's GlobalShortcuts portal, no tray |
| One **x86_64 Linux** machine (any spare PC or mini PC) | the shipped `.deb` itself (release builds are x86_64 only; the ARM VMs run a build from source), VA-API |

UTM on Apple Silicon runs ARM guests at native speed; x86_64 guests under
emulation are too slow for recording tests. ARM Linux VMs build Hippius from
source with `pnpm tauri dev`, which exercises the same code. The built-in Mac
camera cannot be passed to a QEMU guest; a USB webcam and a USB microphone can.

The per-phase checklists above are the cases. Every row is run in light and
dark mode, and the bar, panel, pill and card are checked at the smallest
supported display (1280 x 720) and at 200 % scale.

## Risks and the spike that settles each

| Id | Risk | Spike (time-boxed) |
|---|---|---|
| W1 | xcap `wgc` makes monitor shots slower or flashes a border on Windows 10, and has no GDI fallback | Time 20 area shots with and without `wgc` on Windows 10 and 11 hardware; decide wgc-for-all or own WGC for windows only. 0.5 day |
| W2 | `IsBorderRequired(false)` refused for an unpackaged app on Windows 11 | One WGC session from the child with and without `GraphicsCaptureAccess::RequestAccessAsync(Borderless)`. 0.5 day |
| W3 | Hardware H.264 MFTs need 16-aligned sizes or reject NV12 from our video processor; CPU cost at 4K30 | FMPEG4 writer at 1080p, 1440p, 4K and odd area sizes on Intel, NVIDIA, AMD and WARP; record CPU and output. 2 days |
| W4 | An FMPEG4 file killed mid-write does not play, or fragments are too far apart | `taskkill /F` the child after 10 s; play in Edge, VLC, ffprobe. 0.5 day |
| W5 | AAC encoder input rules (16-bit PCM, 44.1/48 kHz) plus resampling and mixing two clocks drift over an hour | 60 min recording with mic and loopback; measure A/V offset at the end against a clap. 1 day |
| W6 | Defender or SmartScreen flags an unsigned build that captures the screen and mic | Install a staging build on a fresh Windows 11 with default Defender; record. 0.5 day |
| L0 | GStreamer linking adds a runtime library the deb does not already pull | `ldd` of `libwebkit2gtk-4.1.so.0` and of a gstreamer-rs binary on Ubuntu 22.04 and 24.04. 0.5 day |
| L1 | X11 compositor keeps the overlay in the root image right after close | Grab loop after unmapping on GNOME Xorg, KDE X11, XFCE; pick the settle rule. 0.5 day |
| L2 | GNOME's Screenshot portal leaves the file in `~/Pictures/Screenshots` or asks a permission question for host apps | Call it from a host (non-Flatpak) build on GNOME 46 and 48, KDE 6; note where the file lands. 0.5 day |
| L3 | `pipewiresrc` and `mp4mux` fragments: a killed pipeline leaves an unplayable file; pause through pad probes misbehaves with live sources | SIGKILL test and pause test on the real portal stream; fallback is Matroska with a remux at Stop (and `.mkv` counted as media in `dir_contents`). 2 days |
| L4 | On Wayland the card lands mid-screen or is not raised (GNOME shows "Hippius is ready" instead) | Show the card after a capture on GNOME and KDE Wayland; choose card or notification. 0.5 day |
| L5 | WebKitGTK builds without media stream, or `getUserMedia` cannot open a camera in use by nothing else | `enable-media-stream` on Ubuntu 22.04/24.04 and Fedora WebKitGTK; open the camera and a mic. 1 day |
| L6 | Wayland area recording | Monitor stream plus a fullscreen transparent window on that output to draw on, then `videocrop`; judge on GNOME and KDE. 2 days, may land after v1 |
| L7 | Restore tokens not honoured (GNOME older than 44) so the picker shows every time | Record twice on 22.04 and 24.04. 0.5 day |
| L8 | GlobalShortcuts portal differences between KDE and GNOME 48 | Bind, rebind and trigger on both. 1 day |
| X1 | Parity drift between the Swift and Rust recorders (bitrate, alignment, pause rule) | `sizing.rs` tests pinned to the Swift constants; a shared protocol fixture file read by both test suites. part of Phase 0 |

## macOS items this plan found

Not part of this plan's phases, recorded so they are not lost:

1. **Two audio tracks.** Confirmed and fixed: the helper now mixes the
   microphone and (only when `systemAudio` is on, off by default) the system
   audio into one stereo 48 kHz AAC track, `AudioMixer` in `main.swift`. The
   start command carries `systemAudio` and, for a window recording,
   `cameraWindowId`; both are fields of the shared `StartCommand` in
   `recording/protocol.rs`, so `HelperRecorder` sends them on every platform
   and the child reads them (it records no audio yet, so it ignores both).
2. The audit's claim that xcap keeps a GDI fallback with `wgc` is wrong for
   0.9.8 (compile-time switch); corrected here.

## What the user needs to provide

- **Windows x64 hardware** with a high-DPI laptop panel and an external monitor
  at a different scale, a webcam and a headset; ideally a second machine with
  another GPU vendor. The UTM ARM VM is useful for smoke tests only.
- **A Windows code-signing identity** before Windows recording reaches
  production: an Azure Trusted Signing account (recommended) or an OV
  certificate, and the CI secrets for it.
- **Linux test machines:** UTM ARM64 VMs for Ubuntu 24.04 (Wayland and Xorg
  sessions) and Fedora 42 KDE, and one x86_64 Linux machine for the shipped
  `.deb`.
- **A USB webcam and a USB microphone** to pass through to the VMs.
- **Decisions:** accept the Wayland UX differences above; the Linux support
  floor (proposed: Ubuntu 22.04+, Fedora 40+, GNOME or KDE); whether staging
  also ships an `.rpm`; the Windows default shortcut (proposed `Alt+Shift+2`,
  checked on hardware not to trip the Alt+Shift input-language switch).

## External and phone cameras and microphones

On macOS the bar lists what Google Meet lists (built-in, USB, Bluetooth,
virtual and an iPhone as a Continuity Camera and microphone) because the
helper enumerates through AVFoundation plus Core Audio, both processes opt in
with `NSCameraUseContinuityCameraDeviceType`, names are compared through
`deviceNameKey`, and the lists stay live while the bar is up (the helper's
`--watch-devices`, `device_watch.rs`) as well as refreshing on menu open; a
menu with no Continuity device shows Rust's `continuityHint`. The
same shape carries over: the child lists devices with the OS's native API, the
webview opens the camera found by name.

**Windows**
- Cameras: the child lists `MFEnumDeviceSources` with
  `MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID`, which includes USB
  (UVC) cameras and Windows 11's **connected camera** (an Android phone through
  Phone Link / "Mobile devices", exposed as a normal camera once the user turns
  it on). Frame-server virtual cameras (`MFCreateVirtualCamera`, OBS) appear
  there too. The bubble opens the camera through WebView2's
  `navigator.mediaDevices`, matched by name; WebView2 labels sometimes add a
  " (xxxx:yyyy)" USB id, which the loose match already covers.
- Microphones: WASAPI capture endpoints (`IMMDeviceEnumerator::EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)`),
  named by `PKEY_Device_FriendlyName`, default from `GetDefaultAudioEndpoint(eCapture, eConsole)`.
  That covers USB, Bluetooth hands-free and virtual cables. The endpoint id
  is what the recorder opens, so no name matching on the recording side.
- Refresh: `IMMNotificationClient` is not needed for a list-per-menu-open
  design; the overlay's `devicechange` re-reads as on macOS. WebView2 needs
  the camera and microphone permission granted for the capture windows
  (`PermissionRequested` handler scoped to those labels) or labels stay empty.
- Spike: confirm a Phone Link camera is visible to a Win32 (unpackaged) app
  and to WebView2, and that it survives the phone locking.

**Linux**
- Cameras: V4L2 capture nodes (`/dev/video*` with `V4L2_CAP_VIDEO_CAPTURE`, via
  `GstDeviceMonitor` "Video/Source"), which includes USB cameras and phone
  cameras bridged through v4l2loopback (DroidCam, Iriun) or a PipeWire camera
  portal node. There is no Continuity-style system feature for phones on
  Linux; document the bridges rather than build one.
- Microphones: PipeWire (or PulseAudio on older systems) sources from
  `GstDeviceMonitor` "Audio/Source", excluding `.monitor` sources from the
  microphone menu (they are system audio). Bluetooth headsets appear once
  their HFP/HSP profile is active; say so in the empty-state text.
- The webview: WebKitGTK needs `enable-media-stream` (and
  `enable-mediastream-device-info` for labels) set on the capture windows,
  plus the `permission-request` handler already planned in Phase 5, or
  `enumerateDevices` returns nothing usable to match against.
- Refresh: WebKitGTK's `devicechange` support varies by version; keep the
  menu-open re-read as the guarantee and treat `devicechange` as a bonus.

**Tests to add with Phase 5:** device-list parsing fixtures from each OS
(WASAPI friendly names, a Phone Link camera name, a PipeWire source list with
monitor sources to drop), `deviceNameKey` cases for each OS's label quirks.
