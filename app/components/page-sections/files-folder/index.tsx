"use client";

import React, {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { Icons, RefreshButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  FormattedUserFile,
} from "@/app/lib/hooks/use-user-files";
import FilesContent from "@/app/components/page-sections/files/FilesContent";
import { toast } from "sonner";
import { ActiveFilter } from "@/lib/utils/fileFilterUtils";
import { FileTypes } from "@/lib/types/fileTypes";
import { generateActiveFilters } from "@/lib/utils/fileFilterUtils";
import { useFilteredFiles } from "@/app/lib/hooks/useFilteredFiles";
import { SearchInput } from "@/components/ui";
import FilterChips from "@/app/components/page-sections/files/filter-chips";
import { downloadFolder } from "@/app/lib/utils/downloadFolder";
import AddFileToFolderButton from "@/app/components/page-sections/files/AddFileToFolderButton";
import {
  getViewModePreference,
  saveViewModePreference,
} from "@/lib/utils/userPreferencesDb";
import { getFullPath } from "@/app/utils/folderPathUtils";
import AddFolderToFolderButton from "@/app/components/page-sections/files/AddFolderToFolderButton";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import { useInfiniteScroll } from "@/lib/hooks/use-infinite-scroll";
import { List } from "lucide-react";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { useAtomValue } from "jotai";
import {
  driveStatusesAtom,
  triggerSyncPathRefreshAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import FolderBreadcrumb from "./FolderBreadcrumb";
import { SyncPausedAlert, IS_SYNC_PAUSED } from "@/components/ui/SyncPausedAlert";

interface SyncFileEntry {
  name: string;
  is_folder: boolean;
  size: number;
  modified: number | null;
  arion_hash?: string;
  arion_cid?: string;
  sync_status?: string;
}

interface GroupedListing {
  folders: SyncFileEntry[];
  files: SyncFileEntry[];
  pendingBackfill: boolean;
}

interface FolderViewProps {
  folderCid: string;
  folderName?: string;
  folderActualName?: string;
  mainFolderActualName?: string;
  subFolderPath?: string;
}

export default function FolderView({
  folderCid,
  folderName = "Folder",
  mainFolderActualName,
  subFolderPath,
}: FolderViewProps) {
  const router = useRouter();
  const { getParam } = useUrlParams();
  const { polkadotAddress } = useWalletAuth();
  const [files, setFiles] = useState<FormattedUserFile[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");
  const [isDownloading, setIsDownloading] = useState(false);
  const addButtonRef = useRef<{ openWithFiles(files: FileList): void; openWithPaths(paths: string[]): void; isDialogOpen(): boolean }>(null);
  const addFolderButtonRef = useRef<object>({});

  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const [selectedFileTypes, setSelectedFileTypes] = useState<FileTypes[]>([]);
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedFileSize, setSelectedFileSize] = useState(0);

  const [syncFolderPath, setSyncFolderPath] = useState<string>("");
  const [syncFolderLabel, setSyncFolderLabel] = useState<string>("");
  const [isLoadingSyncPath, setIsLoadingSyncPath] = useState(true);
  // `true` when the server-side relative_path index hasn't been backfilled
  // for this drive yet — signals to the user that subfolders only present
  // on another device may be temporarily hidden until the one-shot backfill
  // completes. Driven by `GroupedListing.pendingBackfill` from the Rust
  // `list_sync_folder_grouped` command.
  const [pendingBackfill, setPendingBackfill] = useState(false);
  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  // Read configured drives from the per-drive status atom — used by
  // `resolveSyncPath` to map a folderSource path back to its sync-root
  // label without an extra Rust round-trip.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const folderSource = getParam("folderSource");

  // Rust `filter_file_entries` owns the filter chain — search, type,
  // date, size. `selectedFileSize` (single legacy value) is folded into
  // the `fileSizes` array the Rust side expects so we don't need a
  // second code path in the IPC for it.
  const filterSizes = useMemo(
    () => (selectedFileSize > 0 ? [selectedFileSize] : undefined),
    [selectedFileSize],
  );
  const filteredData = useFilteredFiles(files, {
    searchTerm,
    fileTypes: selectedFileTypes,
    dateFilter: selectedDate,
    fileSizes: filterSizes,
  });

  // Infinite scroll state for list and card views
  const { visibleData, hasMore, loadMore, resetScroll } =
    useInfiniteScroll(filteredData);

  useEffect(() => {
    const newActiveFilters = generateActiveFilters(
      selectedFileTypes,
      selectedDate,
      selectedFileSize
    );
    setActiveFilters(newActiveFilters);
  }, [selectedFileTypes, selectedDate, selectedFileSize]);

  useEffect(() => {
    resetScroll();
  }, [searchTerm, selectedFileTypes, selectedDate, selectedFileSize, viewMode, resetScroll]);

  const loadFolderContents = useCallback(
    async (showLoading = true) => {
      try {
        if (showLoading) {
          setIsLoading(true);
        } else {
          setIsRefreshing(true);
        }

        const syncPath = syncFolderPath || ((await getPrivateSyncPath(polkadotAddress || ""))?.path ?? "");

        // Build the subfolder path relative to the sync root
        const subfolder = getFullPath(mainFolderActualName, subFolderPath) || null;

        // Switched from `list_sync_folder` → `list_sync_folder_grouped`
        // so nested directories a device hasn't downloaded yet still
        // appear in the listing (the grouped IPC overlays the server-side
        // rel-path index onto the on-disk tree). Also surfaces
        // `pendingBackfill` so we can show the "indexing" banner while
        // the one-shot backfill is still running.
        const listing = await invoke<GroupedListing>("list_sync_folder_grouped", {
          accountId: polkadotAddress || "",
          syncPath,
          subfolder,
          label: syncFolderLabel || null,
        });
        setPendingBackfill(listing.pendingBackfill);
        // Folders before files matches FE expectations in list/card views
        // (folder rows render at the top when sorted by default).
        const entries: SyncFileEntry[] = [...listing.folders, ...listing.files];

        const formattedFiles = entries.map((entry): FormattedUserFile => {
          const modifiedMs = (entry.modified ?? 0) * 1000;
          const filePath = subfolder
            ? `${syncPath}/${subfolder}/${entry.name}`
            : `${syncPath}/${entry.name}`;
          return {
            name: entry.name,
            actualFileName: (subfolder && !entry.is_folder) ? `${subfolder}/${entry.name}` : entry.name,
            size: entry.size,
            createdAt: modifiedMs,
            arionHash: entry.arion_hash || "",
            arionCid: entry.arion_cid || "",
            source: filePath,
            minerIds: [],
            isAssigned: entry.is_folder || entry.sync_status === "synced",
            lastChargedAt: modifiedMs,
            isFolder: entry.is_folder,
            type: "private",
            isErasureCoded: false,
            parentFolderId: folderCid,
            parentFolderName: folderName,
            mainReqHash: "",
            label: syncFolderLabel || undefined,
          };
        });

        setFiles(formattedFiles);
      } catch (error) {
        console.error("Error loading folder contents:", error);
      } finally {
        if (showLoading) {
          setIsLoading(false);
        } else {
          setIsRefreshing(false);
        }
      }
    },
    [
      folderCid,
      folderName,
      mainFolderActualName,
      subFolderPath,
      polkadotAddress,
      syncFolderPath,
      syncFolderLabel,
    ]
  );

  useEffect(() => {
    loadFolderContents();
  }, [loadFolderContents]);

  // Resolve the correct sync path + label by matching folderSource
  // against the configured drives in `driveStatusesAtom`. The atom is
  // already populated by `useDriveStatuses`, so this is a synchronous
  // map walk — no IPC, no DB read. Falls back to `getPrivateSyncPath`
  // when folderSource is unavailable or doesn't match any drive.
  const resolveSyncPath = useCallback(async (): Promise<{ path: string; label: string }> => {
    if (folderSource) {
      for (const [label, entry] of driveStatuses) {
        if (entry.path && folderSource.startsWith(entry.path)) {
          return { path: entry.path, label };
        }
      }
    }
    const result = await getPrivateSyncPath(polkadotAddress ?? undefined);
    return { path: result?.path ?? "", label: result?.label ?? "" };
  }, [folderSource, polkadotAddress, driveStatuses]);

  // Load sync path (all files use private/encrypted HCFS path)
  useEffect(() => {
    (async () => {
      try {
        setIsLoadingSyncPath(true);
        const { path, label } = await resolveSyncPath();
        setSyncFolderPath(path);
        setSyncFolderLabel(label);
      } catch (error) {
        console.error("Failed to load sync path:", error);
        setSyncFolderPath("");
        setSyncFolderLabel("");
      } finally {
        setIsLoadingSyncPath(false);
      }
    })();
  }, [resolveSyncPath]);

  // Reload sync path when settings are updated
  useEffect(() => {
    if (syncPathRefreshTrigger > 0) {
      (async () => {
        try {
          setIsLoadingSyncPath(true);
          const { path, label } = await resolveSyncPath();
          setSyncFolderPath(path);
          setSyncFolderLabel(label);
        } catch (error) {
          console.error("Failed to reload sync path:", error);
          setSyncFolderPath("");
          setSyncFolderLabel("");
        } finally {
          setIsLoadingSyncPath(false);
        }
      })();
    }
  }, [syncPathRefreshTrigger, resolveSyncPath]);
  const handleRefresh = () => {
    invoke("trigger_sync_now").catch((err: unknown) => console.warn("[FilesFolder] trigger_sync_now failed:", err));
    loadFolderContents(false);
  };

  const initiateDownloadFolder = async () => {
    try {
      // Ask for output directory — default to Downloads so the dialog
      // always opens in a predictable location regardless of cancel/retry.
      const { downloadDir } = await import("@tauri-apps/api/path");
      let defaultPath: string | undefined;
      try {
        defaultPath = await downloadDir();
      } catch {
        // Fall back to no directory hint
      }
      const outputDir = (await open({
        directory: true,
        multiple: false,
        defaultPath,
      })) as string | null;

      if (!outputDir) {
        return; // User canceled directory selection
      }

      // Download folder — build a minimal file object so downloadFolder
      // resolves the correct sync path (via label) and uses the actual
      // subfolder path relative to the sync root as the fileName.
      const actualFolderPath = getFullPath(mainFolderActualName, subFolderPath) || folderName;
      setIsDownloading(true);
      const result = await downloadFolder({
        folderName,
        polkadotAddress: polkadotAddress ?? "",
        outputDir,
        file: {
          actualFileName: actualFolderPath,
        } as FormattedUserFile,
      });

      if (result && !result.success) {
        toast.error(
          `Failed to download folder: ${result.message || "Unknown error"}`
        );
      }
    } catch (error) {
      console.error("Error downloading folder:", error);
      toast.error(
        `Failed to download folder: ${error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
    resetScroll();
  }, [resetScroll]);

  const handleRemoveFilter = useCallback((filter: ActiveFilter) => {
    switch (filter.type) {
      case "fileType":
        setSelectedFileTypes((prev) =>
          prev.filter((type) => type !== filter.value)
        );
        break;
      case "date":
        setSelectedDate("");
        break;
      case "fileSize":
        setSelectedFileSize(0);
        break;
    }
    resetScroll();
  }, [resetScroll]);

  useEffect(() => {
    const handleFileDrop = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.files && addButtonRef.current) {
        addButtonRef.current.openWithFiles(customEvent.detail.files);
      }
    };

    window.addEventListener("hippius:file-drop", handleFileDrop);
    return () => {
      window.removeEventListener("hippius:file-drop", handleFileDrop);
    };
  }, []);

  // Load user's view mode preference on component mount
  useEffect(() => {
    async function loadViewModePreference() {
      const savedViewMode = await getViewModePreference();
      setViewMode(savedViewMode);
    }
    loadViewModePreference();
  }, []);

  // Update view mode and save preference
  const handleViewModeChange = useCallback((mode: "list" | "card") => {
    setViewMode(mode);
    saveViewModePreference(mode);
  }, []);

  // Check if sync path is empty (user skipped setup)
  const isSyncPathEmpty = syncFolderPath === "";

  const mainReqHash = getParam("mainReqHash");

  return (
    <FileSelectionProvider>
      <div className="w-full relative mt-6">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-y-3">
          <div className="flex items-center gap-2">
            <button
              className="flex gap-2 font-semibold text-lg items-center"
              onClick={() => router.push("/files")}
            >
              <Icons.ArrowLeft className="size-5 text-grey-10" />
              Back
            </button>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <RefreshButton onClick={handleRefresh} refetching={isRefreshing} />

            <div className="">
              <SearchInput
                className="h-9"
                value={searchTerm}
                onChange={handleSearchChange}
                placeholder="Search files"
              />
            </div>

            <div className="flex gap-2 border border-grey-80 p-1 rounded">
              <button
                className={cn(
                  "p-1 rounded",
                  viewMode === "list"
                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                    : "bg-grey-100 text-grey-70"
                )}
                onClick={() => handleViewModeChange("list")}
                aria-label="List View"
              >
                <List className="size-5" />
              </button>
              <button
                className={cn(
                  "p-1 rounded",
                  viewMode === "card"
                    ? "bg-primary-100 border border-primary-80 text-primary-40 rounded"
                    : "bg-grey-100 text-grey-70"
                )}
                onClick={() => handleViewModeChange("card")}
                aria-label="Card View"
              >
                <Icons.Category className="size-5" />
              </button>
            </div>

            {/* Only show upload buttons if sync path is configured */}
            {!isSyncPathEmpty && !isLoadingSyncPath && (
              <>
                <AddFolderToFolderButton
                  ref={addFolderButtonRef}
                  className="h-9"
                  folderName={folderName}
                  mainFolderActualName={mainFolderActualName}
                  subFolderPath={subFolderPath}
                  onFolderAdded={handleRefresh}
                  disabled={IS_SYNC_PAUSED}
                  syncBasePath={syncFolderPath}
                />

                <AddFileToFolderButton
                  ref={addButtonRef}
                  className="h-9"
                  folderName={folderName}
                  subfolder={getFullPath(mainFolderActualName, subFolderPath) || undefined}
                  onFileAdded={handleRefresh}
                  disabled={IS_SYNC_PAUSED}
                  syncBasePath={syncFolderPath}
                />
              </>
            )}

            <button
              onClick={initiateDownloadFolder}
              disabled={isDownloading}
              className={cn(
                "flex items-center justify-center gap-1 h-9 px-4 py-2 rounded border border-grey-80 bg-grey-90 text-grey-10 hover:bg-primary-50 hover:text-white active:bg-primary-70 active:text-white font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-50",
                isDownloading && "opacity-70 cursor-not-allowed"
              )}
            >
              {isDownloading ? (
                <Icons.Loader className="size-4 animate-spin" />
              ) : (
                <Icons.DocumentDownload className="size-4" />
              )}
              Download Folder
            </button>
          </div>
        </div>
        <FolderBreadcrumb
          mainFolderActualName={mainFolderActualName}
          subFolderPath={subFolderPath}
          folderSource={folderSource}
          mainReqHash={mainReqHash}
        />

        {/* Sync Paused Alert */}
        {IS_SYNC_PAUSED && (
          <div className="mt-4">
            <SyncPausedAlert variant="inline" />
          </div>
        )}

        {/* Relative-path backfill in progress banner. Shown when the drive's
            server-side rel-path index is still being populated — server-only
            subfolders (e.g. from another device) may be temporarily absent
            from the listing until the one-shot backfill completes. See
            `src-tauri/src/sync/relative_path_backfill.rs`. */}
        {pendingBackfill && (
          <div className="mt-4 flex items-start gap-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <Icons.Loader className="size-5 text-blue-600 flex-shrink-0 mt-0.5 animate-spin" />
            <div className="text-sm text-blue-800">
              <div className="font-medium">Indexing folders…</div>
              <div className="text-blue-700">
                Nested subfolders uploaded from other devices may take a moment to
                appear while we finish indexing this drive.
              </div>
            </div>
          </div>
        )}

        {activeFilters.length > 0 && (
          <FilterChips
            filters={activeFilters}
            onRemoveFilter={handleRemoveFilter}
            className="mt-4 mb-2"
          />
        )}

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16">
            <Icons.Loader className="size-10 text-primary-50 animate-spin mb-4" />
            <p className="text-grey-40">Loading folder contents...</p>
          </div>
        ) : (
          <>
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 min-h-[37.5rem]">
                <div className="w-12 h-12 rounded-full bg-primary-90 flex items-center justify-center mb-2">
                  <Icons.Folder className="size-7 text-primary-50" />
                </div>
                <h3 className="text-lg font-medium text-grey-10 mb-1">
                  Empty Folder
                </h3>
                <p className="text-grey-50 text-sm max-w-[16.875rem] text-center">
                  This folder does not contain any files.
                </p>
              </div>
            ) : (
              <FilesContent
                isRecentFiles={false}
                isLoading={false}
                filteredData={filteredData}
                displayedData={visibleData}
                searchTerm={searchTerm}
                activeFilters={activeFilters}
                viewMode={viewMode}
                hasMore={hasMore}
                loadMore={loadMore}
                isSyncPathEmpty={isSyncPathEmpty}
                addButtonRef={addButtonRef}
              />
            )}
          </>
        )}
      </div>
    </FileSelectionProvider>
  );
}
