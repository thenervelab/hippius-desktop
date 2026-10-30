// The Insights panel's link field and capture preview, decided without the
// DOM so the rules are tested on their own: which link the panel may show and
// copy, and where a picture of the capture can come from.

import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ShareSummary } from "@/app/lib/tauri/shares";

/**
 * What the panel can do with its link.
 *
 * The full link, with the key in its `#k=` or `#p=` part, is the listing's
 * `shareUrl`: Rust rebuilds it from this computer's keystore or, for a link
 * made in the browser, the extension or on another computer, from the owner
 * wrap, which needs the account's recovery phrase. While Hippius is locked on
 * this computer (`syncRequiresReauthAtom`) the wraps cannot be opened, so
 * unlocking can bring the key back; otherwise the key is not here at all (an
 * older link made elsewhere, or a password link made elsewhere).
 */
export type PanelLink =
  | { kind: "loading" }
  | { kind: "ready"; url: string; needsPassword: boolean }
  | { kind: "locked" }
  | { kind: "unavailable" };

export function panelLink(
  summary: Pick<ShareSummary, "shareUrl" | "isPrivate"> | null,
  locked: boolean,
): PanelLink {
  if (!summary) return { kind: "loading" };
  if (summary.shareUrl) return { kind: "ready", url: summary.shareUrl, needsPassword: summary.isPrivate === true };
  return locked ? { kind: "locked" } : { kind: "unavailable" };
}

/** Stands in for everything that opens a link. */
export const HIDDEN_DOTS = "••••••••••••";

/**
 * The link as the field shows it until the owner asks for all of it: the
 * site, then dots. Never the token or the key, which together open the file,
 * so a screenshot or recording of the panel does not hand the link out.
 */
export function maskedLink(url: string | null): string {
  if (url) {
    try {
      return `${new URL(url).host}/${HIDDEN_DOTS}`;
    } catch {
      // Not a URL Rust would build: show nothing of it.
    }
  }
  return HIDDEN_DOTS;
}

export const COPY_LINK = "Copy link";
export const LINK_COPIED = "Link copied";
export const COPY_FAILED = "Couldn't copy the link.";
export const SHOW_LINK = "Show full link";
export const HIDE_LINK = "Hide full link";
export const UNLOCK_TO_COPY = "Unlock to copy";
export const LINK_LOCKED_NOTE = "Unlock Hippius on this computer to see and copy this link.";
export const LINK_UNAVAILABLE_NOTE =
  "This link was made somewhere else and its key isn't on this computer, so it can't be copied here.";
export const LINK_NEEDS_PASSWORD = "People also need the link's password to open it.";
export const SHOW_PREVIEW = "Show preview";
export const HIDE_PREVIEW = "Hide preview";
export const OPEN_CAPTURE = "Open in your default app";

/** The kinds of capture the panel shows a picture of. */
export type CaptureMediaKind = "image" | "video";

const VIDEO = /\.(mp4|mov|m4v|webm)$/i;
// Only formats the app's WebView draws in an <img> on every platform: HEIC
// needs a conversion the panel does not run.
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function captureMediaKind(fileName: string): CaptureMediaKind | null {
  if (VIDEO.test(fileName)) return "video";
  if (IMAGE.test(fileName)) return "image";
  return null;
}

/** Where a file the panel names lives in a drive synced here. */
export type DriveLocation = { label: string; relativePath: string };

/**
 * Where the panel gets a picture of the capture from, cheapest first:
 *
 *  - `disk`: the opener handed a file that is on this computer.
 *  - `resolve`: the panel knows the capture's drive and path (the link was
 *    made here, or a row of this computer's upload feed), so Rust says where
 *    it is on disk (`resolve_drive_file_source`, which refuses a path outside
 *    the drive). Nothing is downloaded.
 *  - `cloudThumb`: a screenshot that is only on the server: the Files grid's
 *    thumbnailer downloads and decrypts it, keeps a small picture and drops
 *    the full copy. A recording only on the server gets no picture, so the
 *    panel never downloads a whole video to show a frame.
 *  - `none`: the file-type tile, as before.
 *
 * Locked, only `disk` is offered: that is what the header showed before, and
 * everything else needs the app unlocked.
 */
export type MediaPlan =
  | { kind: "none" }
  | { kind: "disk" }
  | { kind: "resolve"; location: DriveLocation }
  | { kind: "cloudThumb" };

export function planPanelMedia({
  mediaKind,
  file,
  onDisk,
  location,
  unlocked,
}: {
  mediaKind: CaptureMediaKind | null;
  file?: Pick<FormattedUserFile, "fileId" | "label" | "actualFileName" | "source">;
  /** The file has a plaintext copy at its `source` on this computer. */
  onDisk: boolean;
  location: DriveLocation | null;
  unlocked: boolean;
}): MediaPlan {
  if (!mediaKind) return { kind: "none" };
  if (file && onDisk) return { kind: "disk" };
  if (!unlocked) return { kind: "none" };
  if (file?.fileId) return mediaKind === "image" ? { kind: "cloudThumb" } : { kind: "none" };
  if (file && !file.source && file.label && file.actualFileName) {
    return { kind: "resolve", location: { label: file.label, relativePath: file.actualFileName } };
  }
  if (location) return { kind: "resolve", location };
  return { kind: "none" };
}

/** A link's drive and path from the listing, when this computer made it. */
export function locationOf(summary: Pick<ShareSummary, "folderLabel" | "relativePath"> | null): DriveLocation | null {
  if (!summary?.folderLabel || !summary.relativePath) return null;
  return { label: summary.folderLabel, relativePath: summary.relativePath };
}
