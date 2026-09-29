/**
 * Ask the main window to open a Drive folder, from a surface that does not
 * hold the router itself (the sync queue widget). `TrayNavigationListener`
 * does the navigation. A window event rather than a hook, so the widget stays
 * free of routing and renders anywhere.
 */
export const OPEN_DRIVE_FOLDER_EVENT = "hippius:open-drive-folder";

export interface OpenDriveFolderDetail {
  /** A `/files?...` URL, from `driveFolderRoute`. */
  url: string;
}

export function requestOpenDriveFolder(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenDriveFolderDetail>(OPEN_DRIVE_FOLDER_EVENT, { detail: { url } }));
}
