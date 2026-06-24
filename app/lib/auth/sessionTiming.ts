// Pure session-timing helpers extracted from wallet-auth-context so the
// logout-chunking and OAuth-expiry parsing can be unit-tested without standing
// up the whole auth provider. Behavior is identical to the inline originals.

// setTimeout's delay is coerced to a signed 32-bit int; a value past i32::MAX
// (~24.8 days) overflows and the timer fires almost immediately — which for a
// logout timer would log the user out at once. Cap each timer at this bound and
// chain the remainder.
export const MAX_LOGOUT_DELAY_MS = 2_147_483_647;

/**
 * One tick of the logout schedule:
 * - `never`  → keep-logged-in (the caller arms no timer).
 * - `fire`   → final chunk; log out after `delayMs`.
 * - `chunk`  → wait `delayMs`, then re-schedule with `nextMs` remaining.
 *
 * A discriminated union (not a `{delayMs, shouldLogout}` bag) so the
 * keep-logged-in case can't be confused with a zero-delay logout.
 */
export type LogoutChunk =
  | { kind: "never" }
  | { kind: "fire"; delayMs: number }
  | { kind: "chunk"; delayMs: number; nextMs: number };

export function computeLogoutChunk(ms: number): LogoutChunk {
  if (ms === Infinity) return { kind: "never" };
  const delayMs = Math.min(Math.max(ms, 0), MAX_LOGOUT_DELAY_MS);
  if (ms > MAX_LOGOUT_DELAY_MS) {
    return { kind: "chunk", delayMs, nextMs: ms - MAX_LOGOUT_DELAY_MS };
  }
  return { kind: "fire", delayMs };
}

/**
 * Parse the OAuth expiry persisted in localStorage. It is written either as a
 * numeric epoch-ms string or an ISO-8601 date string, so a numeric value is
 * `parseInt`ed and anything else is fed to `Date`. Returns `null` for an
 * absent/empty value.
 *
 * NOTE: an unparseable date string yields `NaN` here (mirrors the original
 * inline behavior). The Rust `restore_session` it feeds treats `NaN`/null as
 * "no client expiry"; this is preserved deliberately, not fixed, to keep the
 * extraction behavior-identical.
 */
export function parseOAuthExpiryMs(storedExpiry: string | null): number | null {
  if (!storedExpiry) return null;
  return isNaN(Number(storedExpiry))
    ? new Date(storedExpiry).getTime()
    : parseInt(storedExpiry, 10);
}
