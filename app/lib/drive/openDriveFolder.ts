/**
 * Ask the main window to open a Drive folder (or the Captures page, for the
 * captures drive), from a surface that does not
 * hold the router itself (the sync queue widget). `TrayNavigationListener`
 * does the navigation. A window event rather than a hook, so the widget stays
 * free of routing and renders anywhere.
 */
export const OPEN_DRIVE_FOLDER_EVENT = "hippius:open-drive-folder";

export interface OpenDriveFolderDetail {
  /** A `/files?...` URL from `driveFolderRoute`, or `/captures?...` from `capturesRoute`. */
  url: string;
}

export function requestOpenDriveFolder(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenDriveFolderDetail>(OPEN_DRIVE_FOLDER_EVENT, { detail: { url } }));
}
