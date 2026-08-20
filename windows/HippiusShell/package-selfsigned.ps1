<#
.SYNOPSIS
  Build the shell-extension DLL and pack + SELF-SIGN the sparse MSIX package for
  INTERNAL/PREVIEW testing (no procured cert). Exports the self-signed .cer so a
  tester can trust it once (Trusted People + Trusted Root) and the Win11 menu
  then registers.

.DESCRIPTION
  Runs on windows-latest (CI) or a Windows dev host with the Rust toolchain +
  Windows SDK (makeappx/signtool). Outputs to ./out:
    HippiusShell.dll            the COM DLL (renamed from the snake_case cdylib)
    AppxManifest.xml            stamped
    HippiusShellSparse.msix     packed + self-signed
    HippiusPreviewCert.cer      export the tester imports into Trusted People + Root

  NOT for production — a self-signed cert is not trusted by default; a procured
  OV/EV cert (or Azure Trusted Signing) replaces this for public releases.
#>
param(
  [string]$Publisher = "CN=Hippius Preview (Self-Signed)",
  [string]$Version = "0.3.1.0",
  # BARE GUID (no braces) — the MSIX manifest com:Class Id / Verb Clsid schema
  # rejects braces. The Rust GUID value is unaffected (matched by value at runtime).
  [string]$Clsid = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0"
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = Join-Path $here "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "==> Building HippiusShell.dll (release)"
cargo build --release --manifest-path "$here\Cargo.toml"
Copy-Item "$here\target\release\hippius_shell.dll" "$out\HippiusShell.dll" -Force

Write-Host "==> Generating a self-signed code-signing cert (Subject=$Publisher)"
# The cert Subject MUST equal the manifest Publisher, or registration is refused.
# CA=false basic constraint is required for MSIX signing.
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Publisher `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -FriendlyName "Hippius Preview Self-Signed" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}CA=false")
$thumb = $cert.Thumbprint
Write-Host "    thumbprint: $thumb"

Write-Host "==> Stamping AppxManifest.xml (into a manifest-only pack dir)"
# A SPARSE package packs the MANIFEST ONLY — the DLL lives in the ExternalLocation
# (the app install dir), not inside the package. So stamp into an isolated dir
# that contains nothing but AppxManifest.xml.
$packDir = Join-Path $out "pack"
New-Item -ItemType Directory -Force -Path $packDir | Out-Null
(Get-Content "$here\AppxManifest.xml" -Raw).
  Replace("{PUBLISHER}", $Publisher).
  Replace("{VERSION}", $Version).
  Replace("{CLSID}", $Clsid) | Set-Content "$packDir\AppxManifest.xml" -Encoding UTF8

Write-Host "==> Locating Windows SDK tools (makeappx, signtool)"
$sdkBin = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory |
  Where-Object { Test-Path "$($_.FullName)\x64\makeappx.exe" } |
  Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdkBin) { throw "Windows SDK bin with makeappx.exe not found" }
$makeappx = "$($sdkBin.FullName)\x64\makeappx.exe"
$signtool = "$($sdkBin.FullName)\x64\signtool.exe"
Write-Host "    using $($sdkBin.Name)"

Write-Host "==> Packing sparse package"
$msix = "$out\HippiusShellSparse.msix"
# Pack the manifest-only dir. /nv = no semantic validation (payload-less sparse).
& $makeappx pack /d $packDir /p $msix /nv /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }

Write-Host "==> Signing"
& $signtool sign /fd SHA256 /sha1 $thumb $msix
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed ($LASTEXITCODE)" }

# `verify /pa` requires a chain to a TRUSTED root. A self-signed cert is not
# trusted on the CI runner, so a non-zero result here is EXPECTED and NOT fatal —
# the signing above succeeded. On the tester's machine, importing
# HippiusPreviewCert.cer into Trusted Root + Trusted People makes it valid.
Write-Host "==> Verifying (informational for a self-signed cert)"
& $signtool verify /pa $msix
if ($LASTEXITCODE -ne 0) {
  Write-Host "note: signtool verify returned $LASTEXITCODE — expected for a self-signed cert not yet trusted on this machine (the tester trusts the exported .cer)."
}

Write-Host "==> Exporting the self-signed cert for testers"
Export-Certificate -Cert $cert -FilePath "$out\HippiusPreviewCert.cer" | Out-Null

Write-Host "==> Done. Artifacts in $out"
Get-ChildItem $out | Select-Object Name, Length | Format-Table

# The informational `signtool verify` left $LASTEXITCODE=1; the packaging itself
# succeeded, so exit clean (PowerShell propagates the last native exit code).
exit 0
