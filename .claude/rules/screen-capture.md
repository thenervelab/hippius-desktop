---
paths:
  - "src-tauri/src/capture/**"
  - "app/capture-overlay/**"
  - "app/capture-controls/**"
  - "app/capture-camera/**"
  - "app/capture-preview/**"
  - "app/components/capture/**"
  - "app/lib/capture/**"
  - "src-tauri/src/tray/**"
  - "app/components/page-sections/drive/highlightEntry.ts"
  - "app/components/page-sections/drive/useDriveHighlight.ts"
  - "app/tray-panel/TrayCaptureButton.tsx"
  - "macos/HippiusCapture/**"
---

# Screen capture

Screenshots and (on macOS) recordings of an area, a window or a whole display,
filed in `<drive>/Captures`, with a public share link copied unless
`CaptureOptions.copyLink` is off. Design and
phasing: `docs/plans/2026-09-22-screen-capture.md`. Behind
`SCREEN_CAPTURE_ENABLED = enabledFrom("staging")`, and behind Rust's
`capture_support` for the platform: **screenshots on macOS and Windows**;
**recording on macOS 13+** when `HippiusCapture` is built. Linux reports
unsupported until its desktop-portal path lands. Windows recording is stubbed
behind the `Recorder` trait (`capture_support.recording == false`).

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
`bar::resolve_confirm`: area = the held one, screen = the display the button is
on, window = must be clicked). Window/screen clicks still call `capture_select`.
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
recording countdown (None / 3 / 5 seconds), Show mouse clicks, and "Copy a
share link after capture" (`copyLink`). Clicking the countdown numeral or
pressing Return while counting runs the waiting action at once. Camera only
is macOS-only (`camera_only_supported`, `for_system` turns the screen back on
elsewhere); the sources panel shows the Screen switch only when
`cameraOnlyAvailable`, and the camera row says "Camera is only recorded with
the entire screen or an area." whenever `cameraFilmed` is false.

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
`showClicks`). A still of the first frame is taken before the recorder starts,
for the card.

**Camera and microphone** (`camera.rs`, `app/capture-camera`, label
`capture-camera`): the bar's Loom-style sources panel (Screen / Camera / Mic
rows, each a switch plus a device menu) saves
`CaptureOptions.{screen, camera, camera_device, camera_size, microphone_device}`
at once. The mic row's level meter (`MicMeter`) opens the mic in the overlay
webview, found by name (`deviceIdByName` in `app/lib/capture/devices.ts`,
shared with the camera page); it unmounts with the bar before
the countdown so it never holds the device while recording.
`camera::wanted_shape` decides the window: while selecting it follows the
options live (so the bubble can be placed before recording); from Record on it
follows `recording_camera`, frozen in `select_inner` BEFORE the phase moves, so
a mid-recording option change never pulls the camera out of the video.
`sync_camera` applies it after every change; every ending calls `end_camera`.
Bubble = bottom-left, filmed with the screen (not filmed by a window
recording, which is one window only: `cameraFilmed` in `CameraState` and
`OverlayContext` says so); while choosing an AREA recording it sits inside the
drawn area's bottom-left (`camera::bubble_in_area`) so it is filmed. Sized by
`CameraSize`: small 200 pt, large 340 pt (round), full = the stage's 16:9
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
the bubble instead. The × is "Turn camera off" while choosing and "Hide
camera" while recording (`cameraCloseLabel`). While choosing it is always mounted, faded until
hovered or focused, so Tab reaches it. No native `title` on this window.
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
both lists on menu open and on the overlay's `devicechange`; `MicMeter`
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
title, so the tooltip carries the time (`tray_text_for`). The write is POSTED
to the main thread (`run_on_main_thread`), never awaited: it runs under the
phase lock and `set_title` blocks on the main thread, where a sync command may
be waiting for that lock. A late write is dropped by `seq`
(`newest_for_tray`). The icon is found by `tray_status::TRAY_ID`
(= `TRAY_ID` in `useTraySync.ts`). A left click reaches Rust's own tray
listener (`Builder::on_tray_icon_event` → `tray::panel::on_tray_icon_event`),
never a webview callback (see tray.md), which asks `commands::on_tray_click`:
`tray_status::tray_click_route` sends Recording/Paused to the pill (without
focus; never a stop, the pill has Stop), a signed-out click to the main
window, anything else (Idle after a capture included) to the popover. Pinned
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

**Shortcut** (`shortcut.rs`, `tauri-plugin-global-shortcut`, macOS/Windows):
default `CommandOrControl+Shift+2`, stored `capture_shortcut_v1` (`off` =
disabled). Registered from `CaptureHost` via `capture_sync_shortcut`. It
toggles, decided by `shortcut::action_for` in `commands::on_shortcut`:
recording/paused → stop, selecting → cancel, capturing/finalizing → focus,
signed out → main window forward, else emit `capture_shortcut_pressed` so a
start's refusals reach the same dialogs (`useStartCapture`). `logout_full`
calls `end_for_logout` first: cancels a live capture, forgets the cards,
unregisters the shortcut. A new
shortcut is registered before it is saved, so one another app holds is refused
and the old one stays; no modifier and macOS's ⌘⇧3–6 are refused. A refusal
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
  then helper, so an old Mac is told to update), and `RecordingAvailability`
  (the reason plus Rust's line) is flattened into `capture_support` and the
  overlay context as `recordingUnavailable` / `recordingUnavailableMessage`.
  `disabledRecordingNote` (`app/lib/capture/modes.ts`) turns the first two
  into disabled Record modes with that line on the bar (`aria-disabled`, not
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
- The camera stage is a window owned by the app (`owningApplication.processID
  == getppid()`), trimmed by `stageInset` (12 pt: the page's `p-1.5` margin
  plus the corner of `rounded-[18px]`) so its transparent corners and ring are
  not filmed as black. Pinned against `app/capture-camera/page.tsx`.
- `recording::start` refuses below `MIN_FREE_BYTES` (2 GB) free with a message
  saying so.

Driving the helper by hand (JSON on stdin, probe with AVFoundation) is the
fastest check: a 3 s display recording, an area with pause/resume, and a
window recording must each finish with a playable file.

## Where Capture is offered

The shortcut; `CaptureButtons` (`app/components/capture/CaptureButtons.tsx`):
**Screenshot** (`startCapture("screenshot")`) and **Record**
(`startCapture("recording")`), each opening the bar on its kind's last mode,
plus one "…" menu (Open capture bar with the shortcut's keycaps, Change
capture drive…). A "…" rather than a chevron per button: the two items belong
to neither kind, and one extra control costs less toolbar than two. Rendered in
the folder list's toolbar (`DriveOnboarding`, `size="compact"`, 26px), the
in-drive toolbar (`DriveHeader`, every drive, a Viewer's shared drive included:
a capture is filed in the capture drive, not the open one) and Overview's Recent Files toolbar
(`DriveHeader`'s recent layout, just before Folder and File; never in the
shared home `PageHeader`, which Billing, Wallet, Referrals and Plans use too). Labels show at `@[52rem]` of the app's scroll
`@container`; below it the buttons are icons named by `aria-label` + `title`.
Record's state comes from ONE helper, `recordAvailability`
(`app/lib/capture/recordAvailability.ts`): hidden off macOS without recording,
shown `aria-disabled` with Rust's reason on a Mac without it (not `disabled`,
which would swallow the tooltip). The reason is `capture_support.recordingUnavailable`
(`helperMissing` / `osTooOld` / `unsupportedPlatform`) with Rust's line in
`recordingUnavailableMessage`; `unsupportedPlatform` hides Record, the other two
disable it. The capture bar's Record modes and Settings show the same line. The tray popover has its labelled Capture button
(`TrayCaptureButton`, opens the bar on the last mode; its slot is held while
support is asked). Mode names and icons come from `app/lib/capture/modes.ts`.
Settings › Sync & Storage has the Capture card (shortcut, drive). Pinned by
`CaptureButtons.test.tsx`, `drive/__tests__/captureButtonsPlacement.test.tsx`,
`drive/__tests__/recentFilesCapture.test.tsx`
and `tests/capture_wiring.rs` (content protection, focus, capabilities, every
command registered, retry path). The "…" menu styles its own
`DropdownMenuContent` (theme has no `bg-popover`).
