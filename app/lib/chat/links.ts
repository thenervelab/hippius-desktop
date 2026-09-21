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

const MATRIX_URI_PREFIX = /^matrix:(?:\/\/[^/]*\/)?(.+)$/i;

/** MSC2312 path types → the sigil the id is written with elsewhere. */
const MATRIX_URI_SIGILS: Record<string, string> = { u: "@", r: "#", roomid: "!", e: "$" };

/**
 * Parse a `matrix:` URI (MSC2312: `matrix:u/bob:server`,
 * `matrix:r/general:server`, `matrix:roomid/abc:server/e/evt`), or `null`
 * when it is not one this app can act on. The sanitiser lets these hrefs
 * through as internal navigation (no `target="_blank"`), so they must be
 * routed like `matrix.to` links or the webview navigates the app window to
 * them. Ids are percent-decoded; the query (`?via=…`, `?action=…`) is ignored.
 */
export function parseMatrixUri(href: string): MatrixToLink | null {
  const match = MATRIX_URI_PREFIX.exec(href.trim());
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
  // Pairs of (type, id); sigils are implied by the type in this form.
  if (segments.length !== 2 && segments.length !== 4) return null;
  const sigil = (type: string, id: string): string | null => {
    const s = MATRIX_URI_SIGILS[type.toLowerCase()];
    return s && id ? `${s}${id}` : null;
  };
  const first = sigil(segments[0], segments[1]);
  if (!first) return null;
  if (segments.length === 2) {
    if (first.startsWith("@")) return { kind: "user", userId: first };
    if (first.startsWith("$")) return null;
    return { kind: "room", roomId: first };
  }
  if (first.startsWith("@") || first.startsWith("$")) return null;
  const second = sigil(segments[2], segments[3]);
  return second?.startsWith("$") ? { kind: "event", roomId: first, eventId: second } : null;
}

/**
 * Whatever internal-navigation link an anchor carries — `matrix.to` or a
 * `matrix:` URI — or `null` for anything else (an ordinary web link, which
 * keeps its default action).
 */
export function parseMatrixLink(href: string): MatrixToLink | null {
  return parseMatrixToLink(href) ?? parseMatrixUri(href);
}
