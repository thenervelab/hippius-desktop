"use client";

import React, { useState, useMemo, useCallback } from "react";
import { Icons, RevealTextLine, IconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import { middleTruncate, middleTruncatePath } from "@/lib/utils/middleTruncate";
import SectionHeader from "../SectionHeader";
import { InView } from "react-intersection-observer";
import {
  Folder,
  FolderOpen,
  FolderSearch,
  Plus,
  MoreVertical,
  Trash2,
  PauseCircle,
  PlayCircle,
  ServerCrash,
  Clock,
  HardDrive,
} from "lucide-react";
import TableActionMenu, { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { Button } from "@/components/ui/button";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { SyncFolder } from "@/app/lib/types/sync-folder";
import { Pagination } from "@/components/ui/alt-table";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import FolderCardContextMenu from "@/app/components/ui/context-menu/FolderCardContextMenu";

const FOLDERS_PER_PAGE = 6;

interface LocalFoldersSectionProps {
  syncFolders: SyncFolder[];
  isLoading: boolean;
  onAddFolder: () => void;
  onPauseFolder: (folder: SyncFolder) => void;
  onResumeFolder: (folder: SyncFolder) => void;
  onRemoveFolder: (folder: SyncFolder) => void;
  onDeleteFromServer: (folderName: string, folderId: string) => void;
  onBrowseFolder: (folder: SyncFolder) => void;
}

function getStatusColor(status: SyncFolder["status"]) {
  switch (status) {
    case "syncing":
      return "bg-success-95 text-success-50 border-success-80";
    case "paused":
      return "bg-grey-95 text-grey-50 border-grey-80";
    case "error":
      return "bg-error-100 text-error-50 border-error-80";
  }
}

function getStatusText(status: SyncFolder["status"]) {
  switch (status) {
    case "syncing":
      return "Syncing";
    case "paused":
      return "Paused";
    case "error":
      return "Error";
  }
}

function PathWithTooltip({ path }: { path: string }) {
  const displayPath = middleTruncatePath(path, 30);
  const isPathTruncated = displayPath !== path;

  const textContent = (
    <p className="text-sm text-grey-60 truncate mb-1 cursor-default">
      {displayPath}
    </p>
  );

  if (!isPathTruncated) return textContent;

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {textContent}
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="start"
            sideOffset={0}
            className="z-[9999] max-w-[25rem] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {path}
            <Tooltip.Arrow className="fill-white" width={12} height={6} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

export function LocalFoldersSection({
  syncFolders,
  isLoading,
  onAddFolder,
  onPauseFolder,
  onResumeFolder,
  onRemoveFolder,
  onDeleteFromServer,
  onBrowseFolder,
}: LocalFoldersSectionProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [cardContextMenu, setCardContextMenu] = useState<{ x: number; y: number; folder: SyncFolder } | null>(null);

  const getFileManagerLabel = useCallback(() => {
    if (typeof navigator !== "undefined" && /win/i.test(navigator.platform)) return "Explorer";
    return "Finder";
  }, []);

  const totalPages = Math.max(1, Math.ceil(syncFolders.length / FOLDERS_PER_PAGE));
  const paginatedFolders = useMemo(() => {
    const validPage = Math.min(currentPage, totalPages);
    const start = (validPage - 1) * FOLDERS_PER_PAGE;
    return syncFolders.slice(start, start + FOLDERS_PER_PAGE);
  }, [syncFolders, currentPage, totalPages]);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <>
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/rpc-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <div className="w-full">
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full"
              className="delay-300 w-full"
            >
              <div className="w-full flex flex-wrap justify-between gap-4 items-start">
                <SectionHeader
                  Icon={Icons.Folder}
                  title="Local Sync Folders"
                  subtitle="Manage folders on this device that sync to the Hippius network. Changes are encrypted and synced automatically."
                  info="Multi-folder sync allows you to keep different directories synchronized independently. Files are encrypted and synced to the Hippius network."
                  learnMoreUrl="https://docs.hippius.com/use/desktop/settings#multi-folder-sync"
                />
                <IconButton
                  className="shrink-0 h-[2.625rem]"
                  icon={Plus}
                  text="Add Folder"
                  onClick={onAddFolder}
                />
              </div>
            </RevealTextLine>
          </div>

          <div className="w-full">
            <div className="space-y-3 w-full">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Icons.Loader className="size-6 animate-spin text-primary-50" />
                </div>
              ) : syncFolders.length === 0 ? (
                <div className="p-6 border border-dashed border-grey-80 rounded-lg text-center bg-white/60">
                  <Folder className="size-8 mx-auto mb-2 text-grey-60" />
                  <p className="text-sm text-grey-50 mb-1">
                    No folders syncing yet
                  </p>
                  <p className="text-xs text-grey-60">
                    Add a local folder to get started with encrypted sync
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 @[56rem]:grid-cols-2 gap-2 w-full">
                  {paginatedFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="p-4 border border-grey-80 rounded-lg bg-white hover:bg-grey-98 transition-colors"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCardContextMenu({ x: e.clientX, y: e.clientY, folder });
                      }}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Folder className="size-4 text-grey-40 flex-shrink-0" />
                            <Tooltip.Provider delayDuration={200}>
                              <Tooltip.Root>
                                <Tooltip.Trigger asChild>
                                  <span className="font-medium text-base text-grey-10 truncate cursor-default">
                                    {middleTruncate(folder.folderName, 30)}
                                  </span>
                                </Tooltip.Trigger>
                                {middleTruncate(folder.folderName, 30) !== folder.folderName && (
                                  <Tooltip.Portal>
                                    <Tooltip.Content
                                      side="bottom"
                                      className="z-[9999] max-w-[25rem] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
                                      sideOffset={4}
                                    >
                                      {folder.folderName}
                                      <Tooltip.Arrow className="fill-white" width={12} height={6} />
                                    </Tooltip.Content>
                                  </Tooltip.Portal>
                                )}
                              </Tooltip.Root>
                            </Tooltip.Provider>
                            <span
                              className={cn(
                                "text-xs font-medium px-2 py-0.5 rounded border flex-shrink-0 whitespace-nowrap",
                                getStatusColor(folder.status)
                              )}
                            >
                              {getStatusText(folder.status)}
                            </span>
                          </div>
                          <PathWithTooltip path={folder.localPath} />
                          {(folder.fileCount !== undefined ||
                            folder.totalBytes !== undefined ||
                            folder.lastModified) && (
                            <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-xs text-grey-60 mt-1">
                              {folder.fileCount !== undefined &&
                                folder.fileCount > 0 && (
                                <span className="flex items-center gap-1 whitespace-nowrap">
                                  <Icons.File2 className="size-3" />
                                  {folder.fileCount}{" "}
                                  {folder.fileCount === 1 ? "file" : "files"}
                                </span>
                              )}
                              {folder.totalBytes !== undefined &&
                                folder.totalBytes > 0 && (
                                <span className="flex items-center gap-1 whitespace-nowrap">
                                  <HardDrive className="size-3" />
                                  {formatBytes(folder.totalBytes)}
                                </span>
                              )}
                              {folder.lastModified !== undefined &&
                                folder.lastModified > 0 && (
                                <span className="flex items-center gap-1 whitespace-nowrap">
                                  <Clock className="size-3" />
                                  {new Date(folder.lastModified).toLocaleDateString(
                                    "en-US",
                                    {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    }
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        <TableActionMenu
                          dropdownTitle=""
                          items={[
                            {
                              icon: <FolderSearch className="size-4" />,
                              itemTitle: "Browse Contents",
                              onItemClick: () => onBrowseFolder(folder),
                            },
                            {
                              icon: folder.status === "syncing"
                                ? <PauseCircle className="size-4" />
                                : <PlayCircle className="size-4" />,
                              itemTitle: folder.status === "syncing" ? "Pause Sync" : "Resume Sync",
                              onItemClick: () => folder.status === "syncing"
                                ? onPauseFolder(folder)
                                : onResumeFolder(folder),
                            },
                            {
                              icon: <FolderOpen className="size-4" />,
                              itemTitle: "Open in Finder",
                              onItemClick: async () => {
                                try {
                                  await revealItemInDir(folder.localPath);
                                } catch (error) {
                                  console.error("Failed to open in Finder:", error);
                                }
                              },
                            },
                            {
                              icon: <Trash2 className="size-4" />,
                              itemTitle: "Remove from Sync",
                              onItemClick: () => onRemoveFolder(folder),
                            },
                            {
                              icon: <ServerCrash className="size-4" />,
                              itemTitle: "Delete from Server",
                              variant: "destructive" as const,
                              onItemClick: () => onDeleteFromServer(folder.folderName, folder.id),
                            },
                          ] satisfies ActionItem[]}
                        >
                          <Button variant="ghost" size="auto" className="h-8 w-8 p-0 text-grey-70 action-menu-area">
                            <MoreVertical className="size-4" />
                          </Button>
                        </TableActionMenu>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {syncFolders.length > FOLDERS_PER_PAGE && (
                <Pagination
                  currentPage={Math.min(currentPage, totalPages)}
                  totalPages={totalPages}
                  setPage={setCurrentPage}
                  className="mt-3"
                />
              )}
            </div>
          </div>
        </div>

      {cardContextMenu && (
        <FolderCardContextMenu
          x={cardContextMenu.x}
          y={cardContextMenu.y}
          onClose={() => setCardContextMenu(null)}
          items={[
            {
              icon: <FolderSearch className="size-4" />,
              label: "Browse Contents",
              onClick: () => onBrowseFolder(cardContextMenu.folder),
            },
            {
              icon: cardContextMenu.folder.status === "syncing"
                ? <PauseCircle className="size-4" />
                : <PlayCircle className="size-4" />,
              label: cardContextMenu.folder.status === "syncing" ? "Pause Sync" : "Resume Sync",
              onClick: () => cardContextMenu.folder.status === "syncing"
                ? onPauseFolder(cardContextMenu.folder)
                : onResumeFolder(cardContextMenu.folder),
            },
            {
              icon: <FolderOpen className="size-4" />,
              label: `Open in ${getFileManagerLabel()}`,
              onClick: async () => {
                try {
                  await revealItemInDir(cardContextMenu.folder.localPath);
                } catch (error) {
                  console.error("Failed to open in file manager:", error);
                }
              },
            },
            {
              icon: <Trash2 className="size-4" />,
              label: "Remove from Sync",
              onClick: () => onRemoveFolder(cardContextMenu.folder),
            },
            {
              icon: <ServerCrash className="size-4" />,
              label: "Delete from Server",
              variant: "destructive" as const,
              onClick: () => onDeleteFromServer(cardContextMenu.folder.folderName, cardContextMenu.folder.id),
            },
          ]}
        />
      )}
      </>
      )}
    </InView>
  );
}
