// Jotai atoms for the file-sharing feature.
//
// We keep these split out from `unpinAtoms.ts` because the share
// lifecycle is independent of sync drive state — old code paths
// shouldn't accidentally couple to the share UI.

import { atom } from "jotai";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import type { ServerCapabilities } from "@/app/lib/tauri/shares";

/**
 * Cached server capabilities. Populated once after login by
 * `useServerCapabilities` and refreshed on reconnect; `null` means
 * "not yet known" — consumers should treat that as "hide the feature
 * until we know" rather than "feature available".
 */
export const serverCapabilitiesAtom = atom<ServerCapabilities | null>(null);

/**
 * Derived: should the share UI surfaces (context-menu item, "My Shares"
 * page link) render at all? `false` until the capability fetch resolves
 * with `shares: true`, so a stale frontend pointed at an old hcfs-server
 * never offers a share button that would 404.
 */
export const shareFeatureEnabledAtom = atom((get) => {
  const caps = get(serverCapabilitiesAtom);
  return caps?.shares === true;
});

/**
 * Open `ShareFileModal` for this file. `null` means closed.
 *
 * Storing the file (rather than just `(label, name)`) lets the modal
 * render `<filename>` while the share is in flight without a second
 * IPC round-trip to fetch metadata.
 */
export const shareModalFileAtom = atom<FormattedUserFile | null>(null);
