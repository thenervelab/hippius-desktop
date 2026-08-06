/**
 * Decide whether an inbound OAuth deep link was already routed.
 *
 * The persisted marker used to be the RAW deep-link URL, which for a
 * direct-grant callback embeds the bearer token — keeping that token in
 * localStorage indefinitely (audit AUDIT_LOGIN_2026-08-06 S-1 /
 * RFC 6750 §2.3). Builds after the fix store the opaque, token-free
 * `dedupKey` that `parse_oauth_deep_link` computes in Rust (SHA-256 of
 * the URL) instead. The raw-URL comparison survives ONLY so a marker
 * written by a pre-fix build still recognizes its own link once after
 * an app update — otherwise the OS's initial-deep-link redelivery would
 * re-fire an old callback into `complete_oauth_flow`, which rejects it
 * (no pending flow) and strands the user on the error screen.
 */
export function isDeepLinkAlreadyProcessed(
  stored: string | null,
  url: string,
  dedupKey: string | null,
): boolean {
  if (!stored) return false;
  if (dedupKey !== null && stored === dedupKey) return true;
  // Legacy pre-fix marker: the raw URL itself.
  return stored === url;
}
