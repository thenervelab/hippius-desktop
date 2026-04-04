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
  MoreVertical,
  Folder,
  FolderOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import NameCell from "./NameCell";
import SelectionActionBar from "../SelectionActionBar";
import { SelectionColumn, SelectionHeaderColumn } from "../SelectionColumn";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import { getFileTypeFromExtension, getFileTypeDisplayLabel } from "@/lib/utils/getTileTypeFromExtension";
import { VideoDialogTrigger } from "./VideoDialog";
import { ImageDialogTrigger } from "./ImageDialog";
import { PdfDialogTrigger } from "./PdfDialog";
import { Icons } from "@/app/components/ui";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "@/app/components/page-sections/files/shared/FileViewUtils";
import FileDetailsDialogContent from "@/app/components/page-sections/files/file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/SidebarDialog";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { useRouter } from "next/navigation";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { FormattedTimestamp } from "@/app/components/ui"; // Add this import
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealFile } from "@/lib/utils/revealFile";

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
    const key = `filesTable_baseColumnWidths_${isRecentFiles ? 'recent' : 'main'}`;
    const stored = localStorage.getItem(key);
    if (stored) {
      return JSON.parse(stored);
    }
    return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  } catch {
    return DEFAULT_COLUMN_WIDTHS_NO_SELECTION;
  }
};

const saveBaseColumnWidths = (columnWidths: Record<string, number>, isRecentFiles: boolean) => {
  if (typeof window === "undefined") return;
  try {
    // Remove selection column before saving as base widths
    const baseWidths = { ...columnWidths };
    delete baseWidths.selection;

    const key = `filesTable_baseColumnWidths_${isRecentFiles ? 'recent' : 'main'}`;
    localStorage.setItem(key, JSON.stringify(baseWidths));
  } catch { }
};

// Convert base widths to selection mode or normal mode
const convertBaseWidthsToMode = (baseWidths: Record<string, number>, isSelectionMode: boolean) => {
  if (!isSelectionMode) {
    return baseWidths;
  }

  // Convert to selection mode - scale down to make room for selection column
  const selectionColumnWidth = 5;
  const availableWidthForOthers = 100 - selectionColumnWidth;
  const currentTotal = Object.values(baseWidths).reduce((sum, width) => sum + width, 0);
  const scaleFactor = availableWidthForOthers / currentTotal;

  const selectionModeWidths: Record<string, number> = {};
  Object.keys(baseWidths).forEach(key => {
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
    polkadotAddress: string
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
    // Enrich syncStatus with live snapshot data to distinguish uploads vs downloads
    const snapshot = useSyncSnapshot();
    const enrichedAllFiles = useMemo(() => {
      if (!snapshot.isActive && snapshot.files.length === 0) return allFiles;
      // Build a lookup from fileName → action for active/pending files
      const actionByName = new Map<string, "upload" | "download">();
      for (const f of snapshot.files) {
        if (f.status !== "completed" && (f.action === "upload" || f.action === "download")) {
          actionByName.set(f.fileName, f.action);
        }
      }
      if (actionByName.size === 0) return allFiles;

      return allFiles.map((file) => {
        const actualName = file.actualFileName || file.name;
        const action = actionByName.get(actualName);
        if (!action) return file;
        const liveSyncStatus: FormattedUserFile["syncStatus"] =
          action === "download" ? "downloading" : "uploading";
        return { ...file, syncStatus: liveSyncStatus };
      });
    }, [allFiles, snapshot.isActive, snapshot.files]);

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
        { rootMargin: "200px" }
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [hasMore, loadMore]);

    const [sorting, setSorting] = useState<SortingState>([]);
    const [prevFileCount, setPrevFileCount] = useState<number>(0);
    const { getParam } = useUrlParams();
    const router = useRouter();
    const {
      isSelectionMode,
      selectedFiles,
      enterSelectionModeAndSelectFile,
      toggleFileSelection,
    } = useFileSelection();

    // State for captured files to delete (to handle timing issue with clearSelection)
    const [filesToDelete, setFilesToDelete] = useState<FormattedUserFile[]>(
      []
    );

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
      return allFiles.find(
        (f) =>
          f.actualFileName === localFileDetailsFile.actualFileName &&
          f.label === localFileDetailsFile.label
      ) ?? localFileDetailsFile;
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
      [handleShowFileDetails]
    );

    const localHandleContextMenu = useCallback(
      (e: React.MouseEvent, file: FormattedUserFile) => {
        if (handleContextMenu) {
          handleContextMenu(e, file);
        }
      },
      [handleContextMenu]
    );

    // Memoize handler functions to maintain stable references
    const handleDownload = useCallback(
      (file: FormattedUserFile) => {
        handleFileDownload(file, polkadotAddress ?? "");
      },
      [handleFileDownload, polkadotAddress]
    );

    const handleSetSelectedFile = useCallback(
      (file: FormattedUserFile) => {
        setSelectedFile?.(file);
      },
      [setSelectedFile]
    );

    const handleDeleteFile = useCallback(
      (file: FormattedUserFile) => {
        // Enter selection mode and select this file for deletion
        enterSelectionModeAndSelectFile(file);
      },
      [enterSelectionModeAndSelectFile]
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
      [deleteFiles]
    );
    const createTableItems = useCallback(
      (
        file: FormattedUserFile,
        fileType: string | null,
        arionHash: string,
        canPreview: boolean = true
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
          ...((fileType === "video" || fileType === "image" || fileType === "PDF") && canPreview
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
                toast.error("File is not available locally. It may only exist on another device.");
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
                    await openUrl(`https://hipstats.com/file-tracker/${arionHash}`);
                  } catch (error) {
                    console.error("Failed to open Explorer:", error);
                  }
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
      ]
    );

    // Create a stable memo of columns that doesn't depend on every prop
    const columns = useMemo(
      () => {
        // Create selection column inside useMemo to capture fresh values
        const selectionColumn = !isSelectionMode ? [] : [
          columnHelper.display({
            id: "selection",
            header: () => {
              return (
                <div className="flex justify-center items-center h-full">
                  <SelectionHeaderColumn
                    files={files}
                  />
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
                        className="px-2.5 py-3"
                        rawName={info.getValue()}
                        actualName={info.row.original.actualFileName}
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
                        className="px-2.5 py-3"
                        rawName={info.getValue()}
                        actualName={info.row.original.actualFileName}
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
                        className="px-2.5 py-3"
                        rawName={info.getValue()}
                        actualName={info.row.original.actualFileName}
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
                  className="px-2.5 py-3"
                  rawName={info.getValue()}
                  actualName={info.row.original.actualFileName}
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
            header: "SIZE",
            enableSorting: true,
            id: "size",
            cell: (cell) => {
              const value = cell.getValue();
              if (cell.row.original.tempData) return "...";
              if (value === undefined || value === 0) return "Unknown";
              return (
                <div className="text-grey-20 text-sm font-medium truncate">
                  {formatBytesFromBigInt(BigInt(value))}
                </div>
              );
            },
          }),
          columnHelper.accessor("createdAt", {
            header: "DATE UPLOADED",
            enableSorting: true,
            id: "date_uploaded",
            cell: (cell) => {
              const createdAt = cell.row.original.createdAt;
              return createdAt === 0 ? (
                <div className="truncate text-grey-50">—</div>
              ) : (
                <div className="truncate">
                  <FormattedTimestamp timestamp={createdAt} className="text-grey-20 text-sm" />
                </div>
              );
            },
          }),
          columnHelper.accessor(
            (row) => {
              const { fileFormat } = getFilePartsFromFileName(row.name);
              const fileType = getFileTypeFromExtension(fileFormat || null);
              return row.isFolder
                ? "Folder"
                : getFileTypeDisplayLabel(fileType);
            },
            {
              header: "FILE TYPE",
              id: "type",
              enableSorting: true,
              cell: ({ getValue }) => {
                const value = getValue();
                return (
                  <div className="flex flex-col">
                    <div className="text-grey-20 text-sm font-medium truncate">
                      {value}
                    </div>
                  </div>
                );
              },
            }
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
                      size="md"
                      className="h-8 w-8 p-0 text-grey-70 action-menu-area"
                    >
                      <MoreVertical className="size-4" />
                    </Button>
                  </TableActionMenu>
                </div>
              );
            },
          }),
        ];
      },
      [
        handleSetSelectedFile,
        createTableItems,
        isSelectionMode,
        files,
      ]
    );


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
            const currentTotal = Object.values(baseWidths).reduce((sum, width) => sum + width, 0);
            const scaleFactor = 100 / currentTotal;
            Object.keys(baseWidths).forEach(key => {
              baseWidths[key] = baseWidths[key] * scaleFactor;
            });
          }

          // Convert base widths to the new mode
          return convertBaseWidthsToMode(baseWidths, isSelectionMode);
        });
      }
    }, [isSelectionMode, prevSelectionMode]);

    const handleResizeStart = useCallback((columnId: string, startX: number) => {
      const columnIds = Object.keys(columnWidths);
      const currentIndex = columnIds.indexOf(columnId);
      const nextColumnId = columnIds[currentIndex + 1];

      if (nextColumnId && columnId !== 'actions') {
        setIsResizing(true);
        setResizeData({
          columnId,
          startX,
          startWidth: columnWidths[columnId],
          nextColumnId,
          nextStartWidth: columnWidths[nextColumnId],
        });
      }
    }, [columnWidths]);

    const handleResizeMove = useCallback((clientX: number) => {
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

        const currentMinWidth = MIN_COLUMN_WIDTHS[resizeData.columnId as keyof typeof MIN_COLUMN_WIDTHS] || 5;
        const nextMinWidth = MIN_COLUMN_WIDTHS[resizeData.nextColumnId as keyof typeof MIN_COLUMN_WIDTHS] || 5;

        // Only apply minimum constraints if the proposed width would be below minimum
        const newCurrentWidth = proposedCurrentWidth < currentMinWidth ? currentMinWidth : Math.min(80, proposedCurrentWidth);
        const newNextWidth = proposedNextWidth < nextMinWidth ? nextMinWidth : Math.min(80, proposedNextWidth);

        // Only update if both columns respect their minimums
        if (newCurrentWidth >= currentMinWidth && newNextWidth >= nextMinWidth) {
          setColumnWidths((prev: Record<string, number>) => ({
            ...prev,
            [resizeData.columnId]: newCurrentWidth,
            [resizeData.nextColumnId]: newNextWidth,
          }));
        }
      });
    }, [resizeData, isResizing]); const handleResizeEnd = useCallback(() => {
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

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    // Reset sorting when files change significantly (like switching views)
    useEffect(() => {
      // Check if we have a significant change in the number of files
      // which indicates a view switch (private/public) or major filter change
      if (prevFileCount > 0 && Math.abs(allFiles.length - prevFileCount) > 5) {
        setSorting([]);
      }

      // Update the previous file count
      setPrevFileCount(allFiles.length);
    }, [allFiles.length, prevFileCount]);

    const handleSortingChange = useCallback((updaterOrValue: SortingState | ((old: SortingState) => SortingState)) => {
      setSorting(updaterOrValue);
    }, []);

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
        // Use stable ID generation
        getRowId: (row: FormattedUserFile, index: number) => row.arionHash ? `${row.arionHash}-${index}` : `${row.actualFileName || row.name}-${index}`,

      }),
      [columns, enrichedAllFiles, sorting, handleSortingChange]
    );

    const table = useReactTable(tableConfig);

    // Get sorted rows — show all visible items (no client-side slicing).
    // Include enrichedAllFiles in deps so rows recompute when the data source changes
    // (e.g. folder tab switch). useReactTable returns a stable reference, so
    // without enrichedAllFiles this memo would stay stale.
    const visibleRows = useMemo(() => {
      return table.getRowModel().rows;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [table, enrichedAllFiles]);

    const headerRows = useMemo(
      () =>
        table.getHeaderGroups().map((headerGroup) => (
          <TableModule.Tr key={headerGroup.id} draggable={false}>
            {headerGroup.headers.map((header) => (
              <TableModule.Th
                key={header.id}
                header={header}
                align={header.id === "selection" ? "center" : "left"}
                columnWidth={columnWidths[header.id]}
                onResizeStart={handleResizeStart}
                preventSort={justResized}
              />
            ))}
          </TableModule.Tr>
        )),
      [table, columnWidths, handleResizeStart, justResized]
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
                rowState === "pending" && "animate-pulse",
                rowState === "error" && "bg-red-200/20",
                isSelectionMode && rowData.isAssigned && "cursor-pointer",
                isSelectionMode &&
                selectedFiles.some(
                  (f) => f.actualFileName === rowData.actualFileName && f.label === rowData.label
                ) &&
                rowData.isAssigned &&
                "bg-primary-60/10",
                isSelectionMode &&
                !selectedFiles.some(
                  (f) => f.actualFileName === rowData.actualFileName && f.label === rowData.label
                ) &&
                rowData.isAssigned &&
                "hover:bg-primary-60/8",
                isSelectionMode &&
                !rowData.isAssigned &&
                "opacity-50 cursor-not-allowed"
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
                    cell.column.id === "actions" && "",
                    cell.column.id === "name" && "p-0 relative",
                    cell.column.id === "arionHash" && "p-0"
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
        columnWidths
      ]
    );

    const dialogComponent = useMemo(() => {
      if (sharedState || !localIsFileDetailsOpen) return null;
      return (
        <SidebarDialog
          heading={`${liveLocalFileDetailsFile?.isFolder ? "Folder" : "File"
            } Details`}
          open={localIsFileDetailsOpen}
          onOpenChange={setLocalIsFileDetailsOpen}
        >
          <FileDetailsDialogContent file={liveLocalFileDetailsFile ?? undefined} />
        </SidebarDialog>
      );
    }, [sharedState, localIsFileDetailsOpen, liveLocalFileDetailsFile]);

    return (
      <div className="flex flex-col gap-y-8 relative">
        <div
          className={cn(
            "w-full relative",
            isRecentFiles ? "min-h-[21.875rem]" : "min-h-[43.75rem]"
          )}
        >
          <TableModule.TableWrapper
            className={cn(
              "duration-300 delay-300"
            )}
            key={`table-${files?.length}-${isSelectionMode}`}
          >
            <TableModule.Table className="w-full table-fixed" key={`table-${isSelectionMode}`}>
              <TableModule.THead onContextMenu={onHeaderContextMenu}>{headerRows}</TableModule.THead>
              <TableModule.TBody>{tableBody}</TableModule.TBody>
            </TableModule.Table>
          </TableModule.TableWrapper>
          {/* Sentinel element for infinite scroll */}
          <div ref={sentinelRef} className={cn("h-1", isSelectionMode && "mb-20")} />
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
  }
);

FilesTable.displayName = "FilesTable";

export default FilesTable;
