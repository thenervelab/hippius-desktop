"use client";

// The Shared Drives page: every drive that is shared, and the only place
// shared drives are listed. One list, as the web console reads it: this
// account's own drives with people in them or links out (marked Owner),
// then the drives and folders other accounts invited it into. Quiet
// underline tabs narrow it to one kind ("Shared with you", "Shared by
// you") once anything is listed, and the total size and file count of what the
// list shows sit on the right of that row. Own drives are drawn by the Drive
// page's own folder list, and the others by "Shared with me"'s rows, so a
// drive looks and behaves the same here as everywhere else.
//
// Sharing starts from the page header's "Share a drive", which opens the
// picker of this account's own drives; its "New drive" makes a new drive on
// Hippius (no local folder) and goes straight on to sharing it. On a plan
// without sharing (Free, Starter) that button names the plan that includes
// it and goes to Settings > Billing instead, while drives shared WITH the
// account list and open as usual: joining is open on every plan.
//
// The list never claims more than it knows: skeleton rows until both kinds
// answer, an error with Try again when one could not be loaded (never "none
// shared"), and an empty state per tab that says what goes there.
//
// One dialog at a time throughout: the picker closes before the Share dialog
// opens. The Share dialog and Manage access
// are mounted for the whole app (`ResponsiveContent`), so this page only
// sets their atoms.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertCircle, UserPlus, Users } from "lucide-react";

import { Icons, Skeleton } from "@/components/ui";
import { Button } from "@/components/ui/button";
import UnderlineTabs from "@/components/ui/tabs/UnderlineTabs";
import { Pagination } from "@/components/ui/table";
import type { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import FolderList from "@/components/page-sections/drive/folder-list/FolderList";
import { toFolderRows, type FolderRow } from "@/components/page-sections/drive/folder-list/folderRows";
import { resolveFolderListPage } from "@/components/page-sections/drive/folder-list/folderListPaging";
import { sharingGate } from "@/components/page-sections/drive/share-dialog/shareDialogState";
import StorageStateList from "@/components/page-sections/drive/storage-stats";
import ShareDriveFlow from "@/components/page-sections/drive/share-drive-picker/ShareDriveFlow";
import { SharedWithMeSection } from "@/components/page-sections/settings/multi-folder-sync";
import FolderRowSkeleton from "@/components/page-sections/settings/multi-folder-sync/FolderRowSkeleton";
import { useDriveMemberships } from "@/components/page-sections/settings/multi-folder-sync/useDriveMemberships";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useOwnedDriveSharingState } from "@/app/lib/hooks/useOwnedDriveSharing";
import { useSharedDrivesInPlan } from "@/app/lib/hooks/useSharedDrivesInPlan";
import useIsOnline from "@/lib/hooks/useIsOnline";
import { BILLING_ROUTE } from "@/app/lib/routes";
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

import ShareADriveButton from "./ShareADriveButton";
import ShareADriveEmptyState, { SharedDrivesLoadError } from "./ShareADriveEmptyState";
import { TRY_AGAIN_LABEL, sharedDrivesPartialErrorLine } from "./sharedDrivesCopy";
import {
  SHARED_DRIVES_PAGE_SIZE,
  effectiveSharedDrivesFilter,
  folderGrantRoute,
  formatSharedDriveListTotals,
  joinedDriveRoute,
  ownDriveRoute,
  ownDriveRows,
  ownDriveStatRow,
  resolveSharedDrivesContent,
  sharedByMeRows,
  sharedByYouStatus,
  sharedDriveListTotals,
  sharedDrivesPageSlices,
  sharedDrivesTabCount,
  sharedWithYouStatus,
  showSharedDrivesTabs,
  type SharedKind,
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
  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  const openShareDialog = useSetAtom(shareDialogAtom);
  const openManageAccess = useSetAtom(shareDriveModalAtom);

  const [folders, setFolders] = useState<{ local: SyncFolder[]; remote: RemoteFolder[] }>({
    local: [],
    remote: [],
  });
  const [foldersLoading, setFoldersLoading] = useState(true);
  // The drive listing threw: "Shared by you" cannot answer, which is not
  // the same as having shared nothing.
  const [foldersFailed, setFoldersFailed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState<SharedDrivesFilter>("all");
  const [page, setPage] = useState(1);

  const loadFolders = useCallback(async () => {
    if (!polkadotAddress) {
      setFoldersLoading(false);
      return;
    }
    try {
      setFolders(await fetchSyncFoldersWithStats(polkadotAddress));
      setFoldersFailed(false);
    } catch (error) {
      console.error("Failed to load drives:", error);
      setFoldersFailed(true);
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
  const {
    byLabel: sharingByLabel,
    isPending: sharingPending,
    isError: sharingFailed,
    refetch: refetchSharing,
  } = useOwnedDriveSharingState(ownLabels);
  const sharedRows = useMemo(() => sharedByMeRows(rows, sharingByLabel), [rows, sharingByLabel]);
  const byYou: SharedKind = {
    status: sharedByYouStatus({
      foldersLoading,
      foldersFailed,
      ownDriveCount: ownLabels.length,
      sharingPending,
      sharingFailed,
      sharingAnswered: sharingByLabel.size,
    }),
    count: 0,
  };
  // Rows only from an answer: an unknown drive is never listed, and a kind
  // that failed lists nothing it cannot vouch for.
  byYou.count = byYou.status === "ready" ? sharedRows.length : 0;

  // Shared with you: drives (one fetch, handed to the rows below) and folders.
  const memberships = useDriveMemberships();
  const { grants: folderGrants, isSettled: grantsSettled, refetch: refetchGrants } = useMyFolderGrants();
  const joined = useMemo(
    () => (memberships.data.kind === "ready" ? memberships.data.memberships : []),
    [memberships.data],
  );
  const withYou: SharedKind = {
    status: SHARED_DRIVES_ENABLED
      ? sharedWithYouStatus({ memberships: memberships.data.kind, grantsSettled })
      : "ready",
    // Folder grants are rows of their own, shown even while the drive
    // memberships are still on their way (or failed), as the section
    // draws them.
    count: SHARED_DRIVES_ENABLED ? joined.length + folderGrants.length : 0,
  };
  const withYouCount = withYou.count;
  const byYouCount = byYou.count;

  const tabsShown = showSharedDrivesTabs({ byYou, withYou });
  const applied = effectiveSharedDrivesFilter(filter, tabsShown);
  const byYouShown = applied === "with-you" ? 0 : byYouCount;
  const withYouShown = applied === "by-you" ? 0 : withYouCount;

  // This account's plan decides whether it can share its own drives. It
  // never gates the drives shared with it: joining is open on every plan.
  const planAllows = useSharedDrivesInPlan();
  const gate = sharingGate({ planAllows, owner: true, refusedByServer: false });

  const content = resolveSharedDrivesContent({
    filter: applied,
    byYou,
    withYou,
    planKnown: gate !== "loading",
  });

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

  // One pager over the list, whatever the tab, only once the tab holds
  // more than a page.
  const pageView = resolveFolderListPage({
    total: byYouShown + withYouShown,
    page,
    pageSize: SHARED_DRIVES_PAGE_SIZE,
  });
  const slices = sharedDrivesPageSlices({
    byYou: byYouShown,
    withYou: withYouShown,
    start: pageView.start,
    end: pageView.end,
  });
  const pageRows = sharedRows.slice(slices.byYou.start, slices.byYou.end);

  // Leaving the last drive on the last page (or any drive going away)
  // leaves the page index past the end. The view is already clamped; this
  // keeps the state with it, so a drive coming back later does not jump
  // the list to a page nobody asked for.
  const shownPage = pageView.page;
  useEffect(() => {
    if (shownPage !== page) setPage(shownPage);
  }, [shownPage, page]);

  const changeFilter = (next: SharedDrivesFilter) => {
    setFilter(next);
    setPage(1);
  };

  // Ask again. The drive listing is reloaded only when it failed: reloading
  // it marks "Shared by you" loading, which would blank rows already on
  // screen while only the other half is being retried. The rest keep their
  // rows while they refetch.
  const retry = useCallback(() => {
    if (foldersFailed) {
      setFoldersLoading(true);
      void loadFolders();
    }
    refetchSharing();
    void memberships.reload();
    refetchGrants();
  }, [foldersFailed, loadFolders, refetchSharing, memberships, refetchGrants]);

  // Back online with a list that failed: load it again without a click.
  const online = useIsOnline();
  const anyFailed = byYou.status === "error" || withYou.status === "error";
  const wasOffline = useRef(!online);
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current) {
      wasOffline.current = false;
      if (anyFailed) retry();
    }
  }, [online, anyFailed, retry]);

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

  const openPicker = () => setPickerOpen(true);
  const upgrade = () => router.push(BILLING_ROUTE);
  const shareButton = <ShareADriveButton gate={gate} onShare={openPicker} onUpgrade={upgrade} />;

  // The totals add up the rows the tab shows, so they show only with rows:
  // over an empty tab's card (or a failed one) "0 B" says nothing the card
  // does not, and over a failed tab it would be wrong.
  const totalsShown = content.kind === "rows";
  const stats =
    byYou.status !== "loading" && withYou.status !== "loading" ? (
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
        {totalsShown && (
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
            trailing={totalsShown ? <div className="hidden @2xl:block">{stats}</div> : undefined}
            tabs={[
              { key: "all", label: "All", count: sharedDrivesTabCount([byYou, withYou]) },
              {
                key: "with-you",
                label: "Shared with you",
                shortLabel: "With you",
                count: sharedDrivesTabCount([withYou]),
              },
              { key: "by-you", label: "Shared by you", shortLabel: "By you", count: sharedDrivesTabCount([byYou]) },
            ]}
          />
        )}

        <div className="overflow-hidden rounded-[8px] border border-grey-dark-100 bg-white shadow-[0px_1px_1.1px_rgba(0,0,0,0.04)] dark:border-black-300 dark:bg-black-600">
          {content.kind === "empty" ? (
            <ShareADriveEmptyState
              scope={content.scope}
              canShare={gate === "allowed"}
              onShareDrive={openPicker}
              onUpgrade={upgrade}
            />
          ) : content.kind === "error" ? (
            <SharedDrivesLoadError scope={content.scope} offline={!online} onRetry={retry} />
          ) : content.kind === "loading" ? (
            <div aria-busy="true" aria-label="Loading shared drives">
              {[0, 1, 2, 3, 4].map((i) => (
                <FolderRowSkeleton key={i} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col [&>*+*]:border-t [&>*+*]:border-grey-dark-100 dark:[&>*+*]:border-black-300">
              {content.failed.length > 0 && (
                <div
                  role="alert"
                  data-testid="shared-drives-partial-error"
                  className="flex flex-col gap-2 bg-error-100/30 px-3 py-2.5 sm:flex-row sm:items-center dark:bg-error-30/10"
                >
                  <p className="flex min-w-0 flex-1 items-start gap-2 text-xs leading-5 text-grey-30 dark:text-grey-dark-700">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-error-70" aria-hidden />
                    <span className="min-w-0 break-words">{sharedDrivesPartialErrorLine(content.failed)}</span>
                  </p>
                  <Button
                    type="button"
                    variant="raised"
                    size="auto"
                    onClick={retry}
                    className="h-[28px] shrink-0 self-start rounded-[6px] px-3 text-xs font-medium sm:self-auto"
                  >
                    {TRY_AGAIN_LABEL}
                  </Button>
                </div>
              )}
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
              {content.pending && (
                <div aria-busy="true" aria-label="Loading shared drives">
                  <FolderRowSkeleton />
                  <FolderRowSkeleton />
                </div>
              )}
              {/* Only once the tab outgrows a page: a pager that can only
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
        />
      )}
    </>
  );
}
