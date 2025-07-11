import React, {
  FC,
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import {
  createColumnHelper,
  getCoreRowModel,
  useReactTable,
  getSortedRowModel,
} from "@tanstack/react-table";
import useUserIpfsFiles, {
  FormattedUserIpfsFile,
} from "@/lib/hooks/use-user-ipfs-files";
import * as TableModule from "@/components/ui/alt-table";
import { formatBytesFromBigInt } from "@/lib/utils/formatBytes";
import { WaitAMoment, P } from "@/components/ui";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { Button } from "@/components/ui/button";
import {
  Copy,
  Download,
  LinkIcon,
  MoreVertical,
  Trash2,
  HardDrive,
} from "lucide-react";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePagination } from "@/lib/hooks";
import NameCell from "./name-cell";
import FileDetailsDialog, { FileDetail } from "./unpin-files-dialog";
import IPFSNoEntriesFound from "./ipfs-no-entries-found";
import TableActionMenu from "@/components/ui/alt-table/table-action-menu";
import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useDeleteIpfsFile } from "@/lib/hooks";
import { CloudArrowUpIcon } from "@heroicons/react/24/outline";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import VideoDialog, { VideoDialogTrigger } from "./video-dialog";
import ImageDialog, { ImageDialogTrigger } from "./image-dialog";
import PdfDialog, { PdfDialogTrigger } from "./pdf-dialog";
import { downloadIpfsFile } from "@/lib/utils/downloadIpfsFile";
import FileContextMenu from "@/components/ui/context-menu/file-context-menu";

const HIPPIUS_DROP_EVENT = "hippius:file-drop";
const TIME_BEFORE_ERR = 30 * 60 * 1000;

const columnHelper = createColumnHelper<FormattedUserIpfsFile>();

interface FilesTableProps {
  showUnpinnedDialog?: boolean;
  files: FormattedUserIpfsFile[];
}

const FilesTable: FC<FilesTableProps> = ({
  showUnpinnedDialog = true,
  files,
}) => {
  const [fileToDelete, setFileToDelete] = useState<FormattedUserIpfsFile | null>(null);
  const [openDeleteModal, setOpenDeleteModal] = useState(false);
  const { mutateAsync: deleteFile, isPending: isDeleting } = useDeleteIpfsFile({
    cid: fileToDelete?.cid || "",
  });

  const [unpinnedFiles, setUnpinnedFiles] = useState<FileDetail[] | null>(null);
  const [isUnpinnedOpen, setIsUnpinnedOpen] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [animateCloud, setAnimateCloud] = useState(false);

  const [selectedFile, setSelectedFile] = useState<FormattedUserIpfsFile | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FormattedUserIpfsFile;
  } | null>(null);

  const dragCounterRef = useRef(0);
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isDragging) {
      const t = setTimeout(() => setAnimateCloud(true), 200);
      return () => clearTimeout(t);
    } else {
      setAnimateCloud(false);
    }
  }, [isDragging]);

  // Global listeners: toggle isDragging on dragover, dragleave, drop
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setIsDragging(true);
      }
    };
    const onDragLeaveOrDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setIsDragging(false);
      }
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeaveOrDrop);
    window.addEventListener("drop", onDragLeaveOrDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeaveOrDrop);
      window.removeEventListener("drop", onDragLeaveOrDrop);
    };
  }, []);

  // Dispatch files to your upload logic
  const handleFiles = useCallback((files: FileList) => {
    if (!files.length) return toast.error("No Files Found");
    const ev = new CustomEvent(HIPPIUS_DROP_EVENT, { detail: { files } });
    window.dispatchEvent(ev);
    toast.success(`${files.length} ${files.length === 1 ? "file" : "files"} ready to upload`);
  }, []);

  // Local container handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (Array.from(e.dataTransfer.items || []).some(i => i.kind === "file")) {
      dragCounterRef.current += 1;
      setIsDragging(true);
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
      dragTimeoutRef.current = setTimeout(() => setAnimateCloud(true), 200);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current === 0) {
      setIsDragging(false);
      setAnimateCloud(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.items || []).some(i => i.kind === "file")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const filteredData = useMemo(() => files, [files]);
  const { paginatedData: data, setCurrentPage, currentPage, totalPages } =
    usePagination(filteredData, 10);

  const unpinnedDetails = useMemo(() => {
    if (!showUnpinnedDialog) return [];
    return files.filter(f => !f.isAssigned).map(f => ({
      filename: f.name || "Unnamed File",
      cid: decodeHexCid(f.cid),
      createdAt: f.createdAt,
    }));
  }, [files, showUnpinnedDialog]);

  useEffect(() => {
    if (!showUnpinnedDialog) return;
    if (unpinnedDetails.length) {
      setUnpinnedFiles(unpinnedDetails);
      setIsUnpinnedOpen(true);
    } else {
      setUnpinnedFiles(null);
      setIsUnpinnedOpen(false);
    }
  }, [unpinnedDetails.length, showUnpinnedDialog]);

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
                  setSelectedFile(info.row.original);
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
                  setSelectedFile(info.row.original);
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
                  setSelectedFile(info.row.original);
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
          return formatBytesFromBigInt(BigInt(value));
        },
      }),

      columnHelper.accessor("cid", {
        header: "DATE UPLOADED",
        enableSorting: true,
        id: "date_uploaded",
        cell: (cell) => {
          const value = cell.getValue();
          const createdAt = cell.row.original.createdAt;

          // Format the timestamp to a readable date
          const date = new Date(createdAt);
          const formattedDate = date.toLocaleDateString('en-US', {
            month: '2-digit',
            day: '2-digit',
            year: '2-digit'
          });

          const formattedTime = date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          }).toLowerCase();

          return (
            <div>{createdAt}</div>
          );
        },
      }),
      columnHelper.display({
        header: "LOCATION",
        id: "location",
        enableSorting: false,
        cell: ({ row: { original } }) => (
          <div>{original.source}</div>
        ),
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        size: 40,
        maxSize: 40,
        cell: ({ cell }) => {
          const { cid, name } = cell.row.original;
          const { fileFormat } = getFilePartsFromFileName(name);

          return (
            <div className="flex justify-center items-center w-10">
              <TableActionMenu
                dropdownTitle="IPFS Options"
                items={[
                  {
                    icon: <LinkIcon className="size-4" />,
                    itemTitle: "View on IPFS",
                    onItemClick: () => {
                      const { fileFormat } = getFilePartsFromFileName(name);
                      const fileType = getFileTypeFromExtension(
                        fileFormat || null
                      );

                      if (fileType === "video") {
                        setSelectedFile(cell.row.original);
                      } else {
                        window.open(
                          `https://get.hippius.network/ipfs/${decodeHexCid(cid)}`,
                          "_blank"
                        );
                      }
                    },
                  },
                  {
                    icon: <Copy className="size-4" />,
                    itemTitle: "Copy Link",
                    onItemClick: () => {
                      navigator.clipboard
                        .writeText(
                          `https://get.hippius.network/ipfs/${decodeHexCid(cid)}`
                        )
                        .then(() => {
                          toast.success("Copied to clipboard successfully!");
                        });
                    },
                  },
                  {
                    icon: <Download className="size-4" />,
                    itemTitle: "Download",
                    onItemClick: async () => {
                      downloadIpfsFile(cell.row.original);
                    },
                  },
                  ...(cell.row.original.isAssigned
                    ? [
                      {
                        icon: <Trash2 className="size-4" />,
                        itemTitle: "Delete",
                        onItemClick: () => {
                          setFileToDelete(cell.row.original);
                          handleDelete();
                        },
                        variant: "destructive" as const,
                      },
                    ]
                    : []),
                ]}
              >
                <Button variant="ghost" size="icon" className="h-8 w-8 p-0 text-grey-70">
                  <MoreVertical className="size-4" />
                </Button>
              </TableActionMenu>
            </div>
          );
        },
      }),
    ],
    []
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

  const handleDelete = () => {
    setOpenDeleteModal(true);
  };

  const selectedFileFormat = selectedFile
    ? getFilePartsFromFileName(selectedFile.name).fileFormat
    : null;

  const selectedFileType = selectedFileFormat
    ? getFileTypeFromExtension(selectedFileFormat)
    : null;


  // Handle right-click on table row
  const handleRowContextMenu = (e: React.MouseEvent, file: FormattedUserIpfsFile) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, file });
  };

  return (
    <>
      <div className="flex flex-col gap-y-8 relative">
        <DeleteConfirmationDialog
          open={openDeleteModal}
          onClose={() => {
            setOpenDeleteModal(false);
            setFileToDelete(null);
          }}
          onBack={() => {
            setOpenDeleteModal(false);
            setFileToDelete(null);
          }}
          onDelete={() => {
            setOpenDeleteModal(false);
            toast.success("Deleting file...");

            deleteFile()
              .then(() => {
                toast.success("Request submitted. File will be deleted!");
                setFileToDelete(null);
              })
              .catch((error) => {
                console.error("Delete error:", error);
                toast.error(error.message || "Failed to delete file");
              });
          }}
          button={isDeleting ? "Deleting..." : "Delete File"}
          text={`Are you sure you want to delete\n${fileToDelete?.name ? "\n" + fileToDelete.name : ""}`}
          heading="Delete File"
          disableButton={isDeleting}
        />

        <div
          className={cn(
            "w-full relative min-h-[700px]",
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
              {/* Animated cloud with upload icon */}
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

              {/* Text message */}
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

          {/* Table wrapper - Remove loading/error handling as it's now in parent */}
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
                      onContextMenu={(e) => handleRowContextMenu(e, rowData)}
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

        {showUnpinnedDialog && unpinnedFiles && unpinnedFiles.length > 0 && (
          <FileDetailsDialog
            open={!isLoading && isUnpinnedOpen}
            unpinnedFiles={unpinnedFiles}
          />
        )}
      </div>
      {selectedFileType === "video" && (
        <VideoDialog
          onCloseClicked={() => {
            setSelectedFile(null);
          }}
          file={selectedFile}
        />
      )}
      {selectedFileType === "image" && (
        <ImageDialog
          onCloseClicked={() => {
            setSelectedFile(null);
          }}
          file={selectedFile}
        />
      )}
      {selectedFileType === "pdfDocument" && (
        <PdfDialog
          onCloseClicked={() => {
            setSelectedFile(null);
          }}
          file={selectedFile}
        />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={() => setContextMenu(null)}
          onDelete={(file) => {
            setFileToDelete(file);
            handleDelete();
            setContextMenu(null);
          }}
          onSelectFile={(file) => {
            setSelectedFile(file);
            setContextMenu(null);
          }}
        />
      )}
    </>
  );
};

export default FilesTable;
