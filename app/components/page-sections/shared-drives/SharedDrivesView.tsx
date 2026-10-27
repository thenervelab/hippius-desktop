"use client";

// The Shared Drives page: every drive that is shared, and the only place
// shared drives are listed. One list, as the web console reads it: this
// account's own drives with people in them or links out (marked Owner),
// then the drives and folders other accounts invited it into. Quiet
// underline tabs narrow it to one kind ("Shared with you", "Shared by
// you") when there are both, and the total size and file count of what the
// list shows sit on the right of that row. Own drives are drawn by the Drive
// page's own folder list, and the others by "Shared with me"'s rows, so a
// drive looks and behaves the same here as everywhere else.
//
// Sharing starts from the page header's "Share a drive", which opens the
// picker of this account's own drives; its "New drive" makes a new drive
// and goes straight on to sharing it. One dialog at a time throughout: the
// picker closes before the folder dialog opens, and the folder dialog has
// closed before the Share dialog opens. The Share dialog and Manage access
// are mounted for the whole app (`ResponsiveContent`), so this page only
// sets their atoms.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAtomValue, useSetAtom } from "jotai";
import { Plus, UserPlus, Users } from "lucide-react";

import { Icons, Skeleton } from "@/components/ui";
import { Button } from "@/components/ui/button";
import UnderlineTabs from "@/components/ui/tabs/UnderlineTabs";
import { Pagination } from "@/components/ui/table";
import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import FolderList from "@/components/page-sections/drive/folder-list/FolderList";
import { toFolderRows, type FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import {
  FOLDER_LIST_PAGE_SIZE,
  resolveFolderListPage,
} from "@/components/page-sections/drive/folder-list/folderListPaging";
import StorageStateList from "@/components/page-sections/drive/storage-stats";
import ShareDriveFlow from "@/components/page-sections/drive/share-drive-picker/ShareDriveFlow";
import { SharedWithMeSection } from "@/components/page-sections/settings/multi-folder-sync";
import FolderRowSkeleton from "@/components/page-sections/settings/multi-folder-sync/FolderRowSkeleton";
import { getSharedWithMeView } from "@/components/page-sections/settings/multi-folder-sync/sharedWithMeState";
import { useDriveMemberships } from "@/components/page-sections/settings/multi-folder-sync/useDriveMemberships";
import { AddLocalFolderDialog } from "@/components/page-sections/settings/AddLocalFolderDialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useCreditCheck } from "@/lib/hooks/useCreditCheck";
import { useOwnedDriveSharingState } from "@/app/lib/hooks/useOwnedDriveSharing";
import { sharedDriveStatsKey, useSharedDriveStats } from "@/app/lib/hooks/useSharedDriveStats";
import { useMyFolderGrants } from "@/app/lib/hooks/useSharedDriveRoles";
import { useFolderGrantStatsList } from "@/app/lib/hooks/useFolderGrantStats";
import { SHARED_DRIVES_ENABLED } from "@/app/lib/featureFlags";
import { fetchSyncFoldersWithStats } from "@/app/lib/tauri/syncFolders";
import { shareDialogAtom, shareDriveModalAtom } from "@/app/lib/global-atoms/sharesAtoms";
import { triggerSyncPathRefreshAtom } from "@/app/lib/global-atoms/unpinAtoms";
import type { RemoteFolder, SyncFolder } from "@/app/lib/types/sync-folder";
import { formatBytes } from "@/lib/utils/formatBytes";
import { cn } from "@/lib/utils";

import ShareADriveEmptyState, { SHARE_A_DRIVE_LABEL } from "./ShareADriveEmptyState";
import {
  effectiveSharedDrivesFilter,
  folderGrantRoute,
  formatSharedDriveListTotals,
  joinedDriveRoute,
  ownDriveRoute,
  ownDriveRows,
  ownDriveStatRow,
  sharedByMeLoading,
  sharedByMeRows,
  sharedDriveListTotals,
  sharedDrivesPageSlices,
  showSharedDrivesTabs,
  type SharedDriveStatRow,
  type SharedDrivesFilter,
} from "./sharedDrivesState";

export const SHARED_DRIVES_TABS_LABEL = "Filter shared drives";
export const TOTAL_SIZE_LABEL = "Total size:";

export interface SharedDrivesViewProps {
  /**
   * Draws the page header with the page's actions ("Share a drive") on its
   * right. The page passes its `PageHeader`; without it the actions render
   * on their own row.
   */
  renderHeader?: (_actions: React.ReactNode) => React.ReactNode;
}

export default function SharedDrivesView({ renderHeader }: SharedDrivesViewProps = {}) {
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
  const [filter, setFilter] = useState<SharedDrivesFilter>("all");
  const [page, setPage] = useState(1);

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

  // Shared by you: own drives shared as a whole.
  const rows = useMemo(() => toFolderRows(folders.local, folders.remote), [folders]);
  const ownLabels = useMemo(() => ownDriveRows(rows).map((r) => r.folderName), [rows]);
  const { byLabel: sharingByLabel, isPending: sharingPending } = useOwnedDriveSharingState(ownLabels);
  const sharedRows = useMemo(() => sharedByMeRows(rows, sharingByLabel), [rows, sharingByLabel]);
  const byYouLoading = sharedByMeLoading({ foldersLoading, sharingPending });

  // Shared with you: drives (one fetch, handed to the rows below) and folders.
  const memberships = useDriveMemberships();
  const { grants: folderGrants, isSettled: grantsSettled } = useMyFolderGrants();
  const withYouView = getSharedWithMeView(SHARED_DRIVES_ENABLED, memberships.data, folderGrants.length, {
    alwaysShow: true,
    grantsSettled,
  });
  const joined = useMemo(
    () => (memberships.data.kind === "ready" ? memberships.data.memberships : []),
    [memberships.data],
  );
  const withYouLoading = withYouView === "loading";
  const withYouCount = withYouView === "rows" ? joined.length + folderGrants.length : 0;
  const byYouCount = byYouLoading ? 0 : sharedRows.length;

  const counts = { withYou: withYouCount, byYou: byYouCount };
  const tabsShown = showSharedDrivesTabs(counts);
  const applied = effectiveSharedDrivesFilter(filter, counts);
  const byYouShown = applied === "with-you" ? 0 : byYouCount;
  const withYouShown = applied === "by-you" ? 0 : withYouCount;

  // The figures over the list add up the drives it shows: your own from the
  // drive listing, the rest from their owners' listings. A drive nobody
  // could size is left out, never counted as zero.
  const joinedStats = useSharedDriveStats(useMemo(() => joined.map((m) => m.ownerSs58), [joined]));
  const grantStats = useFolderGrantStatsList(folderGrants);
  const totals = useMemo(() => {
    const statRows: SharedDriveStatRow[] = [];
    if (applied !== "with-you") statRows.push(...sharedRows.map(ownDriveStatRow));
    if (applied !== "by-you" && withYouCount > 0) {
      for (const m of joined) {
        const s = joinedStats.get(sharedDriveStatsKey(m));
        statRows.push({ hasStats: Boolean(s), totalBytes: s?.totalBytes ?? 0, fileCount: s?.fileCount ?? 0 });
      }
      for (const g of grantStats) {
        statRows.push(
          g.kind === "ready"
            ? { hasStats: true, totalBytes: g.stats.totalBytes, fileCount: g.stats.fileCount }
            : { hasStats: false, totalBytes: 0, fileCount: 0 },
        );
      }
    }
    return formatSharedDriveListTotals(sharedDriveListTotals(statRows), formatBytes);
  }, [applied, sharedRows, withYouCount, joined, joinedStats, grantStats]);

  // One pager over the list, whatever the tab.
  const pageView = resolveFolderListPage({
    total: byYouShown + withYouShown,
    page,
    pageSize: FOLDER_LIST_PAGE_SIZE,
  });
  const slices = sharedDrivesPageSlices({
    byYou: byYouShown,
    withYou: withYouShown,
    start: pageView.start,
    end: pageView.end,
  });
  const pageRows = sharedRows.slice(slices.byYou.start, slices.byYou.end);

  const changeFilter = (next: SharedDrivesFilter) => {
    setFilter(next);
    setPage(1);
  };

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

  const shareButton = (
    <Button
      type="button"
      variant="primary"
      size="sm"
      onClick={() => setPickerOpen(true)}
      className="gap-1.5 px-3.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-primary-brand-dark dark:focus-visible:ring-offset-black-primary-bg"
    >
      <Plus className="size-4" aria-hidden />
      {SHARE_A_DRIVE_LABEL}
    </Button>
  );

  // Nothing is claimed until both kinds have answered: an early empty list
  // would say "nothing shared" over drives still on their way.
  const settled = !byYouLoading && !withYouLoading;
  const empty = settled && byYouCount === 0 && withYouCount === 0;
  const anyRows = byYouCount + withYouCount > 0;
  // A kind still loading under rows already shown gets placeholder rows of
  // its own, unless the tab leaves it out.
  const pendingRows =
    (byYouLoading && applied !== "with-you") || (withYouLoading && applied !== "by-you");

  const stats = settled ? (
    <StorageStateList storageLabel={TOTAL_SIZE_LABEL} storageUsed={totals.size} numberOfFiles={totals.files} />
  ) : (
    <Skeleton width={180} height={12} className="rounded" />
  );

  return (
    <>
      {renderHeader ? (
        renderHeader(shareButton)
      ) : (
        <div className="flex justify-end px-3 py-3">{shareButton}</div>
      )}

      <div className="flex w-full flex-col gap-2 px-3 pb-6">
        {/* The totals take a line of their own above the tabs in a narrow
            column, and the right end of the tabs row from @2xl. Without
            tabs there is nothing to share a row with, so they keep this
            line at every width. */}
        {!empty && (
          <div
            data-testid="shared-drives-totals"
            className={cn("flex min-h-5 items-center", tabsShown ? "@2xl:hidden" : "@2xl:justify-end")}
          >
            {stats}
          </div>
        )}
        {tabsShown && (
          <UnderlineTabs
            ariaLabel={SHARED_DRIVES_TABS_LABEL}
            value={applied}
            onChange={changeFilter}
            trailing={<div className="hidden @2xl:block">{stats}</div>}
            tabs={[
              { key: "all", label: "All", count: withYouCount + byYouCount },
              { key: "with-you", label: "Shared with you", shortLabel: "With you", count: withYouCount },
              { key: "by-you", label: "Shared by you", shortLabel: "By you", count: byYouCount },
            ]}
          />
        )}

        <div className="overflow-hidden rounded-[8px] border border-grey-dark-100 bg-white shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)] dark:border-black-300 dark:bg-black-600">
          {empty ? (
            <ShareADriveEmptyState onShareDrive={() => setPickerOpen(true)} />
          ) : !anyRows ? (
            <div aria-busy="true" aria-label="Loading shared drives">
              {[0, 1, 2, 3, 4].map((i) => (
                <FolderRowSkeleton key={i} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col [&>*+*]:border-t [&>*+*]:border-grey-dark-100 dark:[&>*+*]:border-black-300">
              {pageRows.length > 0 && (
                <FolderList
                  bare
                  rows={pageRows}
                  sharingByLabel={sharingByLabel}
                  markOwned
                  onManageAccess={manageAccess}
                  onOpenRow={(row) => router.push(ownDriveRoute(row))}
                  buildActions={buildActions}
                />
              )}
              <SharedWithMeSection
                variant="rows"
                alwaysShow
                memberships={memberships}
                slice={slices.withYou}
                onOpenDrive={(identity) => router.push(joinedDriveRoute(identity))}
                onOpenFolderGrant={(grant) => router.push(folderGrantRoute(grant))}
                onManageAccess={openManageAccess}
                onDriveAdded={() => void loadFolders()}
              />
              {pendingRows && (
                <div aria-busy="true" aria-label="Loading shared drives">
                  <FolderRowSkeleton />
                  <FolderRowSkeleton />
                </div>
              )}
              {/* Only once the list outgrows a page: a pager that can only
                  say "1 of 1" is a control with nothing to do. */}
              {pageView.showPager && (
                <div className="px-3 py-3">
                  <Pagination currentPage={pageView.page} totalPages={pageView.totalPages} setPage={setPage} />
                </div>
              )}
            </div>
          )}
        </div>
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
