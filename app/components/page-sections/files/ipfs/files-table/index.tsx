import React, { FC, useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import * as TableModule from "@/components/ui/alt-table";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { Button } from "@/components/ui/button";
import {
  Copy,
  Download,
  LinkIcon,
  MoreVertical,
  HardDrive,
  Share,
} from "lucide-react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePagination } from "@/lib/hooks";
import NameCell from "./NameCell";
import TableActionMenu from "@/components/ui/alt-table/table-action-menu";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { VideoDialogTrigger } from "./VideoDialog";
import { ImageDialogTrigger } from "./ImageDialog";
import { PdfDialogTrigger } from "./PdfDialog";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import BlockTimestamp from "@/app/components/ui/block-timestamp";
import { Icons } from "@/app/components/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "../shared/file-view-utils";
import { CloudArrowUpIcon } from "@heroicons/react/24/outline";
import FileDetailsDialogContent from "../file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/sidebar-dialog";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
const columnHelper = createColumnHelper<FormattedUserIpfsFile>();

interface FilesTableProps {
  showUnpinnedDialog?: boolean;
  files: FormattedUserIpfsFile[];
  resetPagination?: boolean;
  onPaginationReset?: () => void;
  isRecentFiles?: boolean;
  searchTerm?: string;
  activeFilters?: any[];
  sharedState?: FileViewSharedState;
}

const FilesTable: FC<FilesTableProps> = ({
  files,
  resetPagination,
  onPaginationReset,
  isRecentFiles = false,
  searchTerm = "",
  activeFilters = [],
  sharedState
}) => {
  const { polkadotAddress } = useWalletAuth();

  // Use either provided shared state or local state
  const {
    setFileToDelete,
    setOpenDeleteModal,
    setSelectedFile,
    handleShowFileDetails,
    handleContextMenu
  } = sharedState || {};

  // Add fallback for standalone usage
  const [localFileDetailsFile, setLocalFileDetailsFile] = useState<FormattedUserIpfsFile | null>(null);
  const [localIsFileDetailsOpen, setLocalIsFileDetailsOpen] = useState(false);

  // Local handler for file details if no shared state
  const localHandleShowFileDetails = useCallback((file: FormattedUserIpfsFile) => {
    if (!handleShowFileDetails) {
      setLocalFileDetailsFile(file);
      setLocalIsFileDetailsOpen(true);
    } else {
      handleShowFileDetails(file);
    }
  }, [handleShowFileDetails]);

  // File drop handling
  const [isDragging, setIsDragging] = useState(false);
  const [animateCloud, setAnimateCloud] = useState(false);
  const dragCounterRef = useRef(0);
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Show empty state if no files and search/filters are active
  const showEmptyState = files.length === 0 && (searchTerm || (activeFilters && activeFilters.length > 0));

  if (showEmptyState) {
    return (
      <div className="flex flex-col items-center justify-center py-16 min-h-[600px]">
        <div className="w-12 h-12 rounded-full bg-primary-90 flex items-center justify-center mb-2">
          <Icons.File className="size-7 text-primary-50" />
        </div>
        <h3 className="text-lg font-medium text-grey-10 mb-1">
          No matching files found
        </h3>
        <p className="text-grey-50 text-sm max-w-[270px] text-center">
          Try adjusting the filters or clearing them to see more results.
        </p>
      </div>
    );
  }

  useEffect(() => {
    if (isDragging) {
      const t = setTimeout(() => setAnimateCloud(true), 200);
      return () => clearTimeout(t);
    } else {
      setAnimateCloud(false);
    }
  }, [isDragging]);

  // Local container handlers for drag and drop
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")) {
      dragCounterRef.current += 1;
      setIsDragging(true);
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
      dragTimeoutRef.current = setTimeout(() => setAnimateCloud(true), 200);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
      setAnimateCloud(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.items || []).some((i) => i.kind === "file")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);

    // File handling is now done in FilesContent
    const event = new CustomEvent("hippius:file-drop", {
      detail: { files: e.dataTransfer.files }
    });
    window.dispatchEvent(event);
  }, []);

  const {
    paginatedData: data,
    setCurrentPage,
    currentPage,
    totalPages,
  } = usePagination(files, 10);

  useEffect(() => {
    if (resetPagination) {
      setCurrentPage(1);
      if (onPaginationReset) {
        onPaginationReset();
      }
    }
  }, [resetPagination, setCurrentPage, onPaginationReset]);

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: "NAME",
        enableSorting: false,
        id: "name",
        cell: (info) => {
          const { fileFormat } = getFilePartsFromFileName(info.getValue());
          const fileType = getFileTypeFromExtension(fileFormat || null);

          if (fileType === "video") {
            return (
              <VideoDialogTrigger
                onClick={() => {
                  setSelectedFile?.(info.row.original);
                }}
              >
                <NameCell
                  rawName={info.getValue()}
                  cid={info.row.original.cid}
                  isAssigned={info.row.original.isAssigned}
                  fileType={fileType}
                  isPreviewable={true}
                />
              </VideoDialogTrigger>
            );
          } else if (fileType === "image") {
            return (
              <ImageDialogTrigger
                onClick={() => {
                  setSelectedFile?.(info.row.original);
                }}
              >
                <NameCell
                  rawName={info.getValue()}
                  cid={info.row.original.cid}
                  isAssigned={info.row.original.isAssigned}
                  fileType={fileType}
                  isPreviewable={true}
                />
              </ImageDialogTrigger>
            );
          } else if (fileType === "pdfDocument") {
            return (
              <PdfDialogTrigger
                onClick={() => {
                  setSelectedFile?.(info.row.original);
                }}
              >
                <NameCell
                  rawName={info.getValue()}
                  cid={info.row.original.cid}
                  isAssigned={info.row.original.isAssigned}
                  fileType={fileType}
                  isPreviewable={true}
                />
              </PdfDialogTrigger>
            );
          }
          return (
            <NameCell
              className="px-4 py-[22px]"
              rawName={info.getValue()}
              cid={info.row.original.cid}
              isAssigned={info.row.original.isAssigned}
              fileType={fileType || "document"}
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
          if (value === undefined) return "Unknown";
          return (
            <div className="text-grey-20 text-base font-medium">
              {cell.row.original.isAssigned
                ? formatBytesFromBigInt(BigInt(value))
                : "Unknown"}
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
          return <BlockTimestamp blockNumber={createdAt} />;
        },
      }),
      columnHelper.display({
        header: "LOCATION",
        id: "location",
        enableSorting: false,
        cell: ({ row: { original } }) => {
          const getParentDirectory = (path: string): string => {
            if (!path) return "Unknown";
            const parts = path.split(/[/\\]/).filter((p) => p.trim());
            if (parts.length >= 2) {
              return parts[parts.length - 2];
            }
            return "Hippius";
          };

          const parentDir = getParentDirectory(original.source ?? "");

          return (
            <div className="flex flex-col">
              <div className="text-grey-20 text-base font-medium">
                {parentDir}
              </div>
              {original.source !== "Hippius" && (
                <div
                  className="text-grey-70 text-xs truncate max-w-[250px]"
                  title={original.source}
                >
                  {original.source}
                </div>
              )}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        size: 40,
        maxSize: 40,
        cell: ({ cell }) => {
          const { cid, name } = cell.row.original;
          const decodedCid = decodeHexCid(cid);
          const { fileFormat } = getFilePartsFromFileName(name);
          const fileType = getFileTypeFromExtension(fileFormat || null);

          return (
            <div className="flex justify-center items-center w-10">
              <TableActionMenu
                dropdownTitle="IPFS Options"
                items={[
                  {
                    icon: <Download className="size-4" />,
                    itemTitle: "Download",
                    onItemClick: async () => {
                      downloadIpfsFile(
                        cell.row.original,
                        polkadotAddress ?? ""
                      );
                    },
                  },
                  ...(fileType === "video" ||
                    fileType === "image" ||
                    fileType === "pdfDocument"
                    ? [
                      {
                        icon: <Icons.Eye className="size-4" />,
                        itemTitle: "View",
                        onItemClick: () => {
                          setSelectedFile?.(cell.row.original);
                        },
                      },
                    ]
                    : []),
                  {
                    icon: <Share className="size-4" />,
                    itemTitle: "Go To Explorer",
                    onItemClick: async () => {
                      try {
                        await openUrl(
                          `http://hipstats.com/cid-tracker/${decodedCid}`
                        );
                      } catch (error) {
                        console.error("Failed to open Explorer:", error);
                      }
                    },
                  },
                  {
                    icon: <LinkIcon className="size-4" />,
                    itemTitle: "View on IPFS",
                    onItemClick: async () => {
                      try {
                        await openUrl(
                          `https://get.hippius.network/ipfs/${decodedCid}`
                        );
                      } catch (error) {
                        console.error("Failed to open Explorer:", error);
                      }
                    },
                  },
                  {
                    icon: <Copy className="size-4" />,
                    itemTitle: "Copy Link",
                    onItemClick: () => {
                      navigator.clipboard
                        .writeText(
                          `https://get.hippius.network/ipfs/${decodedCid}`
                        )
                        .then(() => {
                          toast.success("Copied to clipboard successfully!");
                        });
                    },
                  },
                  {
                    icon: <Icons.InfoCircle className="size-4" />,
                    itemTitle: "File Details",
                    onItemClick: () => {
                      localHandleShowFileDetails(cell.row.original);
                    },
                  },
                  ...(cell.row.original.isAssigned
                    ? [
                      {
                        icon: <Icons.Trash className="size-4" />,
                        itemTitle: "Delete",
                        onItemClick: () => {
                          setFileToDelete?.(cell.row.original);
                          setOpenDeleteModal?.(true);
                        },
                        variant: "destructive" as const,
                      },
                    ]
                    : []),
                ]}
              >
                <Button
                  variant="ghost"
                  size="md"
                  className="h-8 w-8 p-0 text-grey-70"
                >
                  <MoreVertical className="size-4" />
                </Button>
              </TableActionMenu>
            </div>
          );
        },
      }),
    ],
    [polkadotAddress, setFileToDelete, setOpenDeleteModal, setSelectedFile, localHandleShowFileDetails]
  );

  const table = useReactTable({
    columns,
    data: data || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    columnResizeMode: "onChange",
    defaultColumn: {
      minSize: 40,
      size: undefined,
    },
  });

  return (
    <div className="flex flex-col gap-y-8 relative">
      <div
        className={cn(
          "w-full relative ",
          isRecentFiles ? "max-h-[150px]" : "min-h-[700px]",
          isDragging &&
          "after:absolute after:inset-0 after:bg-gray-50/50 after:border-2 after:border-primary-50 after:border-dashed after:rounded-lg after:z-10"
        )}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
      >
        {isDragging && (
          <div className="absolute inset-0 bg-opacity-80 flex flex-col items-center justify-center z-20 pointer-events-none">
            <div
              className={cn(
                "relative transition-all duration-500 ease-in-out",
                animateCloud ? "scale-110 transform -translate-y-2" : ""
              )}
            >
              <div className="size-15 p-2 rounded-full flex items-center justify-center">
                <CloudArrowUpIcon className="size-10 text-[#3167dc] animate-slide-up" />
              </div>
            </div>

            <div className="mt-2 font-medium text-center bg-primary-50 p-4 rounded-lg shadow-lg">
              <div className="text-white text-base">
                Drop files here to upload them to
              </div>
              <div className="flex items-center justify-center">
                <HardDrive className="size-6 text-white mr-2" />
                <div className="text-white text-lg font-bold">
                  IPFS Storage
                </div>
              </div>
            </div>
          </div>
        )}

        <TableModule.TableWrapper className="duration-300 delay-300">
          <TableModule.Table>
            <TableModule.THead>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableModule.Tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableModule.Th key={header.id} header={header} />
                  ))}
                </TableModule.Tr>
              ))}
            </TableModule.THead>

            <TableModule.TBody>
              {table.getRowModel().rows?.map((row) => {
                const rowData = row.original;
                let rowState: "success" | "pending" | "error" = "success";

                if (rowData.tempData) {
                  rowState = "pending";
                  if (
                    Date.now() - rowData.tempData.uploadTime >
                    TIME_BEFORE_ERR
                  ) {
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
                      rowState === "error" && "bg-red-200/20"
                    )}
                    onContextMenu={(e) => handleContextMenu?.(e, rowData)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableModule.Td
                        className={cn(
                          cell.column.id === "actions" && "w-8",
                          cell.column.id === "name" && "p-0",
                          cell.column.id === "cid" && "p-0"
                        )}
                        key={cell.id}
                        cell={cell}
                      />
                    ))}
                  </TableModule.Tr>
                );
              })}
            </TableModule.TBody>
          </TableModule.Table>
        </TableModule.TableWrapper>
        <div className="my-8">
          {totalPages > 1 && (
            <TableModule.Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              setPage={setCurrentPage}
            />
          )}
        </div>
      </div>

      {/* Add this for standalone usage */}
      {!sharedState && localIsFileDetailsOpen && (
        <SidebarDialog
          heading="File Details"
          open={localIsFileDetailsOpen}
          onOpenChange={setLocalIsFileDetailsOpen}
        >
          <FileDetailsDialogContent file={localFileDetailsFile ?? undefined} />
        </SidebarDialog>
      )}
    </div>
  );
};

export default FilesTable;
