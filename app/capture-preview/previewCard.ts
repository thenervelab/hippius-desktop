import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";

/**
 * What the capture card says, decided without React so it can be tested.
 * Rust owns what happened (`capture::preview`); this only words it, following
 * the upload wherever it runs: a direct upload (`remote_upload_progress`) or,
 * for a drive synced here, the sync engine's own row (`sync_progress_snapshot`).
 */

/** How long a finished card stays before it slides away, unless hovered. */
export const AUTO_HIDE_MS = 6000;

export interface CardView {
  /** 0 to 100, or null while nothing has been sent yet. */
  percent: number | null;
  /** The status line. */
  text: string;
  /** The file is in the drive. */
  done: boolean;
  failed: boolean;
  /** A link is on the clipboard (Copy link can copy it again). */
  linkCopied: boolean;
}

function percentOf(sent: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(99, Math.round((sent / total) * 100));
}

/** The upload row that belongs to this card, if the event is about it. */
function sameFile(card: CapturePreviewCard, row: { fileName: string; label: string } | null | undefined): boolean {
  return !!row && row.fileName === card.fileName && row.label === card.driveLabel;
}

export function cardView(
  card: CapturePreviewCard,
  remoteRow: RemoteUploadProgress | null,
  syncFiles: readonly FileProgress[],
): CardView {
  const status = card.status;
  switch (status.state) {
    case "uploading": {
      const percent = sameFile(card, remoteRow) && remoteRow ? percentOf(remoteRow.bytesTransferred, remoteRow.totalBytes) : null;
      return {
        percent,
        text: percent === null ? "Preparing upload…" : `Uploading · ${percent}%`,
        done: false,
        failed: false,
        linkCopied: false,
      };
    }
    case "syncing": {
      const row = syncFiles.find((f) => sameFile(card, f));
      if (row?.status === "completed") {
        return { percent: 100, text: uploadedText(status.linkCopied), done: true, failed: false, linkCopied: status.linkCopied };
      }
      if (row?.status === "error") {
        return { percent: null, text: "Couldn't upload · the sync queue will retry", done: false, failed: true, linkCopied: status.linkCopied };
      }
      const percent = row ? percentOf(row.bytesTransferred, row.totalBytes) : null;
      return {
        percent,
        text: percent === null ? "Saved · waiting for sync" : `Uploading · ${percent}%`,
        done: false,
        failed: false,
        linkCopied: status.linkCopied,
      };
    }
    case "uploaded":
      return { percent: 100, text: uploadedText(status.linkCopied), done: true, failed: false, linkCopied: status.linkCopied };
    case "failed":
      return { percent: null, text: "Couldn't upload", done: false, failed: true, linkCopied: false };
  }
}

function uploadedText(linkCopied: boolean): string {
  return linkCopied ? "Uploaded · link copied" : "Uploaded · no link";
}

/** Where the file is going, as the card's first line reads it. */
export function destinationText(card: CapturePreviewCard): string {
  return `${card.driveName} › Captures`;
}

/** Retry applies only to a direct upload that failed; the sync queue retries its own. */
export function canRetry(card: CapturePreviewCard): boolean {
  return card.status.state === "failed";
}
