<#
.SYNOPSIS
  Build the shell-extension DLL and pack + sign the sparse MSIX package.

  ONE script, two signing modes:
    * SELF-SIGNED (default, no -Azure* args) — for INTERNAL/PREVIEW testing with
      no procured cert. Exports the self-signed .cer so a tester trusts it once
      (Trusted People + Trusted Root) and the Win11 menu then registers. This is
      the mode the fast CI lane (ci.yml windows-shell-ext) runs.
    * AZURE ARTIFACT SIGNING (pass -AzureEndpoint/-AzureAccount/-AzureProfile) —
      for PUBLIC releases. Signs the DLL and the sparse package with a
      publicly-trusted cert via `artifact-signing-cli`, so the installer's
      Add-AppxPackage succeeds on any machine with NO cert import. Authenticates
      from the AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID service
      principal in the environment.

.DESCRIPTION
  Runs on windows-latest (CI) or a Windows dev host with the Rust toolchain +
  Windows SDK (makeappx/signtool). In Azure mode also needs `artifact-signing-cli`
  (`cargo install artifact-signing-cli`) and .NET 8. Outputs to ./out:
    HippiusShell.dll            the COM DLL (renamed from the snake_case cdylib)
    AppxManifest.xml            stamped
    HippiusShellSparse.msix     packed + signed
    HippiusPreviewCert.cer      (self-signed mode only) the tester imports it

  The DLL + sparse package are embedded in the NSIS installer at
  $INSTDIR\resources\ (Tauri's resource dir) and (de)registered by
  ../nsis-hooks.nsh — see windows/README.md.
#>
param(
  # In Azure mode this MUST EXACTLY equal the certificate profile's Subject, or
  # Explorer silently refuses to load the extension. In self-signed mode it is
  # the generated cert's Subject (any value; the exported .cer carries trust).
  [string]$Publisher = "CN=Hippius Preview (Self-Signed)",
  [string]$Version = "0.3.1.0",
  # BARE GUID (no braces) — the MSIX manifest com:Class Id / Verb Clsid schema
  # rejects braces. The Rust GUID value is unaffected (matched by value at runtime).
  [string]$Clsid = "0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0",
  # Azure Artifact Signing (formerly Trusted Signing). Providing all three flips
  # this script from self-signed to production signing. Endpoint e.g.
  # https://wus2.codesigning.azure.net .
  [string]$AzureEndpoint = "",
  [string]$AzureAccount = "",
  [string]$AzureProfile = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$out = Join-Path $here "out"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$azure = $AzureEndpoint -and $AzureAccount -and $AzureProfile
Write-Host ("==> Signing mode: {0}" -f ($(if ($azure) { "Azure Artifact Signing" } else { "self-signed (preview)" })))

Write-Host "==> Building HippiusShell.dll (release)"
cargo build --release --manifest-path "$here\Cargo.toml"
Copy-Item "$here\target\release\hippius_shell.dll" "$out\HippiusShell.dll" -Force

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

$msix = "$out\HippiusShellSparse.msix"

if ($azure) {
  # PUBLIC RELEASE: sign the DLL first, THEN pack, THEN sign the package. The
  # cert chains to a trusted root, so `signtool verify /pa` and the installer's
  # Add-AppxPackage both succeed with no cert import on the user's machine.
  $desc = "Hippius Shell Extension"
  Write-Host "==> Signing HippiusShell.dll (Azure)"
  artifact-signing-cli -e $AzureEndpoint -a $AzureAccount -c $AzureProfile -d $desc "$out\HippiusShell.dll"
  if ($LASTEXITCODE -ne 0) { throw "artifact-signing-cli (DLL) failed ($LASTEXITCODE)" }

  Write-Host "==> Packing sparse package"
  & $makeappx pack /d $packDir /p $msix /nv /o
  if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }

  Write-Host "==> Signing sparse package (Azure)"
  artifact-signing-cli -e $AzureEndpoint -a $AzureAccount -c $AzureProfile -d $desc $msix
  if ($LASTEXITCODE -ne 0) { throw "artifact-signing-cli (MSIX) failed ($LASTEXITCODE)" }

  Write-Host "==> Verifying (must chain to a trusted root)"
  & $signtool verify /pa $msix
  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed ($LASTEXITCODE) — the package does not chain to a trusted root" }
}
else {
  # PREVIEW: a self-signed cert is not trusted by default; the tester imports the
  # exported .cer into Trusted People + Trusted Root once, and the menu registers.
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

  Write-Host "==> Packing sparse package"
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
}

Write-Host "==> Done. Artifacts in $out"
Get-ChildItem $out | Select-Object Name, Length | Format-Table

# The informational self-signed `signtool verify` can leave $LASTEXITCODE=1; the
# packaging itself succeeded, so exit clean (PowerShell propagates the last native
# exit code). In Azure mode every native call is checked and throws on failure.
exit 0
