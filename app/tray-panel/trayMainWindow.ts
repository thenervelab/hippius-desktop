import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { revealFile } from "@/app/lib/utils/revealFile";
import { openFileInEditor } from "@/app/lib/tauri/captureEditor";
import {
  TRAY_OPEN_UPLOAD_EVENT,
  TRAY_UPLOAD_PATHS_EVENT,
} from "@/app/lib/tray/trayDrop";
import {
  cloudFileIdFor,
  runsInMainWindow,
  trayRowRelativePath,
  TRAY_FILE_ACTION_EVENT,
  type TrayFileActionRequest,
  type TrayRowActionId,
} from "@/app/lib/tray/trayRowActions";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";
import type { CaptureDriveStatus } from "@/app/lib/tauri/capture";
import {
  capturesFolderTarget,
  TRAY_OPEN_PAGE_EVENT,
  type TrayPage,
} from "@/app/lib/tray/trayHeaderMenu";

/** Reveal + focus the `main` window (addressed by label: the popover runs in
 *  its own webview, so `getCurrentWindow()` here is the panel, not main). */
export async function revealMain() {
  const main = await Window.getByLabel("main");
  if (!main) return;
  if (await main.isMinimized()) await main.unminimize();
  await main.show();
  await main.setFocus();
}

/** Strip the popover-only fields so the main window gets the plain Drive row
 *  its handlers take. */
export function toDriveFile(item: UploadFeedItem): TrayFileActionRequest["file"] {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { feedStatus, progressPercent, errorMessage, ...file } = item;
  return file;
}

/**
 * Run one row action that is not "Copy link" (which keeps its own state in
 * the row). Actions that need a dialog, a toast or a route reveal the main
 * window and hand it the file through {@link TRAY_FILE_ACTION_EVENT}; the
 * popover never navigates or opens app dialogs itself. Reveal runs here: it
 * opens the file manager and needs nothing from the main window.
 *
 * `siblings` (for "preview") is the list the viewer walks: the popover tab
 * the file was opened from.
 *
 * Resolves to a sentence for the row when the action failed (a file that is
 * not on this computer to reveal, say), else `null`.
 */
export async function runTrayRowAction(
  id: TrayRowActionId,
  item: UploadFeedItem,
  accountId: string | null,
  siblings?: UploadFeedItem[],
): Promise<string | null> {
  try {
    if (runsInMainWindow(id)) {
      await revealMain();
      const request: TrayFileActionRequest = {
        action: id,
        file: toDriveFile(item),
        ...(id === "preview" && siblings && siblings.length > 0
          ? { siblings: siblings.map(toDriveFile) }
          : {}),
      };
      await emit(TRAY_FILE_ACTION_EVENT, request);
      await invoke("hide_tray_panel");
      return null;
    }
    if (id === "edit") {
      // The editor must not open under the always-on-top popover. Rust
      // checks the file again (an own drive, synced here, PNG or JPEG).
      await invoke("hide_tray_panel");
      await openFileInEditor(item.label ?? "", trayRowRelativePath(item));
      return null;
    }
    if (id === "reveal") {
      await revealFile({
        sourcePath: item.source || undefined,
        label: item.label,
        accountId: accountId ?? undefined,
        fileName: item.actualFileName || item.name,
      });
      await invoke("hide_tray_panel");
    }
    return null;
  } catch (error) {
    console.error(`[TrayPanel] "${id}" failed:`, error);
    return errorSentence(error);
  }
}

/** Rust's `{ kind, message }` sentence, or an `Error`'s, for the row. */
function errorSentence(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0
    ? message
    : "That didn't work. Try again from Hippius.";
}

/** Mirrors Rust's `shares::quick_link::QuickLinkOutcome`. */
export type QuickLinkOutcome =
  | { status: "copied"; url: string; reused: boolean }
  | { status: "failed"; message: string };

/**
 * "Copy link": Rust reuses the file's existing public link or makes one
 * (public, until revoked), and puts it on the clipboard itself, so the copy
 * lands even if the popover lost focus while a link was being made.
 */
export async function copyTrayRowLink(
  item: UploadFeedItem,
): Promise<QuickLinkOutcome> {
  try {
    return await invoke<QuickLinkOutcome>("copy_file_share_link", {
      folderLabel: item.label ?? "",
      relativePath: trayRowRelativePath(item),
      fileId: cloudFileIdFor(item),
    });
  } catch (error) {
    console.error("[TrayPanel] copy link failed:", error);
    return { status: "failed", message: errorSentence(error) };
  }
}

/**
 * The Upload tile and the empty state's "Upload a File": bring the main
 * window forward and have it open its "Upload File" dialog (the one the
 * Drive and Recent Files Upload buttons open) over whatever page it is on,
 * through `TrayUploadDialogHost`. The popover opens no dialog and no file
 * picker itself; the main window applies the upload gates.
 */
export async function openMainUpload() {
  try {
    await invoke("hide_tray_panel");
    await revealMain();
    await emit(TRAY_OPEN_UPLOAD_EVENT, {});
  } catch (error) {
    console.error("[TrayPanel] Failed to open the upload dialog:", error);
  }
}

/**
 * Reveal the main window (it stays on the page it is on), then hide the
 * popover: "Open Hippius".
 */
export async function openMainWindow() {
  try {
    await revealMain();
    await invoke("hide_tray_panel");
  } catch (error) {
    console.error("[TrayPanel] Failed to open main window:", error);
  }
}

/**
 * Send the main window to one of its pages (the ⋮ menu's Plan, Settings,
 * Help & Support). `TrayNavigationListener` routes it; the popover never
 * navigates. Top up is the same request but opens the console in the
 * browser from the main window, which has the opener permission this
 * popover is denied, so the main window is not brought forward for it.
 */
export async function openMainPage(page: TrayPage) {
  try {
    await invoke("hide_tray_panel");
    if (page !== "top-up") await revealMain();
    await emit(TRAY_OPEN_PAGE_EVENT, { page });
  } catch (error) {
    console.error(`[TrayPanel] Failed to open ${page}:`, error);
  }
}

/**
 * "Open captures folder": reveal the captures drive's folder in Finder or
 * Explorer when it is on this computer, else open the Captures page
 * (`capturesFolderTarget`, from Rust's `capture_drive_status`).
 */
export async function openCapturesFolder() {
  try {
    await invoke("hide_tray_panel");
    const status = await invoke<CaptureDriveStatus>("capture_drive_status").catch(() => null);
    const target = capturesFolderTarget(status);
    if (target.kind === "reveal") {
      await invoke("reveal_drive_in_finder", { label: target.label });
      return;
    }
    await openMainPage("captures");
  } catch (error) {
    console.error("[TrayPanel] Failed to open the captures folder:", error);
    await openMainPage("captures");
  }
}

/** "Quit Hippius": the same quit as the tray icon's right-click menu. */
export async function quitFromTray() {
  try {
    await invoke("app_close");
  } catch (error) {
    console.error("[TrayPanel] Failed to quit:", error);
  }
}

/**
 * Files dropped on the popover: the main window opens its upload dialog
 * with them, as a drop on the Drive page would (the dialog asks which
 * drive, and every upload gate applies there). The popover uploads nothing
 * itself.
 */
export async function uploadDroppedPaths(paths: string[]) {
  if (paths.length === 0) return;
  try {
    await invoke("hide_tray_panel");
    await revealMain();
    await emit(TRAY_UPLOAD_PATHS_EVENT, { paths });
  } catch (error) {
    console.error("[TrayPanel] Failed to hand the dropped files over:", error);
  }
}
