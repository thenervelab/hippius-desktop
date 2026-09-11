/**
 * Clicking a sidebar item you are already on.
 *
 * Next's `<Link>` to the current route does not remount the page, so a
 * page that holds its own view state cannot see the click. The Drive page
 * holds which folder is open, so "Drive" did nothing from inside a folder.
 *
 * The signal is a nonce rather than a flag because two clicks in a row
 * must both register, and because the consumer has to be able to tell a
 * new click from a re-render carrying the same value.
 */
export interface NavReclick {
  href: string;
  nonce: number;
}

/** The next signal value for a click on `href`. */
export function nextReclick(prev: NavReclick | null, href: string): NavReclick {
  // Monotonic across hrefs, not per-href: the consumer compares against
  // the last nonce it handled, and a per-href counter could hand it a
  // value it has already seen after the user visits two items.
  return { href, nonce: (prev?.nonce ?? 0) + 1 };
}

/**
 * Whether a consumer watching `href` should act on this signal.
 *
 * `lastHandled` is the nonce it acted on last. Without that comparison the
 * effect re-runs on every unrelated re-render and yanks the user back to
 * the root while they are navigating.
 */
export function shouldHandleReclick(
  signal: NavReclick | null,
  href: string,
  lastHandled: number,
): boolean {
  if (!signal) return false;
  if (signal.href !== href) return false;
  return signal.nonce !== lastHandled;
}
