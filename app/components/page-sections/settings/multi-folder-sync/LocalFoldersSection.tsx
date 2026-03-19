"use client";

import React, { useState, useMemo, useRef, useCallback } from "react";
import { Icons, RevealTextLine, IconButton } from "@/components/ui";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/utils/formatBytes";
import SectionHeader from "../SectionHeader";
import { InView } from "react-intersection-observer";
import {
  Folder,
  FolderOpen,
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

const FOLDERS_PER_PAGE = 6;

interface LocalFoldersSectionProps {
  syncFolders: SyncFolder[];
  isLoading: boolean;
  onAddFolder: () => void;
  onPauseFolder: (folder: SyncFolder) => void;
  onResumeFolder: (folder: SyncFolder) => void;
  onRemoveFolder: (folder: SyncFolder) => void;
  onDeleteFromServer: (folderName: string, folderId: string) => void;
}

function getStatusColor(status: SyncFolder["status"]) {
  switch (status) {
    case "syncing":
      return "bg-success-95 text-success-50 border-success-80";
    case "paused":
      return "bg-grey-95 text-grey-50 border-grey-80";
    case "error":
      return "bg-error-95 text-error-50 border-error-80";
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
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const checkTruncation = useCallback(() => {
    const el = textRef.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, []);

  if (!isTruncated) {
    return (
      <p
        ref={textRef}
        onMouseEnter={checkTruncation}
        className="text-sm text-grey-60 truncate mb-1 cursor-default"
      >
        {path}
      </p>
    );
  }

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <p
            ref={textRef}
            className="text-sm text-grey-60 truncate cursor-default"
          >
            {path}
          </p>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="start"
            sideOffset={0}
            className="z-[9999] max-w-[400px] bg-white border border-grey-80 rounded-lg px-3 py-2 text-xs font-medium text-grey-40 shadow-lg break-all animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
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
}: LocalFoldersSectionProps) {
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(syncFolders.length / FOLDERS_PER_PAGE));
  const paginatedFolders = useMemo(() => {
    const validPage = Math.min(currentPage, totalPages);
    const start = (validPage - 1) * FOLDERS_PER_PAGE;
    return syncFolders.slice(start, start + FOLDERS_PER_PAGE);
  }, [syncFolders, currentPage, totalPages]);

  return (
    <InView triggerOnce>
      {({ inView, ref }) => (
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
              <div className="w-full flex justify-between gap-4">
                <SectionHeader
                  Icon={Icons.Folder}
                  title="Local Sync Folders"
                  subtitle="Manage folders on this device that sync to the Hippius network. Changes are encrypted and synced automatically."
                  info="Multi-folder sync allows you to keep different directories synchronized independently. Files are encrypted and synced to the Hippius network."
                  learnMoreUrl="https://docs.hippius.com/use/desktop/settings#multi-folder-sync"
                />
                <IconButton
                  className="w-[146px] h-[42px]"
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
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 w-full">
                  {paginatedFolders.map((folder) => (
                    <div
                      key={folder.id}
                      className="p-4 border border-grey-80 rounded-lg bg-white hover:bg-grey-98 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Folder className="size-4 text-grey-40 flex-shrink-0" />
                            <span className="font-medium text-base text-grey-10 truncate">
                              {folder.folderName}
                            </span>
                            <span
                              className={cn(
                                "text-xs font-medium px-2 py-0.5 rounded border",
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
                            <div className="flex items-center gap-3 text-xs text-grey-60 mt-1">
                              {folder.fileCount !== undefined &&
                                folder.fileCount > 0 && (
                                <span className="flex items-center gap-1">
                                  <Icons.File2 className="size-3" />
                                  {folder.fileCount}{" "}
                                  {folder.fileCount === 1 ? "file" : "files"}
                                </span>
                              )}
                              {folder.totalBytes !== undefined &&
                                folder.totalBytes > 0 && (
                                <span className="flex items-center gap-1">
                                  <HardDrive className="size-3" />
                                  {formatBytes(folder.totalBytes)}
                                </span>
                              )}
                              {folder.lastModified !== undefined &&
                                folder.lastModified > 0 && (
                                <span className="flex items-center gap-1">
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
                          <Button variant="ghost" size="md" className="h-8 w-8 p-0 text-grey-70 action-menu-area">
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
      )}
    </InView>
  );
}
