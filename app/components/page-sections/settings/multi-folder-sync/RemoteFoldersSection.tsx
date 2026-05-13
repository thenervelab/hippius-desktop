"use client";

import React, { useState } from "react";
import { InView } from "react-intersection-observer";
import { Icons } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import { middleTruncate } from "@/lib/utils/middleTruncate";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Folder,
  CloudDownload,
  ServerCrash,
  FolderSearch,
} from "lucide-react";
import TableActionMenu, { ActionItem } from "@/components/ui/alt-table/TableActionMenu";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "../SettingsCard";
import FolderRowSkeleton from "./FolderRowSkeleton";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import FolderCardContextMenu from "@/app/components/ui/context-menu/FolderCardContextMenu";

interface RemoteFoldersSectionProps {
  remoteFolders: RemoteFolder[];
  isLoading: boolean;
  onSyncFolder: (folder: RemoteFolder) => void;
  onDeleteFromServer: (folderName: string) => void;
  onBrowseFolder: (folder: RemoteFolder) => void;
}

function formatDate(timestamp: number) {
  const d = new Date(timestamp);
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12;
  return `${month} ${day}, ${year} at ${hours}:${minutes} ${ampm}`;
}

export function RemoteFoldersSection({
  remoteFolders,
  isLoading,
  onSyncFolder,
  onDeleteFromServer,
  onBrowseFolder,
}: RemoteFoldersSectionProps) {
  const [cardContextMenu, setCardContextMenu] = useState<{
    x: number;
    y: number;
    folder: RemoteFolder;
  } | null>(null);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <>
          <div
            ref={ref}
            className={cn(
              "transition-all duration-500 ease-out delay-150",
              inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3"
            )}
          >
            <SettingsCard
              label="Sync from Other Devices"
              icon={<Icons.HardDriveUpload className="size-4" />}
      >
        {/* Content */}
        {isLoading ? (
          <div>
            <FolderRowSkeleton />
            <FolderRowSkeleton />
            <FolderRowSkeleton />
          </div>
        ) : remoteFolders.length === 0 ? (
          <div className="flex min-h-[139px] flex-col items-center justify-center gap-[5px] px-4 py-6 text-center">
            <p className="font-geist text-[14px] font-medium leading-[20px] tracking-[-0.28px] text-black dark:text-white">
              No Remote Folder Found
            </p>
            <p className="font-geist w-[262px] max-w-full text-[14px] font-medium leading-[17px] tracking-[-0.28px] text-[#7D7D7D] dark:text-grey-dark-600">
              Folder synced from your devices will appear here
            </p>
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            {remoteFolders.map((folder) => (
              <div
                key={folder.folderName}
                className="flex items-start justify-between p-3 hover:bg-grey-light-400 dark:hover:bg-white/5 transition-colors"
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCardContextMenu({ x: e.clientX, y: e.clientY, folder });
                }}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[7px] flex-wrap">
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

                    {(folder.totalBytes > 0 ||
                      folder.fileCount > 0 ||
                      folder.lastModified > 0) && (
                      <span className="h-4 w-px bg-grey-80 dark:bg-[#3a3a3a] flex-shrink-0" />
                    )}

                    {folder.totalBytes > 0 && (
                      <span className="flex items-center gap-1 text-xs text-grey-60 dark:text-grey-dark-600 whitespace-nowrap">
                        <Icons.Database className="size-3.5 text-[#1F50BD]" />
                        {formatBytes(folder.totalBytes)}
                      </span>
                    )}
                    {folder.fileCount > 0 && (
                      <>
                        <span aria-hidden="true" className="w-[3px] h-[3px] rounded-full bg-[#9D9D9D] dark:bg-[#5a5a5a] flex-shrink-0" />
                        <span className="flex items-center gap-1 text-xs text-grey-60 dark:text-grey-dark-600 whitespace-nowrap">
                          <Icons.Folders className="size-3.5 text-[#1F50BD]" />
                          {folder.fileCount}{" "}
                          {folder.fileCount === 1 ? "file" : "files"}
                        </span>
                      </>
                    )}
                    {folder.lastModified > 0 && (
                      <>
                        <span aria-hidden="true" className="w-[3px] h-[3px] rounded-full bg-[#9D9D9D] dark:bg-[#5a5a5a] flex-shrink-0" />
                        <span className="flex items-center gap-1 text-xs text-grey-60 dark:text-grey-dark-600 whitespace-nowrap">
                          <Icons.Clock8 className="size-3.5 text-[#1F50BD]" />
                          {formatDate(folder.lastModified)}
                        </span>
                      </>
                    )}
                  </div>
                  {folder.deviceName && (
                    <p className="font-geist text-[14px] font-medium leading-normal text-[#0A0A0A]/40 dark:text-white/40 mt-2 ml-6 cursor-default">
                      {folder.deviceName}
                    </p>
                  )}
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
                    className="h-8 w-8 p-0 action-menu-area mt-0.5 flex-shrink-0 rounded-md text-grey-70 hover:text-grey-30 hover:bg-grey-90 dark:text-grey-dark-600 dark:hover:text-white dark:hover:bg-white/10 transition-colors"
                  >
                    <Icons.EllipsisVertical className="size-[18px]" />
                  </Button>
                </TableActionMenu>
              </div>
            ))}
          </div>
        )}

            </SettingsCard>
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
      )}
    </InView>
  );
}
