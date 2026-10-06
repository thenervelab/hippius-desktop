import { getCurrentWindow } from "@tauri-apps/api/window";

export const TRAY_OPEN_FILES_EVENT = "hippius:tray-open-files";
export const TRAY_OPEN_VM_EVENT = "hippius:tray-open-vm";

/** Backend event the tray popover emits to have the main window's
 *  `CaptureHost` start a capture (`{ kind?, mode? }`), through the same
 *  `useStartCapture` as the Drive page, so a first capture still gets the
 *  drive picker or the permission explainer, which are main-window dialogs. */
export const TRAY_CAPTURE_EVENT = "hippius:tray-capture";

/** Backend event the tray popover emits to open the capture drive picker in
 *  the main window ("Captures folder…"). */
export const TRAY_CAPTURE_DRIVE_EVENT = "hippius:tray-capture-drive";

export async function openAppWindow(): Promise<void> {
  try {
    const appWindow = getCurrentWindow();
    const isMinimized = await appWindow.isMinimized();

    if (isMinimized) {
      await appWindow.unminimize();
    }

    await appWindow.show();
    await appWindow.setFocus();
  } catch (error) {
    console.error("[Tray] Failed to open app window:", error);
  }
}

export async function openFilesPage(): Promise<void> {
  await openAppWindow();

  if (typeof window === "undefined") return;
  if (window.location.pathname === "/files") return;

  window.dispatchEvent(new CustomEvent(TRAY_OPEN_FILES_EVENT));
}

export async function openVirtualMachinesPage(): Promise<void> {
  await openAppWindow();

  if (typeof window === "undefined") return;
  if (window.location.pathname === "/vm") return;

  window.dispatchEvent(new CustomEvent(TRAY_OPEN_VM_EVENT));
}
