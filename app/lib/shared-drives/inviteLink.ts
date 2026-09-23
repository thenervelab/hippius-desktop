/**
 * Display helpers for invite links. The full URL (including `#k=`) is a
 * drive-access capability — copy carries it; the UI never renders the
 * fragment.
 */

/**
 * Origin, path, and the first few characters of the token — never the
 * `#k=` fragment, and never enough of the token to be usable.
 *
 * Truncation is not only cosmetic. The fragment is the drive key, so a
 * panel that rendered the whole link would put drive-access key material
 * on screen, in screenshots, and in screen shares.
 */
export function truncateInviteUrl(url: string, shown = 8): string {
  const [withoutFragment = ""] = url.split("#");
  const cut = withoutFragment.lastIndexOf("/");
  if (cut < 0) return `${withoutFragment.slice(0, shown)}…`;

  const base = withoutFragment.slice(0, cut + 1);
  const token = withoutFragment.slice(cut + 1);
  if (token.length <= shown) return `${base}${token}…`;
  return `${base}${token.slice(0, shown)}…`;
}
