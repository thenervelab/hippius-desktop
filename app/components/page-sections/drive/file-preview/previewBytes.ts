/**
 * The renderer's side of the `read_preview_bytes` IPC, plus the pure pieces of
 * the load lifecycle every preview body shares.
 *
 * Rust owns the read: path validation against the account's sync roots and the
 * preview cache, the byte cap, and the "too large" copy. Nothing here decides
 * whether a file may be read — it only asks, cancels, and turns a rejection
 * into something the viewer can show.
 */

import { invoke } from "@tauri-apps/api/core";

/** Structured Tauri error shape (`AppError`'s custom `Serialize`). */
interface StructuredIpcError {
  kind: string;
  message: string;
}

function isStructuredIpcError(value: unknown): value is StructuredIpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StructuredIpcError).kind === "string" &&
    typeof (value as StructuredIpcError).message === "string"
  );
}

/**
 * Message to show for a failed preview load.
 *
 * Matches on the structured `{ kind, message }` shape rather than sniffing
 * substrings of `err.message` — the per-kind copy (over-cap, unreadable path)
 * is written in Rust and passed through verbatim, so the two sides cannot
 * drift.
 */
export function previewErrorMessage(reason: unknown): string {
  if (isStructuredIpcError(reason)) return reason.message;
  if (typeof reason === "string" && reason) return reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return "This file could not be previewed.";
}

/** True for a rejection caused by our own cancellation, which is not an error. */
export function isAbortReason(reason: unknown): boolean {
  return (
    reason instanceof DOMException && reason.name === "AbortError"
  ) || (reason instanceof Error && reason.name === "AbortError");
}

export function abortError(): DOMException {
  return new DOMException("Preview cancelled", "AbortError");
}

/**
 * Read a previewable file's plaintext bytes through Rust.
 *
 * `maxBytes` is the renderer's per-format cap; Rust clamps it to its own hard
 * ceiling and rejects the read when the file is bigger, so an over-cap file
 * never reaches a parser. The returned buffer is a fresh copy owned by the
 * caller.
 *
 * Cancellation is cooperative: the IPC itself cannot be interrupted, so an
 * aborted read still completes in Rust but its bytes are dropped here rather
 * than being handed to a renderer whose file is no longer on screen.
 */
export async function readPreviewBytes(
  localPath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) throw abortError();
  const buffer = await invoke<ArrayBuffer>("read_preview_bytes", {
    sourcePath: localPath,
    maxBytes,
  });
  if (signal.aborted) throw abortError();
  return new Uint8Array(buffer);
}
