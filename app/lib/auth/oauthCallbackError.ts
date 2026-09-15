import { errorMessage } from "@/lib/utils/errorUtils";

/**
 * Shown when the rejection carries nothing we can put in front of a user.
 * Deliberately the only place this generic sentence still exists.
 */
export const OAUTH_CALLBACK_FALLBACK_MESSAGE =
  "Failed to complete authentication. Please try again.";

/**
 * Values `errorMessage` can hand back that are technically strings but say
 * nothing — an empty IPC rejection (`{}` at the transport layer, see
 * `isExpectedNoSessionError`) stringifies to `"[object Object]"`, and a
 * `null`/`undefined` rejection to its own name.
 */
const USELESS = new Set(["", "{}", "[object Object]", "undefined", "null"]);

/**
 * User-facing text for a failed OAuth callback.
 *
 * The callback page used to read `err instanceof Error ? err.message : <generic>`.
 * `invoke()` rejects with the SERIALIZED `AppError` — a plain `{ kind, message }`
 * object (see `impl Serialize for AppError`), never an `Error` — so that test was
 * always false and every distinct cause (expired sign-in, provider rejection,
 * failed code exchange, missing account address) collapsed into one generic
 * sentence. Users reported a screenshot we could not diagnose from.
 *
 * Rust owns the wording of these messages; this only unwraps them, and falls
 * back to the generic line when there is genuinely nothing to show.
 */
export function oauthCallbackErrorMessage(error: unknown): string {
  const message = errorMessage(error).trim();
  return USELESS.has(message) ? OAUTH_CALLBACK_FALLBACK_MESSAGE : message;
}
