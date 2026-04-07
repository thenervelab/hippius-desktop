import { toast } from "sonner";

/**
 * Shape of an `AppError` returned by Tauri commands. The `kind` field
 * is a top-level discriminant ("NotReady", "Auth", etc.) and `message`
 * is the human-readable error from the Display impl. See
 * `src-tauri/src/error.rs::AppError::serialize`.
 */
interface TauriError {
  kind?: string;
  message?: string;
}

/**
 * Detect the `NotReady(SigningKeyUnavailable)` error and show a focused
 * "re-authenticate" toast with an action button instead of the generic
 * `${operation} failed: ${message}` toast.
 *
 * Returns `true` if the error was handled (the caller should NOT show
 * its own toast). Returns `false` for any other error so the caller
 * can fall through to its existing handling.
 *
 * Usage:
 * ```ts
 * try { await invoke("bond", ...); }
 * catch (err) {
 *   toast.dismiss(loadingToast);
 *   if (!dispatchSigningError(err, () => logout("/"))) {
 *     toast.error(`Staking failed: ${err instanceof Error ? err.message : "Unknown error"}`);
 *   }
 * }
 * ```
 */
export function dispatchSigningError(
  error: unknown,
  onReAuth: () => void
): boolean {
  const e = error as TauriError | null;
  if (
    e?.kind === "NotReady" &&
    typeof e.message === "string" &&
    e.message.includes("re-entering your seed phrase")
  ) {
    toast.error("Re-authentication required", {
      description:
        "This action needs your seed phrase. Log out and log back in to continue.",
      action: {
        label: "Re-authenticate",
        onClick: onReAuth,
      },
    });
    return true;
  }
  return false;
}
