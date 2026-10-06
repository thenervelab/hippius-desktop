// The empty-drive notification's way back to its banner. "Keep my files"
// puts a banner away until its prompt next changes; a drive that stays on
// hold never brings it back on its own, so the episode's notification does.
// Rust writes the drive into the row's link
// (`notifications::credits::create_empty_remote_notification`); this reads
// it back and shows that banner again. Presentation only.

import { appStore } from "@/lib/store/jotaiStore";
import { emptyRemoteDrivesAtom } from "@/lib/store/syncAtoms";
import { updateDrive } from "@/app/lib/emptyRemote/drives";

/** The page an empty-drive notification opens; the banners show above it. */
export const EMPTY_REMOTE_PAGE = "/files";

/** The drive an empty-drive notification's link names, or `null` for any
 *  other link. */
export function emptyRemoteFromLink(link: string): string | null {
  const queryStart = link.indexOf("?");
  if (queryStart < 0 || link.slice(0, queryStart) !== EMPTY_REMOTE_PAGE) return null;
  const params = new URLSearchParams(link.slice(queryStart + 1));
  if (!params.has("emptyDrive")) return null;
  return params.get("drive") || null;
}

/** Show that drive's banner again. Nothing to show once the prompt ended. */
export function showEmptyRemote(label: string): void {
  appStore.set(emptyRemoteDrivesAtom, (prev) => updateDrive(prev, label, { dismissed: false }));
}

/** When `link` is an empty-drive notification's, show its banner again and
 *  return `true`; any other link is left alone. */
export function revealEmptyRemote(link: string | undefined): boolean {
  const label = link ? emptyRemoteFromLink(link) : null;
  if (!label) return false;
  showEmptyRemote(label);
  return true;
}
