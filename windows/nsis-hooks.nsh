; Tauri NSIS installer hooks for the Hippius shell extension.
;
; Reference from tauri.conf.json:
;   "bundle": { "windows": { "nsis": { "installerHooks": "./windows/nsis-hooks.nsh" } } }
;
; POSTINSTALL registers the signed sparse MSIX package (shipped next to the app)
; with an external location = the install dir, which is where HippiusShell.dll
; lives. PREUNINSTALL deregisters it. Registration failures are non-fatal — the
; app still works, just without the Explorer menu item.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering Hippius shell extension..."
  ; -ExternalLocation points the payload-less sparse package at the install dir.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-AppxPackage -Path \"$INSTDIR\HippiusShellSparse.msix\" -ExternalLocation \"$INSTDIR\""'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Hippius shell extension registration failed ($0); the app will run without the Explorer menu item."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Removing Hippius shell extension..."
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name Hippius.ShellExtension | Remove-AppxPackage"'
  Pop $0
!macroend
