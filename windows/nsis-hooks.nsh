; Tauri NSIS installer hooks for the Hippius shell extension.
;
; These hooks fire ONLY when tauri-build.yml's Windows leg injects them (plus the
; DLL/MSIX resources + signCommand) via `--config` at release time — which it
; does only when the Azure signing secrets are present. A no-secret build never
; references this file, so a self-signed/preview or dev `tauri build` is
; unaffected. See windows/README.md.
;
; Tauri copies the bundled DLL + sparse package to $INSTDIR\resources\ (its
; resource dir). The sparse package's manifest declares the COM DLL by a path
; relative to the ExternalLocation (= $INSTDIR), so the DLL must sit at
; $INSTDIR\HippiusShell.dll — hence the copy up from resources\ below.
; Registration failures are non-fatal: the app still works, just without the
; Explorer menu item.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Installing Hippius shell extension..."
  ; The manifest's com:Class Path="HippiusShell.dll" resolves against the
  ; ExternalLocation ($INSTDIR), so lift the DLL out of resources\ to the root.
  CopyFiles /SILENT "$INSTDIR\resources\HippiusShell.dll" "$INSTDIR\HippiusShell.dll"
  ; -ExternalLocation points the payload-less sparse package at the install dir.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-AppxPackage -Path \"$INSTDIR\resources\HippiusShellSparse.msix\" -ExternalLocation \"$INSTDIR\""'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Hippius shell extension registration failed ($0); the app will run without the Explorer menu item."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing Hippius shell extension..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name Hippius.ShellExtension | Remove-AppxPackage"'
  Pop $0
  ; Remove the DLL we lifted to the install root in POSTINSTALL (the resources\
  ; copy is removed by Tauri's own uninstaller with the rest of the bundle).
  Delete "$INSTDIR\HippiusShell.dll"
!macroend
