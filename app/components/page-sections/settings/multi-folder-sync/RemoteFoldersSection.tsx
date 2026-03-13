"use client";

import React, { useState, useMemo } from "react";
import { Icons, RevealTextLine } from "@/components/ui";
import { formatBytes } from "@/lib/utils/formatBytes";
import SectionHeader from "../SectionHeader";
import { InView } from "react-intersection-observer";
import {
  Folder,
  CloudDownload,
  MoreVertical,
  ServerCrash,
  Clock,
  HardDrive,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { RemoteFolder } from "@/app/lib/types/sync-folder";
import { Pagination } from "@/components/ui/alt-table";

const FOLDERS_PER_PAGE = 6;

interface RemoteFoldersSectionProps {
  remoteFolders: RemoteFolder[];
  isLoading: boolean;
  onSyncFolder: (folder: RemoteFolder) => void;
  onDeleteFromServer: (folderName: string) => void;
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
}: RemoteFoldersSectionProps) {
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(remoteFolders.length / FOLDERS_PER_PAGE));
  const paginatedFolders = useMemo(() => {
    const validPage = Math.min(currentPage, totalPages);
    const start = (validPage - 1) * FOLDERS_PER_PAGE;
    return remoteFolders.slice(start, start + FOLDERS_PER_PAGE);
  }, [remoteFolders, currentPage, totalPages]);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
        <div
          ref={ref}
          className="flex gap-6 w-full flex-col border border-grey-80 rounded-lg p-4 relative bg-[url('/assets/balance-bg-layer.png')] bg-repeat-round bg-cover"
        >
          <div className="w-full">
            <RevealTextLine
              rotate
              reveal={inView}
              parentClassName="w-full"
              className="delay-300 w-full"
            >
              <SectionHeader
                Icon={CloudDownload}
                title="Sync from Other Devices"
                subtitle="Folders synced from your other machines. Start syncing to download them to this device."
              />
            </RevealTextLine>
          </div>

          <div className="w-full">
            <div className="space-y-3 w-full">
              {isLoading ? (
                <div className="flex justify-center py-8">
                  <Icons.Loader className="size-6 animate-spin text-primary-50" />
                </div>
              ) : remoteFolders.length > 0 ? (
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 w-full">
                  {paginatedFolders.map((folder) => (
                    <div
                      key={folder.folderName}
                      className="p-4 border border-grey-80 rounded-lg bg-white hover:bg-grey-98 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Folder className="size-4 text-primary-50 flex-shrink-0" />
                            <span className="font-medium text-base text-grey-10 truncate">
                              {folder.folderName}
                            </span>
                            <span className="text-xs font-medium px-2 py-0.5 rounded border bg-grey-95 text-grey-50 border-grey-80">
                              {folder.deviceName}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-grey-60 mt-1">
                            {folder.fileCount > 0 && (
                              <span className="flex items-center gap-1">
                                <Icons.File2 className="size-3" />
                                {folder.fileCount}{" "}
                                {folder.fileCount === 1 ? "file" : "files"}
                              </span>
                            )}
                            {folder.totalBytes > 0 && (
                              <span className="flex items-center gap-1">
                                <HardDrive className="size-3" />
                                {formatBytes(folder.totalBytes)}
                              </span>
                            )}
                            {folder.lastModified > 0 && (
                              <span className="flex items-center gap-1">
                                <Clock className="size-3" />
                                {formatDate(folder.lastModified)}
                              </span>
                            )}
                          </div>
                        </div>

                        <DropdownMenu.Root>
                          <DropdownMenu.Trigger asChild>
                            <button className="p-2 hover:bg-grey-95 rounded transition-colors">
                              <MoreVertical className="size-4 text-grey-40" />
                            </button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content
                              className="bg-white border border-grey-80 rounded-lg shadow-lg p-1 min-w-[200px] z-[60]"
                              sideOffset={5}
                              align="end"
                              avoidCollisions
                            >
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-2 text-sm text-grey-10 hover:bg-grey-95 rounded cursor-pointer outline-none"
                                onSelect={() => onSyncFolder(folder)}
                              >
                                <CloudDownload className="size-4" />
                                Sync to This Device
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator className="h-px bg-grey-80 my-1" />
                              <DropdownMenu.Item
                                className="flex items-center gap-2 px-3 py-2 text-sm text-error-50 hover:bg-error-95 rounded cursor-pointer outline-none"
                                onSelect={() =>
                                  onDeleteFromServer(folder.folderName)
                                }
                              >
                                <ServerCrash className="size-4" />
                                Delete from Server
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-6 border border-dashed border-grey-80 rounded-lg text-center bg-white/60">
                  <CloudDownload className="size-8 mx-auto mb-2 text-grey-60" />
                  <p className="text-sm text-grey-50 mb-1">
                    No remote folders found
                  </p>
                  <p className="text-xs text-grey-60">
                    Folders synced from your other devices will appear here
                  </p>
                </div>
              )}
              {remoteFolders.length > FOLDERS_PER_PAGE && (
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
      )}
    </InView>
  );
}
