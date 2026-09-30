import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";
import { cappedPercent } from "@/app/lib/upload-feed/percent";

/**
 * What the capture card says, decided without React so it can be tested.
 * Rust owns what happened (`capture::preview`); this only words it, following
 * the upload wherever it runs: a direct upload (`remote_upload_progress`) or,
 * for a drive synced here, the sync engine's own row (`sync_progress_snapshot`).
 */

/**
 * How long a finished card stays before it slides away. Hovering holds it
 * for as long as the pointer is on it, and leaving starts the full time
 * again, so reaching for a button never races the card.
 */
export const AUTO_HIDE_MS = 10_000;

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

/**
 * What this card has seen of its file in the sync engine's snapshots. The
 * engine drops a finished row from later snapshots, and on a busy drive it
 * can finish the file before the card is even told it is syncing (the share
 * link is minted first), so "done" is remembered rather than read off the
 * latest snapshot. Keyed by card id: a new capture starts over.
 *
 * Rust will own this outcome (it knows the file's relative path); until then
 * this keeps the card from sitting on "waiting for sync" for an uploaded file.
 */
export interface SyncWatch {
  cardId: number;
  /** The row has been in a snapshot, in flight. */
  seen: boolean;
  /** The row finished, or left the snapshots once the engine went quiet. */
  done: boolean;
}

export function watchSyncRow(
  prev: SyncWatch | null,
  card: CapturePreviewCard,
  snapshot: { files: readonly FileProgress[]; effectiveInProgress: boolean },
): SyncWatch {
  const start = prev && prev.cardId === card.id ? prev : { cardId: card.id, seen: false, done: false };
  if (start.done) return start;
  const row = snapshot.files.find((f) => sameFile(card, f));
  if (row?.status === "completed") return { ...start, seen: true, done: true };
  if (row) return start.seen ? start : { ...start, seen: true };
  // Seen in flight, now gone, and the engine has nothing left running: it finished.
  if (start.seen && !snapshot.effectiveInProgress) return { ...start, done: true };
  return start;
}

/** The upload row that belongs to this card, if the event is about it. */
function sameFile(card: CapturePreviewCard, row: { fileName: string; label: string } | null | undefined): boolean {
  return !!row && row.fileName === card.fileName && row.label === card.driveLabel;
}

export function cardView(
  card: CapturePreviewCard,
  remoteRow: RemoteUploadProgress | null,
  syncFiles: readonly FileProgress[],
  syncWatch: SyncWatch | null = null,
): CardView {
  const status = card.status;
  switch (status.state) {
    case "uploading": {
      const percent = sameFile(card, remoteRow) && remoteRow ? cappedPercent(remoteRow.bytesTransferred, remoteRow.totalBytes) : null;
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
      const watchedDone = syncWatch?.cardId === card.id && syncWatch.done;
      if (row?.status === "completed" || (watchedDone && row?.status !== "error")) {
        return { percent: 100, text: uploadedText(status.linkCopied), done: true, failed: false, linkCopied: status.linkCopied };
      }
      if (row?.status === "error") {
        return { percent: null, text: "Couldn't upload · the sync queue will retry", done: false, failed: true, linkCopied: status.linkCopied };
      }
      const percent = row ? cappedPercent(row.bytesTransferred, row.totalBytes) : null;
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

/** Where the file is going, on the card's own line under the status. */
export function destinationText(card: CapturePreviewCard): string {
  return `${card.driveName} › Captures`;
}

/** Retry applies only to a direct upload that failed; the sync queue retries its own. */
export function canRetry(card: CapturePreviewCard): boolean {
  return card.status.state === "failed";
}

/** Whether the card listens to upload progress: only while there is some to show. */
export function wantsProgress(card: CapturePreviewCard | null): boolean {
  return card?.status.state === "uploading" || card?.status.state === "syncing";
}
