<#
.SYNOPSIS
  Register the Hippius Explorer "Share with Hippius" extension for PREVIEW /
  internal testing (self-signed).

.DESCRIPTION
  Run in an **Administrator** PowerShell, from the folder that contains the
  downloaded HippiusShell.dll, HippiusShellSparse.msix, and
  HippiusPreviewCert.cer, AFTER installing Hippius. It trusts the self-signed
  preview cert, copies the DLL next to the app, and registers the sparse package.

  A self-signed cert is trusted ONLY because this script imports it — a public
  release would use a procured cert and register from the installer instead.

.PARAMETER InstallDir
  Folder where the Hippius installer placed Hippius.exe. Default is the Tauri
  NSIS per-user location; pass -InstallDir if you installed elsewhere.

.EXAMPLE
  ./register-preview.ps1 -InstallDir "$env:LOCALAPPDATA\Hippius"
#>
param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Hippius"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

if (-not (Test-Path "$InstallDir\Hippius.exe")) {
  Write-Warning "Hippius.exe not found in '$InstallDir'. If the menu doesn't appear, re-run with -InstallDir pointing at the folder that has Hippius.exe."
}

Write-Host "==> Trusting the self-signed preview cert (LocalMachine Root + TrustedPeople)"
Import-Certificate -FilePath "$here\HippiusPreviewCert.cer" -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath "$here\HippiusPreviewCert.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null

Write-Host "==> Placing HippiusShell.dll next to the app ($InstallDir)"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item "$here\HippiusShell.dll" "$InstallDir\HippiusShell.dll" -Force

Write-Host "==> Registering the sparse package (external location = install dir)"
Add-AppxPackage -Path "$here\HippiusShellSparse.msix" -ExternalLocation $InstallDir

Write-Host ""
Write-Host "Done. Right-click a file or folder in Explorer -> 'Share with Hippius'."
Write-Host "(If it's under 'Show more options', restart explorer.exe once.)"
Write-Host "To remove: Get-AppxPackage *Hippius.ShellExtension* | Remove-AppxPackage"
