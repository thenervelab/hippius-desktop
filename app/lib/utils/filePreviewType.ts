/**
 * The single classifier for in-app file previews.
 *
 * Every Drive surface (files table, expanded folder rows, card view, context
 * menus, sidebar search) asks this module two questions and nothing else:
 * "can this file be previewed?" and "which renderer body does it get?". Before
 * this existed each call site kept its own `fileType === "image" || ... ===
 * "video" || ... === "PDF"` triple, so adding a format meant editing six
 * places and any one of them could be missed.
 *
 * Classification is presentation-only logic and therefore lives in TypeScript.
 * Reading the bytes, enforcing them against the on-disk file and resolving
 * cloud-only files stays in Rust (`read_preview_bytes`, `cache_remote_file`).
 */

import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";

/** Every category the unified preview can render. */
export type PreviewType =
  | "image"
  | "video"
  | "PDF"
  | "markdown"
  | "html"
  | "text"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "json"
  | "svg";

// ---------------------------------------------------------------------------
// Byte caps
// ---------------------------------------------------------------------------

/**
 * Media (image/video/PDF) streams straight into a WebView element from disk,
 * so it never lands in a JS buffer and needs no cap of its own. The renderers
 * below all materialise the whole file in memory, so each carries a ceiling
 * sized to what its parser realistically has to hold.
 *
 * These are **plaintext** caps: they bound the decrypted bytes the renderer
 * receives, which for the OOXML formats is what a zip bomb would inflate to.
 * Rust re-checks the same number against the real file length so a renderer
 * cannot talk itself past the limit (see `read_preview_bytes`).
 */
/**
 * Markdown only. It is parsed into React **elements** on the main thread, one
 * node per token, so its cost and its peak memory scale with the token count
 * rather than the byte count. This is the tightest cap for that reason — do
 * not extend it to another format without checking that the format's renderer
 * does the same kind of work.
 */
export const MAX_MARKDOWN_PREVIEW_BYTES = 1024 * 1024;

/**
 * HTML. Deliberately far above Markdown's cap despite the two looking alike:
 * HTML is never walked token-by-token in React. It is decoded, sanitised with
 * the platform's own (native) parser, and handed to a sandboxed frame that
 * parses it natively too — the browser does the work in both steps.
 *
 * Sharing Markdown's 1 MiB was a real bug: an ordinary `index.html` refused to
 * open with "too large to preview" while the machinery that would have
 * rendered it was never reached. It mirrors the same fix in the console
 * (hippius-console#722), which measured peak resident memory on this path at
 * roughly 6-9x the file size — a 25 MiB file lands near 200 MB, which is fine
 * on desktop.
 */
export const MAX_HTML_PREVIEW_BYTES = 25 * 1024 * 1024;

/**
 * JSON. Re-serialised, then split into lines and rendered as one React element
 * per line plus a span per highlighted token — the same element-per-token cost
 * as Markdown, so it stays tight.
 */
export const MAX_STRUCTURED_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Plain text. The cheapest renderer here: decoded once and dropped into a
 * single `<pre>`, so the browser lays it out and React builds one node. Higher
 * than JSON for that reason, but below HTML's because the `<pre>` is not
 * virtualised, so the whole file is laid out at once.
 */
export const MAX_PLAIN_TEXT_PREVIEW_BYTES = 8 * 1024 * 1024;

export const MAX_SPREADSHEET_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_PREVIEW_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_PREVIEW_BYTES = 40 * 1024 * 1024;
/** SVG is sanitised, then base64-encoded into a `data:` URL, which inflates 4/3. */
export const MAX_SVG_PREVIEW_BYTES = 4 * 1024 * 1024;
/**
 * Ceiling for the types that stream rather than buffer. It is still finite so
 * `previewByteCap` is total and the Rust side always receives a real number.
 */
export const MAX_STREAMED_PREVIEW_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Mirror of `MAX_PREVIEW_READ_BYTES` in `src-tauri/src/media_preview.rs`.
 *
 * Rust clamps every read to that ceiling, so a per-format cap above it would
 * be silently unreachable: the file would be refused by Rust and reported as
 * "too large to preview" even though it sat inside its own format's cap —
 * exactly the failure this file's caps exist to prevent. Pinned by
 * `filePreviewType.test.ts` on this side and by `preview_read_limit`'s tests
 * on the Rust side.
 */
export const RUST_PREVIEW_READ_CEILING_BYTES = 64 * 1024 * 1024;

/** Per-type ceiling for inline preview, in plaintext bytes. */
export function previewByteCap(type: PreviewType): number {
  switch (type) {
    case "markdown":
      return MAX_MARKDOWN_PREVIEW_BYTES;
    case "html":
      return MAX_HTML_PREVIEW_BYTES;
    case "text":
      return MAX_PLAIN_TEXT_PREVIEW_BYTES;
    case "json":
      return MAX_STRUCTURED_TEXT_PREVIEW_BYTES;
    case "svg":
      return MAX_SVG_PREVIEW_BYTES;
    case "spreadsheet":
      return MAX_SPREADSHEET_PREVIEW_BYTES;
    case "document":
      return MAX_DOCUMENT_PREVIEW_BYTES;
    case "presentation":
      return MAX_PRESENTATION_PREVIEW_BYTES;
    default:
      return MAX_STREAMED_PREVIEW_BYTES;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Extensions that map to a renderer directly, ahead of any MIME hint.
 *
 * The extension wins on purpose: a `.docx` served as `text/html` must open the
 * Word renderer, never the HTML frame. `svg` is its own category rather than
 * an image because it is a script-capable document and only `SvgPreview`
 * renders it inertly.
 */
const PREVIEW_EXTENSIONS: Record<string, PreviewType> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  txt: "text",
  log: "text",
  docx: "document",
  xlsx: "spreadsheet",
  csv: "spreadsheet",
  pptx: "presentation",
  json: "json",
  svg: "svg",
};

/**
 * Legacy binary Office formats. They are NOT OOXML — no renderer here opens
 * them — so they are reported as recognised-but-unsupported and routed to the
 * download / system-viewer fallback rather than being mislabelled previewable.
 */
const LEGACY_OFFICE_EXTENSIONS = new Set(["doc", "xls", "ppt", "odt", "ods", "odp", "rtf"]);

/** Lower-cased extension of `filename`, or `""` when it has none. */
export function previewExtension(filename: string): string {
  if (!filename.includes(".")) return "";
  const { fileFormat } = getFilePartsFromFileName(filename);
  return fileFormat.toLowerCase();
}

/** True for `*.svg` in any casing — the one image-shaped script carrier. */
export function isSvgFilename(filename: string): boolean {
  return previewExtension(filename) === "svg";
}

/**
 * True for a legacy binary Office file (`.doc`, `.xls`, `.ppt`, OpenDocument).
 * Callers use it to explain *why* there is no preview instead of showing the
 * generic "unsupported file" state.
 */
export function isLegacyOfficeFilename(filename: string): boolean {
  return LEGACY_OFFICE_EXTENSIONS.has(previewExtension(filename));
}

/** A MIME header may carry parameters; guards compare its essence. */
export function mimeEssence(mime: string): string {
  return mime.split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * A MIME hint is only ever consulted when the filename gives us nothing
 * (no extension, or an extension we do not recognise). Script-capable
 * document MIMEs (`image/svg+xml`, `text/html`) still resolve to their
 * inert renderers, never to a raw image or a navigated frame.
 */
function previewTypeFromMime(mime: string): PreviewType | null {
  const essence = mimeEssence(mime);
  if (!essence) return null;
  if (essence === "image/svg+xml") return "svg";
  // Other `+xml` image types have no inert renderer here, so they are not
  // previewable rather than being handed to `<img>` on trust.
  if (essence.startsWith("image/") && !essence.endsWith("+xml")) return "image";
  if (essence.startsWith("video/")) return "video";
  if (essence === "application/pdf") return "PDF";
  if (essence === "text/markdown") return "markdown";
  if (essence === "text/html" || essence === "application/xhtml+xml") return "html";
  if (essence === "text/plain") return "text";
  if (essence === "text/csv") return "spreadsheet";
  if (essence === "application/json") return "json";
  if (essence === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return "document";
  }
  if (essence === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    return "spreadsheet";
  }
  if (essence === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return "presentation";
  }
  return null;
}

/**
 * Map a filename (and an optional MIME hint) to the renderer that opens it,
 * or `null` when nothing here can render it.
 *
 * Resolution order, and why:
 *  1. **Extension table** — the formats this module owns outright.
 *  2. **Legacy Office** — recognised, deliberately not previewable.
 *  3. **The existing icon/extension groups** for image/video/PDF, so the
 *     viewer keeps opening exactly the media it opened before.
 *  4. **MIME hint** — last, and only for names that told us nothing.
 */
export function derivePreviewType(
  filename: string,
  mime = "",
): PreviewType | null {
  const ext = previewExtension(filename);

  if (ext) {
    const byTable = PREVIEW_EXTENSIONS[ext];
    if (byTable) return byTable;
    if (LEGACY_OFFICE_EXTENSIONS.has(ext)) return null;

    const byGroup = getFileTypeFromExtension(ext);
    if (byGroup === "image" || byGroup === "video" || byGroup === "PDF") {
      return byGroup;
    }
    // A known-but-unpreviewable extension (`.zip`, `.py`, …) must not fall
    // through to a MIME hint that would contradict it.
    if (byGroup !== null) return null;
  }

  return previewTypeFromMime(mime);
}

/** Convenience predicate for the "does this row open a viewer?" call sites. */
export function isPreviewableFileName(filename: string, mime = ""): boolean {
  return derivePreviewType(filename, mime) !== null;
}

/**
 * True for the renderers that need the decrypted bytes in memory (via the
 * Rust `read_preview_bytes` IPC) rather than a URL the WebView streams.
 *
 * Image, video and PDF stay on the URL path so their existing behaviour —
 * HEIC conversion, Live Photo motion, the Linux PDF fallback — is untouched.
 */
export function previewNeedsBytes(type: PreviewType | null): boolean {
  return (
    type === "text" ||
    type === "json" ||
    type === "markdown" ||
    type === "html" ||
    type === "svg" ||
    type === "document" ||
    type === "spreadsheet" ||
    type === "presentation"
  );
}
