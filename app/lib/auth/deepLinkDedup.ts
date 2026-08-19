/**
 * How long a processed-callback marker stays authoritative.
 *
 * Long enough to absorb every legitimate redelivery of the SAME link
 * (macOS re-sends the launching deep link on each activation of the
 * singleton app, and remounts re-run `getCurrent()`), and comfortably
 * past the backend's 5-minute OAuth-state TTL — so within this window a
 * suppressed duplicate could never have completed anyway. Anything
 * older is stale: the marker used to latch FOREVER, so a user
 * re-clicking the console's "Open Hippius" button after a failed
 * attempt was silently ignored for the life of the install (audit M-4).
 */
export const DEEP_LINK_DEDUP_TTL_MS = 10 * 60 * 1000;

/**
 * Decide whether an inbound OAuth deep link was already routed.
 *
 * The persisted marker used to be the RAW deep-link URL, which for a
 * direct-grant callback embeds the bearer token — keeping that token in
 * localStorage indefinitely (audit AUDIT_LOGIN_2026-08-06 S-1 /
 * RFC 6750 §2.3). Current builds store the opaque, token-free
 * `dedupKey` that `parse_oauth_deep_link` computes in Rust (SHA-256 of
 * the URL) instead. The raw-URL comparison survives ONLY so a marker
 * written by a pre-fix build still recognizes its own link once after
 * an app update — otherwise the OS's initial-deep-link redelivery would
 * re-fire an old callback into `complete_oauth_flow`, which rejects it
 * (no pending flow) and strands the user on the error screen.
 *
 * `storedAtMs` is the marker's write time; a marker older than
 * [`DEEP_LINK_DEDUP_TTL_MS`] (or with no recorded time) no longer
 * suppresses anything.
 */
export function isDeepLinkAlreadyProcessed(
  stored: string | null,
  storedAtMs: number | null,
  nowMs: number,
  url: string,
  dedupKey: string | null,
): boolean {
  if (!stored) return false;
  if (
    storedAtMs === null ||
    Number.isNaN(storedAtMs) ||
    nowMs - storedAtMs > DEEP_LINK_DEDUP_TTL_MS
  ) {
    return false;
  }
  if (dedupKey !== null && stored === dedupKey) return true;
  // Legacy pre-fix marker: the raw URL itself.
  return stored === url;
}
