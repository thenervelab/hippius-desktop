import type { CapturePreviewCard } from "@/app/lib/tauri/capture";
import type { RemoteUploadProgress } from "@/app/lib/remote-upload/remoteUploadFeed";
import type { FileProgress } from "@/app/lib/types/syncSnapshot";
import { cappedPercent } from "@/app/lib/upload-feed/percent";

/**
 * What the capture card says, decided without React so it can be tested.
 *
 * Rust owns what happened (`capture::preview`): the status, including a
 * synced capture's move from `syncing` to `uploaded` or `failed` (Rust
 * follows the sync engine's row by the file's path), the line about the link
 * and which buttons apply. This only draws the percent of an upload in
 * flight, joined on the row's path, and never decides from a progress row
 * that a capture is done or failed: a percent row that says "completed" still
 * shows 99% until Rust says `uploaded`.
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
  /** Rust says the card is finished (in the drive, link settled): it may slide away. */
  settled: boolean;
  failed: boolean;
  /**
   * Not uploaded because nobody has said where captures go yet. Still a
   * `failed` status to Rust (the file is kept and Retry asks for the folder),
   * but the card waits instead of alarming: no red, and "Choose folder".
   */
  waiting: boolean;
  /**
   * A recording held at the free plan's limit: not uploaded and no link, with
   * Upgrade and Delete as the ways out. Neither a failure (no red) nor done.
   */
  held: boolean;
}

/**
 * `path` is this card's file: the drive-relative `Captures/<name>`, or a local
 * path ending in it. Compared in NFC, as Rust does (`same_drive_path`): a name
 * macOS wrote decomposed ("e" plus an accent) is the same name.
 */
function sameFile(card: CapturePreviewCard, row: { path: string; label: string } | null | undefined): boolean {
  if (!row || row.label !== card.driveLabel) return false;
  const path = row.path.replace(/\\/g, "/").normalize("NFC");
  const rel = card.relPath.normalize("NFC");
  return path === rel || path.endsWith(`/${rel}`);
}

export function cardView(
  card: CapturePreviewCard,
  remoteRow: RemoteUploadProgress | null,
  syncFiles: readonly FileProgress[],
): CardView {
  const status = card.status;
  switch (status.state) {
    case "uploading": {
      const percent = remoteRow && sameFile(card, remoteRow) ? cappedPercent(remoteRow.bytesTransferred, remoteRow.totalBytes) : null;
      return {
        percent,
        text: percent === null ? "Preparing upload…" : `Uploading · ${percent}%`,
        done: false,
        settled: false,
        failed: false,
        waiting: false,
        held: false,
      };
    }
    case "syncing": {
      const row = syncFiles.find((f) => sameFile(card, f));
      const percent = row ? cappedPercent(row.bytesTransferred, row.totalBytes) : null;
      return {
        percent,
        text: percent === null ? "Saved · waiting for sync" : `Uploading · ${percent}%`,
        done: false,
        settled: false,
        failed: false,
        waiting: false,
        held: false,
      };
    }
    case "uploaded":
      return {
        percent: 100,
        text: joinLink("Uploaded", card.linkText),
        done: true,
        settled: card.settled ?? true,
        failed: false,
        waiting: false,
        held: false,
      };
    case "failed":
      return status.reason === "needsFolder"
        ? { percent: null, text: "Waiting for a folder", done: false, settled: false, failed: true, waiting: true, held: false }
        : { percent: null, text: "Couldn't upload", done: false, settled: false, failed: true, waiting: false, held: false };
    case "held":
      return { percent: null, text: "Not uploaded", done: false, settled: false, failed: false, waiting: false, held: true };
  }
}

/** The status line with Rust's sentence about the link after it, when there is one. */
function joinLink(status: string, linkText: string | undefined): string {
  return linkText ? `${status} · ${linkText}` : status;
}

/** Where the file is going, on the card's own line under the status. */
export function destinationText(card: CapturePreviewCard): string {
  return `${card.driveName} › Captures`;
}

/** Whether the card listens to upload progress: only while there is some to show. */
export function wantsProgress(card: CapturePreviewCard | null): boolean {
  return card?.status.state === "uploading" || card?.status.state === "syncing";
}
