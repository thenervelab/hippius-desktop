import React, {
  FC,
  useState,
  useMemo,
  useEffect,
  useCallback,
  memo,
  useRef,
} from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
  SortingState,
} from "@tanstack/react-table";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { useSyncSnapshot } from "@/lib/hooks/useSyncSnapshot";
import * as TableModule from "@/components/ui/alt-table";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Link2,
  MoreVertical,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  shareFeatureEnabledAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { cn } from "@/lib/utils";
import NameCell from "./NameCell";
import SelectionActionBar from "../SelectionActionBar";
import { SelectionColumn, SelectionHeaderColumn } from "../SelectionColumn";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import {
  getFileTypeFromExtension,
  getFileTypeDisplayLabel,
} from "@/lib/utils/getTileTypeFromExtension";
import { VideoDialogTrigger } from "./VideoDialog";
import { ImageDialogTrigger } from "./ImageDialog";
import { PdfDialogTrigger } from "./PdfDialog";
import { Icons } from "@/app/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "@/app/components/page-sections/drive/shared/FileViewUtils";
import { fileDetailsPanelAtom } from "@/app/lib/global-atoms/fileDetailsAtoms";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { useRouter } from "next/navigation";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { FormattedTimestamp } from "@/app/components/ui"; // Add this import
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealFile } from "@/lib/utils/revealFile";
import { macosNameCmp } from "@/lib/utils/fileSort";
import ExpandedFolderRows from "./ExpandedFolderRows";
import { NameCellExpander } from "./FolderRail";

import { toast } from "sonner";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
const columnHelper = createColumnHelper<FormattedUserFile>();

// Default widths when NOT in selection mode (no selection column)
const DEFAULT_COLUMN_WIDTHS_NO_SELECTION = {
  name: 37,
  size: 12,
  date_uploaded: 30,
  type: 16,
  actions: 5,
};

const MIN_COLUMN_WIDTHS = {
  selection: 10,
  name: 23,
  size: 15,
  date_uploaded: 28,
  type: 20,
  actions: 10,
};

const normalizeBaseColumnWidths = (value: Record<string, number>) => {
  const merged = {
    ...DEFAULT_COLUMN_WIDTHS_NO_SELECTION,
    ...value,
  };
  delete (merged as Record<string, number | undefined>).selection;
  // Drop the legacy `folder` column from stored widths so users who already
  // had the column persisted in localStorage don't keep its slice after it's
  // been collapsed into the Name column.
  delete (merged as Record<string, number | undefined>).folder;
  const total = Object.values(merged).reduce((sum, width) => sum + width, 0);
  if (total <= 0) {
    return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  }
  if (Math.abs(total - 100) < 0.5) {
    return merged;
  }
  const scale = 100 / total;
  return Object.fromEntries(
    Object.entries(merged).map(([key, width]) => [key, width * scale]),
  ) as Record<string, number>;
};

// Store the "base" column widths (without selection column) to preserve user preferences
const getStoredBaseColumnWidths = (isRecentFiles: boolean) => {
  if (typeof window === "undefined") return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  try {
    const key = `filesTable_baseColumnWidths_${isRecentFiles ? "recent" : "main"}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      return normalizeBaseColumnWidths(JSON.parse(stored));
    }
    return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  } catch {
    return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  }
};

const saveBaseColumnWidths = (
  columnWidths: Record<string, number>,
  isRecentFiles: boolean,
) => {
  if (typeof window === "undefined") return;
  try {
    // Remove selection column before saving as base widths
    const baseWidths = { ...columnWidths };
    delete baseWidths.selection;

    const key = `filesTable_baseColumnWidths_${isRecentFiles ? "recent" : "main"}`;
    localStorage.setItem(key, JSON.stringify(baseWidths));
  } catch {}
};

// Convert base widths to selection mode or normal mode
const convertBaseWidthsToMode = (
  baseWidths: Record<string, number>,
  isSelectionMode: boolean,
) => {
  if (!isSelectionMode) {
    return baseWidths;
  }

  // Convert to selection mode - scale down to make room for selection column
  const selectionColumnWidth = 5;
  const availableWidthForOthers = 100 - selectionColumnWidth;
  const currentTotal = Object.values(baseWidths).reduce(
    (sum, width) => sum + width,
    0,
  );
  const scaleFactor = availableWidthForOthers / currentTotal;

  const selectionModeWidths: Record<string, number> = {};
  Object.keys(baseWidths).forEach((key) => {
    selectionModeWidths[key] = baseWidths[key] * scaleFactor;
  });
  selectionModeWidths.selection = selectionColumnWidth;

  return selectionModeWidths;
};

interface FilesTableProps {
  files: FormattedUserFile[];
  allFiles: FormattedUserFile[];
  isRecentFiles?: boolean;
  sharedState?: FileViewSharedState;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string,
  ) => void;
  hasMore: boolean;
  loadMore: () => void;
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
  drivePathsByLabel?: Record<string, string>;
  currentSubfolderPath?: string | null;
  searchTerm?: string;
  activeFilterCount?: number;
}

const FilesTable: FC<FilesTableProps> = memo(
  ({
    files,
    allFiles,
    isRecentFiles = false,
    sharedState,
    handleFileDownload,
    hasMore,
    loadMore,
    onHeaderContextMenu,
    drivePathsByLabel,
    currentSubfolderPath,
    searchTerm,
    activeFilterCount,
  }) => {
    const { polkadotAddress } = useWalletAuth();
    const drivePaths = useMemo(
      () => drivePathsByLabel ?? {},
      [drivePathsByLabel],
    );
    const normalizedSubfolderPath = useMemo(() => {
      if (!currentSubfolderPath) return "";
      return currentSubfolderPath.replace(/^\/+|\/+$/g, "");
    }, [currentSubfolderPath]);

    const resolveRelativePath = useCallback(
      (basePath: string, entryName: string) => {
        const normalizedName = entryName.replace(/^\/+|\/+$/g, "");
        if (!basePath) return normalizedName;
        if (
          normalizedName === basePath ||
          normalizedName.startsWith(`${basePath}/`)
        ) {
          return normalizedName;
        }
        if (normalizedName.includes("/")) return normalizedName;
        return `${basePath}/${normalizedName}`;
      },
      [],
    );

    const getFolderKey = useCallback(
      (file: FormattedUserFile, basePath = normalizedSubfolderPath) => {
        const name = file.actualFileName || file.name;
        const relativePath = resolveRelativePath(basePath, name);
        return `${file.label ?? ""}::${relativePath}`;
      },
      [normalizedSubfolderPath, resolveRelativePath],
    );

    const [expandedFolders, setExpandedFolders] = useState<
      Record<string, boolean>
    >({});
    const toggleFolderExpanded = useCallback((folderKey: string) => {
      setExpandedFolders((previous) => ({
        ...previous,
        [folderKey]: !previous[folderKey],
      }));
    }, []);
    // Share-feature gating: only show the menu item when the connected
    // hcfs-server advertises `shares: true`. The atom is populated once
    // per session by `useServerCapabilities` (mounted in SyncEventLogger).
    const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
    const setShareModalFile = useSetAtom(shareModalFileAtom);
    const enableFolderExpander = !isRecentFiles;
    // Enrich syncStatus with live snapshot data to distinguish uploads vs downloads.
    // Also suppress the "pending" upload arrow for files that just finished downloading
    // (they appear locally before the synced-set updates, so the backend marks them "pending").
    //
    // Matching uses snapshot `path` (full relative path) first, then falls back to
    // `fileName` (basename). The "Your Files" page lists all files as basenames
    // (actualFileName = "photo.jpg"), while subfolder views use relative paths
    // (actualFileName = "subfolder/photo.jpg"). The snapshot always has the full path.
    const snapshot = useSyncSnapshot();
    // Stable signature of the actionable snapshot rows. The snapshot atom
    // is replaced wholesale on every progress event (~250ms during sync,
    // see useSyncSnapshotListener), so `snapshot.files` gets a new
    // reference every tick even when nothing material changed for the
    // file table. Reducing first to this string lets the downstream
    // `enrichedAllFiles` memo skip its O(allFiles) re-map whenever the
    // actionable set is content-equal — which is the common case during
    // a sync of large files where bytes change but row status doesn't.
    const actionSignature = useMemo(() => {
      const parts: string[] = [];
      for (const f of snapshot.files) {
        const isInFlight =
          f.status !== "completed" &&
          (f.action === "upload" || f.action === "download");
        const isCompletedDownload =
          f.status === "completed" && f.action === "download";
        if (isInFlight || isCompletedDownload) {
          parts.push(`${f.path}|${f.fileName}|${f.status}|${f.action}`);
        }
      }
      parts.sort();
      return parts.join(",");
    }, [snapshot.files]);

    const enrichedAllFiles = useMemo(() => {
      if (actionSignature === "") return allFiles;

      // Index by full path (preferred, no collisions) and basename (fallback)
      const actionByPath = new Map<string, "upload" | "download">();
      const actionByName = new Map<string, "upload" | "download">();
      const completedDownloadPaths = new Set<string>();
      const completedDownloadNames = new Set<string>();

      for (const f of snapshot.files) {
        if (
          f.status !== "completed" &&
          (f.action === "upload" || f.action === "download")
        ) {
          actionByPath.set(f.path, f.action);
          actionByName.set(f.fileName, f.action);
        } else if (f.status === "completed" && f.action === "download") {
          completedDownloadPaths.add(f.path);
          completedDownloadNames.add(f.fileName);
        }
      }

      return allFiles.map((file) => {
        const key = file.actualFileName || file.name;
        const action = actionByPath.get(key) ?? actionByName.get(key);
        if (action) {
          const liveSyncStatus: FormattedUserFile["syncStatus"] =
            action === "download" ? "downloading" : "uploading";
          return { ...file, syncStatus: liveSyncStatus };
        }
        // File just finished downloading but backend still reports "pending"
        // because the synced-set hasn't refreshed yet — mark as synced.
        if (
          file.syncStatus === "pending" &&
          (completedDownloadPaths.has(key) || completedDownloadNames.has(key))
        ) {
          return { ...file, syncStatus: "synced" as const };
        }
        return file;
      });
      // `snapshot.files` is intentionally captured by the closure rather
      // than declared as a dep: when actionSignature is unchanged the
      // snapshot.files contents are equivalent (same actionable rows,
      // different reference), so re-running would just re-allocate.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allFiles, actionSignature]);

    // Reserve the leading chevron slot only when the visible rows include
    // at least one folder; pure-file views (or empty sync folders) skip
    // the slot so file names sit flush against the cell edge and the
    // "Name" header lines up with them.
    const hasAnyFolder = useMemo(
      () => enrichedAllFiles.some((file) => file.isFolder),
      [enrichedAllFiles],
    );

    // Sentinel ref for infinite scroll
    const sentinelRef = useRef<HTMLDivElement>(null);

    // IntersectionObserver for infinite scroll
    useEffect(() => {
      if (!hasMore) return;
      const sentinel = sentinelRef.current;
      if (!sentinel) return;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            loadMore();
          }
        },
        { rootMargin: "200px" },
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [hasMore, loadMore]);

    useEffect(() => {
      setExpandedFolders((previous) => {
        const validKeys = new Set(
          allFiles
            .filter((file) => file.isFolder)
            .map((file) => getFolderKey(file)),
        );
        const nextEntries = Object.entries(previous).filter(([key]) =>
          validKeys.has(key),
        );
        return Object.fromEntries(nextEntries);
      });
    }, [allFiles, getFolderKey]);

    useEffect(() => {
      setExpandedFolders({});
    }, [searchTerm, activeFilterCount, normalizedSubfolderPath, isRecentFiles]);

    const [sorting, setSorting] = useState<SortingState>([]);
    const sortBy = useMemo<
      "name" | "size" | "date_uploaded" | undefined
    >(() => {
      const activeSort = sorting[0];
      if (!activeSort) return undefined;
      if (activeSort.id === "name") return "name";
      if (activeSort.id === "size") return "size";
      if (activeSort.id === "date_uploaded") return "date_uploaded";
      return undefined;
    }, [sorting]);
    const sortDir = useMemo<"asc" | "desc" | undefined>(() => {
      const activeSort = sorting[0];
      if (!activeSort) return undefined;
      return activeSort.desc ? "desc" : "asc";
    }, [sorting]);
    const { getParam } = useUrlParams();
    const router = useRouter();
    const {
      isSelectionMode,
      selectedFiles,
      enterSelectionModeAndSelectFile,
      toggleFileSelection,
    } = useFileSelection();

    // State for captured files to delete (to handle timing issue with clearSelection)
    const [filesToDelete, setFilesToDelete] = useState<FormattedUserFile[]>([]);

    const { mutate: deleteFiles, isPending: isDeleting } = useDeleteFile({
      files: filesToDelete,
    });

    // Defensive fallback: if no sharedState was passed, dispatch directly to
    // the global file-details atom so the inline panel still opens.
    const setFileDetailsAtom = useSetAtom(fileDetailsPanelAtom);

    const { setSelectedFile, handleShowFileDetails, handleContextMenu } =
      sharedState || {};

    const localHandleShowFileDetails = useCallback(
      (file: FormattedUserFile) => {
        if (handleShowFileDetails) {
          handleShowFileDetails(file);
        } else {
          setFileDetailsAtom(file);
        }
      },
      [handleShowFileDetails, setFileDetailsAtom],
    );

    const localHandleContextMenu = useCallback(
      (e: React.MouseEvent, file: FormattedUserFile) => {
        if (handleContextMenu) {
          handleContextMenu(e, file);
        }
      },
      [handleContextMenu],
    );

    // Memoize handler functions to maintain stable references
    const handleDownload = useCallback(
      (file: FormattedUserFile) => {
        handleFileDownload(file, polkadotAddress ?? "");
      },
      [handleFileDownload, polkadotAddress],
    );

    const handleSetSelectedFile = useCallback(
      (file: FormattedUserFile) => {
        setSelectedFile?.(file);
      },
      [setSelectedFile],
    );

    const handleDeleteFile = useCallback(
      (file: FormattedUserFile) => {
        // Enter selection mode and select this file for deletion
        enterSelectionModeAndSelectFile(file);
      },
      [enterSelectionModeAndSelectFile],
    );

    // Handle file deletion with captured files from confirmation dialog
    const handleDeleteSelectedFiles = useCallback(
      (capturedFiles: FormattedUserFile[]) => {
        if (capturedFiles.length === 0) return;

        setFilesToDelete(capturedFiles);

        // Use setTimeout to ensure the delete hook reinitializes with new files
        setTimeout(() => {
          deleteFiles(undefined, {
            onSuccess: () => {
              setFilesToDelete([]);
            },
            onError: () => {
              setFilesToDelete([]);
            },
          });
        }, 100);
      },
      [deleteFiles],
    );
    const createTableItems = useCallback(
      (
        file: FormattedUserFile,
        fileType: string | null,
        arionHash: string,
        canPreview: boolean = true,
        folderExpansion?: { expanded: boolean; onToggle: () => void },
        // Parent path inside the sync drive when the action menu is
        // built for a row in an inline-expanded subtree. Without it,
        // the "Open" item would inherit the page URL's subFolderPath
        // and skip the intermediate folders the user expanded into.
        parentSubFolderPath?: string,
      ) => {
        // Compute folderUrl if file is a folder
        let folderUrl: string | undefined = undefined;
        if (file.isFolder) {
          const { url } = generateFolderUrl(
            file,
            getParam,
            parentSubFolderPath,
          );
          folderUrl = url;
        }

        return [
          ...(file.isFolder && folderExpansion
            ? [
                {
                  icon: folderExpansion.expanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  ),
                  itemTitle: folderExpansion.expanded
                    ? "Collapse Folder"
                    : "Expand Folder",
                  onItemClick: folderExpansion.onToggle,
                },
              ]
            : []),
          ...(file.isFolder && folderUrl
            ? [
                {
                  icon: <Folder className="size-4" />,
                  itemTitle: "Open",
                  onItemClick: () => {
                    router.push(folderUrl);
                  },
                },
              ]
            : []),
          {
            icon: <Download className="size-4" />,
            itemTitle: "Download",
            onItemClick: () => handleDownload(file),
          },
          ...((fileType === "video" ||
            fileType === "image" ||
            fileType === "PDF") &&
          canPreview
            ? [
                {
                  icon: <Icons.Eye className="size-4" />,
                  itemTitle: "View",
                  onItemClick: () => handleSetSelectedFile(file),
                },
              ]
            : []),

          {
            icon: <FolderOpen className="size-4" />,
            itemTitle: "Reveal in Finder",
            onItemClick: async () => {
              try {
                await revealFile({
                  sourcePath: file.source,
                  label: file.label,
                  accountId: polkadotAddress ?? undefined,
                  fileName: file.actualFileName || file.name,
                });
              } catch (error) {
                console.error("Failed to reveal file in Finder:", error);
                toast.error(
                  "File is not available locally. It may only exist on another device.",
                );
              }
            },
          },
          {
            icon: <Icons.InfoCircle className="size-4" />,
            itemTitle: `${file?.isFolder ? "Folder" : "File"} Details`,
            onItemClick: () => localHandleShowFileDetails(file),
          },
          ...(!file.isFolder && arionHash && arionHash !== "pending"
            ? [
                {
                  icon: <Icons.SendSquare2 className="size-4" />,
                  itemTitle: "View on Explorer",
                  onItemClick: async () => {
                    try {
                      await openUrl(
                        `https://hipstats.com/file-tracker/${arionHash}`,
                      );
                    } catch (error) {
                      console.error("Failed to open Explorer:", error);
                    }
                  },
                },
              ]
            : []),
          // Share via link — same gating as the right-click context menu
          // in `app/components/ui/context-menu/index.tsx`. Hidden for
          // folders, mid-flight files, and old hcfs-servers that don't
          // advertise `shares: true`.
          ...(!file.isFolder && file.syncStatus === "synced" && shareEnabled
            ? [
                {
                  icon: <Link2 className="size-4" />,
                  itemTitle: "Share via link",
                  onItemClick: () => {
                    setShareModalFile(file);
                  },
                },
              ]
            : []),
          // Always show delete option, but disabled for unpinned files
          {
            icon: <Icons.Trash className="size-4" />,
            itemTitle: !file.isAssigned
              ? "Delete (Syncing in progress...)"
              : "Delete",
            disabled: !file.isAssigned,
            tooltip: !file.isAssigned
              ? "This file is currently being synced and cannot be deleted yet. Please wait for the sync to complete."
              : undefined,
            onItemClick: () => {
              if (file.isAssigned) {
                handleDeleteFile(file);
              }
            },
            variant: "destructive" as const,
          },
        ];
      },
      [
        handleDownload,
        handleSetSelectedFile,
        localHandleShowFileDetails,
        handleDeleteFile,
        getParam,
        router,
        polkadotAddress,
        shareEnabled,
        setShareModalFile,
      ],
    );

    // Create a stable memo of columns that doesn't depend on every prop
    const columns = useMemo(() => {
      // Create selection column inside useMemo to capture fresh values
      const selectionColumn = !isSelectionMode
        ? []
        : [
            columnHelper.display({
              id: "selection",
              header: () => {
                return (
                  <div className="flex justify-center items-center h-full">
                    <SelectionHeaderColumn files={files} />
                  </div>
                );
              },
              cell: ({ row }) => (
                <div className="flex justify-center items-center h-full px-2">
                  <SelectionColumn row={row} />
                </div>
              ),
            }),
          ];
      // Mirrors the row layout used by ExpandedFolderRows so top-level
      // and nested rows align icon-to-icon: a fixed-width chevron slot
      // (folders get an interactive button, files get an empty spacer)
      // followed by the existing NameCell or dialog-trigger content.
      const renderNameCellWithExpander = (
        file: FormattedUserFile,
        children: React.ReactNode,
      ) => {
        const folderKey = file.isFolder ? getFolderKey(file) : "";
        const isExpanded = file.isFolder
          ? Boolean(expandedFolders[folderKey])
          : false;
        const canExpand = Boolean(
          file.isFolder &&
            enableFolderExpander &&
            file.label &&
            drivePaths[file.label],
        );
        return (
          <div className="flex items-center min-w-0 gap-2 py-[5px] pl-2 pr-2">
            {hasAnyFolder ? (
              <NameCellExpander
                expanded={isExpanded}
                interactive={canExpand}
                isFolder={Boolean(file.isFolder)}
                onToggle={canExpand ? () => toggleFolderExpanded(folderKey) : undefined}
              />
            ) : null}
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        );
      };
      const triggerClass = "min-w-0 px-0 py-0";
      return [
        ...selectionColumn,
        columnHelper.accessor("name", {
          header: "Name",
          enableSorting: true,
          id: "name",
          sortingFn: (rowA, rowB, columnId) =>
            macosNameCmp(
              rowA.getValue<string>(columnId) ?? "",
              rowB.getValue<string>(columnId) ?? "",
            ),
          minSize: 200,
          maxSize: 1000,
          cell: (info) => {
            const file = info.row.original;
            const { fileFormat } = getFilePartsFromFileName(info.getValue());
            const fileType = getFileTypeFromExtension(fileFormat || null);

            const nameNode = (
              <NameCell
                rawName={info.getValue()}
                actualName={file.actualFileName}
                label={file.label}
                arionHash={file.arionHash}
                isAssigned={file.isAssigned}
                fileType={fileType || "document"}
                isPreviewable={!isSelectionMode}
                isFolder={file.isFolder}
                source={file.source}
                mainReqHash={file.mainReqHash}
                syncStatus={file.syncStatus}
              />
            );

            let content: React.ReactNode = nameNode;
            if (!isSelectionMode) {
              if (fileType === "video") {
                content = (
                  <VideoDialogTrigger
                    onClick={() => handleSetSelectedFile(file)}
                    className={triggerClass}
                  >
                    {nameNode}
                  </VideoDialogTrigger>
                );
              } else if (fileType === "image") {
                content = (
                  <ImageDialogTrigger
                    onClick={() => handleSetSelectedFile(file)}
                    className={triggerClass}
                  >
                    {nameNode}
                  </ImageDialogTrigger>
                );
              } else if (fileType === "PDF") {
                content = (
                  <PdfDialogTrigger
                    onClick={() => handleSetSelectedFile(file)}
                    className={triggerClass}
                  >
                    {nameNode}
                  </PdfDialogTrigger>
                );
              }
            }

            return renderNameCellWithExpander(file, content);
          },
        }),
        columnHelper.accessor("size", {
          header: "Size",
          enableSorting: true,
          id: "size",
          cell: (cell) => {
            const value = cell.getValue();
            if (cell.row.original.tempData) return "...";
            if (value === undefined || value === 0) return "Unknown";
            return (
              <div className="text-grey-dark-800 text-xs font-medium truncate tracking-[-0.24px]">
                {formatBytesFromBigInt(BigInt(value))}
              </div>
            );
          },
        }),
        columnHelper.accessor("createdAt", {
          header: "Date Uploaded",
          enableSorting: true,
          id: "date_uploaded",
          cell: (cell) => {
            const createdAt = cell.row.original.createdAt;
            return createdAt === 0 ? (
              <div className="truncate text-grey-dark-800 text-xs">—</div>
            ) : (
              <div className="truncate">
                <FormattedTimestamp
                  timestamp={createdAt}
                  className="text-grey-dark-800 text-xs font-medium tracking-[-0.24px]"
                />
              </div>
            );
          },
        }),
        columnHelper.accessor(
          (row) => {
            const { fileFormat } = getFilePartsFromFileName(row.name);
            const fileType = getFileTypeFromExtension(fileFormat || null);
            return row.isFolder ? "Folder" : getFileTypeDisplayLabel(fileType);
          },
          {
            header: "File Type",
            id: "type",
            enableSorting: true,
            cell: ({ getValue }) => {
              const value = getValue();
              return (
                <div className="flex flex-col">
                  <div className="text-grey-dark-800 text-xs font-medium truncate tracking-[-0.24px]">
                    {value}
                  </div>
                </div>
              );
            },
          },
        ),
        columnHelper.display({
          id: "actions",
          header: "",
          minSize: 40,
          maxSize: 60,
          enableResizing: false,
          cell: ({ cell }) => {
            const file = cell.row.original;
            const { arionHash, name } = file;
            const resolvedHash = arionHash;
            const { fileFormat } = getFilePartsFromFileName(name);
            const fileType = getFileTypeFromExtension(fileFormat || null);
            const folderKey = file.isFolder ? getFolderKey(file) : "";
            const isExpanded =
              file.isFolder && folderKey
                ? Boolean(expandedFolders[folderKey])
                : false;
            const canExpand =
              file.isFolder &&
              enableFolderExpander &&
              Boolean(file.label && drivePaths[file.label]);
            const menuItems = createTableItems(
              file,
              fileType,
              resolvedHash,
              true,
              canExpand
                ? {
                    expanded: isExpanded,
                    onToggle: () => toggleFolderExpanded(folderKey),
                  }
                : undefined,
            );

            return (
              <div className="flex justify-center items-center">
                <TableActionMenu dropdownTitle="" items={menuItems}>
                  <Button
                    variant="ghost"
                    size="auto"
                    className="h-6 w-6 p-0 text-grey-70 action-menu-area"
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                </TableActionMenu>
              </div>
            );
          },
        }),
      ];
    }, [
      handleSetSelectedFile,
      createTableItems,
      isSelectionMode,
      files,
      getFolderKey,
      expandedFolders,
      drivePaths,
      enableFolderExpander,
      toggleFolderExpanded,
      hasAnyFolder,
    ]);

    const [columnWidths, setColumnWidths] = useState(() => {
      const baseWidths = getStoredBaseColumnWidths(isRecentFiles);
      return convertBaseWidthsToMode(baseWidths, isSelectionMode);
    });

    const [isResizing, setIsResizing] = useState(false);
    const [resizeData, setResizeData] = useState<{
      columnId: string;
      startX: number;
      startWidth: number;
      nextColumnId: string;
      nextStartWidth: number;
    } | null>(null);
    const [justResized, setJustResized] = useState(false);

    // Load base widths when file context changes (not selection mode)
    useEffect(() => {
      const baseWidths = getStoredBaseColumnWidths(isRecentFiles);
      const newWidths = convertBaseWidthsToMode(baseWidths, isSelectionMode);
      setColumnWidths(newWidths);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isRecentFiles]);

    useEffect(() => {
      const timeoutId = setTimeout(() => {
        saveBaseColumnWidths(columnWidths, isRecentFiles);
      }, 300);
      return () => clearTimeout(timeoutId);
    }, [columnWidths, isRecentFiles]);

    // Handle smooth transition when entering/exiting selection mode
    const [prevSelectionMode, setPrevSelectionMode] = useState(isSelectionMode);

    useEffect(() => {
      if (prevSelectionMode !== isSelectionMode) {
        setPrevSelectionMode(isSelectionMode);

        setColumnWidths((prevWidths: Record<string, number>) => {
          // Get the base widths (without selection column) from current widths
          const baseWidths = { ...prevWidths };
          delete baseWidths.selection;

          // If we have selection column currently, convert back to base proportions
          if (prevWidths.selection) {
            const currentTotal = Object.values(baseWidths).reduce(
              (sum, width) => sum + width,
              0,
            );
            const scaleFactor = 100 / currentTotal;
            Object.keys(baseWidths).forEach((key) => {
              baseWidths[key] = baseWidths[key] * scaleFactor;
            });
          }

          // Convert base widths to the new mode
          return convertBaseWidthsToMode(baseWidths, isSelectionMode);
        });
      }
    }, [isSelectionMode, prevSelectionMode]);

    const handleResizeStart = useCallback(
      (columnId: string, startX: number) => {
        const columnIds = Object.keys(columnWidths);
        const currentIndex = columnIds.indexOf(columnId);
        const nextColumnId = columnIds[currentIndex + 1];

        if (nextColumnId && columnId !== "actions") {
          setIsResizing(true);
          setResizeData({
            columnId,
            startX,
            startWidth: columnWidths[columnId],
            nextColumnId,
            nextStartWidth: columnWidths[nextColumnId],
          });
        }
      },
      [columnWidths],
    );

    const handleResizeMove = useCallback(
      (clientX: number) => {
        if (!resizeData || !isResizing) return;

        // Use requestAnimationFrame for smoother updates
        requestAnimationFrame(() => {
          const diff = clientX - resizeData.startX;
          // Increase sensitivity by using a more responsive calculation
          // Base the percentage on a standard table width for consistent feel
          const standardTableWidth = 1200; // Standard table width for calculation
          const sensitivity = 2.2; // Multiplier for increased responsiveness
          const diffPercent = (diff / standardTableWidth) * 100 * sensitivity;

          const proposedCurrentWidth = resizeData.startWidth + diffPercent;
          const proposedNextWidth = resizeData.nextStartWidth - diffPercent;

          const currentMinWidth =
            MIN_COLUMN_WIDTHS[
              resizeData.columnId as keyof typeof MIN_COLUMN_WIDTHS
            ] || 5;
          const nextMinWidth =
            MIN_COLUMN_WIDTHS[
              resizeData.nextColumnId as keyof typeof MIN_COLUMN_WIDTHS
            ] || 5;

          // Only apply minimum constraints if the proposed width would be below minimum
          const newCurrentWidth =
            proposedCurrentWidth < currentMinWidth
              ? currentMinWidth
              : Math.min(80, proposedCurrentWidth);
          const newNextWidth =
            proposedNextWidth < nextMinWidth
              ? nextMinWidth
              : Math.min(80, proposedNextWidth);

          // Only update if both columns respect their minimums
          if (
            newCurrentWidth >= currentMinWidth &&
            newNextWidth >= nextMinWidth
          ) {
            setColumnWidths((prev: Record<string, number>) => ({
              ...prev,
              [resizeData.columnId]: newCurrentWidth,
              [resizeData.nextColumnId]: newNextWidth,
            }));
          }
        });
      },
      [resizeData, isResizing],
    );
    const handleResizeEnd = useCallback(() => {
      setIsResizing(false);
      setResizeData(null);
      setJustResized(true);
      // Clear the flag after a short delay to allow normal clicking
      setTimeout(() => {
        setJustResized(false);
      }, 100);
    }, []);

    useEffect(() => {
      if (!isResizing) return;

      const handleMouseMove = (e: MouseEvent) => handleResizeMove(e.clientX);
      const handleMouseUp = () => handleResizeEnd();

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    const handleSortingChange = useCallback(
      (
        updaterOrValue: SortingState | ((old: SortingState) => SortingState),
      ) => {
        setSorting(updaterOrValue);
      },
      [],
    );

    const tableConfig = useMemo(
      () => ({
        columns,
        data: enrichedAllFiles || [],
        state: {
          sorting,
        },
        onSortingChange: handleSortingChange,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        manualSorting: false,
        enableRowSelection: false,
        enableMultiRowSelection: false,
        enableSubRowSelection: false,
        // Enable column resizing
        enableColumnResizing: true,
        enableExpanding: false,
        enableGrouping: false,
        // Row identity must be stable across re-orderings (sort, filter,
        // sync re-enrichment). Including the array index would change the
        // ID whenever rows reorder, which causes TanStack to drop per-row
        // state (selection, sort cursor) and triggers DOM unmount/remount
        // of cells — same anti-flicker rationale documented for
        // SyncStatusDialog in CLAUDE.md. `label::actualFileName` is the
        // canonical unique key (sync_paths enforces UNIQUE relative paths
        // per drive, so label + path is globally unique); arionHash is
        // unsuitable on its own because it's "pending"/empty for
        // not-yet-uploaded rows AND identical files synced to two drives
        // share the same hash.
        getRowId: (row: FormattedUserFile) =>
          `${row.label ?? ""}::${row.actualFileName ?? row.name}`,
      }),
      [columns, enrichedAllFiles, sorting, handleSortingChange],
    );

    const table = useReactTable(tableConfig);

    // useReactTable returns a stable `table` reference across renders, so
    // `[table, ...]` deps alone never re-fire when sorting state changes.
    // We MUST include `sorting` so getRowModel() (which yields freshly
    // sorted rows) is re-read on every sort toggle, and so getHeaderGroups()
    // is re-read so each Th picks up the new getIsSorted() value (sort
    // chevron + active style). `enrichedAllFiles` keeps the rows in sync
    // when the data source changes (folder tab switch, sync re-enrichment).
    const visibleRows = useMemo(() => {
      return table.getRowModel().rows;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [table, enrichedAllFiles, sorting]);

    const headerRows = useMemo(
      () =>
        table.getHeaderGroups().map((headerGroup) => (
          <TableModule.Tr
            key={headerGroup.id}
            draggable={false}
            className="border-b-grey-dark-100"
          >
            {headerGroup.headers.map((header) => (
              <TableModule.Th
                key={header.id}
                header={header}
                align={header.id === "selection" ? "center" : "left"}
                columnWidth={columnWidths[header.id]}
                onResizeStart={handleResizeStart}
                preventSort={justResized}
                disableUppercase
                className={cn(
                  "h-8 px-2 py-2 border-x-0 border-r last:border-r-0 border-grey-dark-100 text-grey-dark-600 dark:bg-black-600 dark:border-black-300 dark:hover:bg-black-400",
                  // When the chevron slot is reserved in body rows, indent
                  // the "Name" header by the same amount (slot 20px + gap 8px)
                  // so the label visually lines up with the file names below.
                  header.id === "name" && hasAnyFolder && "pl-9",
                )}
              />
            ))}
          </TableModule.Tr>
        )),
      [table, columnWidths, handleResizeStart, justResized, sorting, hasAnyFolder],
    );

    const columnCount = useMemo(
      () => Object.keys(columnWidths).length,
      [columnWidths],
    );

    // Canonical column order shared by the outer table's <colgroup> and
    // by ExpandedFolderRows so child <tr>s render with the same leading
    // rail cells as the header. Because child rows are rendered as flat
    // siblings of parent rows in the same <tbody> (no nested <table>),
    // every row inherits the colgroup directly and column borders line
    // up exactly regardless of nesting depth or resize state.
    const orderedColumnIds = useMemo(() => {
      const baseOrder = ["selection", "name", "size", "date_uploaded", "type", "actions"];
      return baseOrder.filter((id) => columnWidths[id] !== undefined);
    }, [columnWidths]);

    const tableColgroup = useMemo(
      () => (
        <colgroup>
          {orderedColumnIds.map((id) => (
            <col key={id} style={{ width: `${columnWidths[id]}%` }} />
          ))}
        </colgroup>
      ),
      [orderedColumnIds, columnWidths],
    );

    const tableBody = useMemo(
      () =>
        visibleRows?.map((row) => {
          const rowData = row.original;
          let rowState: "success" | "pending" | "error" = "success";

          if (rowData.tempData) {
            rowState = "pending";
            if (Date.now() - rowData.tempData.uploadTime > TIME_BEFORE_ERR) {
              rowState = "error";
            }
          }

          const rowKey = rowData.isFolder
            ? getFolderKey(rowData)
            : `${rowData.label ?? ""}::${rowData.actualFileName ?? rowData.name}`;
          const isExpanded = Boolean(expandedFolders[rowKey]);
          const syncPath = rowData.label
            ? drivePaths[rowData.label]
            : undefined;
          const canInlineExpand =
            enableFolderExpander && rowData.isFolder && Boolean(syncPath);

          return (
            <React.Fragment key={`${row.id}-${rowState}`}>
              <TableModule.Tr
                rowHover
                transparent
                className={cn(
                  "border-b-0 odd:bg-grey-light-200 even:bg-grey-light-400 hover:bg-grey-light-300 dark:odd:bg-black-500 dark:even:bg-black-primary-bg dark:hover:bg-black-300",
                  rowState === "pending" && "animate-pulse",
                  rowState === "error" && "bg-red-200/20",
                  isSelectionMode && rowData.isAssigned && "cursor-pointer",
                  isSelectionMode &&
                    selectedFiles.some(
                      (f) =>
                        f.actualFileName === rowData.actualFileName &&
                        f.label === rowData.label,
                    ) &&
                    rowData.isAssigned &&
                    "bg-primary-60/10",
                  isSelectionMode &&
                    !selectedFiles.some(
                      (f) =>
                        f.actualFileName === rowData.actualFileName &&
                        f.label === rowData.label,
                    ) &&
                    rowData.isAssigned &&
                    "hover:bg-primary-60/8",
                  isSelectionMode &&
                    !rowData.isAssigned &&
                    "opacity-50 cursor-not-allowed",
                )}
                onContextMenu={(e) => localHandleContextMenu(e, rowData)}
                onClick={(e) => {
                  // Don't handle clicks if it's on the action menu area or checkbox area
                  const target = e.target as HTMLElement;
                  if (
                    target.closest(".action-menu-area") ||
                    target.closest('[role="checkbox"]') ||
                    target.closest(".checkbox-container") ||
                    target.closest(".folder-expander-area")
                  ) {
                    return;
                  }

                  if (isSelectionMode && rowData.isAssigned) {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleFileSelection(rowData);
                  }
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableModule.Td
                    className={cn(
                      "px-2 py-[5px] border-x-0 border-r last:border-r-0 border-grey-dark-100 text-grey-dark-800 text-xs dark:border-black-300",
                      cell.column.id === "actions" && "p-0",
                      cell.column.id === "name" && "p-0 relative",
                      cell.column.id === "arionHash" && "p-0",
                    )}
                    key={cell.id}
                    cell={cell}
                    columnWidth={columnWidths[cell.column.id]}
                  />
                ))}
              </TableModule.Tr>

              {rowData.isFolder && isExpanded && canInlineExpand && (
                <ExpandedFolderRows
                  folder={rowData}
                  accountId={polkadotAddress}
                  syncPath={syncPath}
                  label={rowData.label}
                  baseSubfolderPath={normalizedSubfolderPath}
                  orderedColumnIds={orderedColumnIds}
                  createTableItems={createTableItems}
                  onSelectFile={handleSetSelectedFile}
                  onRowContextMenu={localHandleContextMenu}
                  onOpenFolder={(childFile, parentPath) => {
                    const { url } = generateFolderUrl(
                      childFile,
                      getParam,
                      parentPath,
                    );
                    router.push(url);
                  }}
                  sortBy={sortBy}
                  sortDir={sortDir}
                />
              )}
            </React.Fragment>
          );
        }),
      [
        visibleRows,
        localHandleContextMenu,
        isSelectionMode,
        toggleFileSelection,
        selectedFiles,
        columnWidths,
        expandedFolders,
        createTableItems,
        getFolderKey,
        drivePaths,
        enableFolderExpander,
        normalizedSubfolderPath,
        polkadotAddress,
        handleDownload,
        handleSetSelectedFile,
        getParam,
        router,
        columnCount,
        sortBy,
        sortDir,
        orderedColumnIds,
      ],
    );

    // The inline FileDetailsPanel is mounted at the FilesPage level and
    // reads from the global atom — no local dialog mount needed here.
    const dialogComponent = null;

    return (
      <div className="flex flex-col gap-y-8 relative">
        <div className="w-full relative">
          <TableModule.TableWrapper
            className={cn(
              "duration-300 delay-300 bg-white border-grey-dark-100 rounded-[8px] dark:bg-black-600 dark:border-black-300",
              // Drive (non-recent) view: table sits flush inside the inner
              // white card from DriveHeader, so its own rounded corners and
              // outer border would compete visually with the card. Strip both.
              // Recent Files keeps the standalone card look.
              !isRecentFiles && "rounded-none border-0 bg-transparent",
            )}
            key={`table-${files?.length}-${isSelectionMode}`}
          >
            <TableModule.Table
              className="w-full table-fixed border-collapse"
              key={`table-${isSelectionMode}`}
              style={{ borderSpacing: 0 }}
            >
              {tableColgroup}
              <TableModule.THead
                onContextMenu={onHeaderContextMenu}
                className={cn(!isRecentFiles ? "!bg-transparent" : "")}
              >
                {headerRows}
              </TableModule.THead>
              <TableModule.TBody>{tableBody}</TableModule.TBody>
            </TableModule.Table>
          </TableModule.TableWrapper>
          {/* Sentinel element for infinite scroll */}
          <div
            ref={sentinelRef}
            className={cn("h-1 -mt-1", isSelectionMode && "mb-20")}
          />
        </div>

        {/* Selection action bar positioned above pagination */}
        {isSelectionMode && (
          <SelectionActionBar
            onDelete={handleDeleteSelectedFiles}
            isDeleting={isDeleting}
          />
        )}

        {dialogComponent}
      </div>
    );
  },
);

FilesTable.displayName = "FilesTable";

export default FilesTable;
