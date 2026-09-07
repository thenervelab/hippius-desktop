// Pure split for the remote-folder cards — the sidebarSearchState
// convention. Unit-tested in `__tests__/remoteFoldersState.test.ts`.
//
// Rust owns the bucket (`RemoteFolderOrigin`). The FE only renders:
// comparing `deviceName` to this machine's name here would reintroduce
// H-077 the moment the two copies drifted.

import type { RemoteFolder } from "@/app/lib/types/sync-folder";

export const OTHER_DEVICE_SECTION_LABEL = "Sync from Other Devices";
export const LOCALLY_REMOVED_SECTION_LABEL = "Not synced on this computer";

export function partitionRemoteFolders(folders: RemoteFolder[]): {
  locallyRemoved: RemoteFolder[];
  otherDevice: RemoteFolder[];
} {
  const locallyRemoved: RemoteFolder[] = [];
  const otherDevice: RemoteFolder[] = [];
  for (const folder of folders) {
    if (folder.origin?.kind === "locallyRemoved") {
      locallyRemoved.push(folder);
    } else {
      otherDevice.push(folder);
    }
  }
  return { locallyRemoved, otherDevice };
}

/**
 * Other-devices stays visible while loading (the skeleton lives there)
 * and when it has rows — or when there is nothing remote at all, so the
 * original empty copy still has a home. The locally-removed card is
 * hidden until it has rows; an empty "not synced here" headline would
 * read as a standing status rather than a way back.
 */
export function remoteFolderSectionVisibility(
  isLoading: boolean,
  locallyRemovedCount: number,
  otherDeviceCount: number,
): { otherDevice: boolean; locallyRemoved: boolean } {
  if (isLoading) {
    return { otherDevice: true, locallyRemoved: false };
  }
  return {
    otherDevice: otherDeviceCount > 0 || locallyRemovedCount === 0,
    locallyRemoved: locallyRemovedCount > 0,
  };
}
