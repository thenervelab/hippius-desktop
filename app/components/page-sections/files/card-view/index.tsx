import React, { FC, useState, useEffect, useCallback, memo, useMemo } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
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

import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";
import { decodeHexCid } from "@/lib/utils/decodeHexCid";
import { Icons } from "@/components/ui";
import FileCard from "./FileCard";
import SelectionActionBar from "../SelectionActionBar";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import * as TableModule from "@/components/ui/alt-table";
import { useRouter } from "next/navigation";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "@/app/components/page-sections/files/shared/FileViewUtils";
import FileDetailsDialogContent from "@/app/components/page-sections/files/file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/SidebarDialog";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { Folder } from "@/app/components/ui/icons";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { isLocalFile } from "@/app/lib/utils/ipfsUrlResolver";
import { shouldAllowPreview } from "@/app/lib/utils/filePreviewPermissions";

const TIME_BEFORE_ERR = 30 * 60 * 1000;

interface CardViewProps {
  showUnpinnedDialog?: boolean;
  files: FormattedUserFile[];
  resetPagination?: boolean;
  onPaginationReset?: () => void;
  isRecentFiles?: boolean;
  sharedState?: FileViewSharedState;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
  currentPage: number;
  totalPages: number;
  setCurrentPage: (page: number) => void;
}

const CardView: FC<CardViewProps> = ({
  files,
  resetPagination,
  onPaginationReset,
  isRecentFiles = false,
  sharedState,
  handleFileDownload,
  currentPage,
  totalPages,
  setCurrentPage,
}) => {
  const router = useRouter();
  const { polkadotAddress } = useWalletAuth();
  const { getParam } = useUrlParams();
  const { isSelectionMode, enterSelectionModeAndSelectFile, } = useFileSelection();

  const isPrivateFolder = useMemo(() => {
    const folderType = getParam('type');
    if (folderType === 'private') return true;
    return files.length > 0 && files.some((file: FormattedUserFile) => file.type?.toLowerCase() === 'private');
  }, [getParam, files]);

  // State for captured files to delete (to handle timing issue with clearSelection)
  const [filesToDelete, setFilesToDelete] = useState<FormattedUserFile[]>([]);

  // Initialize delete hook with filesToDelete instead of selectedFiles
  const { mutate: deleteFiles, isPending: isDeleting } = useDeleteFile({
    files: filesToDelete,
    isPrivateFolder
  });

  const [localFileDetailsFile, setLocalFileDetailsFile] =
    useState<FormattedUserFile | null>(null);
  const [localIsFileDetailsOpen, setLocalIsFileDetailsOpen] = useState(false);
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);

  const {
    setSelectedFile,
    handleShowFileDetails,
    handleContextMenu
  } = sharedState || {};

  // Handle file deletion with captured files from confirmation dialog
  const handleDeleteSelectedFiles = useCallback((capturedFiles: FormattedUserFile[]) => {
    console.log("handleDeleteSelectedFiles called with captured files:", capturedFiles.map(f => ({
      name: f.name,
      actualFileName: f.actualFileName,
      isFolder: f.isFolder
    })));

    if (capturedFiles.length === 0) {
      console.log("No files to delete, aborting");
      return;
    }

    // Set the files to delete and trigger the delete operation
    setFilesToDelete(capturedFiles);

    // Use setTimeout to ensure the delete hook reinitializes with new files
    setTimeout(() => {
      deleteFiles(undefined, {
        onSuccess: () => {
          console.log("Delete successful, clearing filesToDelete state");
          setFilesToDelete([]);
        },
        onError: (error) => {
          console.error("Delete failed:", error);
          setFilesToDelete([]);
        }
      });
    }, 100);
  }, [deleteFiles]);

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

  // Ensure files is always an array to prevent undefined errors


  useEffect(() => {
    if (resetPagination) {
      if (onPaginationReset) {
        onPaginationReset();
      }
    }
  }, [resetPagination, setCurrentPage, onPaginationReset]);

  return (
    <div className="flex flex-col gap-y-8 relative">

      <div
        className={cn(
          "w-full relative",
          isRecentFiles ? "min-h-[200px]" : "min-h-[700px]"
        )}
      >
        <div className="duration-300 delay-300">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {files.map((file, index) => {
              const { fileFormat } = getFilePartsFromFileName(file.name);
              const fileType = getFileTypeFromExtension(fileFormat || null);

              let cardState: "success" | "pending" | "error" = "success";
              if (file.tempData) {
                cardState = "pending";
                if (Date.now() - file.tempData.uploadTime > TIME_BEFORE_ERR) {
                  cardState = "error";
                }
              }

              // Get folder URL if file is a folder
              let folderUrl = "";
              if (file.isFolder) {
                const { url } = generateFolderUrl(file, getParam);
                folderUrl = url;
              }

              return (
                <div
                  key={index}
                  className="card-container relative"
                  onContextMenu={(e) => localHandleContextMenu(e, file)}
                >
                  <FileCard
                    key={file.cid}
                    file={file}
                    state={cardState}
                    onClick={() => {
                      // Don't handle card clicks if dropdown menu is open
                      if (openMenuIndex === index) {
                        return;
                      }

                      // Normal mode behavior - only if not in selection mode
                      if (!isSelectionMode) {
                        if (
                          fileType === "video" ||
                          fileType === "image" ||
                          fileType === "PDF"
                        ) {
                          // Check if preview is allowed for private files
                          const hasCheckmark = isLocalFile(file.source);
                          const canPreview = shouldAllowPreview(file, hasCheckmark, isPrivateFolder); if (canPreview) {
                            setSelectedFile?.(file);
                          }
                        } else if (file.isFolder) {
                          router.push(folderUrl);
                        }
                      }
                    }}
                    actionMenu={
                      <TableActionMenu
                        dropdownTitle="IPFS Options"
                        dropDownMenuTriggerClass="size-5 text-grey-60 flex items-center"
                        open={openMenuIndex === index}
                        onOpenChange={(open) => setOpenMenuIndex(open ? index : null)}
                        items={[
                          ...(file.isFolder && folderUrl
                            ? [
                              {
                                icon: <Folder className="size-4" />,
                                itemTitle: "Open",
                                onItemClick: () => {
                                  setOpenMenuIndex(null);
                                  router.push(folderUrl);
                                }
                              }
                            ]
                            : []),
                          {
                            icon: <Download className="size-4" />,
                            itemTitle: "Download",
                            onItemClick: async (e?: React.MouseEvent) => {
                              // Prevent event bubbling to avoid triggering card's onClick
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                              setOpenMenuIndex(null);
                              handleFileDownload(file, polkadotAddress ?? "");
                            }
                          },
                          ...((fileType === "video" || fileType === "image" || fileType === "PDF")
                            ? (() => {
                              const hasCheckmark = isLocalFile(file.source);
                              const canPreview = shouldAllowPreview(file, hasCheckmark, isPrivateFolder);
                              return canPreview ? [{
                                icon: <Icons.Eye className="size-4" />,
                                itemTitle: "View",
                                onItemClick: () => {
                                  setOpenMenuIndex(null);
                                  setSelectedFile?.(file);
                                },
                              }] : [];
                            })()
                            : []),
                          {
                            icon: <Share className="size-4" />,
                            itemTitle: "Go To Explorer",
                            onItemClick: async (e?: React.MouseEvent) => {
                              // Prevent event bubbling to avoid triggering card's onClick
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                              setOpenMenuIndex(null);
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
                            onItemClick: async (e?: React.MouseEvent) => {
                              // Prevent event bubbling to avoid triggering card's onClick
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                              setOpenMenuIndex(null);
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
                            onItemClick: (e?: React.MouseEvent) => {
                              // Prevent event bubbling to avoid triggering card's onClick
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                              setOpenMenuIndex(null);
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
                            itemTitle: `${file?.isFolder ? "Folder" : "File"} Details`,
                            onItemClick: (e?: React.MouseEvent) => {
                              // Prevent event bubbling to avoid triggering card's onClick
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                              setOpenMenuIndex(null);
                              localHandleShowFileDetails(file);
                            }
                          },
                          // Always show delete option, but disabled for unpinned files
                          {
                            icon: <Icons.Trash className="size-4" />,
                            itemTitle: !file.isAssigned ? "Delete (Pinning in progress...)" : "Delete",
                            disabled: !file.isAssigned,
                            className: !file.isAssigned ? "cursor-not-allowed opacity-60" : "",
                            tooltip: !file.isAssigned ? "This file is currently being pinned and cannot be deleted yet. Please wait for the pinning process to complete." : undefined,
                            onItemClick: (e?: React.MouseEvent) => {
                              // Always prevent event bubbling to avoid triggering card's onClick
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }

                              // Don't proceed if file is not assigned (disabled state)
                              if (!file.isAssigned) {
                                // Close the menu even for disabled items
                                setOpenMenuIndex(null);
                                return;
                              }

                              // Close the menu
                              setOpenMenuIndex(null);
                              // Enter selection mode and select file
                              enterSelectionModeAndSelectFile(file);
                            },
                            variant: "destructive" as const
                          }
                        ]}
                      >
                        <Button
                          variant="ghost"
                          size="md"
                          className="text-grey-70 focus:outline-none focus:ring-0 focus:ring-transparent active:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
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
        <div className="my-8 pb-20">
          {totalPages > 1 && (
            <TableModule.Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              setPage={setCurrentPage}
            />
          )}
        </div>
      </div>

      {/* Selection action bar positioned above pagination */}
      {isSelectionMode && <SelectionActionBar
        onDelete={handleDeleteSelectedFiles}
        isDeleting={isDeleting}
      />
      }

      {!sharedState && localIsFileDetailsOpen && (
        <SidebarDialog
          heading={`${localFileDetailsFile?.isFolder ? "Folder" : "File"} Details`}
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
