"use client";

// The Starred page: every file, folder and drive this account starred, in
// every drive it can read (its own, drives shared with it, granted folders).
//
// The list is the Drive's own view (`DriveContent`: the files table and the
// card grid), so a starred row looks, expands, collapses, previews and acts
// exactly as it does in the Drive, in list and card view. A starred drive is
// a row for the whole drive (`isDriveRoot`), which expands to its root.
//
// A folder or drive opens right here, as a drive opens on Shared Drives: the
// URL names it (`?openLabel=…`, `DriveRoute.folderHref`), and the page then
// hosts the Drive's container for that drive with "Starred" as the trail's
// first crumb, so Back from the drive's root comes back to the list.
//
// Rust lists the stars and resolves every drive (`list_starred`). The list
// is searched by name here and sorted by the table, until the server can
// search it (hcfs#1452).
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Star } from "lucide-react";

import PageHeader from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { RefreshButton, SearchInput } from "@/components/ui";
import DriveContainer from "@/components/page-sections/drive/DriveContainer";
import DriveContent from "@/components/page-sections/drive/DriveContent";
import { isDriveOpenInUrl } from "@/components/page-sections/drive/driveTrail";
import ViewModeToggle, { type ViewMode } from "@/components/page-sections/drive/ViewModeToggle";
import { DriveRouteContext, type DriveRoute } from "@/components/page-sections/drive/driveRoute";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import type { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useStarredListing, useStars } from "@/app/lib/starred/useStars";
import { driveStatusesAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { STARRED_ROUTE } from "@/app/lib/routes";
import { getViewModePreference, saveViewModePreference } from "@/app/lib/utils/userPreferencesDb";
import { cn } from "@/lib/utils";

import { arrangeStarredItems, starredFolderHref, starredItemRow, starredOpenNames } from "./starredRows";

export const STARRED_TITLE = "Starred";
export const STARRED_SUBTITLE = "Files, folders and drives you starred";
export const STARRED_EMPTY_TITLE = "No starred items yet";
export const STARRED_EMPTY_NOTE = "Star files, folders and drives to find them here.";
export const STARRED_ERROR = "Couldn't load Starred.";
export const STARRED_UNAVAILABLE = "Starred isn't available yet";

/** The Drive page's outer card (`DriveHeader`), around its top line and the rows. */
const OUTER_CARD = cn(
  "w-full flex flex-col items-stretch mb-2.5 overflow-hidden",
  "bg-grey-light-300 border border-grey-dark-100 rounded-[8px]",
  "shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.04)]",
  "dark:bg-black-primary-bg dark:border-black-300",
  "dark:shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.4)]",
);

/** The Drive page's inner white card, around the rows. */
const INNER_CARD = cn(
  "w-full flex flex-col",
  "bg-white border-t border-grey-dark-100 rounded-[8px]",
  "dark:bg-black-primary-bg dark:border-black-300",
);

const noopLoadMore = () => {};

/** A drive opened from the list, on this page: the trail starts at "Starred" and leads back here. */
const STARRED_DRIVE_ROUTE: DriveRoute = {
  basePath: STARRED_ROUTE,
  pinned: null,
  parent: { label: STARRED_TITLE, href: STARRED_ROUTE },
};

export default function StarredView() {
  const { getParam } = useUrlParams();
  return isDriveOpenInUrl(getParam) ? <StarredDriveView /> : <StarredList />;
}

/** A starred folder or drive, opened right here in the Drive's own container. */
function StarredDriveView() {
  // A file's details belong to the drive they were opened in.
  const setFileDetails = useSetAtom(fileDetailsPanelAtom);
  useEffect(() => () => setFileDetails(null), [setFileDetails]);
  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader hideStats title={STARRED_TITLE} subtitle={STARRED_SUBTITLE} className="!shadow-none" />
      <DriveRouteContext.Provider value={STARRED_DRIVE_ROUTE}>
        <DriveContainer />
      </DriveRouteContext.Provider>
    </div>
  );
}

/** Everything starred, in the Drive's own list and card views. */
function StarredList() {
  const { isItemStarred } = useStars();
  const listing = useStarredListing();
  const driveStatuses = useAtomValue(driveStatusesAtom);

  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  // The Drive's list-or-cards choice, so both pages open the same way.
  useEffect(() => {
    let cancelled = false;
    void getViewModePreference().then((mode) => {
      if (!cancelled) setViewMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const changeViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    void saveViewModePreference(mode);
  }, []);

  // An item unstarred here leaves the list at once; the next listing agrees.
  const starred = useMemo(
    () => (listing.data?.items ?? []).filter((item) => isItemStarred(item)),
    [listing.data, isItemStarred],
  );
  // Drives, then folders, then files, by name: the cards' order, and the
  // table's until a column header sorts it.
  const rows: FormattedUserFile[] = useMemo(
    () =>
      arrangeStarredItems(starred, query).map((item) =>
        starredItemRow(item, item.openRemote ? null : (driveStatuses.get(item.openLabel)?.path ?? null)),
      ),
    [starred, query, driveStatuses],
  );

  // Where each synced drive is on disk, so a row in one expands from there.
  const drivePathsByLabel = useMemo(() => {
    const paths: Record<string, string> = {};
    for (const [label, status] of driveStatuses) {
      if (status?.path) paths[label] = status.path;
    }
    return paths;
  }, [driveStatuses]);

  const openNames = useMemo(() => starredOpenNames(starred), [starred]);
  const route = useMemo<DriveRoute>(
    () => ({
      basePath: STARRED_ROUTE,
      pinned: null,
      folderHref: (folder, parentPath) => starredFolderHref(folder, parentPath, openNames),
    }),
    [openNames],
  );

  const listingData = listing.data;
  const loading = listing.isLoading;

  let body: React.ReactNode;
  if (listing.isError) {
    body = (
      <StarredState
        title={STARRED_ERROR}
        action={
          <Button variant="raised" size="sm" className="h-8 px-3 text-sm" onClick={() => void listing.refetch()}>
            Try again
          </Button>
        }
      />
    );
  } else if (listingData && !listingData.available) {
    body = <StarredState title={STARRED_UNAVAILABLE} />;
  } else if (!loading && starred.length === 0) {
    body = <StarredState icon title={STARRED_EMPTY_TITLE} note={STARRED_EMPTY_NOTE} />;
  } else {
    body = (
      <DriveContent
        isLoading={loading}
        filteredData={rows}
        displayedData={rows}
        searchTerm={query}
        activeFilters={[]}
        viewMode={viewMode}
        hasMore={false}
        loadMore={noopLoadMore}
        drivePathsByLabel={drivePathsByLabel}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <PageHeader hideStats title={STARRED_TITLE} subtitle={STARRED_SUBTITLE} className="!shadow-none" />
      <DriveRouteContext.Provider value={route}>
        <FileSelectionProvider>
          <div className="w-full relative px-3 pb-10">
            <div className={OUTER_CARD}>
              {/* The Drive's top line: the place on the left, its controls
                  on the right (search, refresh, list or cards). One line, so
                  no empty toolbar row sits between it and the rows. */}
              <div className="flex items-center gap-x-4 gap-y-2 flex-wrap min-w-0 w-full px-2.5 py-2">
                <span className="text-sm font-medium text-grey-10 dark:text-grey-light-100">{STARRED_TITLE}</span>
                <div className="flex items-center gap-3 ml-auto shrink-0">
                  {/* A set width: the input is `w-full`, which took the whole
                      line and pushed the switch and refresh below it. */}
                  <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search starred"
                    className="w-[200px] lg:w-[240px]"
                  />
                  <RefreshButton
                    refetching={listing.isFetching}
                    className="size-7 rounded-[6px]"
                    iconClassName="size-4"
                    onClick={() => void listing.refetch()}
                  />
                  <ViewModeToggle viewMode={viewMode} setViewMode={changeViewMode} />
                </div>
              </div>
              <div className={INNER_CARD}>{body}</div>
            </div>
          </div>
        </FileSelectionProvider>
      </DriveRouteContext.Provider>
    </div>
  );
}

/** Nothing starred, an older server, or a list that could not be read. */
function StarredState({
  title,
  note,
  icon = false,
  action,
}: {
  title: string;
  note?: string;
  icon?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
      {icon && (
        <span className="flex size-12 items-center justify-center rounded-full bg-primary-50/10 text-primary-50 dark:bg-primary-brand-dark/15 dark:text-primary-brand-dark">
          <Star className="size-6" strokeWidth={1.75} aria-hidden="true" />
        </span>
      )}
      <p className="text-base font-medium text-grey-10 dark:text-white">{title}</p>
      {note && <p className="-mt-2 text-sm text-grey-50 dark:text-grey-dark-600">{note}</p>}
      {action}
    </div>
  );
}
