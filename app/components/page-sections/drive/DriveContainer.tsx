"use client";

import React, {
  FC,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import useUserFiles, {
  FormattedUserFile,
} from "@/app/lib/hooks/use-user-files";
import useRecentFiles from "@/lib/hooks/use-recent-files";
import { WaitAMoment } from "@/components/ui";
import * as Typography from "@/components/ui/typography";
import DriveOnboarding from "./DriveOnboarding";
import { getPrivateSyncPath } from "@/lib/utils/syncPathUtils";
import { useDriveStorageStats } from "@/app/lib/hooks/api/useDriveStorageStats";
import { formatBytes } from "@/app/lib/utils/formatBytes";
import { FileTypes } from "@/lib/types/fileTypes";
import {
  generateActiveFilters,
  ActiveFilter,
} from "@/lib/utils/fileFilterUtils";
import { useFilteredFiles } from "@/app/lib/hooks/useFilteredFiles";
import DriveHeader from "./DriveHeader";
import DriveContent from "./DriveContent";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { useNestedFolderListing } from "@/app/lib/hooks/use-nested-folder-listing";
import { downloadFolder } from "@/app/lib/utils/downloadFolder";
import { BreadcrumbSegment } from "./SyncFolderBreadcrumb";
import { useAtomValue, useSetAtom } from "jotai";
import {
  settingsDialogOpenAtom,
  activeSettingsTabAtom,
} from "@/app/components/sidebar/sideBarAtoms";
import {
  getViewModePreference,
  saveViewModePreference,
  getActiveSyncFolderLabel,
  saveActiveSyncFolderLabel,
} from "@/lib/utils/userPreferencesDb";
import { useInfiniteScroll } from "@/lib/hooks/use-infinite-scroll";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import {
  triggerSyncPathRefreshAtom,
  hasConfiguredDrivesAtom,
  driveStatusesAtom,
} from "@/app/lib/global-atoms/unpinAtoms";
import { FileSelectionProvider } from "@/app/contexts/FileSelectionContext";
import {
  SyncPausedAlert,
  IS_SYNC_PAUSED,
} from "@/components/ui/SyncPausedAlert";
import { SyncConnectivityAlert } from "@/components/ui/SyncConnectivityAlert";
import { HcfsSetupDialog } from "../settings/HcfsSetupDialog";
import { MnemonicBackupDialog } from "../settings/MnemonicBackupDialog";
import { useHcfsSync } from "@/app/lib/hooks/useHcfsSync";
import { toast } from "sonner";
import { cn } from "@/app/lib/utils";

const DriveContainer: FC<{ isRecentFiles?: boolean }> = ({
  isRecentFiles = false,
}) => {
  const { polkadotAddress, getMnemonic } = useWalletAuth();

  // Indexer-based drive stats (same source as Home page for consistency).
  // Single round-trip returns size + count from the same snapshot.
  const { data: driveStats } = useDriveStorageStats();
  const remoteStorageStats = driveStats;
  const remoteFileCount = driveStats?.fileCount;

  // Regular files hook
  const {
    data: regularFilesData,
    isLoading: isRegularFilesLoading,
    refetch: refetchUserFiles,
    isRefetching,
    isFetching: isRegularFilesFetching,
    error,
  } = useUserFiles();

  // Recent files hook
  const {
    data: recentFilesData,
    isLoading: isRecentFilesLoading,
    isFetching: isRecentFilesFetching,
    refetch: refetchRecentFiles,
  } = useRecentFiles();

  // Loading + fetching flags are computed AFTER nested-mode resolution
  // below (so they can branch on `isNested`). See `isLoading` / `isFetching`
  // declarations following the `useNestedFolderListing` call.

  const addButtonRef = useRef<{
    openWithFiles(files: FileList): Promise<void>;
    openWithPaths(paths: string[]): Promise<void>;
    isDialogOpen(): boolean;
  }>(null);
  const [viewMode, setViewMode] = useState<"list" | "card">("list");

  // Folder upload dialog state (lifted from DriveHeader so context menus can trigger it)
  const [isFolderUploadOpen, setIsFolderUploadOpen] = useState(false);

  const [selectedPrivateFolderPath, setSelectedPrivateFolderPath] = useState(
    undefined as string | null | undefined,
  );

  // Loading states for sync paths
  const [isLoadingPrivatePath, setIsLoadingPrivatePath] = useState(true);

  // Active sync folder for the breadcrumb-based drive view. Replaces the
  // legacy "All / per-folder tabs" flow with a single-folder-at-a-time
  // model where the user navigates back to a "Local" cards view via the
  // breadcrumb (see SyncFolderBreadcrumb / DriveOnboarding).
  //
  // - `activeSyncFolderLabel`: persisted in user prefs. `null` means we
  //   haven't picked a folder yet (first launch or saved label removed);
  //   the bootstrap effect below resolves it to the first available label.
  // - `isOnLocalView`: ephemeral UI flag set to true only when the user
  //   clicks the "Local" breadcrumb segment. NOT persisted — next session
  //   resumes at the last active folder, never on the Local cards view.
  const [activeSyncFolderLabel, setActiveSyncFolderLabel] = useState<
    string | null
  >(null);
  const [isOnLocalView, setIsOnLocalView] = useState(false);
  // Tracks whether the saved label has been hydrated, so the bootstrap
  // / fallback effects don't fight each other on first mount.
  const [activeFolderHydrated, setActiveFolderHydrated] = useState(false);

  // Search state
  const [searchTerm, setSearchTerm] = useState<string>("");

  // Filter states - using a single atomic state to prevent race conditions
  const [filterState, setFilterState] = useState({
    fileTypes: [] as FileTypes[],
    date: "",
    fileSize: 0,
    fileSizes: [] as number[],
    lastUpdated: Date.now(),
  });

  // Active filters state
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  // State to track if sync folder is configured
  const [isSyncPathConfigured, setIsSyncPathConfigured] = useState<
    boolean | null
  >(null);
  const [isCheckingSyncPath, setIsCheckingSyncPath] = useState(true);
  const [showPrivateStartSyncingSelector, setShowPrivateStartSyncingSelector] =
    useState(false);

  const syncPathRefreshTrigger = useAtomValue(triggerSyncPathRefreshAtom);
  const triggerSyncPathRefresh = useSetAtom(triggerSyncPathRefreshAtom);
  const setSettingsDialogOpen = useSetAtom(settingsDialogOpenAtom);
  const setActiveSettingsTab = useSetAtom(activeSettingsTabAtom);
  const isSyncConfigured = useAtomValue(hasConfiguredDrivesAtom);

  // Per-drive sync status is owned by Rust and pushed via the
  // `useDriveStatuses` hook mounted in `SyncEventLogger`. The previous
  // global engine-status atom and its mount-time race are gone.

  // HCFS sync integration
  const {
    setupAndInitialize,
    isInitializing,
    mnemonicToBackup,
    clearMnemonicBackup,
  } = useHcfsSync();

  const [showHcfsSetup, setShowHcfsSetup] = useState(false);
  const [showMnemonicBackup, setShowMnemonicBackup] = useState(false);

  // Sync folder labels from the query data
  const syncFolderLabels = useMemo(() => {
    if (regularFilesData && "syncFolderLabels" in regularFilesData) {
      return (
        (regularFilesData as { syncFolderLabels?: string[] })
          .syncFolderLabels ?? []
      );
    }
    return [];
  }, [regularFilesData]);

  // Label → display name is derived from driveStatusesAtom (the
  // per-drive source of truth, mirrored from Rust by useDriveStatuses).
  // Used by the SyncFolderBreadcrumb to render the folder name segment.
  const driveStatuses = useAtomValue(driveStatusesAtom);
  const labelDisplayNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const [label, entry] of driveStatuses.entries()) {
      names[label] = entry.folderName;
    }
    return names;
  }, [driveStatuses]);

  // ── Nested folder browsing (URL-param driven) ──────────────────────────────
  //
  // When the user clicks a folder row in DriveContent, NameCell builds a
  // `/files?folderName=…&subFolderPath=…&folderSource=…` URL via <Link>.
  // The legacy FolderView page used to handle that URL on a separate route;
  // it's now collapsed into DriveContainer so the breadcrumb + filters keep
  // working consistently with the root drive view. Persistence rules
  // (only the top-level sync folder label is saved to user prefs) are
  // preserved — nested navigation never calls `saveActiveSyncFolderLabel`.
  const router = useRouter();
  const { getParam } = useUrlParams();
  const urlFolderName = getParam("folderName");
  const urlMainFolderActualName = getParam("mainFolderActualName");
  const urlSubFolderPath = getParam("subFolderPath");
  const urlFolderSource = getParam("folderSource");
  const urlMainReqHash = getParam("mainReqHash");
  const isNested = !isRecentFiles && Boolean(urlFolderName && urlSubFolderPath);

  // Resolve which sync drive the nested URL points at. `folderSource` is the
  // local FS path the user navigated from, so we match it against
  // driveStatuses (Map<label, entry>) to back out the (label, syncPath) pair
  // — same logic the old FolderView used (synchronous, no IPC).
  const nestedDrive = useMemo(() => {
    if (!isNested) return null;
    if (urlFolderSource) {
      for (const [label, entry] of driveStatuses) {
        if (entry.path && urlFolderSource.startsWith(entry.path)) {
          return { label, syncPath: entry.path };
        }
      }
    }
    // Fallback: use the active sync folder label's entry if folderSource
    // is missing or doesn't match (e.g. cold deep-link from elsewhere).
    if (activeSyncFolderLabel) {
      const entry = driveStatuses.get(activeSyncFolderLabel);
      if (entry?.path) {
        return { label: activeSyncFolderLabel, syncPath: entry.path };
      }
    }
    return null;
  }, [isNested, urlFolderSource, driveStatuses, activeSyncFolderLabel]);

  // Bumping this re-fetches the nested listing. Used by the Refresh button,
  // by upload-success callbacks, and by sync-completed window events so the
  // nested view stays in step with the rest of the app.
  const [nestedRefreshKey, setNestedRefreshKey] = useState(0);
  useEffect(() => {
    if (!isNested) return;
    const handler = () => setNestedRefreshKey((prev) => prev + 1);
    window.addEventListener("sync_files_completed_changed", handler);
    return () =>
      window.removeEventListener("sync_files_completed_changed", handler);
  }, [isNested]);

  const nestedListing = useNestedFolderListing({
    accountId: polkadotAddress,
    syncPath: nestedDrive?.syncPath ?? null,
    subfolder: urlSubFolderPath || null,
    label: nestedDrive?.label ?? null,
    refreshKey: nestedRefreshKey,
    enabled: isNested,
  });

  const refreshNestedListing = useCallback(() => {
    setNestedRefreshKey((prev) => prev + 1);
  }, []);

  // Loading + fetching flags branched across the three view modes:
  //   - recent files (read-only): use the recent-files query flags
  //   - nested folder browsing: use the nested-listing hook's flags
  //   - root drive view: use the regular useUserFiles flags
  const isLoading = isRecentFiles
    ? isRecentFilesLoading
    : isNested
      ? nestedListing.isLoading
      : isRegularFilesLoading;
  const isFetching = isRecentFiles
    ? isRecentFilesFetching
    : isNested
      ? nestedListing.isRefreshing
      : isRegularFilesFetching;

  // Get the appropriate data based on view mode
  const allData = useMemo(() => {
    if (isRecentFiles) {
      return recentFilesData || [];
    }
    if (isNested) {
      return nestedListing.data;
    }
    if (regularFilesData?.files) {
      return regularFilesData.files.filter((file) => !file.deleted);
    }
    return [];
  }, [
    isRecentFiles,
    isNested,
    nestedListing.data,
    recentFilesData,
    regularFilesData?.files,
  ]);

  // Prune the list down to the private-files universe the files page
  // displays. The folder-tab cut is delegated to Rust's filter along with
  // every other filter — keeping the type cut here keeps recents vs.
  // private as a TS-owned concern (it's part of *which view* the user
  // picked, not a filter the chip UI exposes). Nested listings are already
  // pre-scoped to one private sync drive so the type cut would be a no-op.
  const allFilteredData = useMemo(() => {
    if (isRecentFiles || isNested) return allData;
    return allData.filter(
      (file) => (file.type?.toLowerCase() || "") === "private",
    );
  }, [allData, isRecentFiles, isNested]);

  // Rust owns the filter chain — search, type, date, size, folder tab.
  // `useFilteredFiles` debounces fast typing so we don't IPC per keystroke.
  // In nested mode the listing is already scoped to one folder, so
  // `folderTab` is null (no second-pass label filter needed).
  const filteredData = useFilteredFiles(allFilteredData, {
    searchTerm,
    fileTypes: filterState.fileTypes,
    dateFilter: filterState.date,
    fileSizes: filterState.fileSizes,
    folderTab: isRecentFiles || isNested ? null : activeSyncFolderLabel,
  });

  // Infinite scroll state for list and card views
  const { visibleData, hasMore, loadMore, resetScroll } =
    useInfiniteScroll(filteredData);

  // Batch update helper to prevent multiple rapid filter updates
  const updateFilters = useCallback(
    (updates: Partial<typeof filterState>) => {
      setFilterState((prev) => ({
        ...prev,
        ...updates,
        lastUpdated: Date.now(),
      }));
      // Always reset scroll position when filters change
      resetScroll();
    },
    [resetScroll],
  );

  // Update active filters when filter settings change
  useEffect(() => {
    const newActiveFilters = generateActiveFilters(
      filterState.fileTypes,
      filterState.date,
      filterState.fileSize,
      filterState.fileSizes,
    );
    setActiveFilters(newActiveFilters);
  }, [
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
  ]);

  // Reset scroll when filters or folder tab change
  useEffect(() => {
    resetScroll();
  }, [
    searchTerm,
    filterState.fileTypes,
    filterState.date,
    filterState.fileSize,
    filterState.fileSizes,
    filterState.lastUpdated,
    activeSyncFolderLabel,
    resetScroll,
  ]);

  // Handle removing a filter
  const handleRemoveFilter = useCallback(
    (filter: ActiveFilter) => {
      const updates: Partial<typeof filterState> = {};
      switch (filter.type) {
        case "fileType":
          updates.fileTypes = filterState.fileTypes.filter(
            (type: FileTypes) => type !== filter.value,
          );
          break;

        case "date":
          updates.date = "";
          break;

        case "fileSize":
          // Remove specific file size from the array
          const sizeValue = parseInt(filter.value);
          updates.fileSizes = filterState.fileSizes.filter(
            (size: number) => size !== sizeValue,
          );
          break;
      }

      updateFilters(updates);
    },
    [filterState.fileTypes, filterState.fileSizes, updateFilters],
  );

  // Header "Total Storage Used":
  //   - active folder: raw per-drive bytes from the Rust aggregator. Raw
  //     (not CID-deduplicated) is intentional — it matches what the user
  //     sees in the folder's rows. See 2026-04-17-folder-tab-stats-fix.md.
  //   - fallback (no active folder, e.g. mid-bootstrap): keep the indexer
  //     value so it stays consistent with the Home page / Available
  //     Credits numbers.
  const formattedStorageSize = useMemo(() => {
    if (isRecentFiles) return "";

    if (activeSyncFolderLabel) {
      const bytes =
        regularFilesData?.labelStats?.[activeSyncFolderLabel]?.totalBytes ?? 0;
      return formatBytes(bytes, 2);
    }

    if (remoteStorageStats?.totalBytes) {
      return formatBytes(remoteStorageStats.totalBytes, 2);
    }

    return "0 B";
  }, [
    isRecentFiles,
    activeSyncFolderLabel,
    regularFilesData?.labelStats,
    remoteStorageStats,
  ]);

  // Handle search input change
  const handleSearchChange = useCallback((value: string) => {
    setSearchTerm(value);
  }, []);

  // Handle filter changes using atomic state updates
  const handleFileTypesChange = useCallback(
    (types: FileTypes[]) => {
      updateFilters({ fileTypes: types });
    },
    [updateFilters],
  );

  const handleDateChange = useCallback(
    (date: string) => {
      updateFilters({ date });
    },
    [updateFilters],
  );

  const handleFileSizesChange = useCallback(
    (sizes: number[]) => {
      updateFilters({ fileSizes: sizes });
    },
    [updateFilters],
  );

  // Load private sync path (with stale-request cancellation)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setIsLoadingPrivatePath(true);
        const result = await getPrivateSyncPath(polkadotAddress || undefined);
        if (!cancelled) {
          setSelectedPrivateFolderPath(result?.path ?? null);
        }
      } catch (err) {
        console.error("Failed to load private sync folder:", err);
        if (!cancelled) {
          setSelectedPrivateFolderPath(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPrivatePath(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [polkadotAddress]);

  // Reload sync path when sync is configured from another component/page
  // (e.g., user sets up sync on Files page, then navigates to Home)
  useEffect(() => {
    if (!isSyncConfigured || !polkadotAddress) return;
    // Only reload if we don't already have a path (avoids redundant fetches)
    if (selectedPrivateFolderPath) return;

    let cancelled = false;

    (async () => {
      try {
        setIsLoadingPrivatePath(true);
        const result = await getPrivateSyncPath(polkadotAddress);
        if (!cancelled) {
          setSelectedPrivateFolderPath(result?.path ?? null);
        }
      } catch {
        // Ignore — initial load will handle errors
      } finally {
        if (!cancelled) {
          setIsLoadingPrivatePath(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSyncConfigured, polkadotAddress]);

  // Check if sync path is configured
  useEffect(() => {
    if (isRecentFiles) {
      setIsCheckingSyncPath(false);
      return;
    }

    const checkSyncPath = async () => {
      try {
        setIsCheckingSyncPath(true);

        // Wait for private path to finish loading
        if (isLoadingPrivatePath) {
          return; // Don't check yet, still loading
        }

        const syncPath = selectedPrivateFolderPath;

        setIsSyncPathConfigured(syncPath !== null && syncPath !== undefined);
      } catch (error) {
        console.error(`Failed to check private sync path:`, error);
        setIsSyncPathConfigured(false);
      } finally {
        setIsCheckingSyncPath(false);
      }
    };

    checkSyncPath();
  }, [selectedPrivateFolderPath, isRecentFiles, isLoadingPrivatePath]);

  const refreshUserFilesCallback = useCallback(() => {
    refetchUserFiles();
  }, [refetchUserFiles]);

  const refreshRecentFilesCallback = useCallback(() => {
    refetchRecentFiles();
  }, [refetchRecentFiles]);

  // Handle sync started from onboarding (folder added or remote folder
  // synced). `newLabel` lets us auto-land in the freshly added folder
  // instead of leaving the user on the Local cards view — the breadcrumb
  // model has no "All" placeholder so we need a concrete active folder.
  const handleOnboardingSyncStarted = useCallback(
    async (newLabel?: string) => {
      if (!polkadotAddress) return;
      // Reload sync paths so we pick up the newly added folder
      try {
        const result = await getPrivateSyncPath(polkadotAddress);
        setSelectedPrivateFolderPath(result?.path ?? null);
      } catch {
        // Ignore — we still want to mark as configured
      }
      setIsSyncPathConfigured(true);
      setShowPrivateStartSyncingSelector(false);
      if (newLabel) {
        setActiveSyncFolderLabel(newLabel);
        setIsOnLocalView(false);
        void saveActiveSyncFolderLabel(newLabel);
      }
      triggerSyncPathRefresh((prev) => prev + 1);
      refetchUserFiles();
    },
    [polkadotAddress, triggerSyncPathRefresh, refetchUserFiles],
  );

  const handleHcfsSetupComplete = useCallback(
    async (result: { serverUrl: string; password: string }) => {
      if (!polkadotAddress) return;

      try {
        const mnemonic = (await getMnemonic()) ?? undefined;
        const initResult = await setupAndInitialize(
          polkadotAddress,
          "default",
          result.serverUrl,
          result.password,
          mnemonic ?? undefined,
        );

        setShowHcfsSetup(false);

        if (initResult) {
          toast.success("Sync folder set — syncing started!");
          // Mark sync path as configured and hide selectors so files view shows
          setIsSyncPathConfigured(true);
          setShowPrivateStartSyncingSelector(false);
          // Directly reload path so local state updates immediately
          try {
            const pathResult = await getPrivateSyncPath(polkadotAddress);
            setSelectedPrivateFolderPath(pathResult?.path ?? null);
          } catch {
            // Will be retried by triggerSyncPathRefresh effect
          }
          // Refresh file list to show the synced files
          refetchUserFiles();
          // Signal other components about the change
          triggerSyncPathRefresh((prev) => prev + 1);

          if (initResult.mnemonic) {
            setShowMnemonicBackup(true);
          }
        }
      } catch (err) {
        console.error("Failed to setup HCFS:", err);
        toast.error("Sync setup failed. Please try again.");
      }
    },
    [
      polkadotAddress,
      setupAndInitialize,
      getMnemonic,
      refetchUserFiles,
      triggerSyncPathRefresh,
    ],
  );

  const handleMnemonicBackupConfirm = useCallback(() => {
    setShowMnemonicBackup(false);
    clearMnemonicBackup();
  }, [clearMnemonicBackup]);

  // Navigation to settings
  const handleNavigateToSettings = useCallback(() => {
    setActiveSettingsTab("Sync & Storage");
    setSettingsDialogOpen(true);
  }, [setActiveSettingsTab, setSettingsDialogOpen]);

  // Handle start syncing button click
  const handleStartSyncing = useCallback(() => {
    // If not on /files page, navigate to settings instead
    if (isRecentFiles) {
      handleNavigateToSettings();
      return;
    }

    // If on /files page, show the sync folder selector
    setShowPrivateStartSyncingSelector(true);
  }, [isRecentFiles, handleNavigateToSettings]);

  // Context menu handlers
  const handleContextUploadFile = useCallback(() => {
    addButtonRef.current?.openWithPaths([]);
  }, []);

  const handleContextAddFolder = useCallback(() => {
    setIsFolderUploadOpen(true);
  }, []);

  const handleContextAddSyncFolder = useCallback(() => {
    setActiveSettingsTab("Sync & Storage");
    setSettingsDialogOpen(true);
  }, [setActiveSettingsTab, setSettingsDialogOpen]);

  // Breadcrumb / Local-view navigation handlers.
  //
  // The drive's "Local" cards view (DriveOnboarding) is the new home for
  // per-folder actions (pause / resume / remove / delete-from-server /
  // browse contents) — the old tab right-click menu is gone. Those flows
  // are still wired inside DriveOnboarding via LocalFoldersSection's
  // action menu, so removing them from here does not lose functionality.
  //
  // When the user clicks "Local" while inside a nested URL, we also have to
  // drop the nested query string — otherwise the page would re-mount into
  // nested mode immediately. Same for the sync-folder breadcrumb segment
  // and the deeper nested-segment jumps below.
  const handleNavigateToLocalView = useCallback(() => {
    setIsOnLocalView(true);
    if (isNested) {
      router.push("/files");
    }
  }, [isNested, router]);

  // Click on the top-level sync folder segment (e.g. "MyDrive" in
  // Local > MyDrive > Photos > 2024). Pops the user back to that drive's
  // root listing and persists it as the active folder.
  const handleNavigateToSyncFolderRoot = useCallback(
    (label: string) => {
      setActiveSyncFolderLabel(label);
      setIsOnLocalView(false);
      void saveActiveSyncFolderLabel(label);
      router.push("/files");
    },
    [router],
  );

  // Click on an intermediate nested segment. Rebuilds the URL so we
  // navigate to that exact sub-path inside the same sync drive.
  const handleNavigateToBreadcrumbSegment = useCallback(
    (segmentName: string, subPathTo: string) => {
      const params = new URLSearchParams();
      const parts = subPathTo.split("/").filter(Boolean);
      const mainFolder = parts[0] ?? segmentName;
      params.set("folderName", segmentName);
      params.set("folderActualName", segmentName);
      params.set("mainFolderActualName", mainFolder);
      params.set("subFolderPath", subPathTo);
      if (urlFolderSource) params.set("folderSource", urlFolderSource);
      if (urlMainReqHash) params.set("mainReqHash", urlMainReqHash);
      router.push(`/files?${params.toString()}`);
    },
    [router, urlFolderSource, urlMainReqHash],
  );

  // Switch the active sync folder from a click on a LocalFoldersSection
  // card. Persisted so the next session resumes here.
  const handleSelectFolderFromCards = useCallback((label: string) => {
    setActiveSyncFolderLabel(label);
    setIsOnLocalView(false);
    void saveActiveSyncFolderLabel(label);
  }, []);

  // Build the breadcrumb path that lives in the drive header. Empty when
  // the user is on the Local cards view (DriveOnboarding); otherwise the
  // first segment is the active sync folder display name, followed by one
  // segment per nested directory the user has dived into.
  const breadcrumbSegments = useMemo<BreadcrumbSegment[]>(() => {
    if (isRecentFiles || isOnLocalView) return [];
    const segments: BreadcrumbSegment[] = [];

    const topLabel = isNested ? nestedDrive?.label : activeSyncFolderLabel;
    if (topLabel) {
      const topDisplayName = labelDisplayNames[topLabel] ?? topLabel;
      segments.push({
        label: topDisplayName,
        title: topDisplayName,
        // Only clickable when the user is below this level (nested view).
        // In the root view the segment IS the current location.
        onClick: isNested
          ? () => handleNavigateToSyncFolderRoot(topLabel)
          : undefined,
      });
    }

    // `urlSubFolderPath` is rooted at `mainFolderActualName` (e.g.
    // "Photos/2024"). Split it into parts and emit one segment per
    // intermediate level, with the final part rendered as the active
    // (non-clickable) segment.
    if (isNested && urlSubFolderPath) {
      const mainName = urlMainFolderActualName || "";
      const allParts: string[] = [];
      if (mainName) allParts.push(mainName);
      let trailing = urlSubFolderPath;
      if (mainName && trailing.startsWith(`${mainName}/`)) {
        trailing = trailing.substring(mainName.length + 1);
      } else if (trailing === mainName) {
        trailing = "";
      }
      if (trailing) {
        trailing
          .split("/")
          .filter(Boolean)
          .forEach((part) => allParts.push(part));
      }

      allParts.forEach((part, idx) => {
        const isLast = idx === allParts.length - 1;
        if (isLast) {
          segments.push({ label: part, title: part });
        } else {
          const subPathTo = allParts.slice(0, idx + 1).join("/");
          segments.push({
            label: part,
            title: part,
            onClick: () => handleNavigateToBreadcrumbSegment(part, subPathTo),
          });
        }
      });
    }

    return segments;
  }, [
    isRecentFiles,
    isOnLocalView,
    isNested,
    nestedDrive,
    activeSyncFolderLabel,
    labelDisplayNames,
    urlSubFolderPath,
    urlMainFolderActualName,
    handleNavigateToSyncFolderRoot,
    handleNavigateToBreadcrumbSegment,
  ]);

  // Download Folder — only relevant inside a nested folder. Mirrors the
  // old FolderView's `initiateDownloadFolder` flow: pick an output dir,
  // then hand off to `downloadFolder` with the nested rel-path as
  // `actualFileName` (the util resolves the sync path via the label).
  const [isDownloadingFolder, setIsDownloadingFolder] = useState(false);
  const handleDownloadNestedFolder = useCallback(async () => {
    if (!isNested || !polkadotAddress) return;
    try {
      const { downloadDir } = await import("@tauri-apps/api/path");
      let defaultPath: string | undefined;
      try {
        defaultPath = await downloadDir();
      } catch {
        // Fall back to no directory hint
      }
      const outputDir = (await openDialog({
        directory: true,
        multiple: false,
        defaultPath,
      })) as string | null;
      if (!outputDir) return;

      const folderName = urlFolderName || urlMainFolderActualName || "Folder";
      const actualFolderPath = urlSubFolderPath || folderName;
      setIsDownloadingFolder(true);
      const result = await downloadFolder({
        folderName,
        polkadotAddress,
        outputDir,
        file: {
          actualFileName: actualFolderPath,
          label: nestedDrive?.label,
          source: urlFolderSource || undefined,
        } as FormattedUserFile,
      });
      if (result && !result.success) {
        toast.error(
          `Failed to download folder: ${result.message || "Unknown error"}`,
        );
      }
    } catch (err) {
      console.error("Error downloading folder:", err);
      toast.error(
        `Failed to download folder: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsDownloadingFolder(false);
    }
  }, [
    isNested,
    polkadotAddress,
    urlFolderName,
    urlMainFolderActualName,
    urlSubFolderPath,
    nestedDrive,
    urlFolderSource,
  ]);

  // Load data on mount and set up interval refresh
  useEffect(() => {
    if (isRecentFiles) {
      return;
    }

    refreshUserFilesCallback();
  }, [refreshUserFilesCallback, isRecentFiles]);

  // Log error for debugging
  useEffect(() => {
    if (error) {
      console.error("Error in useUserFiles:", error);
    }
  }, [error]);

  // Header "Number of Files":
  //   - "All" tab, no search/filters: indexer count (deduplicated).
  //   - Folder tab, no search/filters: Rust-aggregated per-label count
  //     (one entry per leaf file; empty folders contribute 0).
  //   - Search or filter active: count the filtered list. Folder rows
  //     contribute their recursive file_count; empty folders contribute 0.
  //     Safe from double-count because list_sync_folder is single-level —
  //     a folder row's descendants are never in regularFilesData.files.
  const displayedFileCount = useMemo(() => {
    if (searchTerm || activeFilters.length > 0) {
      return filteredData.reduce((count, item) => {
        if (item.isFolder) {
          return count + (item.fileCount ?? 0);
        }
        return count + 1;
      }, 0);
    }

    if (activeSyncFolderLabel) {
      return (
        regularFilesData?.labelStats?.[activeSyncFolderLabel]?.fileCount ?? 0
      );
    }

    if (remoteFileCount !== undefined) {
      return remoteFileCount;
    }

    return 0;
  }, [
    filteredData,
    searchTerm,
    activeFilters.length,
    activeSyncFolderLabel,
    remoteFileCount,
    regularFilesData?.labelStats,
  ]);

  // Handle file drop events
  useEffect(() => {
    const handleFileDrop = (event: Event) => {
      const customEvent = event as CustomEvent;
      if (customEvent.detail?.files && addButtonRef.current) {
        console.log(
          "Handling files via global event",
          customEvent.detail.files,
        );
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

  // Hydrate active sync folder from user preferences on mount. This is the
  // breadcrumb's "remember me here" — picks up where the user left off in
  // a previous session. Runs once and toggles `activeFolderHydrated` so
  // the fallback effect below knows when it's safe to fill in a default.
  useEffect(() => {
    if (isRecentFiles) {
      setActiveFolderHydrated(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const saved = await getActiveSyncFolderLabel();
        if (!cancelled && saved) {
          setActiveSyncFolderLabel(saved);
        }
      } finally {
        if (!cancelled) setActiveFolderHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isRecentFiles]);

  // Auto-fill / reconcile the active folder against the live label list.
  //   - On first hydration with no saved label: pick the first available.
  //   - When the active label is removed (e.g. via settings or another
  //     device): fall back to the first available, or null if none left
  //     (the parent then shows DriveOnboarding via isSyncPathConfigured).
  // The chosen fallback IS persisted so it stays stable across sessions.
  useEffect(() => {
    if (isRecentFiles) return;
    if (!activeFolderHydrated) return;
    if (syncFolderLabels.length === 0) return;
    if (
      activeSyncFolderLabel &&
      syncFolderLabels.includes(activeSyncFolderLabel)
    ) {
      return;
    }
    const fallback = syncFolderLabels[0];
    setActiveSyncFolderLabel(fallback);
    void saveActiveSyncFolderLabel(fallback);
  }, [
    isRecentFiles,
    activeFolderHydrated,
    syncFolderLabels,
    activeSyncFolderLabel,
  ]);

  // Reload sync paths when settings are updated
  useEffect(() => {
    if (syncPathRefreshTrigger > 0) {
      let cancelled = false;

      // Reload private sync path
      (async () => {
        try {
          setIsLoadingPrivatePath(true);
          const result = await getPrivateSyncPath(polkadotAddress || undefined);
          if (!cancelled) {
            setSelectedPrivateFolderPath(result?.path ?? null);
            // Refetch file list so it reads from the new sync folder
            refetchUserFiles();
          }
        } catch (err) {
          console.error("Failed to reload private sync folder:", err);
        } finally {
          if (!cancelled) {
            setIsLoadingPrivatePath(false);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }
  }, [syncPathRefreshTrigger, polkadotAddress, refetchUserFiles]);

  // Computed values for current view (always private)
  const currentSyncPath = selectedPrivateFolderPath;
  const isCurrentSyncPathEmpty = !currentSyncPath;
  const showCurrentStartSyncingSelector = showPrivateStartSyncingSelector;

  // Recent files specific logic - check if private path is available.
  // While path is still loading, treat as "has paths" to avoid flashing
  // the Start Syncing button before the async load completes.
  const hasNoSyncPaths = useMemo(() => {
    if (!isRecentFiles) return false;
    if (isLoadingPrivatePath) return false;
    return (
      selectedPrivateFolderPath === null ||
      selectedPrivateFolderPath === undefined
    );
  }, [isRecentFiles, selectedPrivateFolderPath, isLoadingPrivatePath]);

  // For recent files, check if sync path is available (not empty).
  // While loading, optimistically assume path exists to prevent button flash.
  const hasAnySyncPath = useMemo(() => {
    if (!isRecentFiles) return false;
    if (isLoadingPrivatePath) return true;
    const hasPrivate =
      selectedPrivateFolderPath !== null &&
      selectedPrivateFolderPath !== undefined &&
      selectedPrivateFolderPath !== "";
    return hasPrivate;
  }, [isRecentFiles, selectedPrivateFolderPath, isLoadingPrivatePath]);

  // Determine what content to render
  let content;

  // Show loading while checking sync path or while loading sync paths.
  // Nested mode skips this check — by the time we have a `?subFolderPath`
  // URL, sync was already configured, and the nested listing hook owns
  // its own loading state surfaced through DriveContent.
  const shouldShowLoading =
    !isNested && (isCheckingSyncPath || isLoadingPrivatePath);

  if (shouldShowLoading) {
    content = <WaitAMoment />;
  } else if (error && !isRecentFiles && !isNested) {
    // `useUserFiles` exposes a terminal error (after TanStack Query's
    // retry budget is exhausted or the 15 s wall-clock cap in the
    // query fires). Without an explicit branch here the page stayed
    // blank with only the reauth banner at the top, which the user
    // reported as "loads indefinitely without displaying any content".
    content = (
      <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
        <Typography.P size="md" className="font-medium text-error-60 mb-2">
          Couldn&apos;t load your files right now.
        </Typography.P>
        <Typography.P size="sm" className="text-grey-50 max-w-md">
          {error instanceof Error ? error.message : String(error)}
        </Typography.P>
        <button
          type="button"
          className="mt-6 text-sm font-medium text-primary-50 hover:text-primary-40"
          onClick={() => refetchUserFiles()}
        >
          Try again
        </button>
      </div>
    );
  } else if (isSyncPathConfigured === false && !isRecentFiles && !isNested) {
    content = <DriveOnboarding onSyncStarted={handleOnboardingSyncStarted} />;
  } else if (showCurrentStartSyncingSelector && !isRecentFiles && !isNested) {
    // Show onboarding when Start Syncing is clicked
    content = <DriveOnboarding onSyncStarted={handleOnboardingSyncStarted} />;
  } else if (isOnLocalView && !isRecentFiles && !isNested) {
    // User clicked the "Local" breadcrumb segment. Reuses DriveOnboarding
    // for the cards view, but here we also pass `onSelectFolder` so a
    // card click switches the active folder instead of just opening the
    // action menu. NOT persisted — next session resumes at the last
    // active folder via the bootstrap effect.
    content = (
      <DriveOnboarding
        onSyncStarted={handleOnboardingSyncStarted}
        onSelectFolder={handleSelectFolderFromCards}
      />
    );
  } else {
    // Compute whether sync path is effectively empty
    let effectiveSyncPathEmpty = false;

    if (isRecentFiles) {
      effectiveSyncPathEmpty = !hasAnySyncPath;
    } else {
      effectiveSyncPathEmpty = isCurrentSyncPathEmpty;
    }

    // Get file count for view all button
    const privateFileCount =
      regularFilesData?.files.filter((f) => f.type?.toLowerCase() === "private")
        .length || 0;

    content = (
      <FileSelectionProvider>
        <div className={cn("w-full relative", !isRecentFiles && "px-3")}>
          {/* Sync Paused Alert */}
          {IS_SYNC_PAUSED && !isRecentFiles && (
            <div className="mb-4">
              <SyncPausedAlert variant="inline" />
            </div>
          )}

          {/* Sync connectivity alert. `SyncReauthRequiredAlert` is
              mounted globally in `ResponsiveContent` so it's visible
              on every authenticated route (not just /files). */}
          <SyncConnectivityAlert
            variant={isRecentFiles ? "compact" : "banner"}
          />

          {(() => {
            // Drive content node — used both as a sibling (recent files) and
            // as children of DriveHeader (drive view, so it lives inside the
            // inner white card per Figma).
            const driveContent = (
              <DriveContent
                isRecentFiles={isRecentFiles}
                isLoading={isLoading}
                filteredData={filteredData}
                displayedData={visibleData}
                searchTerm={searchTerm}
                activeFilters={activeFilters}
                viewMode={viewMode}
                error={error}
                addButtonRef={addButtonRef}
                hasMore={hasMore}
                loadMore={loadMore}
                isSyncPathEmpty={effectiveSyncPathEmpty}
                onSyncPathConfigured={
                  isRecentFiles
                    ? handleNavigateToSettings
                    : handleStartSyncing
                }
                onUploadFile={handleContextUploadFile}
                onAddFolder={handleContextAddFolder}
                onAddSyncFolder={handleContextAddSyncFolder}
              />
            );

            const refreshForCurrentView = isRecentFiles
              ? refreshRecentFilesCallback
              : isNested
                ? refreshNestedListing
                : refreshUserFilesCallback;

            const driveHeader = (
              <DriveHeader
                isRecentFiles={isRecentFiles}
                isRefetching={isRefetching}
                isFetching={isFetching}
                formattedStorageSize={formattedStorageSize}
                allFilteredDataLength={displayedFileCount}
                viewMode={viewMode}
                setViewMode={handleViewModeChange}
                searchTerm={searchTerm}
                handleSearchChange={handleSearchChange}
                activeFilters={activeFilters}
                handleRemoveFilter={handleRemoveFilter}
                refetchUserFiles={refreshForCurrentView}
                addButtonRef={addButtonRef}
                privateFileCount={privateFileCount}
                isSyncPathEmpty={effectiveSyncPathEmpty}
                onStartSyncing={handleStartSyncing}
                hasNoSyncPaths={hasNoSyncPaths}
                onNavigateToSettings={handleNavigateToSettings}
                selectedFileTypes={filterState.fileTypes}
                selectedDate={filterState.date}
                selectedFileSizes={filterState.fileSizes}
                onFileTypesChange={handleFileTypesChange}
                onDateChange={handleDateChange}
                onFileSizesChange={handleFileSizesChange}
                defaultFolderLabel={activeSyncFolderLabel}
                isFolderUploadOpen={isFolderUploadOpen}
                onSetFolderUploadOpen={setIsFolderUploadOpen}
                breadcrumbSegments={breadcrumbSegments}
                onBreadcrumbLocalClick={handleNavigateToLocalView}
                isNested={isNested}
                nestedFolderName={isNested ? urlFolderName : null}
                nestedSubfolderPath={isNested ? urlSubFolderPath : null}
                nestedSyncBasePath={
                  isNested ? (nestedDrive?.syncPath ?? null) : null
                }
                nestedMainFolderActualName={
                  isNested ? urlMainFolderActualName : null
                }
                onNestedUploadSuccess={
                  isNested ? refreshNestedListing : undefined
                }
                onDownloadFolder={
                  isNested ? handleDownloadNestedFolder : undefined
                }
                isDownloadingFolder={isDownloadingFolder}
              >
                {!isRecentFiles && driveContent}
              </DriveHeader>
            );

            if (isRecentFiles) {
              // Recent Files card — unchanged. DriveContent sits as a sibling
              // of DriveHeader inside the outer card.
              return (
                <div className="bg-grey-light-300 border border-grey-dark-100 rounded-[8px] shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.04)] dark:bg-black-primary-bg dark:border-black-300 dark:shadow-[0px_1px_1.1px_0px_rgba(0,0,0,0.4)]">
                  {driveHeader}
                  {driveContent}
                </div>
              );
            }

            // Drive view — DriveHeader owns the nested card structure and
            // hosts DriveContent as its children.
            return driveHeader;
          })()}
        </div>
      </FileSelectionProvider>
    );
  }

  return (
    <>
      {content}

      <HcfsSetupDialog
        open={showHcfsSetup}
        onClose={() => setShowHcfsSetup(false)}
        onComplete={handleHcfsSetupComplete}
        loading={isInitializing}
      />

      <MnemonicBackupDialog
        open={showMnemonicBackup}
        mnemonic={mnemonicToBackup || ""}
        onConfirm={handleMnemonicBackupConfirm}
        onClose={handleMnemonicBackupConfirm}
      />
    </>
  );
};

export default DriveContainer;
