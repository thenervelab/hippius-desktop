import React, { FC, useState, useEffect, useCallback, memo } from "react";
import { FormattedUserIpfsFile } from "@/lib/hooks/use-user-ipfs-files";
import { Button } from "@/components/ui/button";
import {
  MoreVertical,
  LinkIcon,
  Copy,
  Download,
  Share,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import usePagination from "@/lib/hooks/use-pagination";
import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { Icons } from "@/components/ui";
import FileCard from "./FileCard";
import TableActionMenu from "@/components/ui/alt-table/table-action-menu";
import * as TableModule from "@/components/ui/alt-table";
import { useRouter } from "next/navigation";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "../shared/file-view-utils";
import FileDetailsDialogContent from "../file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/sidebar-dialog";

const TIME_BEFORE_ERR = 30 * 60 * 1000;
interface Filter {
  type: string;
  value: string | number;
  label: string;
}

interface CardViewProps {
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

const CardView: FC<CardViewProps> = ({
  files,
  resetPagination,
  onPaginationReset,
  isRecentFiles = false,
  searchTerm = "",
  activeFilters = [],
  sharedState,
  handleFileDownload
}) => {
  const router = useRouter();
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
    paginatedData: data,
    setCurrentPage,
    currentPage,
    totalPages
  } = usePagination(files || [], 12);

  useEffect(() => {
    if (resetPagination) {
      setCurrentPage(1);
      if (onPaginationReset) {
        onPaginationReset();
      }
    }
  }, [resetPagination, setCurrentPage, onPaginationReset]);

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
        <div className="duration-300 delay-300">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {data.map((file, index) => {
              const { fileFormat } = getFilePartsFromFileName(file.name);
              const fileType = getFileTypeFromExtension(fileFormat || null);

              let cardState: "success" | "pending" | "error" = "success";
              if (file.tempData) {
                cardState = "pending";
                if (Date.now() - file.tempData.uploadTime > TIME_BEFORE_ERR) {
                  cardState = "error";
                }
              }

              const handleCardClick = () => {
                if (
                  fileType === "video" ||
                  fileType === "image" ||
                  fileType === "PDF"
                ) {
                  setSelectedFile?.(file);
                } else if (fileType === "ec") {
                  router.push(
                    `/dashboard/storage/ipfs/${decodeHexCid(file.cid)}`
                  );
                }
              };

              return (
                <div
                  key={index}
                  className="card-container"
                  onContextMenu={(e) => localHandleContextMenu(e, file)}
                >
                  <FileCard
                    key={file.cid}
                    file={file}
                    state={cardState}
                    onClick={handleCardClick}
                    actionMenu={
                      <TableActionMenu
                        dropdownTitle="IPFS Options"
                        dropDownMenuTriggerClass="size-5 text-grey-60 flex items-center"
                        items={[
                          {
                            icon: <Download className="size-4" />,
                            itemTitle: "Download",
                            onItemClick: async () => {
                              handleFileDownload(file, polkadotAddress ?? "");
                            }
                          },
                          ...(fileType === "video" ||
                            fileType === "image" ||
                            fileType === "PDF"
                            ? [
                              {
                                icon: <Icons.Eye className="size-4" />,
                                itemTitle: "View",
                                onItemClick: () => {
                                  setSelectedFile?.(file);
                                }
                              }
                            ]
                            : []),
                          {
                            icon: <Share className="size-4" />,
                            itemTitle: "Go To Explorer",
                            onItemClick: async () => {
                              try {
                                await openUrl(
                                  `http://hipstats.com/cid-tracker/${decodeHexCid(
                                    file.cid
                                  )}`
                                );
                              } catch (error) {
                                console.error(
                                  "Failed to open Explorer:",
                                  error
                                );
                              }
                            }
                          },
                          {
                            icon: <LinkIcon className="size-4" />,
                            itemTitle: "View on IPFS",
                            onItemClick: async () => {
                              try {
                                await openUrl(
                                  `https://get.hippius.network/ipfs/${decodeHexCid(
                                    file.cid
                                  )}`
                                );
                              } catch (error) {
                                console.error("Failed to open on IPFS:", error);
                              }
                            }
                          },
                          {
                            icon: <Copy className="size-4" />,
                            itemTitle: "Copy Link",
                            onItemClick: () => {
                              navigator.clipboard
                                .writeText(
                                  `https://get.hippius.network/ipfs/${decodeHexCid(
                                    file.cid
                                  )}`
                                )
                                .then(() => {
                                  toast.success(
                                    "Copied to clipboard successfully!"
                                  );
                                });
                            }
                          },
                          {
                            icon: <Icons.InfoCircle className="size-4" />,
                            itemTitle: "File Details",
                            onItemClick: () => {
                              localHandleShowFileDetails(file);
                            }
                          },
                          ...(file.isAssigned
                            ? [
                              {
                                icon: <Icons.Trash className="size-4" />,
                                itemTitle: "Delete",
                                onItemClick: () => {
                                  setFileToDelete?.(file);
                                  setOpenDeleteModal?.(true);
                                },
                                variant: "destructive" as const
                              }
                            ]
                            : [])
                        ]}
                      >
                        <Button
                          variant="ghost"
                          size="md"
                          className="text-grey-70"
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      </TableActionMenu>
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
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

// Wrap the component with memo to prevent unnecessary re-renders
export default memo(CardView);
