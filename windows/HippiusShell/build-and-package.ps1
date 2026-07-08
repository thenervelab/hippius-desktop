<#
.SYNOPSIS
  Build the Hippius shell-extension DLL, stamp the sparse-package manifest, pack
  and sign it. Produces HippiusShell.dll + HippiusShellSparse.msix.

.DESCRIPTION
  Run on Windows with: the Rust toolchain, the Windows SDK (makeappx.exe,
  signtool.exe), and a code-signing cert whose Subject EXACTLY matches -Publisher.

.NOTES
  This is the SCAFFOLD build. Wire it into the release pipeline (tauri-build.yml)
  once green: build the DLL, copy it next to Hippius.exe in the install dir,
  stamp+pack+sign the sparse package, and register it from the NSIS installer
  hook (../nsis-hooks.nsh).
#>
param(
  [string]$Publisher = "CN=Hippius",
  [string]$Version = "0.3.1.0",
  [string]$Clsid = "{0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0}",
  [string]$InstallDir = "$PSScriptRoot\out",
  [string]$CertThumbprint = ""   # signing cert in CurrentUser\My; empty => skip signing (dev)
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

Write-Host "==> Building HippiusShell.dll (release)"
cargo build --release --manifest-path "$here\Cargo.toml"
# cdylib output is the snake_case lib name; the manifest expects HippiusShell.dll.
$dll = "$here\target\release\hippius_shell.dll"
if (-not (Test-Path $dll)) { throw "DLL not found at $dll" }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $dll "$InstallDir\HippiusShell.dll" -Force

Write-Host "==> Stamping AppxManifest.xml"
$manifest = Get-Content "$here\AppxManifest.xml" -Raw
$manifest = $manifest.Replace("{PUBLISHER}", $Publisher).
                      Replace("{VERSION}", $Version).
                      Replace("{CLSID}", $Clsid).
                      Replace("{INSTALL_DIR}", $InstallDir)
$stamped = "$InstallDir\AppxManifest.xml"
Set-Content -Path $stamped -Value $manifest -Encoding UTF8

Write-Host "==> Packing sparse package (makeappx pack /nv)"
$msix = "$InstallDir\HippiusShellSparse.msix"
# /nv = no semantic validation of the (payload-less) sparse layout.
makeappx pack /d $InstallDir /p $msix /nv /o

if ($CertThumbprint) {
  Write-Host "==> Signing $msix"
  signtool sign /fd SHA256 /sha1 $CertThumbprint $msix
  Write-Host "==> Verifying signature"
  signtool verify /pa $msix
} else {
  Write-Warning "No -CertThumbprint: package left UNSIGNED (dev only; register with -AllowUnsigned)."
}

Write-Host "==> Done. DLL + sparse package in $InstallDir"
