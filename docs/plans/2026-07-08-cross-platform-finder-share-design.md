# Cross-Platform Shell Share — Windows & Linux — Design

**Date:** 2026-07-08
**Status:** Design validated, ready for implementation planning
**Scope:** Bring the macOS "right-click a file/folder in the file manager → Share with Hippius" feature to **Windows Explorer** and **Linux file managers**. v1 = the share action (public + password-protected) only; status badges are deferred.

## Problem

macOS ships a native Finder Sync extension: right-click a file/folder in Finder → **Share with Hippius** → the app opens its public/private chooser and mints a link. Windows and Linux users have no equivalent — they can only share from inside the app window. We want OS-file-manager parity on all three desktops.

## Guiding decisions (validated with stakeholder)

| Question | Decision |
|---|---|
| Sequencing | **Both platforms in parallel** — the shared Rust core is built once and both tracks consume it |
| v1 feature scope | **Right-click share only** (public + password-private). **Badges deferred** — Windows overlay slots are an unwinnable war for a newcomer; Linux badge support is near-zero |
| Windows target | **Windows 11 + 10 modern** — `IExplorerCommand` + a signed **sparse MSIX package**. Covers Win10 2004+ and Win11's primary menu |
| Windows COM DLL language | **Rust** (`windows` crate, `cdylib`) — stays in the cargo workspace and reuses the existing `protocol` codec |
| Windows menu model | **Embedded COM DLL** — the direct analog of the macOS `.appex`: an OS-loaded, in-process extension binary shipped *inside the one installer*, not a separate process/helper the user runs. Gives the Win11 primary menu |
| Linux packaging (v1) | **`.deb` / rpm only** (postinst drops the action files). AppImage = fast-follow (first-run copy); **Flatpak documented as blocked** (sandbox can't install a host FM extension) |

## Non-negotiable requirements (stakeholder, 2026-07-08)

1. **Do not break macOS.** macOS ships and works today. Every Phase-0 change to the shared core is **additive or a gate-widening**, never a rewrite of a macOS code path. Enforcement (all on the macOS CI lane): the `protocol` wire format stays byte-identical (existing proptests are the guard), the Unix transport is *moved not modified*, `dispatch.rs`/`resolve.rs` get zero logic change, and a source-text pin keeps `lifecycle::start` wired. A macOS regression turns those tests red.

2. **One binary — no separately-run/-shipped helper.** Parity with macOS, where the *only* extra artifact is the OS-required embedded `.appex` inside the single `.app`. Applied per platform:
   - **Linux:** **no helper binary.** The per-file-manager action files invoke the **same main app binary** in a short-lived CLI mode — `hippius-desktop --finder-share <path>` — which is intercepted at the very top of `main()` (before Tauri/webview boot), writes `SHARE:<path>` to the socket, and `exit(0)`s. Same executable, second mode; the deep-link/single-instance pattern.
   - **Windows:** the **only** extra artifact is the embedded COM DLL — Explorer *requires* an in-process COM server for the primary menu, exactly as Finder requires the `.appex`. It is embedded in the one installer and loaded by `explorer.exe`; the app itself remains a single `.exe`. No separate process or helper is ever spawned by us.
   - **macOS:** unchanged — the embedded `.appex` is the OS-required extension, already the model both other platforms mirror.

## What already exists (do not rebuild)

The heavy lifting is done. On the Rust side, `src-tauri/src/finder_bridge/` is **already layered for this port**:

| Module | Today's gate | Portability |
|---|---|---|
| `protocol.rs` (line codec) | `#[cfg(unix)]` | Pure/sans-io, proptest-covered. **Only Unix-coupling:** encodes paths via `std::os::unix::ffi` raw bytes → needs a cross-platform byte source for Windows |
| `socket.rs` (accept/broadcast/mpsc server) | `#[cfg(unix)]` | Accept-loop + `broadcast`/`mpsc`/`CancellationToken` logic is transport-agnostic; only the `UnixListener`/`UnixStream` types are Unix. **Works unchanged on Linux** |
| `resolve.rs` (path → drive/outside) | `#[cfg(unix)]` | **Fully portable** — pure `Path`/`String`, proptest-covered |
| `dispatch.rs` (click → share engine) | `#[cfg(target_os = "macos")]` | **Fully portable** — `tokio::fs` + the platform-agnostic `shares/` engine. Only the module gate is macOS |
| `lifecycle.rs` (boot start + drain) | `#[cfg(target_os = "macos")]` | Generic Tauri/tokio; only the gate + the endpoint call are macOS |
| `container.rs` (App Group path) | `#[cfg(target_os = "macos")]` | macOS-specific — the per-OS endpoint address lives here |
| `commands.rs` (confirm/cancel IPC) | `#[cfg(unix)]` | Portable; registered `#[cfg(unix)]` in `main.rs` |

The entire `shares/` engine (`share_synced_file`, `share_external_file`, `share_directory_as_zip`, `make_private`, `revoke_public_share`) is platform-agnostic and untouched. The public/private chooser, `ShareFileModal`, `FinderShareListener`, and the `finder:share-choosing` event contract are all reused verbatim.

**Implication:** this feature is (1) a small Rust generalization done once, plus (2) one thin OS-native menu shim per file manager, plus (3) one platform IPC listener. Zero new sharing logic. This is exactly the split Nextcloud/ownCloud, Dropbox, and Insync all use (one local socket + native thin bridges per file manager).

## Architecture

```
                    ┌─────────────────────────── shared, platform-agnostic ──────────────────────────┐
  OS file manager   │  finder_bridge::protocol (codec)   finder_bridge::resolve   shares/ engine     │
  ───────────────   │  finder_bridge::socket (server logic: accept/broadcast/mpsc/cancel)             │
   right-click      │  finder_bridge::dispatch (click → mint)   finder_bridge::lifecycle (boot)       │
       │            └───────────────────────────────────────────────────────────────────────────────┘
       │  SHARE:<path>                    ▲                         ▲                        ▲
       ▼                                  │ transport               │ endpoint               │ enable-gate
┌──────────────┐  macOS: Unix socket (App Group)  ─────────────────┤                        │
│ macOS .appex │──────────────────────────────────────────────────┤                        │
├──────────────┤  Linux: Unix socket ($XDG_RUNTIME_DIR/hippius/)   ─┤ endpoint::address()   │ #[cfg(any(macos,
│ Linux per-FM │─ hippius-desktop --finder-share <path> (same bin) ─┤ (per-OS)               │   linux, windows))]
│ action files │                                                    │                        │
├──────────────┤  Windows: named pipe (\\.\pipe\hippius-finder-…)  ─┘                        │
│ Win COM DLL  │──── IExplorerCommand::Invoke ──────────────────────────────────────────────┘
└──────────────┘
```

### Shared Rust core (built once)

1. **Path codec (`protocol.rs`).** Keep the exact percent-encoding wire format (macOS/Linux extensions stay byte-compatible; proptests still hold). Replace the `std::os::unix::ffi` byte source with a cross-platform one: on Unix, current raw bytes; on Windows, UTF-8 of the path with a lossless fallback for the (vanishingly rare) ill-formed-UTF-16 path. Widen the gate from `#[cfg(unix)]` to all three targets.

2. **Transport abstraction (`socket.rs` → `transport/`).** Extract the accept-loop / `broadcast` / `mpsc` / `CancellationToken` machinery to be generic over the listener/stream. `transport/unix.rs` = today's `UnixListener` impl (serves **macOS and Linux** unchanged). `transport/windows.rs` = a `tokio::net::windows::named_pipe` server with the same shape (per-connection read/write tasks, root replay, cooperative shutdown). `FinderBridge::start` picks the impl by target.

3. **Endpoint resolution (`container.rs` → `endpoint.rs`).** Per-OS address:
   - macOS: `~/Library/Group Containers/<group>/finder.sock` (unchanged).
   - Linux: `$XDG_RUNTIME_DIR/hippius/share.sock` (fallback `~/.hippius/share.sock`), dir `0700`.
   - Windows: pipe name `\\.\pipe\hippius-finder-<user-sid>` (SID-scoped so two logged-in users don't collide; ACL limited to the current user).

4. **Enable `lifecycle`/`dispatch`/commands on all three targets.** Change the `#[cfg(target_os = "macos")]` gates on `lifecycle`/`dispatch`/`container→endpoint` and the `lifecycle::start` call in `main.rs` to `#[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]`. `dispatch.rs` needs **no logic change**. The confirm/cancel command registration in `main.rs` moves from `#[cfg(unix)]` to the tri-platform gate so Windows gets them too.

### Windows track

- **Menu shim:** one `IExplorerCommand` verb ("Share with Hippius"), an **in-proc COM DLL in Rust** (`windows` crate, `cdylib`) reusing the `protocol` codec. Appears in the Win11 **primary** menu and the Win10 main menu. `IObjectWithSelection` receives the selected `IShellItemArray`.
- **Identity:** a **signed sparse MSIX package** (manifest only, `<desktop4:Extension Category="windows.fileExplorerContextMenus">`, `ExternalLocation` = the Tauri install dir, packaged-COM CLSID registration — **no `regsvr32`**). Registered from an **NSIS `POSTINSTALL` hook** (`Add-AppxPackage -ExternalLocation`), deregistered on `PREUNINSTALL`.
- **Signing:** reuse the installer's code-signing cert. **The cert Subject `CN=` must match the sparse manifest `Publisher` exactly** or Explorer silently drops the extension. Sparse packages must chain to a trusted root (self-signed only for dev, imported into Trusted People).
- **IPC:** the app hosts a **named-pipe server**. `Invoke()` reads the `IShellItemArray`, connects, writes `SHARE:<path>` — **all off the shell UI thread**. `GetTitle`/`GetState` do zero I/O (they run on Explorer's UI thread; slow work there hangs the menu). If the app is down, `ShellExecute` it then retry-connect with backoff.
- **Deferred:** overlay badges (15-slot registry war) and Cloud Filter API (a full placeholder/hydration engine — the right choice only if Hippius later wants real sync-status badges + a sidebar sync root; disproportionate for one verb, and it *also* needs the sparse package, so nothing is lost by deferring).

### Linux track

- **Menu shim:** per-file-manager declarative action files, all invoking one shared helper:

  | FM | File | Location | Gotcha |
  |---|---|---|---|
  | Nautilus (GNOME) | executable script | `~/.local/share/nautilus/scripts/` | Prefer scripts — Nautilus 43+/GTK4 broke python extensions; scripts are immune |
  | Dolphin (KDE) | ServiceMenu `.desktop` | `~/.local/share/kio/servicemenus/` | must be `chmod +x` |
  | Nemo (Cinnamon) | `.nemo_action` | `~/.local/share/nemo/actions/` | needs `Quote=double` for spaces |
  | Caja (MATE) | script | `~/.config/caja/scripts/` | |
  | Thunar (XFCE) | entry in `uca.xml` | `~/.config/Thunar/uca.xml` | **merge**, not drop-in |

- **No helper binary — the main binary in CLI mode.** Per the one-binary requirement, the action files invoke `hippius-desktop --finder-share <path>`. A guard at the very top of `main()` (before the Tauri builder/webview initializes) detects the flag, connects to the Unix socket, writes `SHARE:<path>`, and `exit(0)`s — or, if the socket is absent, launches the app normally and retries. It reuses the in-crate `protocol` codec directly. This is a short-lived second mode of the *same* executable (the deep-link/single-instance pattern), so the fork-write-exit is milliseconds and no separate artifact ships.
- **Packaging (v1):** `.deb`/rpm postinst drops the action files into system dirs, pointing each at the installed `hippius-desktop` binary (the Nextcloud model, minus the separate helper package). AppImage (fast-follow) needs a first-run copy into `~/.local/share/...`. **Flatpak is blocked** — the sandbox cannot install a host FM extension; documented as a known limitation, users install the native package.

## Testing strategy

Discipline (matches CLAUDE.md "logic in Rust" + the Nextcloud split): **keep the OS shim a dumb, thin, manually-verified shim; push every testable line into the Rust listener + the `--finder-share` CLI path.**

**Automated (CI, every PR):**
- `protocol` codec proptests — already run on Linux CI; extend to Windows once the codec is cross-platform (round-trip, ASCII-single-line, non-UTF-8/UTF-16 fidelity).
- Transport integration tests: the Unix-socket server tests (already in `socket.rs`) plus new **named-pipe server** tests on a Windows runner — feed `SHARE:<path>`, assert dispatch fires; malformed lines, path escaping, oversized input, concurrent connections, cooperative shutdown, root replay.
- `--finder-share` CLI mode: end-to-end test that invoking the binary with the flag writes the expected line to a mock socket and exits `0` (and launches + retries when the socket is absent) — without booting Tauri.
- Static validation of Linux action files (`desktop-file-validate`) and a Windows CI step asserting the sparse package signs + registers (`signtool verify` / `Get-AppxPackage`).
- A source-text regression pin (mirroring the existing `handle_defers_mint_and_emits_choosing` and backfill-spawn pins) that `main.rs` calls `lifecycle::start` under the tri-platform gate, so a refactor can't silently drop Windows/Linux startup.

**Manual / VM (release checklist — no CI framework exists for this):**
- The actual right-click render: Win11 primary-menu placement + "Show more options", Win10 main menu, and each of the 5 Linux file managers in a VM/container with an X session.
- The app-down launch-and-retry path on each platform.
- Public and password-private mint end-to-end from the shell on each platform (the chooser modal, clipboard copy, `#k=`/`#p=` link).

## Security notes (carried over + per-platform)

- The `dispatch.rs` "socket peer trust (accepted risk)" note applies to all platforms: any local process running as the user can drive the share path (confused-deputy). Windows adds a per-user-SID-ACL'd pipe; Linux uses a `0700` `$XDG_RUNTIME_DIR` dir — both narrow the surface to the same user, matching the macOS App-Group bar. A follow-up peer-codesign check remains cross-platform future work.
- Path validation is unchanged and portable: `resolve_share_target` uses component-level `strip_prefix` (never substring) and rejects `..`; the outside-file path verifies a regular file before reading.
- The Argon2 password-wrap for `#p=` links is entirely in the shared engine — no per-platform crypto.

## Cross-repo footprint

| Repo | Work |
|---|---|
| **hippius-desktop** | The bulk: shared Rust core generalization; Windows Rust COM DLL + sparse package + NSIS hook + named-pipe listener; Linux per-FM action files + `--finder-share` CLI mode on the main binary + `.deb`/rpm packaging; Windows/Linux CI lanes |
| **hcfs-client / console / server** | **None** — the wire protocol, share engine, `#k=`/`#p=` link format, and recipient page are unchanged from the shipped macOS feature |

## Out of scope (explicit, deferred)

- **Status/overlay badges** on Windows and Linux (v1 is the share action only).
- **Windows Cloud Filter API** sync root (adopt wholesale only if real badges are wanted later).
- **AppImage / Flatpak** first-class shell integration (AppImage = fast-follow; Flatpak = documented-blocked).
- **Peer-codesignature verification** on the socket/pipe (cross-platform follow-up).

## Open questions / follow-ups

- Exact Rust COM-server ergonomics with the `windows` crate for `IExplorerCommand` + `IObjectWithSelection` (spike first — this is the least-charted part).
- Whether the named-pipe server runs for the whole app lifetime or only while signed in (mirror the macOS bridge lifecycle: boot-scoped, best-effort).
- Nautilus: script-only vs also shipping a GTK4-variadic `MenuProvider` python extension for a nicer top-level item (start script-only; revisit if users want it in the primary menu rather than the Scripts submenu).
- Thunar `uca.xml` merge strategy on install (parse + append if our action is absent; never clobber the user's existing actions).
