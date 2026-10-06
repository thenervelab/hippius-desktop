import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Window } from "@tauri-apps/api/window";
import { revealFile } from "@/app/lib/utils/revealFile";
import {
  cloudFileIdFor,
  runsInMainWindow,
  trayRowRelativePath,
  TRAY_FILE_ACTION_EVENT,
  type TrayFileActionRequest,
  type TrayRowActionId,
} from "@/app/lib/tray/trayRowActions";
import type { UploadFeedItem } from "@/app/lib/upload-feed/mergeUploadFeed";

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
function toDriveFile(item: UploadFeedItem): TrayFileActionRequest["file"] {
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
 * Resolves to a sentence for the row when the action failed (a file that is
 * not on this computer to reveal, say), else `null`.
 */
export async function runTrayRowAction(
  id: TrayRowActionId,
  item: UploadFeedItem,
  accountId: string | null,
): Promise<string | null> {
  try {
    if (runsInMainWindow(id)) {
      await revealMain();
      const request: TrayFileActionRequest = {
        action: id,
        file: toDriveFile(item),
      };
      await emit(TRAY_FILE_ACTION_EVENT, request);
      await invoke("hide_tray_panel");
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
