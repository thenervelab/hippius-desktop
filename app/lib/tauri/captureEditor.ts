import { invoke } from "@tauri-apps/api/core";

/**
 * The screenshot editor's IPC (`src-tauri/src/capture/editor.rs`). Rust owns
 * the file, its upload and its link; the editor only sends the flattened
 * picture and says how to save it. Pictures travel as raw bytes, never JSON
 * arrays.
 */

/** How a picture in a drive is saved. Mirrors Rust's `SaveMode`. */
export type SaveMode = "copy" | "replace";

/** The user's saved choice for Save. Mirrors Rust's `SavePreference`. */
export type SavePreference = "ask" | SaveMode;

/** What the editor shows about the open picture. Mirrors Rust's `EditorContext`. */
export interface EditorContext {
  session: number;
  fileName: string;
  driveName: string;
  mime: string;
  /** A file in a drive (copy or replace), or a picked picture (new capture). */
  saveKind: "inDrive" | "newCapture";
  /** Rust's line about what Save does, for a picked picture. */
  saveNote: string;
  /** Rust's line for "Save as a copy". */
  copyNote: string;
  /** Rust's line for "Replace the original", with the link warning when it applies. */
  replaceNote: string;
  hasPublicLink: boolean;
  savePreference: SavePreference;
}

/** Mirrors Rust's `SaveOutcome`. */
export interface SaveOutcome {
  title: string;
  message: string;
  fileName: string;
  /** "Copy link" can be offered (`copySavedLink`). */
  offerLink: boolean;
}

/** Mirrors Rust's `shares::quick_link::QuickLinkOutcome`. */
export type CopyLinkOutcome =
  | { status: "copied"; url: string; reused: boolean }
  | { status: "failed"; message: string };

/**
 * Sent to the main window (with the session's id) when a picture is open in
 * the editor; the window shows it over the page. Rust's `OPEN_EVENT`.
 */
export const EDITOR_OPEN_EVENT = "capture_editor_open";

/** The header that names the session a save or copy is for. */
const SESSION_HEADER = "x-editor-session";
/** The header that says how to save a picture in a drive. */
const SAVE_MODE_HEADER = "x-editor-save-mode";

/** The open picture, or null when nothing is open. */
export function getEditorContext(): Promise<EditorContext | null> {
  return invoke("capture_editor_context");
}

/** The picture as it was opened. */
export async function getEditorImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("capture_editor_image");
}

/**
 * Save the flattened picture. `mode` is required for a picture in a drive
 * and ignored for a picked one (always a new capture).
 */
export function saveEditedImage(session: number, png: Uint8Array, mode?: SaveMode): Promise<SaveOutcome> {
  const headers: Record<string, string> = { [SESSION_HEADER]: String(session) };
  if (mode) headers[SAVE_MODE_HEADER] = mode;
  return invoke("capture_editor_save", png, { headers });
}

export function copyEditedImage(png: Uint8Array): Promise<void> {
  return invoke("capture_editor_copy", png);
}

/** Close, Cancel or Discard: nothing is written and the session is forgotten. */
export function closeEditor(session: number): Promise<void> {
  return invoke("capture_editor_close", { session });
}

/** The user's saved choice for Save (Settings, and the dialog's "Remember my choice"). */
export function getSavePreference(): Promise<SavePreference> {
  return invoke("capture_editor_save_preference");
}

export function setSavePreference(preference: SavePreference): Promise<void> {
  return invoke("capture_editor_set_save_preference", { preference });
}

/** "Copy link" after a save: Rust copies the saved picture's link, or says why not. */
export function copySavedLink(): Promise<CopyLinkOutcome> {
  return invoke("capture_editor_copy_saved_link");
}

/** "Edit image" on a Drive file. Rust checks the file and shows the editor. */
export function openFileInEditor(label: string, relativePath: string): Promise<void> {
  return invoke("capture_editor_open_file", { label, relativePath });
}

/** The latest screenshot the tray's Annotate offers. Mirrors Rust's `LatestScreenshot`. */
export interface LatestScreenshot {
  fileName: string;
}

/** The latest screenshot, when there is one (Rust decides which). */
export function getLatestScreenshot(): Promise<LatestScreenshot | null> {
  return invoke("capture_annotate_latest");
}

/** Open the latest screenshot in the editor; `false` when there is none any more. */
export function annotateLatestScreenshot(): Promise<boolean> {
  return invoke("capture_annotate_open_latest");
}

/**
 * Rust shows the system's file dialog and opens the picked picture; no path
 * crosses the IPC. `false` when the user cancelled.
 */
export function annotateChosenImage(): Promise<boolean> {
  return invoke("capture_annotate_pick");
}
