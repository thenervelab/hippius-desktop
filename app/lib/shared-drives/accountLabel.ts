/**
 * Display label for an account in shared-drive UI.
 *
 * Name when HCFS sent one (hcfs #455); shortened ss58 otherwise. Every
 * surface that names a person — Shared by, members list, remove confirm,
 * Created by on links, File Details — should go through this so they cannot
 * disagree about what someone is called.
 */

import { displayEmail } from "@/lib/utils/displayEmail";
import { middleTruncate } from "@/lib/utils/middleTruncate";

/** Keep a real display string; drop blank/whitespace (console `presentText`). */
export function presentText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Words for an account in running text: the name when known, otherwise a
 * middle-truncated ss58 (desktop's existing address ellipsis).
 */
export function accountDisplayName(
  ss58: string,
  name?: string | null,
  maxChars = 22,
): string {
  return presentText(name) ?? middleTruncate(ss58, maxChars);
}

/** What one account label shows, and what its hover adds. */
export interface AccountLabelView {
  /** The visible words: the name, or the shortened ss58. */
  label: string;
  /** True when `label` is a real name (the ss58 fallback is set in mono). */
  isName: boolean;
  /** The full address, always: it is the identity, the name is not. */
  ss58: string;
  /** The email, when the server disclosed one to this reader. */
  email?: string;
}

/**
 * Project an account into its label and tooltip.
 *
 * The ss58 stays the identity everywhere (filters, dedup, keys); the name and
 * email are presentation only, and an absent key means "unknown", never an
 * empty string on screen. Every surface that names a person renders through
 * `AccountLabel`, which reads this, so no two screens call someone different
 * things.
 */
export function accountLabelView(
  ss58: string,
  name?: string | null,
  email?: string | null,
  maxChars = 22,
): AccountLabelView {
  const presentName = presentText(name);
  // A system placeholder (`@hippius.local`) is never shown.
  const presentEmail = displayEmail(email);
  return {
    label: presentName ?? middleTruncate(ss58, maxChars),
    isName: presentName !== undefined,
    ss58,
    ...(presentEmail ? { email: presentEmail } : {}),
  };
}
