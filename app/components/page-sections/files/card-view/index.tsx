import React, { FC, useState, useEffect, useCallback, memo, useMemo, useRef } from "react";
import { FormattedUserFile } from "@/app/lib/hooks/use-user-files";
import { Button } from "@/components/ui/button";
import {
  MoreVertical,
  Download,
  FolderOpen,
  Link2,
} from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  shareFeatureEnabledAtom,
  shareModalFileAtom,
} from "@/app/lib/global-atoms/sharesAtoms";
import { cn } from "@/lib/utils";

import { getFilePartsFromFileName } from "@/lib/utils/getFilePartsFromFileName";
import { getFileTypeFromExtension } from "@/lib/utils/getTileTypeFromExtension";

import { Icons } from "@/components/ui";
import FileCard from "./FileCard";
import SelectionActionBar from "../SelectionActionBar";
import TableActionMenu from "@/app/components/ui/alt-table/TableActionMenu";
import { useRouter } from "next/navigation";

import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { FileViewSharedState } from "@/app/components/page-sections/files/shared/FileViewUtils";
import FileDetailsDialogContent from "@/app/components/page-sections/files/file-details-dialog-content";
import SidebarDialog from "@/app/components/ui/SidebarDialog";
import { useUrlParams } from "@/app/utils/hooks/useUrlParams";
import { Folder } from "@/app/components/ui/icons";
import { generateFolderUrl } from "@/app/utils/folderUrlUtils";
import { useFileSelection } from "@/app/contexts/FileSelectionContext";
import useDeleteFile from "@/app/lib/hooks/use-delete-file";
import { openUrl } from "@tauri-apps/plugin-opener";
import { revealFile } from "@/lib/utils/revealFile";
import { toast } from "sonner";

const TIME_BEFORE_ERR = 30 * 60 * 1000;

interface CardViewProps {
  files: FormattedUserFile[];
  isRecentFiles?: boolean;
  sharedState?: FileViewSharedState;
  handleFileDownload: (
    file: FormattedUserFile,
    polkadotAddress: string
  ) => void;
  hasMore: boolean;
  loadMore: () => void;
}

const CardView: FC<CardViewProps> = ({
  files,
  isRecentFiles = false,
  sharedState,
  handleFileDownload,
  hasMore,
  loadMore,
}) => {
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

  const router = useRouter();
  const { polkadotAddress } = useWalletAuth();
  // Share-feature gating: hidden unless the connected hcfs-server
  // advertises `shares: true`. Atom populated once per session by
  // `useServerCapabilities` (mounted in SyncEventLogger).
  const shareEnabled = useAtomValue(shareFeatureEnabledAtom);
  const setShareModalFile = useSetAtom(shareModalFileAtom);
  const { getParam } = useUrlParams();
  const { isSelectionMode, enterSelectionModeAndSelectFile, } = useFileSelection();

  // State for captured files to delete (to handle timing issue with clearSelection)
  const [filesToDelete, setFilesToDelete] = useState<FormattedUserFile[]>([]);

  // Initialize delete hook with filesToDelete instead of selectedFiles
  const { mutate: deleteFiles, isPending: isDeleting } = useDeleteFile({
    files: filesToDelete,
  });

  const [localFileDetailsFile, setLocalFileDetailsFile] =
    useState<FormattedUserFile | null>(null);
  const [localIsFileDetailsOpen, setLocalIsFileDetailsOpen] = useState(false);
  const [openMenuIndex, setOpenMenuIndex] = useState<number | null>(null);

  // Look up the latest version of the file details from live query data.
  // The captured snapshot may have stale arion hashes if it was opened
  // before sync completed.
  const liveLocalFileDetailsFile = useMemo(() => {
    if (!localFileDetailsFile) return null;
    return files.find(
      (f) =>
        f.actualFileName === localFileDetailsFile.actualFileName &&
        f.label === localFileDetailsFile.label
    ) ?? localFileDetailsFile;
  }, [localFileDetailsFile, files]);

  const {
    setSelectedFile,
    handleShowFileDetails,
    handleContextMenu
  } = sharedState || {};

  // Handle file deletion with captured files from confirmation dialog
  const handleDeleteSelectedFiles = useCallback((capturedFiles: FormattedUserFile[]) => {
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


  return (
    <div className="flex flex-col gap-y-8 relative">

      <div
        className={cn(
          "w-full relative",
          isRecentFiles ? "min-h-[12.5rem]" : "min-h-[43.75rem]"
        )}
      >
        <div className="duration-300 delay-300">
          <div className="grid grid-cols-1 @sm:grid-cols-2 @2xl:grid-cols-3 @4xl:grid-cols-4 gap-4">
            {files.map((file, index) => {
              const { fileFormat } = getFilePartsFromFileName(file.name);
              const fileType = getFileTypeFromExtension(fileFormat || null);
              const arionHash = file.arionHash;

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
                  key={`${file.arionHash || file.actualFileName || file.name}-${file.label || ''}-${index}`}
                  className="card-container relative"
                  onContextMenu={(e) => localHandleContextMenu(e, file)}
                >
                  <FileCard
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
                          setSelectedFile?.(file);
                        } else if (file.isFolder) {
                          router.push(folderUrl);
                        }
                      }
                    }}
                    actionMenu={
                      <TableActionMenu
                        dropdownTitle=""
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
                            ? [{
                              icon: <Icons.Eye className="size-4" />,
                              itemTitle: "View",
                              onItemClick: () => {
                                setOpenMenuIndex(null);
                                setSelectedFile?.(file);
                              },
                            }]
                            : []),

                          {
                            icon: <FolderOpen className="size-4" />,
                            itemTitle: "Reveal in Finder",
                            onItemClick: async (e?: React.MouseEvent) => {
                              if (e) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                              setOpenMenuIndex(null);
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
                          ...(!file.isFolder && arionHash && arionHash !== "pending"
                            ? [
                              {
                                icon: <Icons.SendSquare2 className="size-4" />,
                                itemTitle: "View on Explorer",
                                onItemClick: async (e?: React.MouseEvent) => {
                                  if (e) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }
                                  setOpenMenuIndex(null);
                                  try {
                                    await openUrl(`https://hipstats.com/file-tracker/${arionHash}`);
                                  } catch (error) {
                                    console.error("Failed to open Explorer:", error);
                                  }
                                },
                              },
                            ]
                            : []),
                          // Share via link — same gating as the right-click
                          // context menu and the table-view 3-dots menu:
                          // hidden for folders, mid-flight files, and old
                          // hcfs-servers without the `shares` capability.
                          ...(!file.isFolder && file.syncStatus === "synced" && shareEnabled
                            ? [
                              {
                                icon: <Link2 className="size-4" />,
                                itemTitle: "Share via link",
                                onItemClick: (e?: React.MouseEvent) => {
                                  if (e) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }
                                  setOpenMenuIndex(null);
                                  setShareModalFile(file);
                                },
                              },
                            ]
                            : []),
                          // Always show delete option, but disabled for unpinned files
                          {
                            icon: <Icons.Trash className="size-4" />,
                            itemTitle: !file.isAssigned ? "Delete (Syncing in progress...)" : "Delete",
                            disabled: !file.isAssigned,
                            className: !file.isAssigned ? "cursor-not-allowed opacity-60" : "",
                            tooltip: !file.isAssigned ? "This file is currently being synced and cannot be deleted yet. Please wait for the sync to complete." : undefined,
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
        {/* Sentinel element for infinite scroll */}
        <div ref={sentinelRef} className="h-1" />
      </div>

      {/* Selection action bar positioned above pagination */}
      {isSelectionMode && <SelectionActionBar
        onDelete={handleDeleteSelectedFiles}
        isDeleting={isDeleting}
      />
      }

      {!sharedState && localIsFileDetailsOpen && (
        <SidebarDialog
          heading={`${liveLocalFileDetailsFile?.isFolder ? "Folder" : "File"} Details`}
          open={localIsFileDetailsOpen}
          onOpenChange={setLocalIsFileDetailsOpen}
        >
          <FileDetailsDialogContent file={liveLocalFileDetailsFile ?? undefined} />
        </SidebarDialog>
      )}
    </div>
  );
};

// Wrap the component with memo to prevent unnecessary re-renders
export default memo(CardView);
