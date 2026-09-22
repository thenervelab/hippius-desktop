/**
 * Sending a GIF from the picker.
 *
 * A picked GIF becomes an ordinary encrypted attachment, never a link: Rust
 * downloads the bytes from the provider's CDN (`chat_gif_download` — https
 * only, size-capped while streaming), the webview wraps them in a `File` and
 * they go through the same upload path as a dropped file (AES-CTR in
 * encrypted rooms, still thumbnail alongside). The recipient only ever talks
 * to the homeserver; the event never carries a provider URL.
 *
 * The event's `body` is the filename (`<slug>.gif`), the same as `filename`.
 * Per the spec, `body` is a caption only when it differs from `filename`, so
 * the timeline shows the GIF alone, no title above it (as Slack / Discord
 * do). The provider title only survives as the slug; `m.image` has no field
 * for it and we do not invent one.
 *
 * Rendition choice: the GIF itself as `m.image` (`image/gif`) when it fits
 * the cap; when it does not but the provider has a silent MP4 that fits, that
 * goes out as `m.video` flagged `GIF_CONTENT_FLAG` so the timeline treats it
 * like a GIF (muted, looping, no controls). Otherwise the send is refused
 * with a clear message.
 */

import type { MatrixClient, Room } from "matrix-js-sdk";

import { GIF_CONTENT_FLAG, formatFileSize } from "@/lib/chat/attachments";
import { type SendFileOptions, sendFile } from "@/lib/chat/compose";
import type { GifResult } from "@/lib/chat/gifs-api";
import { chatGifDownload } from "@/lib/tauri/chat";
import { errorMessage } from "@/lib/utils/errorUtils";

/** Mirrors Rust's `GIF_MAX_BYTES`. */
export const GIF_MAX_BYTES = 8 * 1024 * 1024;
/** Longest edge of the still thumbnail generated for a GIF. */
export const GIF_THUMBNAIL_EDGE = 320;
export { GIF_CONTENT_FLAG };

export type GifRendition =
  | { kind: "gif"; url: string; size: number }
  | { kind: "mp4"; url: string; size: number };

/** Pick what to send, from the provider's reported sizes. Throws over the cap. */
export function chooseRendition(
  gif: GifResult,
  cap = GIF_MAX_BYTES,
): GifRendition {
  const gifSize = gif.full.size;
  if (gifSize > 0 && gifSize <= cap)
    return { kind: "gif", url: gif.full.url, size: gifSize };
  if (gif.mp4 && gif.mp4.size > 0 && gif.mp4.size <= cap)
    return { kind: "mp4", url: gif.mp4.url, size: gif.mp4.size };
  if (gifSize === 0) return { kind: "gif", url: gif.full.url, size: 0 }; // unknown size: Rust enforces the cap while streaming
  throw new Error(tooLargeMessage(cap));
}

export function tooLargeMessage(cap = GIF_MAX_BYTES): string {
  return `This GIF is too large to send (limit ${formatFileSize(cap)})`;
}

/** Safe, short filename from a GIF title. */
export function gifFileName(title: string, ext: "gif" | "mp4"): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "gif"}.${ext}`;
}

/** Fetch bytes from the provider's CDN — through Rust, never the webview. */
export type GifDownloader = (url: string, cap: number) => Promise<ArrayBuffer>;

const rustDownloader: GifDownloader = (url, cap) => chatGifDownload(url, cap);

/**
 * One rendition's bytes as a Blob. An invoke rejection is an `AppError`
 * object, not an `Error`; it is rewrapped so the caller's `.message` works.
 */
async function download(
  url: string,
  cap: number,
  downloader: GifDownloader,
  signal?: AbortSignal,
): Promise<Blob> {
  if (signal?.aborted) throw new Error("Cancelled");
  let bytes: ArrayBuffer;
  try {
    bytes = await downloader(url, cap);
  } catch (error) {
    throw error instanceof Error ? error : new Error(errorMessage(error));
  }
  if (signal?.aborted) throw new Error("Cancelled");
  // Rust already refused anything over the cap; this is the belt for a
  // downloader that did not (tests, a future non-Rust path).
  if (bytes.byteLength > cap) throw new Error(tooLargeMessage(cap));
  return new Blob([bytes]);
}

/**
 * First frame of an animated image as a JPEG, drawn on a canvas. Browser
 * only; resolves `null` where there is no DOM or decoding fails, in which
 * case the attachment simply has no still thumbnail.
 */
export async function stillFrame(
  blob: Blob,
  maxEdge = GIF_THUMBNAIL_EDGE,
): Promise<File | null> {
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function"
  )
    return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = objectUrl;
    });
    const scale = Math.min(
      1,
      maxEdge / Math.max(image.naturalWidth, image.naturalHeight, 1),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82),
    );
    return jpeg
      ? new File([jpeg], "thumbnail.jpg", { type: "image/jpeg" })
      : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export interface SendGifOptions extends Pick<
  SendFileOptions,
  "threadRootId" | "onProgress" | "abort"
> {
  cap?: number;
  /** Injected for tests; defaults to the Rust `chat_gif_download` command. */
  downloader?: GifDownloader;
  /** Injected for tests / environments without a canvas. */
  thumbnailer?: typeof stillFrame;
}

/**
 * Download the chosen rendition, wrap it as a File, and send it through the
 * regular attachment path. The event never contains a provider URL.
 */
export async function sendGif(
  client: MatrixClient,
  room: Room,
  gif: GifResult,
  opts: SendGifOptions = {},
): Promise<void> {
  const cap = opts.cap ?? GIF_MAX_BYTES;
  const downloader = opts.downloader ?? rustDownloader;
  const thumbnailer = opts.thumbnailer ?? stillFrame;
  const rendition = chooseRendition(gif, cap);
  const signal = opts.abort?.signal;
  const title = gif.title.trim() || "GIF";
  const dimensions =
    gif.full.width && gif.full.height
      ? { w: gif.full.width, h: gif.full.height }
      : null;

  if (rendition.kind === "gif") {
    const bytes = await download(rendition.url, cap, downloader, signal);
    const file = new File([bytes], gifFileName(title, "gif"), {
      type: "image/gif",
    });
    const thumbnail = await thumbnailer(file);
    await sendFile(client, room, file, {
      threadRootId: opts.threadRootId,
      onProgress: opts.onProgress,
      abort: opts.abort,
      // Unknown provider dimensions: let `sendFile` decode the file.
      dimensions: dimensions ?? undefined,
      thumbnail,
    });
    return;
  }

  // Oversized GIF, MP4 fits: the poster comes from the small preview GIF so
  // the recipient still sees a frame before (or instead of) playback.
  const [video, previewBytes] = await Promise.all([
    download(rendition.url, cap, downloader, signal),
    download(gif.preview.url, cap, downloader, signal).catch(() => null),
  ]);
  const file = new File([video], gifFileName(title, "mp4"), {
    type: "video/mp4",
  });
  const thumbnail = previewBytes ? await thumbnailer(previewBytes) : null;
  await sendFile(client, room, file, {
    threadRootId: opts.threadRootId,
    onProgress: opts.onProgress,
    abort: opts.abort,
    dimensions,
    thumbnail,
    extraContent: { [GIF_CONTENT_FLAG]: true },
  });
}
