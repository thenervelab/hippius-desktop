import { invoke } from "@tauri-apps/api/core";

/**
 * The screenshot editor's IPC (`src-tauri/src/capture/editor.rs`). Rust owns
 * the file, its upload and its link; the editor only sends the flattened
 * picture. Pictures travel as raw bytes, never JSON arrays.
 */

/** What the editor shows about the open picture. Mirrors Rust's `EditorContext`. */
export interface EditorContext {
  session: number;
  fileName: string;
  driveName: string;
  mime: string;
  /** Rust's line about what Save does (and to the link). */
  saveNote: string;
}

export interface SaveOutcome {
  message: string;
}

/** Sent when the window's close button is pressed; the page decides. */
export const EDITOR_CLOSE_REQUESTED_EVENT = "capture_editor_close_requested";

/** The header that names the session a save or copy is for. */
const SESSION_HEADER = "x-editor-session";

export function getEditorContext(): Promise<EditorContext | null> {
  return invoke("capture_editor_context");
}

/** The picture as it was opened. */
export async function getEditorImage(): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("capture_editor_image");
}

export function saveEditedImage(session: number, png: Uint8Array): Promise<SaveOutcome> {
  return invoke("capture_editor_save", png, { headers: { [SESSION_HEADER]: String(session) } });
}

export function copyEditedImage(png: Uint8Array): Promise<void> {
  return invoke("capture_editor_copy", png);
}

/** Cancel: nothing is written and the window goes. */
export function closeEditor(): Promise<void> {
  return invoke("capture_editor_close");
}

/** "Edit image" on a Drive file. Rust checks the file and opens the window. */
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
