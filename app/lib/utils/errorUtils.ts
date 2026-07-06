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

/**
 * Is this invoke rejection the EXPECTED "no session yet" boot-gap failure?
 *
 * Account-scoped Rust commands authorize against the in-memory session, which
 * only `restore_session` populates. Callers that fire early (on mount, on a
 * pre-login interval, on `hippius_auth_ready`, during account transitions) can
 * reach Rust before that and get `AppError::Auth("No active account set")` /
 * `AppError::Auth("Requested account is not the active session account")` /
 * a `NotReady` kind — sometimes surfacing as a bare empty `{}` at the IPC
 * transport layer. These are transient and non-actionable: the call degrades
 * gracefully and the next post-hydration attempt succeeds. Logging them as
 * errors just spams the console / the Next.js dev "Issues" overlay with
 * non-failures. Use this to skip logging the expected case while still
 * surfacing genuine errors (DB, schema, real backend faults).
 */
export function isExpectedNoSessionError(e: unknown): boolean {
  if (e == null) return true;
  if (typeof e === "object") {
    const kind = (e as { kind?: unknown }).kind;
    if (kind === "Auth" || kind === "NotReady") return true;
    if (Object.keys(e as object).length === 0) return true;
  }
  const msg = errorMessage(e).toLowerCase();
  return (
    msg.includes("no active account") ||
    msg.includes("not the active session") ||
    msg.includes("not ready") ||
    msg.includes("no wallet") ||
    msg.includes("no session")
  );
}
