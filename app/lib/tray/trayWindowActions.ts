import { getCurrentWindow } from "@tauri-apps/api/window";

export const TRAY_OPEN_FILES_EVENT = "hippius:tray-open-files";

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
