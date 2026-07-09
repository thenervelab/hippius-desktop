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
| `HippiusShell/package-shell-ext.ps1` | Build DLL → stamp manifest → `makeappx pack` → sign (self-signed **or** Azure) |
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
  "One binary like macOS" here means one installer, zero manual steps — not one
  `.exe`, because Explorer loads an in-proc COM **DLL**, never our `.exe`.

## Two signing modes (one script)

`package-shell-ext.ps1` builds the DLL and packs + signs the sparse package. The
cert is what decides whether a user has to import anything:

- **Self-signed (default, no `-Azure*` args)** — INTERNAL/PREVIEW only. Exports
  `HippiusPreviewCert.cer`; a tester imports it once (Trusted People + Trusted
  Root) and the menu registers. This is what the CI `windows-shell-ext` lane
  runs, and what the preview `.zip` ships for manual registration.
- **Azure Artifact Signing (pass `-AzureEndpoint/-AzureAccount/-AzureProfile`)** —
  PUBLIC releases. Signs the DLL + package with a publicly-trusted cert, so the
  installer's `Add-AppxPackage` succeeds on any machine with **no cert import**.
  This is the mode the release workflow uses.

```powershell
# Preview / dev (self-signed):
windows/HippiusShell/package-shell-ext.ps1
# Production (Azure Artifact Signing; Publisher MUST equal the cert profile Subject):
windows/HippiusShell/package-shell-ext.ps1 `
  -Publisher "CN=Hippius, O=Hippius, C=US" -Version 0.3.1.0 `
  -AzureEndpoint https://wus2.codesigning.azure.net -AzureAccount <acct> -AzureProfile <profile>
```

## Release wiring (auto-embed, zero manual steps)

`.github/workflows/tauri-build.yml`'s Windows leg is **secret-gated exactly like
the macOS Apple block**: without the signing secrets it builds today's unsigned
installer with no extension; with them it (1) `cargo install artifact-signing-cli`
+ runs `package-shell-ext.ps1` in Azure mode, (2) writes a `win-release.conf.json`
merged into the config via `tauri build --config`, adding the DLL/MSIX as
`resources`, wiring `nsis-hooks.nsh` as `installerHooks`, and setting
`bundle.windows.signCommand` so tauri signs the app's own `.exe`/NSIS.

Tauri places bundled resources under `$INSTDIR\resources\`. The sparse manifest
declares the COM DLL by a path relative to the `ExternalLocation` (`$INSTDIR`),
so `nsis-hooks.nsh` **copies `HippiusShell.dll` up to `$INSTDIR\`** on install and
registers the package with `-ExternalLocation "$INSTDIR"`. Registration is
non-fatal — a failure leaves the app fully working, just without the menu item.

The config is injected only at release time so a plain `pnpm tauri build` or the
`cargo check` lane never references the (uncommitted, CI-built) DLL/MSIX.

## Azure Artifact Signing — procurement + secrets

Setup (the long pole; identity validation can take days–weeks):

1. Paid Azure subscription (free/trial rejected). US/CA/EU/UK.
2. Register the `Microsoft.CodeSigning` resource provider.
3. Create a **Trusted Signing account** + complete **Public Trust** identity
   validation (the validated org name becomes the cert Subject).
4. Create a **certificate profile**.
5. Create a **service principal** and grant it **Trusted Signing Certificate
   Profile Signer**.

Then set these GitHub Actions secrets (all seven required to activate):

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | Service principal (non-interactive auth) |
| `WINDOWS_SIGN_ENDPOINT` | e.g. `https://wus2.codesigning.azure.net` |
| `WINDOWS_SIGN_ACCOUNT` | Trusted Signing account name |
| `WINDOWS_SIGN_PROFILE` | Certificate profile name |
| `WINDOWS_SIGN_PUBLISHER` | The **exact** cert Subject DN (stamped into the MSIX `Identity Publisher` — a mismatch makes Explorer silently refuse the extension) |

Once set, the next `main` release auto-embeds + auto-registers the extension and
the app is publicly trusted — the full macOS-equivalent: install the `.exe`,
right-click → **Share with Hippius**, nothing else.

## Follow-ups

- `GetIcon` returns the app icon (currently `E_NOTIMPL`).
- App-down fallback in `forward_paths`: `ShellExecuteW` the install-dir
  `Hippius.exe` and retry the pipe, mirroring the Linux `--finder-share`
  launch-and-retry (`finder_bridge/cli.rs`).
- First signed release validates the release-workflow Windows leg end-to-end
  (it can't be exercised until the secrets exist).
