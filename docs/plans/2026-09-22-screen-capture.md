# Screen capture: screenshots and recordings straight into Hippius

**Status:** decided (see "Decisions"); phase 1 in progress.
**Branch:** `feat/screen-capture`, local only.

## The feature

A Loom / CleanShot-style capture flow inside the desktop app:

1. The user triggers a capture — from a Capture button in the Drive header, from
   the tray popover, or with a global shortcut.
2. They pick what to capture: **an area** (drag a rectangle), **a window**
   (hover to highlight, click to pick), or **a full screen**.
3. A screenshot is taken at once. A recording starts, with a small floating
   control bar (timer, pause, stop, cancel) until they stop it.
4. The file lands in the user's Hippius drive, encrypted like every other upload.
5. A share link is minted and copied to the clipboard, and a notification says
   so. Clicking the notification opens the file.

The last two steps are the point. Every OS can already take a screenshot; what
it cannot do is put it somewhere encrypted and hand back a link in one motion.

## What already exists and gets reused

| Need | Already in the app |
|---|---|
| Transparent, borderless, always-on-top window | The tray popover (`macOSPrivateApi`, `macos-private-api` feature) — the area-selection overlay and the recording control bar are the same kind of window |
| Keep our own windows out of the capture | `WebviewWindow::set_content_protected` in Tauri 2.10 (`NSWindow.sharingType = .none` on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows) |
| Upload into a drive without syncing it locally | `upload_files_to_remote_folder` (`sync/fileops/remote_upload.rs`) — also handles shared drives and the storage gate |
| Upload into a synced drive | `add_files` staging + rename (`sync/fileops/files/add.rs`) |
| Share any file on disk and get a link | `share_external_file` / `share_synced_file` (`shares/commands.rs`) — the Finder "Share with Hippius" path |
| Storage gate on every write | `require_eligible` → `drive_quota` (already inside both upload paths) |
| Remembered preferences | `user_preferences` table (`get_user_preference` / `save_user_preference`) |
| Notifications | `tauri-plugin-notification` |
| A Swift build, signing and embedding pipeline | `macos/build-finder-appex.sh`, `embed-finder-extension.sh`, the notarization jobs |
| Ship to testers before production | `enabledFrom(channel)` feature flags |

Nothing about upload, encryption, sharing or billing is new. The new work is
**capture** and the **UI around it**.

## Architecture

Per the project rule, everything except presentation is Rust.

```
app/ (presentation only)
  CaptureButton (Drive header)   ─┐
  Tray popover capture actions   ─┼─ invoke("capture_start", { kind, mode })
  Global shortcut (Rust-side)    ─┘
  /capture-overlay route          — draws the selection; reports a rect/window id
  /capture-controls route         — timer, pause, stop, cancel
  Capture settings card           — destination drive/folder, shortcuts, audio

src-tauri/src/capture/  (new module)
  mod.rs          commands + the capture session state machine
  permissions.rs  screen-recording / microphone checks and the prompt flow
  targets.rs      list displays and windows (xcap), hit-testing for the overlay
  screenshot.rs   grab a display/window, crop to the selection, encode PNG
  recording/      one backend per OS behind a `Recorder` trait
    macos.rs      drives the Swift helper (ScreenCaptureKit → MP4)
    windows.rs    windows-capture (Windows.Graphics.Capture + Media Foundation)
    linux.rs      follow-up (screenshots only in the first release)
  deliver.rs      temp file → destination drive → share link → clipboard + notification
  naming.rs       "Screenshot 2026-09-22 at 14.03.11.png" (pure, unit-tested)

macos/HippiusCapture/  (new, only if recording ships on macOS)
  A small Swift CLI embedded in the app bundle, spoken to over stdin/stdout JSON.
```

### Session state machine (Rust, pure and unit-tested)

```
Idle → Selecting → (Screenshot: Capturing → Delivering → Idle)
                 → (Recording: Countdown → Recording ⇄ Paused → Finalizing → Delivering → Idle)
Any state → Cancelled → Idle
```

One session at a time; a second trigger while one is live focuses it rather
than starting another. Every transition emits `capture_state_changed`, and the
overlay, the control bar and the tray read only that event, so the three
surfaces cannot disagree about whether a recording is running.

### Screenshots: `xcap`

`xcap` (0.9) captures a display or a single window on macOS, Windows and Linux
(X11 and Wayland). An area is a display capture cropped to the selection, which
keeps Retina / high-DPI scaling in one place: the overlay reports the rect in
logical points and Rust converts it with the display's scale factor.

The overlay is one transparent, content-protected window per display. It dims
the screen and draws the selection rectangle. In window mode it highlights the
window under the cursor using window bounds from `xcap`. The main window hides
while the overlay is up and comes back afterwards, so it never ends up in the
shot.

### Recordings: native encoders, not a bundled ffmpeg

| OS | Capture | Encode | Notes |
|---|---|---|---|
| macOS 12.3+ | ScreenCaptureKit | AVAssetWriter, H.264 in MP4, hardware encoder | In a Swift helper; system audio on 13+, mic, cursor and click highlights available |
| Windows 10 1903+ | Windows.Graphics.Capture | Media Foundation, H.264 MP4 (`windows-capture` has a built-in `VideoEncoder`) | Pure Rust, no helper |
| Linux | PipeWire via the ScreenCast portal | GStreamer | Follow-up, not in the first release |

**Why not bundle ffmpeg:** one pipeline for all three would be tidy, but it adds
roughly 40–80 MB per platform, needs care with LGPL/GPL build flags, and its
software encoder runs the CPU hot during a long recording. The native encoders
are hardware-accelerated and already on every machine.

**Why not the webview (`getDisplayMedia` + `MediaRecorder`):** WKWebView on
macOS does not expose `getDisplayMedia` to embedded apps reliably, WebKitGTK
barely does, and it would put the capture logic in TypeScript against the
project's rule.

**Why a Swift helper on macOS:** ScreenCaptureKit and AVAssetWriter are Swift /
Objective-C APIs. Driving them from Rust through `objc` bindings is possible but
fragile; the repo already builds, signs, embeds and notarizes Swift for the
Finder extension, so a second small target reuses that pipeline. It is a CLI in
`Contents/MacOS/`, not an extension, so it needs no App Group (which the
entitlements file explains we must not add).

### Delivery

1. The capture is written to a temp file under `~/.hippius/capture-tmp/` (not
   the OS temp dir, so a crash-orphaned recording is reclaimable at next launch).
2. Upload to the destination (see Decisions) through the existing upload
   commands — never a new upload path. The storage gate runs as it does today.
3. Mint a share link from the uploaded copy (`share_synced_file` for a synced
   destination, the remote-share path otherwise).
4. Copy the link to the clipboard and post a notification.
5. Delete the temp file — on success and on every error.

A failed upload keeps the temp file and says where it is, so a 20-minute
recording is never lost because the network dropped at the end.

## Permissions

**macOS Screen Recording** has no Info.plist key and cannot be asked for up
front in a way that sticks: `CGRequestScreenCaptureAccess` shows the system
prompt once, then the user has to enable Hippius in System Settings and
**relaunch the app** before the grant takes effect. The flow:

- `capture_permission_status` (Rust, `CGPreflightScreenCaptureAccess`) before any capture.
- If not granted: an in-app explainer with "Open System Settings"
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`)
  and "Relaunch Hippius", instead of a capture that silently comes back black.
- Nothing is requested at launch. Like the folder-access prompts the
  entitlements file avoids, it is asked for only when the user first captures.

**Microphone** (recordings with audio only): the hardened runtime needs the
`com.apple.security.device.audio-input` entitlement, and `NSMicrophoneUsageDescription`
is already present but its copy ("for voice features") should name recordings.
**Camera** only if a webcam bubble is in scope.

**Windows**: no permission prompt; the yellow capture border Windows draws is
suppressed where the API allows it.

**Linux/Wayland**: the portal shows its own picker every time. That is the OS's
rule, and the UI should say so rather than fight it.

## Surfaces

- **Drive header**: a **Capture** button beside Folder / File, opening a menu:
  Screenshot (area / window / full screen) and Record (area / window / full
  screen). Hidden for a Viewer on a shared drive, same as the other write
  controls.
- **Tray popover**: the same actions. This is the primary surface, as it is for
  Loom, because it does not put the app window in front of what you are about to
  capture.
- **Global shortcuts** (`tauri-plugin-global-shortcut`, v2): proposed
  `⌥⇧S` screenshot area and `⌥⇧R` record, on Windows `Alt+Shift+S` / `R`. They
  deliberately avoid `⌘⇧3/4/5`, which macOS owns. Configurable in Settings later.
- **Settings → Capture**: destination, shortcuts, "copy link after capture",
  microphone on/off, and whether to show clicks.

## Phasing

Each phase is shippable on its own, behind `SCREEN_CAPTURE_ENABLED = enabledFrom("staging")`.

1. **Screenshots, all platforms.** Overlay, xcap, delivery, link on clipboard,
   permission flow, Drive header + tray + shortcut. The whole loop, end to end,
   on the simplest capture.
2. **Recording, macOS.** Swift helper, control bar, mic audio, finalizing and
   delivery of large files, the relaunch-after-grant flow.
3. **Recording, Windows.** `windows-capture` backend behind the same `Recorder` trait.
4. **Recording, Linux** (if in scope) and extras: webcam bubble, system audio,
   trimming before upload, simple annotations on screenshots.

## Testing

- **Pure units in Rust**: the session state machine (every transition,
  including cancel from each state and a second trigger during a session), the
  selection → physical-pixel crop maths across scale factors and multi-display
  offsets, file naming, and temp-file cleanup on every exit path.
- **Delivery** against the existing mock hcfs-server suites: a capture reaches
  the destination drive, the storage gate refuses an over-allowance capture with
  the plans dialog (not a lost file), and a shared-drive destination writes into
  the owner's namespace, not the uploader's.
- **Wiring pins**: the overlay and control bar are content-protected, and every
  capture upload goes through the existing upload commands.
- **Frontend**: the Capture menu's gating (flag, Viewer role), and the overlay's
  rect reporting.
- **Manual** on real hardware for what no test reaches: Retina and mixed-DPI
  displays, a second monitor left of the primary (negative coordinates), the
  permission relaunch, and a 30-minute recording's file size and CPU.

## Decisions

1. **Destination:** a `Captures` folder in a drive the user picks on their first
   capture, remembered in `user_preferences` and changeable in Settings. Uploaded
   through the remote path, so it works whether or not that drive is synced here.
2. **Share link:** copied to the clipboard automatically after every capture,
   with a notification. This is the feature's point.
3. **Recording platforms, first release:** macOS and Windows. Linux gets
   screenshots; Linux recording is a follow-up.
4. **Recording extras, first release:** microphone, system audio, webcam bubble
   and click highlights — all four. Phase 2 is therefore larger than first
   sketched: the webcam bubble is its own content-protected floating window and
   needs the camera entitlement, and system audio is macOS 13+ (hidden on 12.x).
5. **macOS floor:** unchanged at 11.0. Recording is hidden on 11–12.2 because
   ScreenCaptureKit needs 12.3; screenshots work everywhere.
