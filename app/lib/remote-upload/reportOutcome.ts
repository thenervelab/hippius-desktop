import { toast } from "sonner";

import type { RemoteUploadFailure } from "@/app/lib/tauri/remoteUpload";

/** Shared id so a start notice is replaced by its outcome, not stacked under it. */
export const REMOTE_UPLOAD_TOAST_ID = "remote-upload-started";

/** How long the "upload started" notice stays up, in ms. */
export const REMOTE_UPLOAD_TOAST_MS = 4000;

/** Tell the user a FILE upload into a non-synced folder has begun. */
export function reportRemoteUploadStarted(fileCount: number): void {
  announceUploadStarted(
    fileCount === 1
      ? "Your file is being uploaded"
      : "Your files are being uploaded",
  );
}

/**
 * Tell the user a FOLDER upload into a non-synced folder has begun.
 *
 * Its own wording rather than the file version with a count of one: the
 * file count is not known until Rust has walked the tree, so passing 1
 * announced "Your file is being uploaded" for a folder of any size.
 */
export function reportRemoteFolderUploadStarted(): void {
  announceUploadStarted("Your folder is being uploaded");
}

function announceUploadStarted(message: string): void {
  toast.info(message, {
    id: REMOTE_UPLOAD_TOAST_ID,
    duration: REMOTE_UPLOAD_TOAST_MS,
  });
}

/**
 * Say how an upload into a non-synced folder ended.
 *
 * Shared by the button inside such a folder and the upload dialog's remote
 * destination, so one upload does not get two different vocabularies
 * depending on where it was started from.
 *
 * Partial success is a real outcome and says both halves: each file is
 * uploaded independently, so reporting only the failures would hide the
 * ones that landed, and reporting only success would hide the ones that
 * did not.
 */
export function reportRemoteUploadOutcome(
  attempted: number,
  failures: RemoteUploadFailure[],
): void {
  const uploaded = attempted - failures.length;

  if (failures.length === 0) {
    toast.success(uploaded === 1 ? "1 file uploaded" : `${uploaded} files uploaded`, {
      id: REMOTE_UPLOAD_TOAST_ID,
    });
    return;
  }
  if (uploaded === 0) {
    // Rust owns the sentence; it already explains why.
    toast.error(failures[0].error, { id: REMOTE_UPLOAD_TOAST_ID });
    return;
  }
  toast.warning(
    `${uploaded} uploaded, ${failures.length} failed: ${failures
      .map((f) => f.name)
      .join(", ")}`,
    { id: REMOTE_UPLOAD_TOAST_ID, duration: 6000 },
  );
}

/**
 * Say how a FOLDER upload into a non-synced drive ended.
 *
 * Separate from the file version because the count is not known up front
 * — Rust walks the tree and only the failures come back — so this can
 * only report what went wrong, not "n of m".
 */
export function reportRemoteUploadOutcomeForFolder(
  failures: RemoteUploadFailure[],
): void {
  if (failures.length === 0) {
    toast.success("Folder uploaded", { id: REMOTE_UPLOAD_TOAST_ID });
    return;
  }
  toast.warning(
    `Folder uploaded, ${failures.length} ${failures.length === 1 ? "file" : "files"} failed: ${failures
      .map((f) => f.name)
      .join(", ")}`,
    { id: REMOTE_UPLOAD_TOAST_ID, duration: 6000 },
  );
}
