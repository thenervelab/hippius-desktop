import { save } from "@tauri-apps/plugin-dialog";

import { chatSaveAttachment } from "@/app/lib/tauri/chat";

export type SaveAttachmentOutcome = "saved" | "cancelled";

/**
 * Webview glue between a decrypted attachment and the disk. A `<a download>`
 * on a `blob:` URL is a no-op inside the Tauri webview (there is no
 * download manager), so: read the already-decrypted bytes back from the
 * object URL the viewer is showing, ask where to put them with the native
 * dialog (UI), and hand the write to Rust (`chat_save_attachment`: absolute
 * path only, atomic, no silent overwrite).
 *
 * Throws on a failed read or write so the caller can toast the message;
 * a dismissed dialog resolves `"cancelled"` and is not an error.
 */
export async function saveAttachmentToDisk(objectUrl: string, name: string): Promise<SaveAttachmentOutcome> {
  const destination = await save({ defaultPath: await defaultSavePath(name) });
  if (!destination) return "cancelled";
  const response = await fetch(objectUrl);
  if (!response.ok) throw new Error("Could not read the downloaded file");
  await chatSaveAttachment(destination, await response.arrayBuffer());
  return "saved";
}

/** `~/Downloads/<name>` when the platform tells us where that is, else just the name. */
async function defaultSavePath(name: string): Promise<string> {
  try {
    const { downloadDir, join } = await import("@tauri-apps/api/path");
    return await join(await downloadDir(), name);
  } catch {
    return name;
  }
}

/** The one line a failed save shows; Rust's `Validation` messages are user-facing already. */
export function saveErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return error instanceof Error ? error.message : "Could not save the file";
}
