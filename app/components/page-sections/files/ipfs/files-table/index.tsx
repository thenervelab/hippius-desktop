import React, {
  FC,
  useState,
  useMemo,
  useEffect,
  useCallback,
  memo
} from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel
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
  Share
} from "lucide-react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePagination } from "@/lib/hooks";
import NameCell from "./NameCell";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { VideoDialogTrigger } from "./VideoDialog";
import { ImageDialogTrigger } from "./ImageDialog";
import { PdfDialogTrigger } from "./PdfDialog";
import BlockTimestamp from "@/app/components/ui/block-timestamp";
import { Icons } from "@/app/components/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "@/components/page-sections/files/ipfs/shared/FileViewUtils";
import FileDetailsDialogContent from "@/components/page-sections/files/ipfs/file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/SidebarDialog";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
const columnHelper = createColumnHelper<FormattedUserIpfsFile>();

interface Filter {
  type: string;
  value: string | number;
  label: string;
}

interface FilesTableProps {
  showUnpinnedDialog?: boolean;
  files: FormattedUserIpfsFile[];
  resetPagination?: boolean;
  onPaginationReset?: () => void;
  isRecentFiles?: boolean;
  searchTerm?: string;
  activeFilters?: Filter[];
  sharedState?: FileViewSharedState;
  handleFileDownload: (
    file: FormattedUserIpfsFile,
    polkadotAddress: string
  ) => void;
}

// Create stable action functions outside component to prevent recreation
const openExplorerUrl = async (decodedCid: string) => {
  try {
    await openUrl(`http://hipstats.com/cid-tracker/${decodedCid}`);
  } catch (error) {
    console.error("Failed to open Explorer:", error);
  }
};

const openIpfsUrl = async (decodedCid: string) => {
  try {
    await openUrl(`https://get.hippius.network/ipfs/${decodedCid}`);
  } catch (error) {
    console.error("Failed to open IPFS:", error);
  }
};

const copyToClipboard = (decodedCid: string) => {
  navigator.clipboard
    .writeText(`https://get.hippius.network/ipfs/${decodedCid}`)
    .then(() => {
      toast.success("Copied to clipboard successfully!");
    });
};

const FilesTable: FC<FilesTableProps> = memo(({
  files,
  resetPagination,
  onPaginationReset,
  isRecentFiles = false,
  searchTerm = "",
  activeFilters = [],
  sharedState,
  handleFileDownload
}) => {
  const { polkadotAddress } = useWalletAuth();

  const [localFileDetailsFile, setLocalFileDetailsFile] =
    useState<FormattedUserIpfsFile | null>(null);
  const [localIsFileDetailsOpen, setLocalIsFileDetailsOpen] = useState(false);

  const {
    setFileToDelete,
    setOpenDeleteModal,
    setSelectedFile,
    handleShowFileDetails,
    handleContextMenu
  } = sharedState || {};

  const localHandleShowFileDetails = useCallback(
    (file: FormattedUserIpfsFile) => {
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
    (e: React.MouseEvent, file: FormattedUserIpfsFile) => {
      if (handleContextMenu) {
        handleContextMenu(e, file);
      }
    },
    [handleContextMenu]
  );

  const showEmptyState =
    files.length === 0 &&
    (searchTerm || (activeFilters && activeFilters.length > 0));

  const {
    paginatedData,
    setCurrentPage,
    currentPage,
    totalPages
  } = usePagination(files, 10);

  useEffect(() => {
    if (resetPagination) {
      setCurrentPage(1);
      if (onPaginationReset) {
        onPaginationReset();
      }
    }
  }, [resetPagination, setCurrentPage, onPaginationReset]);

  // Memoize handler functions to maintain stable references
  const handleDownload = useCallback((file: FormattedUserIpfsFile) => {
    handleFileDownload(file, polkadotAddress ?? "");
  }, [handleFileDownload, polkadotAddress]);

  const handleSetSelectedFile = useCallback((file: FormattedUserIpfsFile) => {
    setSelectedFile?.(file);
  }, [setSelectedFile]);

  const handleDeleteFile = useCallback((file: FormattedUserIpfsFile) => {
    setFileToDelete?.(file);
    setOpenDeleteModal?.(true);
  }, [setFileToDelete, setOpenDeleteModal]);

  const createTableItems = useCallback((file: FormattedUserIpfsFile, fileType: string | null, decodedCid: string) => {
    return [
      {
        icon: <Download className="size-4" />,
        itemTitle: "Download",
        onItemClick: () => handleDownload(file)
      },
      ...(fileType === "video" || fileType === "image" || fileType === "PDF"
        ? [
          {
            icon: <Icons.Eye className="size-4" />,
            itemTitle: "View",
            onItemClick: () => handleSetSelectedFile(file)
          }
        ]
        : []),
      {
        icon: <Share className="size-4" />,
        itemTitle: "Go To Explorer",
        onItemClick: () => openExplorerUrl(decodedCid)
      },
      {
        icon: <LinkIcon className="size-4" />,
        itemTitle: "View on IPFS",
        onItemClick: () => openIpfsUrl(decodedCid)
      },
      {
        icon: <Copy className="size-4" />,
        itemTitle: "Copy Link",
        onItemClick: () => copyToClipboard(decodedCid)
      },
      {
        icon: <Icons.InfoCircle className="size-4" />,
        itemTitle: `${file?.isFolder ? "Folder" : "File"} Details`,
        onItemClick: () => localHandleShowFileDetails(file)
      },
      ...(file.isAssigned
        ? [
          {
            icon: <Icons.Trash className="size-4" />,
            itemTitle: "Delete",
            onItemClick: () => handleDeleteFile(file),
            variant: "destructive" as const
          }
        ]
        : [])
    ];
  }, [handleDownload, handleSetSelectedFile, localHandleShowFileDetails, handleDeleteFile]);

  // Create a stable memo of columns that doesn't depend on every prop
  const columns = useMemo(() => [
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
              onClick={() => handleSetSelectedFile(info.row.original)}
            >
              <NameCell
                rawName={info.getValue()}
                actualName={info.row.original.actualFileName}
                cid={info.row.original.cid}
                isAssigned={info.row.original.isAssigned}
                fileType={fileType}
                isPreviewable={true}
                isFolder={info.row.original.isFolder}
              />
            </VideoDialogTrigger>
          );
        } else if (fileType === "image") {
          return (
            <ImageDialogTrigger
              onClick={() => handleSetSelectedFile(info.row.original)}
            >
              <NameCell
                rawName={info.getValue()}
                actualName={info.row.original.actualFileName}
                cid={info.row.original.cid}
                isAssigned={info.row.original.isAssigned}
                fileType={fileType}
                isPreviewable={true}
                isFolder={info.row.original.isFolder}
              />
            </ImageDialogTrigger>
          );
        } else if (fileType === "PDF") {
          return (
            <PdfDialogTrigger
              onClick={() => handleSetSelectedFile(info.row.original)}
            >
              <NameCell
                rawName={info.getValue()}
                actualName={info.row.original.actualFileName}
                cid={info.row.original.cid}
                isAssigned={info.row.original.isAssigned}
                fileType={fileType}
                isPreviewable={true}
                isFolder={info.row.original.isFolder}
              />
            </PdfDialogTrigger>
          );
        }
        return (
          <NameCell
            className="px-4 py-[22px]"
            rawName={info.getValue()}
            actualName={info.row.original.actualFileName}
            cid={info.row.original.cid}
            isAssigned={info.row.original.isAssigned}
            fileType={fileType || "document"}
            isFolder={info.row.original.isFolder}
          />
        );
      }
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
      }
    }),
    columnHelper.accessor("createdAt", {
      header: "DATE UPLOADED",
      enableSorting: true,
      id: "date_uploaded",
      cell: (cell) => {
        const createdAt = cell.row.original.createdAt;
        return createdAt === 0 ? "Unknown" : <BlockTimestamp blockNumber={createdAt} />;
      }
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
                className="text-grey-70 text-xs truncate max-w-[250px] xl:max-w-[100%]"
                title={original.source}
              >
                {original.source && original.source.length > 53
                  ? original.source.slice(0, 40) + "..." + original.source.slice(-10)
                  : original.source ?? ""}
              </div>
            )}
          </div>
        );
      }
    }),
    columnHelper.display({
      id: "actions",
      header: "",
      size: 40,
      maxSize: 40,
      cell: ({ cell }) => {
        const file = cell.row.original;
        const { cid, name } = file;
        const decodedCid = decodeHexCid(cid);
        const { fileFormat } = getFilePartsFromFileName(name);
        const fileType = getFileTypeFromExtension(fileFormat || null);

        const menuItems = createTableItems(file, fileType, decodedCid);

        return (
          <div className="flex justify-center items-center">
            <TableActionMenu
              dropdownTitle="IPFS Options"
              items={menuItems}
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
      }
    })
  ], [handleSetSelectedFile, createTableItems]);

  const tableConfig = useMemo(() => ({
    columns,
    data: paginatedData || [],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    defaultColumn: {
      minSize: 40,
      size: undefined
    }
  }), [columns, paginatedData]);

  const table = useReactTable(tableConfig);

  const headerRows = useMemo(() => (
    table.getHeaderGroups().map((headerGroup) => (
      <TableModule.Tr key={headerGroup.id}>
        {headerGroup.headers.map((header) => (
          <TableModule.Th key={header.id} header={header} />
        ))}
      </TableModule.Tr>
    ))
  ), [table]);

  const tableBody = useMemo(() => (
    table.getRowModel().rows?.map((row) => {
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
          onContextMenu={(e) => localHandleContextMenu(e, rowData)}
        >
          {row.getVisibleCells().map((cell) => (
            <TableModule.Td
              className={cn(
                cell.column.id === "actions" && "",
                cell.column.id === "name" && "p-0",
                cell.column.id === "cid" && "p-0"
              )}
              key={cell.id}
              cell={cell}
            />
          ))}
        </TableModule.Tr>
      );
    })
  ), [table, localHandleContextMenu, paginatedData]);

  const paginationComponent = useMemo(() => {
    if (totalPages <= 1) return null;
    return (
      <TableModule.Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        setPage={setCurrentPage}
      />
    );
  }, [currentPage, totalPages, setCurrentPage]);

  const dialogComponent = useMemo(() => {
    if (sharedState || !localIsFileDetailsOpen) return null;
    return (
      <SidebarDialog
        heading={`${localFileDetailsFile?.isFolder ? "Folder" : "File"} Details`}
        open={localIsFileDetailsOpen}
        onOpenChange={setLocalIsFileDetailsOpen}
      >
        <FileDetailsDialogContent file={localFileDetailsFile ?? undefined} />
      </SidebarDialog>
    );
  }, [sharedState, localIsFileDetailsOpen, localFileDetailsFile]);

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

  return (
    <div className="flex flex-col gap-y-8 relative">
      <div
        className={cn(
          "w-full relative",
          isRecentFiles ? "max-h-[150px]" : "min-h-[700px]"
        )}
      >
        <TableModule.TableWrapper className="duration-300 delay-300">
          <TableModule.Table>
            <TableModule.THead>
              {headerRows}
            </TableModule.THead>
            <TableModule.TBody>
              {tableBody}
            </TableModule.TBody>
          </TableModule.Table>
        </TableModule.TableWrapper>
        <div className="my-8">
          {paginationComponent}
        </div>
      </div>
      {dialogComponent}
    </div>
  );
});

FilesTable.displayName = 'FilesTable';

export default FilesTable;
