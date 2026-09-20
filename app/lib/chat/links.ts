/**
 * `matrix.to` permalinks: what a link in a message points at.
 *
 * The app's own "Copy link" produces `https://matrix.to/#/<room>/<event>`
 * with both segments percent-encoded (`!abc%3Aserver/%24evt`), which is
 * also what matrix.to itself and Element emit for anything they encode.
 * Other clients paste the sigils raw (`!abc:server/$evt`). Both forms are
 * the same link and must route the same way, so the parser decodes each
 * path segment before it reads the sigil. Matching the raw href (as the
 * click handler did before) let the app's own permalinks fall through to
 * the webview's default navigation instead of jumping to the message.
 */

export type MatrixToLink =
  /** `@user:server` — a mention. */
  | { kind: "user"; userId: string }
  /** `!id:server` or `#alias:server` with no event. */
  | { kind: "room"; roomId: string }
  /** `<room>/$event` — a message permalink. `roomId` may be an alias. */
  | { kind: "event"; roomId: string; eventId: string };

const MATRIX_TO_PREFIX = /^https:\/\/matrix\.to\/#\/(.+)$/i;

/**
 * Parse a `matrix.to` href, or `null` when it is not one (or is one this
 * app cannot act on). Query parameters (`?via=…`) are ignored; a segment
 * with malformed percent-encoding fails the whole parse rather than being
 * read raw.
 */
export function parseMatrixToLink(href: string): MatrixToLink | null {
  const match = MATRIX_TO_PREFIX.exec(href.trim());
  if (!match) return null;
  const path = match[1].split("?")[0];
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  const [first, second] = segments;
  if (!first || segments.length > 2) return null;

  if (first.startsWith("@")) {
    return segments.length === 1 ? { kind: "user", userId: first } : null;
  }
  if (first.startsWith("!") || first.startsWith("#")) {
    if (second === undefined) return { kind: "room", roomId: first };
    return second.startsWith("$") ? { kind: "event", roomId: first, eventId: second } : null;
  }
  return null;
}
