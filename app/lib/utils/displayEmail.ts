/**
 * Which emails the UI may show.
 *
 * Accounts that sign in with an access key or a wallet are given a system
 * placeholder email on the server (`user_...@hippius.local`). It is not an
 * address anyone can write to, so it is never shown. Rust drops it from
 * every command that returns an email for display
 * (`src-tauri/src/utils/display_email.rs`); this copy guards an email that
 * reaches the UI another way, such as an older session hint. The shared
 * fixture `src-tauri/tests/fixtures/display_email_cases.json` pins the two
 * rules together.
 */

/** The domain the server gives placeholder emails. */
export const PLACEHOLDER_EMAIL_DOMAIN = "hippius.local";

/** True for an address whose domain is exactly `hippius.local`, any case. */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return false;
  return trimmed.slice(at + 1).toLowerCase() === PLACEHOLDER_EMAIL_DOMAIN;
}

/**
 * An email as the UI may show it: trimmed, and `undefined` when blank or a
 * placeholder, so the surface falls back as it does with no email at all.
 */
export function displayEmail(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || isPlaceholderEmail(trimmed)) return undefined;
  return trimmed;
}
