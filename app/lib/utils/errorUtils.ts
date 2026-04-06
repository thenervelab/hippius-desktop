/**
 * Extract a human-readable message from a Tauri invoke error.
 *
 * Handles both bare strings (legacy) and structured { kind, message }
 * objects (AppError returned by Rust commands).
 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
