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
import FileDetailsDialogContent from "@/app/components/page-sections/drive/file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/SidebarDialog";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { useRouter } from "next/navigation";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { FormattedTimestamp } from "@/app/components/ui"; // Add this import
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealFile } from "@/lib/utils/revealFile";
import { macosNameCmp } from "@/lib/utils/fileSort";

import { toast } from "sonner";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
const columnHelper = createColumnHelper<FormattedUserFile>();

// Default widths when NOT in selection mode (no selection column)
const DEFAULT_COLUMN_WIDTHS_NO_SELECTION = {
  name: 35,
  size: 12,
  date_uploaded: 32,
  type: 16,
  actions: 5,
};

const MIN_COLUMN_WIDTHS = {
  selection: 10,
  name: 17,
  size: 15,
  date_uploaded: 28,
  type: 20,
  actions: 10,
};

// Store the "base" column widths (without selection column) to preserve user preferences
const getStoredBaseColumnWidths = (isRecentFiles: boolean) => {
  if (typeof window === "undefined") return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  try {
    const key = `filesTable_baseColumnWidths_${isRecentFiles ? "recent" : "main"}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored);
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
  }) => {
    const { polkadotAddress } = useWalletAuth();
    // Share-feature gating: only show the menu item when the connected
    // hcfs-server advertises `shares: true`. The atom is populated once
    // per session by `useServerCapabilities` (mounted in SyncEventLogger).
    const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
    const setShareModalFile = useSetAtom(shareModalFileAtom);
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

    const [sorting, setSorting] = useState<SortingState>([]);
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

    const [localFileDetailsFile, setLocalFileDetailsFile] =
      useState<FormattedUserFile | null>(null);
    const [localIsFileDetailsOpen, setLocalIsFileDetailsOpen] = useState(false);

    // Look up the latest version of the file details from live query data.
    // The captured snapshot may have stale arion hashes if it was opened
    // before sync completed.
    const liveLocalFileDetailsFile = useMemo(() => {
      if (!localFileDetailsFile) return null;
      return (
        allFiles.find(
          (f) =>
            f.actualFileName === localFileDetailsFile.actualFileName &&
            f.label === localFileDetailsFile.label,
        ) ?? localFileDetailsFile
      );
    }, [localFileDetailsFile, allFiles]);

    const { setSelectedFile, handleShowFileDetails, handleContextMenu } =
      sharedState || {};

    const localHandleShowFileDetails = useCallback(
      (file: FormattedUserFile) => {
        if (!handleShowFileDetails) {
          setLocalFileDetailsFile(file);
          setLocalIsFileDetailsOpen(true);
        } else {
          handleShowFileDetails(file);
        }
      },
      [handleShowFileDetails],
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
      ) => {
        // Compute folderUrl if file is a folder
        let folderUrl: string | undefined = undefined;
        if (file.isFolder) {
          const { url } = generateFolderUrl(file, getParam);
          folderUrl = url;
        }

        return [
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
      return [
        ...selectionColumn,
        columnHelper.accessor("name", {
          header: "NAME",
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
            const { fileFormat } = getFilePartsFromFileName(info.getValue());
            const fileType = getFileTypeFromExtension(fileFormat || null);

            if (fileType === "video") {
              return (
                <>
                  {isSelectionMode ? (
                    <NameCell
                      className="px-2 py-[5px]"
                      rawName={info.getValue()}
                      actualName={info.row.original.actualFileName}
                      label={info.row.original.label}
                      arionHash={info.row.original.arionHash}
                      isAssigned={info.row.original.isAssigned}
                      fileType={fileType}
                      isPreviewable={false}
                      isFolder={info.row.original.isFolder}
                      source={info.row.original.source}
                      mainReqHash={info.row.original.mainReqHash}
                      syncStatus={info.row.original.syncStatus}
                    />
                  ) : (
                    <VideoDialogTrigger
                      onClick={() => handleSetSelectedFile(info.row.original)}
                    >
                      <NameCell
                        rawName={info.getValue()}
                        actualName={info.row.original.actualFileName}
                        label={info.row.original.label}
                        arionHash={info.row.original.arionHash}
                        isAssigned={info.row.original.isAssigned}
                        fileType={fileType}
                        isPreviewable={true}
                        isFolder={info.row.original.isFolder}
                        source={info.row.original.source}
                        mainReqHash={info.row.original.mainReqHash}
                        syncStatus={info.row.original.syncStatus}
                      />
                    </VideoDialogTrigger>
                  )}
                </>
              );
            } else if (fileType === "image") {
              return (
                <>
                  {isSelectionMode ? (
                    <NameCell
                      className="px-2 py-[5px]"
                      rawName={info.getValue()}
                      actualName={info.row.original.actualFileName}
                      label={info.row.original.label}
                      arionHash={info.row.original.arionHash}
                      isAssigned={info.row.original.isAssigned}
                      fileType={fileType}
                      isPreviewable={false}
                      isFolder={info.row.original.isFolder}
                      source={info.row.original.source}
                      mainReqHash={info.row.original.mainReqHash}
                    />
                  ) : (
                    <ImageDialogTrigger
                      onClick={() => handleSetSelectedFile(info.row.original)}
                    >
                      <NameCell
                        rawName={info.getValue()}
                        actualName={info.row.original.actualFileName}
                        label={info.row.original.label}
                        arionHash={info.row.original.arionHash}
                        isAssigned={info.row.original.isAssigned}
                        fileType={fileType}
                        isPreviewable={true}
                        isFolder={info.row.original.isFolder}
                        source={info.row.original.source}
                        mainReqHash={info.row.original.mainReqHash}
                        syncStatus={info.row.original.syncStatus}
                      />
                    </ImageDialogTrigger>
                  )}
                </>
              );
            } else if (fileType === "PDF") {
              return (
                <>
                  {isSelectionMode ? (
                    <NameCell
                      className="px-2 py-[5px]"
                      rawName={info.getValue()}
                      actualName={info.row.original.actualFileName}
                      label={info.row.original.label}
                      arionHash={info.row.original.arionHash}
                      isAssigned={info.row.original.isAssigned}
                      fileType={fileType}
                      isPreviewable={false}
                      isFolder={info.row.original.isFolder}
                      source={info.row.original.source}
                      mainReqHash={info.row.original.mainReqHash}
                    />
                  ) : (
                    <PdfDialogTrigger
                      onClick={() => handleSetSelectedFile(info.row.original)}
                    >
                      <NameCell
                        rawName={info.getValue()}
                        actualName={info.row.original.actualFileName}
                        label={info.row.original.label}
                        arionHash={info.row.original.arionHash}
                        isAssigned={info.row.original.isAssigned}
                        fileType={fileType}
                        isPreviewable={true}
                        isFolder={info.row.original.isFolder}
                        source={info.row.original.source}
                        mainReqHash={info.row.original.mainReqHash}
                        syncStatus={info.row.original.syncStatus}
                      />
                    </PdfDialogTrigger>
                  )}
                </>
              );
            }
            return (
              <NameCell
                className="px-2 py-[5px]"
                rawName={info.getValue()}
                actualName={info.row.original.actualFileName}
                label={info.row.original.label}
                arionHash={info.row.original.arionHash}
                isAssigned={info.row.original.isAssigned}
                fileType={fileType || "document"}
                isFolder={info.row.original.isFolder}
                source={info.row.original.source}
                mainReqHash={info.row.original.mainReqHash}
                syncStatus={info.row.original.syncStatus}
              />
            );
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
            const menuItems = createTableItems(file, fileType, resolvedHash);

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
    }, [handleSetSelectedFile, createTableItems, isSelectionMode, files]);

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
                className="h-8 px-2 py-2 border-x-0 border-r last:border-r-0 border-grey-dark-100 text-grey-dark-600 dark:bg-black-600 dark:border-black-300 dark:hover:bg-black-400"
              />
            ))}
          </TableModule.Tr>
        )),
      [table, columnWidths, handleResizeStart, justResized, sorting],
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

          return (
            <TableModule.Tr
              rowHover
              key={`${row.id}-${rowState}`}
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
                  target.closest(".checkbox-container")
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
          );
        }),
      [
        visibleRows,
        localHandleContextMenu,
        isSelectionMode,
        toggleFileSelection,
        selectedFiles,
        columnWidths,
      ],
    );

    const dialogComponent = useMemo(() => {
      if (sharedState || !localIsFileDetailsOpen) return null;
      return (
        <SidebarDialog
          heading={`${
            liveLocalFileDetailsFile?.isFolder ? "Folder" : "File"
          } Details`}
          open={localIsFileDetailsOpen}
          onOpenChange={setLocalIsFileDetailsOpen}
        >
          <FileDetailsDialogContent
            file={liveLocalFileDetailsFile ?? undefined}
          />
        </SidebarDialog>
      );
    }, [sharedState, localIsFileDetailsOpen, liveLocalFileDetailsFile]);

    return (
      <div className="flex flex-col gap-y-8 relative">
        <div
          className={cn(
            "w-full relative",
            !isRecentFiles && "min-h-[43.75rem]",
          )}
        >
          <TableModule.TableWrapper
            className={cn(
              "duration-300 delay-300 bg-white border-grey-dark-100 rounded-[8px] dark:bg-black-600 dark:border-black-300",
            )}
            key={`table-${files?.length}-${isSelectionMode}`}
          >
            <TableModule.Table
              className="w-full table-fixed"
              key={`table-${isSelectionMode}`}
            >
              <TableModule.THead onContextMenu={onHeaderContextMenu}>
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
