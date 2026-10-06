/**
 * Files dropped on the tray popover, on their way to the main window's
 * upload dialog.
 *
 * The popover is its own webview and uploads nothing: it emits
 * {@link TRAY_UPLOAD_PATHS_EVENT}, `TrayNavigationListener` (main window)
 * sends the window to the Drive page and parks the paths here, and
 * `DriveContent` takes them once it is mounted and runs them through the
 * same path as a drop on the page itself. Parking them covers the case the
 * Drive page is not mounted yet when the event arrives.
 */

/** Backend event the popover emits to send the main window to the Drive page. */
export const TRAY_OPEN_FILES_TAURI_EVENT = "hippius:tray-open-files";

/** Backend event the popover's Upload tile emits: the main window opens its
 *  "Upload File" dialog over the page it is on (`TrayUploadDialogHost`). */
export const TRAY_OPEN_UPLOAD_EVENT = "hippius:tray-open-upload";

/** Backend event the popover emits with `{ paths }` when files are dropped on it. */
export const TRAY_UPLOAD_PATHS_EVENT = "hippius:tray-upload-paths";

/** Window event telling a mounted Drive page that paths are waiting. */
export const TRAY_DROP_WAITING_EVENT = "hippius:tray-drop-waiting";

let waiting: string[] | null = null;

/** The `{ paths }` payload, or null when it is not one (it crosses a webview). */
export function parseTrayDropPayload(payload: unknown): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const paths = (payload as { paths?: unknown }).paths;
  if (!Array.isArray(paths)) return null;
  const clean = paths.filter((p): p is string => typeof p === "string" && p.length > 0);
  return clean.length > 0 ? clean : null;
}

/** Park dropped paths for the Drive page and tell a mounted one. */
export function parkTrayDrop(paths: string[]): void {
  waiting = paths;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TRAY_DROP_WAITING_EVENT));
  }
}

/** Take the parked paths, once: a second call returns null. */
export function takeTrayDrop(): string[] | null {
  const paths = waiting;
  waiting = null;
  return paths;
}
