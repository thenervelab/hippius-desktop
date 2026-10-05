// The held-delete notification's way back to its banner. "Decide later"
// hides a banner until its hold next changes; a hold that stands unchanged
// never brings it back on its own, so the episode's notification does. Rust
// writes the drive and side into the row's link
// (`notifications::credits::create_mass_delete_held_notification`); this
// reads them back and shows that banner again. Presentation only: the hold
// itself is Rust's.

import { appStore } from "@/lib/store/jotaiStore";
import { massDeleteHoldsAtom } from "@/lib/store/syncAtoms";
import { holdKey, updateHold } from "@/app/lib/massDelete/holds";
import type { MassDeleteSide, MassDeleteSidePayload } from "@/app/lib/tauri/massDelete";

/** The page a held-delete notification opens; the banners show above it. */
export const HELD_DELETE_PAGE = "/files";

function isSide(value: string | null): value is MassDeleteSide {
  return value === "server" || value === "local";
}

/** The drive and side a held-delete notification's link names, or `null`
 *  for any other link. */
export function heldDeleteFromLink(link: string): MassDeleteSidePayload | null {
  const queryStart = link.indexOf("?");
  if (queryStart < 0 || link.slice(0, queryStart) !== HELD_DELETE_PAGE) return null;
  const params = new URLSearchParams(link.slice(queryStart + 1));
  const side = params.get("heldDelete");
  const label = params.get("drive");
  if (!isSide(side) || !label) return null;
  return { label, side };
}

/** Show that side's banner again. Nothing to show once the hold has ended. */
export function showHeldDelete({ label, side }: MassDeleteSidePayload): void {
  appStore.set(massDeleteHoldsAtom, (prev) =>
    updateHold(prev, holdKey(label, side), { dismissed: false }),
  );
}
