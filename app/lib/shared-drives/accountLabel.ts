/**
 * Display label for an account in shared-drive UI.
 *
 * Name when HCFS sent one (hcfs #455); shortened ss58 otherwise. Every
 * surface that names a person — Shared by, members list, remove confirm,
 * Created by on links, File Details — should go through this so they cannot
 * disagree about what someone is called.
 */

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
