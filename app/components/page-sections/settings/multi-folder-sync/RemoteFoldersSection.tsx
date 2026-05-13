"use client";

import React, { useState, useMemo } from "react";
import { Icons } from "@/components/ui";
import { formatBytes } from "@/lib/utils/formatBytes";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Folder,
  CloudDownload,
  MoreVertical,
  ServerCrash,
  Clock,
  HardDrive,
  FolderSearch,
} from "lucide-react";
import TableActionMenu, { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "../SettingsCard";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import { Pagination } from "@/components/ui/alt-table";
import FolderCardContextMenu from "@/app/components/ui/context-menu/FolderCardContextMenu";

const FOLDERS_PER_PAGE = 10;

interface RemoteFoldersSectionProps {
  remoteFolders: RemoteFolder[];
  isLoading: boolean;
  onSyncFolder: (folder: RemoteFolder) => void;
  onDeleteFromServer: (folderName: string) => void;
  onBrowseFolder: (folder: RemoteFolder) => void;
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RemoteFoldersSection({
  remoteFolders,
  isLoading,
  onSyncFolder,
  onDeleteFromServer,
  onBrowseFolder,
}: RemoteFoldersSectionProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [cardContextMenu, setCardContextMenu] = useState<{
    x: number;
    y: number;
    folder: RemoteFolder;
  } | null>(null);

  const totalPages = Math.max(
    1,
    Math.ceil(remoteFolders.length / FOLDERS_PER_PAGE)
  );
  const paginatedFolders = useMemo(() => {
    const validPage = Math.min(currentPage, totalPages);
    const start = (validPage - 1) * FOLDERS_PER_PAGE;
    return remoteFolders.slice(start, start + FOLDERS_PER_PAGE);
  }, [remoteFolders, currentPage, totalPages]);

  return (
    <>
      <SettingsCard
        label="Sync from Other Devices"
        icon={<Icons.HardDriveUpload className="size-4" />}
      >
        {/* Content */}
        {isLoading ? (
          <div className="flex justify-center py-10">
            <Icons.Loader className="size-6 animate-spin text-primary-50" />
          </div>
        ) : remoteFolders.length === 0 ? (
          <div className="flex min-h-[112px] flex-col items-center justify-center gap-[5px] px-4 py-6 text-center">
            <p className="font-geist text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-black dark:text-white">
              No Remote Folder Found
            </p>
            <p className="font-geist w-[262px] max-w-full text-[14px] font-medium leading-[17px] tracking-[-0.28px] text-[#7D7D7D] dark:text-grey-dark-600">
              Folder synced from your devices will appear here
            </p>
          </div>
        ) : (
          <div className="divide-y divide-grey-80">
            {paginatedFolders.map((folder) => (
              <div
                key={folder.folderName}
                className="flex items-start justify-between px-4 py-3 hover:bg-grey-98 dark:hover:bg-white/5 transition-colors"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCardContextMenu({ x: e.clientX, y: e.clientY, folder });
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Folder className="size-4 text-primary-50 flex-shrink-0" />
                    <Tooltip.Provider delayDuration={200}>
                      <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                          <span className="text-sm font-medium text-grey-10 dark:text-white cursor-default">
                            {middleTruncate(folder.folderName, 30)}
                          </span>
                        </Tooltip.Trigger>
                        {middleTruncate(folder.folderName, 30) !==
                          folder.folderName && (
                          <Tooltip.Portal>
                            <Tooltip.Content
                              side="bottom"
                              sideOffset={4}
                              className="z-[9999] max-w-[25rem] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
                            >
                              {folder.folderName}
                              <Tooltip.Arrow
                                className="fill-white"
                                width={12}
                                height={6}
                              />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        )}
                      </Tooltip.Root>
                    </Tooltip.Provider>

                    {folder.deviceName && (
                      <span className="text-xs font-medium px-1.5 py-0.5 rounded border bg-grey-95 text-grey-50 border-grey-80 flex-shrink-0 whitespace-nowrap">
                        {folder.deviceName}
                      </span>
                    )}

                    {folder.totalBytes > 0 && (
                      <>
                        <span className="text-grey-80 text-xs select-none">·</span>
                        <span className="flex items-center gap-1 text-xs text-grey-60 whitespace-nowrap">
                          <HardDrive className="size-3" />
                          {formatBytes(folder.totalBytes)}
                        </span>
                      </>
                    )}
                    {folder.fileCount > 0 && (
                      <>
                        <span className="text-grey-80 text-xs select-none">·</span>
                        <span className="flex items-center gap-1 text-xs text-grey-60 whitespace-nowrap">
                          <Icons.File2 className="size-3" />
                          {folder.fileCount}{" "}
                          {folder.fileCount === 1 ? "file" : "files"}
                        </span>
                      </>
                    )}
                    {folder.lastModified > 0 && (
                      <>
                        <span className="text-grey-80 text-xs select-none">·</span>
                        <span className="flex items-center gap-1 text-xs text-grey-60 whitespace-nowrap">
                          <Clock className="size-3" />
                          {formatDate(folder.lastModified)}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <TableActionMenu
                  dropdownTitle=""
                  items={
                    [
                      {
                        icon: <FolderSearch className="size-4" />,
                        itemTitle: "Browse Contents",
                        onItemClick: () => onBrowseFolder(folder),
                      },
                      {
                        icon: <CloudDownload className="size-4" />,
                        itemTitle: "Sync to This Device",
                        onItemClick: () => onSyncFolder(folder),
                      },
                      {
                        icon: <ServerCrash className="size-4" />,
                        itemTitle: "Delete from Server",
                        variant: "destructive" as const,
                        onItemClick: () => onDeleteFromServer(folder.folderName),
                      },
                    ] satisfies ActionItem[]
                  }
                >
                  <Button
                    variant="ghost"
                    size="auto"
                    className="h-8 w-8 p-0 text-grey-70 action-menu-area mt-0.5 flex-shrink-0"
                  >
                    <MoreVertical className="size-4" />
                  </Button>
                </TableActionMenu>
              </div>
            ))}
          </div>
        )}

        {remoteFolders.length > FOLDERS_PER_PAGE && (
          <div className="px-4 py-3 border-t border-grey-dark-100 dark:border-black-300">
            <Pagination
              currentPage={Math.min(currentPage, totalPages)}
              totalPages={totalPages}
              setPage={setCurrentPage}
            />
          </div>
        )}
      </SettingsCard>

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
              icon: <CloudDownload className="size-4" />,
              label: "Sync to This Device",
              onClick: () => onSyncFolder(cardContextMenu.folder),
            },
            {
              icon: <ServerCrash className="size-4" />,
              label: "Delete from Server",
              variant: "destructive" as const,
              onClick: () => onDeleteFromServer(cardContextMenu.folder.folderName),
            },
          ]}
        />
      )}
    </>
  );
}
