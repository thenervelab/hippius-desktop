import { toast } from "sonner";

/**
 * Shape of an `AppError` returned by Tauri commands. The `kind` field
 * is a top-level discriminant ("NotReady", "Auth", etc.) and `message`
 * is the human-readable error from the Display impl. See
 * `src-tauri/src/error.rs::AppError::serialize`.
 */
interface TauriError {
  kind?: string;
  /**
   * Structured discriminant for `NotReady` errors — the SCREAMING_SNAKE_CASE
   * name of the corresponding `NotReadyKind` variant (e.g.
   * `"MASTER_MNEMONIC_UNRECOVERABLE"`). See `src-tauri/src/error.rs`.
   * Absent for other `AppError` variants.
   */
  subkind?: string;
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
/**
 * Match a Tauri-serialized `AppError` against the structured
 * `{ kind: "NotReady", message: <substring> }` shape. Use this in catch
 * blocks instead of ad-hoc `err.message.includes(...)` checks — `err`
 * from `invoke()` failures is a plain object (not an `Error` instance),
 * so substring matching against `err.message` is brittle and easy to
 * get wrong.
 *
 * `messageSubstring` is matched case-insensitively against the Display
 * output of the corresponding `NotReadyKind` variant — e.g. pass
 * `"insufficient credits"` to detect `NotReadyKind::InsufficientCredits`.
 * Omit it (or pass `undefined`) to match any `NotReady` variant.
 */
export function isNotReady(
  error: unknown,
  messageSubstring?: string
): boolean {
  const e = error as TauriError | null;
  if (e?.kind !== "NotReady") return false;
  if (messageSubstring === undefined) return true;
  return (
    typeof e.message === "string" &&
    e.message.toLowerCase().includes(messageSubstring.toLowerCase())
  );
}

/**
 * Structural match against `NotReady(MasterMnemonicUnrecoverable)`.
 * Surfaced by `ensure_sync_mnemonic` when encrypted state exists but
 * the mnemonic can't be recovered (OS keychain evicted the entry, or
 * the mnemonic was never written on this device). Callers should flip
 * `syncRequiresReauthAtom` and let the reauth banner drive recovery.
 */
export function isMasterMnemonicUnrecoverable(error: unknown): boolean {
  return (error as TauriError | null)?.subkind === "MASTER_MNEMONIC_UNRECOVERABLE";
}

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
