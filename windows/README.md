# Windows Explorer "Share with Hippius" integration

Right-click a file or folder in Windows Explorer → **Share with Hippius**. Same
backend as macOS/Linux: the shell extension forwards the clicked path to the
running app over a named pipe (`finder_bridge`), which opens the public/private
chooser and mints. Design:
[`docs/plans/2026-07-08-cross-platform-finder-share-design.md`](../docs/plans/2026-07-08-cross-platform-finder-share-design.md).

## Layout

| Path | What |
|---|---|
| `HippiusShell/` | The `IExplorerCommand` COM DLL crate (`hippius-shell`, cdylib) |
| `HippiusShell/src/lib.rs` | COM server: `IExplorerCommand` + `IObjectWithSelection` + `IClassFactory` + `DllGetClassObject` |
| `HippiusShell/src/wire.rs` | Pipe name + `SHARE:<path>` encoder, byte-pinned (KATs) to the app's `finder_bridge::protocol`/`endpoint` |
| `HippiusShell/AppxManifest.xml` | Sparse MSIX manifest (package identity + `fileExplorerContextMenus` verb) |
| `HippiusShell/build-and-package.ps1` | Build DLL → stamp manifest → `makeappx pack` → `signtool sign` |
| `nsis-hooks.nsh` | Tauri NSIS `POSTINSTALL`/`PREUNINSTALL` to (de)register the sparse package |

The DLL crate is **deliberately NOT in the `src-tauri` workspace** (it's
windows-only and built by packaging), so the app's macOS/Linux/Windows
`cargo check` is unaffected.

## Why this shape (Windows 11 primary menu)

- Win11's primary context menu requires an **`IExplorerCommand`** COM handler
  **with package identity**. Legacy `IContextMenu`/registry verbs are demoted to
  "Show more options".
- A plain Win32/Tauri app gets identity via a **sparse MSIX package** (manifest
  only, `ExternalLocation` = the install dir). Supported on Win10 2004+ and Win11.
- The COM DLL is the Windows analog of the macOS `.appex`: an OS-loaded, in-proc
  extension binary embedded in the one installer — not a separate process we run.

## Build + register (Windows dev host)

Prereqs: Rust (MSVC), Windows SDK (`makeappx`, `signtool`), a code-signing cert
whose **Subject exactly matches** the manifest `Publisher`.

```powershell
# From repo root, on Windows:
cargo build --release --manifest-path windows/HippiusShell/Cargo.toml
# Build DLL + sparse package (dev: unsigned; prod: pass -CertThumbprint):
windows/HippiusShell/build-and-package.ps1 -Publisher "CN=Hippius, O=Hippius, C=US" -CertThumbprint <thumb>
# Register for dev (self-signed cert must be trusted in Trusted People first):
Add-AppxPackage -Path <out>/HippiusShellSparse.msix -ExternalLocation <out>
```

Signing notes: a sparse package **must be signed** and chain to a trusted root
(reuse the installer's Developer-ID-equivalent cert; **cert Subject must equal
the manifest `Publisher`**). Self-signed works for dev only (import into Trusted
People, cert needs `BasicConstraints CA=false`).

## Status: SCAFFOLD — remaining work

This is a compile-ready scaffold; finish it on a Windows host (fast local
iterate) — it cannot compile on macOS/Linux.

1. **Compile `hippius-shell`** and fix any `// VERIFY(windows 0.58)` interface
   signature mismatches (the `windows`-crate `*_Impl` method shapes are
   version-sensitive). `cargo test -p hippius-shell` runs the `wire.rs` KATs.
2. **Generate a real CLSID** (`uuidgen`) and paste it in BOTH `src/lib.rs`
   (`CLSID_HIPPIUS_SHARE`) and `AppxManifest.xml` (`{CLSID}`).
3. **`GetIcon`**: return the app icon resource path (currently `E_NOTIMPL`).
4. **App-down fallback** in `forward_paths`: `ShellExecuteW` the install-dir
   `Hippius.exe` and retry the pipe, mirroring the Linux `--finder-share`
   launch-and-retry (see `finder_bridge/cli.rs`).
5. **Backend activation on Windows**: widen the finder feature gates from `unix`
   to `any(unix, windows)` so `lifecycle::start` binds the named pipe on Windows
   (today the transport compiles on Windows but is only started on `unix`). See
   the hippius-mem gotcha "Activating the Finder/shell-share feature on a new
   platform needs a CASCADE of cfg widenings".
6. **Packaging**: wire `build-and-package.ps1` into `tauri-build.yml` (embed the
   DLL + sparse package in the installer) and reference `nsis-hooks.nsh` from
   `tauri.conf.json` (`bundle.windows.nsis.installerHooks`).
7. **One-time enable UX**: after install, nudge the user to enable the extension
   (Win11 doesn't auto-activate third-party context menus for unsigned/dev; a
   signed prod package is enabled on register).
