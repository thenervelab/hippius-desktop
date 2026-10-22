"use client";

// The Shared Drives page: every drive that is shared, and the only place
// shared drives are listed. Two cards, as the console reads it: "Shared by
// Me" (this account's own drives with people in them or links out, marked
// Owner) and "Shared with Me" (the drives and folders other accounts invited
// it into). Drives are drawn by the Drive page's own folder list, so a drive
// looks and behaves the same in either place.
//
// Sharing starts here. "Share a drive" opens the picker of this account's own
// drives; its "Sync a Folder" makes a new drive and goes straight on to
// sharing it.
// One dialog at a time throughout: the picker closes before the folder
// dialog opens, and the folder dialog has closed before the Share dialog
// opens. The Share dialog and Manage access are mounted for the whole app
// (`ResponsiveContent`), so this page only sets their atoms.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAtomValue, useSetAtom } from "jotai";
import { UserPlus, Users } from "lucide-react";

import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import NoEntriesFound from "@/components/ui/NoEntriesFound";
import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import FolderList from "@/components/page-sections/drive/folder-list/FolderList";
import { toFolderRows, type FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import ShareDriveFlow from "@/components/page-sections/drive/share-drive-picker/ShareDriveFlow";
import { SharedWithMeSection } from "@/components/page-sections/settings/multi-folder-sync";
import { AddLocalFolderDialog } from "@/components/page-sections/settings/AddLocalFolderDialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";
import { useOwnedDriveSharingState } from "@/app/lib/hooks/useOwnedDriveSharing";
import { fetchSyncFoldersWithStats } from "@/app/lib/tauri/syncFolders";
import { shareDialogAtom, shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { RemoteFolder, SyncFolder } from "@/app/lib/types/sync-folder";

import ShareADriveEmptyState, { SHARE_A_DRIVE_LABEL } from "./ShareADriveEmptyState";
import {
  folderGrantRoute,
  joinedDriveRoute,
  ownDriveRoute,
  ownDriveRows,
  sharedByMeLoading,
  sharedByMeRows,
} from "./sharedDrivesState";

export const SHARED_BY_ME_LABEL = "Shared by Me";
export const SHARED_WITH_ME_LABEL = "Shared with Me";
export const SHARED_WITH_ME_EMPTY_TITLE = "Nothing shared with you yet";
export const SHARED_WITH_ME_EMPTY_LINE = "When somebody invites you into a drive or a folder, it appears here.";

const HEADER_BUTTON = "h-[26px] gap-1.5 rounded-[6px] px-2.5 text-[12px] font-medium";

export default function SharedDrivesView() {
  const router = useRouter();
  const { polkadotAddress } = useWalletAuth();
  const { requireUploadRoom } = useCreditCheck();
  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  const openShareDialog = useSetAtom(shareDialogAtom);
  const openManageAccess = useSetAtom(shareDriveModalAtom);

  const [folders, setFolders] = useState<{ local: SyncFolder[]; remote: RemoteFolder[] }>({
    local: [],
    remote: [],
  });
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addingDrive, setAddingDrive] = useState(false);
  // A drive made from "Share a drive", waiting for the folder dialog to
  // close before its Share dialog opens.
  const [shareWhenAdded, setShareWhenAdded] = useState<string | null>(null);

  const loadFolders = useCallback(async () => {
    if (!polkadotAddress) {
      setFoldersLoading(false);
      return;
    }
    try {
      setFolders(await fetchSyncFoldersWithStats(polkadotAddress));
    } catch (error) {
      console.error("Failed to load drives:", error);
    } finally {
      setFoldersLoading(false);
    }
  }, [polkadotAddress]);

  useEffect(() => {
    void loadFolders();
  }, [loadFolders]);

  // Drives added or removed elsewhere (Settings, the Drive page).
  useEffect(() => {
    if (syncPathRefreshTrigger > 0) void loadFolders();
  }, [syncPathRefreshTrigger, loadFolders]);

  const rows = useMemo(() => toFolderRows(folders.local, folders.remote), [folders]);
  const ownLabels = useMemo(() => ownDriveRows(rows).map((r) => r.folderName), [rows]);
  const { byLabel: sharingByLabel, isPending: sharingPending } = useOwnedDriveSharingState(ownLabels);
  const sharedRows = useMemo(() => sharedByMeRows(rows, sharingByLabel), [rows, sharingByLabel]);

  useEffect(() => {
    if (addingDrive || !shareWhenAdded) return;
    openShareDialog({ label: shareWhenAdded, folderName: shareWhenAdded });
    setShareWhenAdded(null);
  }, [addingDrive, shareWhenAdded, openShareDialog]);

  // The Drive page's Sync a Folder: the storage gate first, then the dialog.
  const startNewDrive = async () => {
    if (!(await requireUploadRoom("folder-sync", false))) return;
    setAddingDrive(true);
  };

  const shareDrive = (row: FolderRow) =>
    openShareDialog({ label: row.folderName, folderName: row.folderName });
  const manageAccess = (row: FolderRow) =>
    openManageAccess({ label: row.folderName, folderName: row.folderName });

  const buildActions = (row: FolderRow): ActionItem[] => [
    {
      icon: <Icons.FolderOpen className="size-4" />,
      itemTitle: "Open",
      onItemClick: () => router.push(ownDriveRoute(row)),
    },
    {
      icon: <UserPlus className="size-4" />,
      itemTitle: "Share drive…",
      onItemClick: () => shareDrive(row),
    },
    {
      icon: <Users className="size-4" />,
      itemTitle: "Manage access",
      onItemClick: () => manageAccess(row),
    },
  ];

  return (
    <>
      <div className="flex w-full flex-col gap-3 px-3">
        <FolderList
          label={SHARED_BY_ME_LABEL}
          rows={sharedRows}
          isLoading={sharedByMeLoading({ foldersLoading, sharingPending })}
          sharingByLabel={sharingByLabel}
          markOwned
          onManageAccess={manageAccess}
          onOpenRow={(row) => router.push(ownDriveRoute(row))}
          buildActions={buildActions}
          headerAction={
            <Button
              variant="primary"
              size="auto"
              onClick={() => setPickerOpen(true)}
              className={HEADER_BUTTON}
            >
              <UserPlus className="size-3.5" />
              {SHARE_A_DRIVE_LABEL}
            </Button>
          }
          emptyState={<ShareADriveEmptyState onShareDrive={() => setPickerOpen(true)} />}
        />

        <SharedWithMeSection
          label={SHARED_WITH_ME_LABEL}
          alwaysShow
          onOpenDrive={(identity) => router.push(joinedDriveRoute(identity))}
          onOpenFolderGrant={(grant) => router.push(folderGrantRoute(grant))}
          onManageAccess={openManageAccess}
          onDriveAdded={() => void loadFolders()}
          emptyState={
            <NoEntriesFound
              title={SHARED_WITH_ME_EMPTY_TITLE}
              description={SHARED_WITH_ME_EMPTY_LINE}
              cardView={false}
              className="bg-transparent px-3 py-6 dark:bg-transparent"
            />
          }
        />
      </div>

      {pickerOpen && (
        <ShareDriveFlow
          drives={ownLabels}
          sharingByLabel={sharingByLabel}
          loading={foldersLoading}
          onClose={() => setPickerOpen(false)}
          onAddDrive={() => void startNewDrive()}
        />
      )}
      <AddLocalFolderDialog
        open={addingDrive}
        onClose={() => setAddingDrive(false)}
        onSuccess={(newLabel) => {
          void loadFolders();
          if (newLabel) setShareWhenAdded(newLabel);
        }}
      />
    </>
  );
}
