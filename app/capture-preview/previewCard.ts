import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";

/**
 * What the capture card says, decided without React so it can be tested.
 * Rust owns what happened (`capture::preview`); this only words it.
 */

/** How long a finished card stays before it slides away, unless hovered. */
export const AUTO_HIDE_MS = 6000;

/**
 * The upload's progress for this card, 0 to 100, from the same
 * `remote_upload_progress` events the sync widget reads. `null` until the
 * first event arrives (encryption, before any byte is sent).
 */
export function uploadPercent(card: CapturePreviewCard, row: RemoteUploadProgress | null): number | null {
  if (card.status.state === "uploaded") return 100;
  if (!row || row.fileName !== card.fileName || row.label !== card.driveLabel) return null;
  if (row.status === "completed") return 100;
  if (row.totalBytes <= 0) return null;
  return Math.min(99, Math.round((row.bytesTransferred / row.totalBytes) * 100));
}

/** Where the file is going, as the card's first line reads it. */
export function destinationText(card: CapturePreviewCard): string {
  return `${card.driveName} › Captures`;
}

/** The card's status line. */
export function statusText(card: CapturePreviewCard, percent: number | null): string {
  switch (card.status.state) {
    case "uploading":
      return percent === null ? "Preparing upload…" : `Uploading · ${percent}%`;
    case "uploaded":
      return card.status.linkCopied ? "Uploaded · link copied" : "Uploaded · no link";
    case "failed":
      return "Couldn't upload";
  }
}

/** A finished card hides itself; an uploading or failed one waits for the user. */
export function hidesItself(card: CapturePreviewCard): boolean {
  return card.status.state === "uploaded";
}
