"use client";

import React, { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, FolderInput, FolderPlus } from "lucide-react";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Folder } from "@/components/ui/icons";
import { useWalletAuth } from "@/app/lib/wallet-auth-context";
import { useNestedFolderListing } from "@/app/lib/hooks/use-nested-folder-listing";
import { parseSharedDriveLabel, sharedDriveTargetArgs } from "@/app/lib/shared-drives/sharedDriveLabel";
import { notifyFilesMutated } from "@/app/lib/utils/fileMutationEvents";
import { errorMessage } from "@/app/lib/utils/errorUtils";
import {
  basenameOf,
  isSameOrInside,
  moveProblem,
  moveTitle,
  normalizePath,
  type MoveItem,
} from "@/app/lib/drive-move/moveLogic";
import { cn } from "@/lib/utils";
import type { MoveTarget } from "./DriveMoveProvider";

const rowClassName =
  "flex h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-grey-10 outline-none hover:bg-grey-90 focus-visible:ring-2 focus-visible:ring-primary-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:text-grey-light-100 dark:hover:bg-black-500";

const crumbClassName =
  "max-w-[10rem] truncate text-sm font-medium text-grey-50 hover:underline underline-offset-2 dark:text-grey-dark-600";

/**
 * The Move to… picker: the current drive, opened at the folder on screen,
 * with a breadcrumb, its subfolders (click to enter), New folder, and
 * "Move here". Phase one moves within this drive only; a drive switcher
 * belongs at the top of this dialog when moves between drives arrive.
 */
export default function MoveDialog({
  items,
  target,
  onClose,
  onMove,
}: {
  items: MoveItem[] | null;
  target: MoveTarget;
  onClose: () => void;
  onMove: (destination: string, destinationName: string) => void;
}) {
  const open = items !== null && items.length > 0;
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPath(normalizePath(target.parentPath));
    setNewName(null);
  }, [open, target.parentPath]);

  const listing = useNestedFolderListing({
    accountId: polkadotAddress,
    syncPath: target.remote ? null : target.syncPath,
    subfolder: path || null,
    label: target.label,
    refreshKey,
    enabled: open,
    remote: target.remote,
    sharedDrive: target.remote ? parseSharedDriveLabel(target.label) : null,
  });

  const folders = useMemo(
    () =>
      listing.data
        .filter((row) => row.isFolder)
        .map((row) => {
          const name = basenameOf(normalizePath(row.actualFileName || row.name));
          return { name, path: path ? `${path}/${name}` : name };
        }),
    [listing.data, path],
  );

  const segments = path ? path.split("/") : [];
  const problem = items ? moveProblem(items, path, target.readOnlyReason) : null;
  const destinationName = segments.length ? segments[segments.length - 1] : target.driveName;

  const createFolder = async () => {
    const name = (newName ?? "").trim();
    if (!name || !polkadotAddress || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      // The New Folder dialog's own commands: a synced drive gets a real
      // directory, a browsed one a registered folder.
      await invoke(target.remote ? "create_remote_folder" : "create_sync_folder", {
        accountId: polkadotAddress,
        label: target.label,
        parentPath: path || null,
        name,
        ...sharedDriveTargetArgs(target.label),
      });
      setNewName(null);
      setPath(path ? `${path}/${name}` : name);
      setRefreshKey((k) => k + 1);
      await notifyFilesMutated(queryClient, polkadotAddress);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      title={items ? <span className="block truncate">{moveTitle(items)}</span> : "Move"}
      icon={<FolderInput className="size-4 text-white" aria-hidden />}
      maxWidth="max-w-[480px]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1">
          <button type="button" className={crumbClassName} onClick={() => setPath("")} title={target.driveName}>
            {target.driveName}
          </button>
          {segments.map((segment, index) => (
            <Fragment key={`${index}-${segment}`}>
              <ChevronRight aria-hidden className="size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700" />
              <button
                type="button"
                className={cn(crumbClassName, index === segments.length - 1 && "text-grey-10 dark:text-grey-light-100")}
                onClick={() => setPath(segments.slice(0, index + 1).join("/"))}
                title={segment}
              >
                {segment}
              </button>
            </Fragment>
          ))}
        </nav>

        <ul
          aria-label="Folders"
          className="flex h-60 flex-col gap-0.5 overflow-y-auto rounded-lg border border-grey-80 p-1 dark:border-black-300"
        >
          {newName !== null && (
            <li className="flex items-center gap-2 px-2 py-1">
              <FolderPlus className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
              <Input
                autoFocus
                value={newName}
                placeholder="Untitled folder"
                aria-label="New folder name"
                disabled={creating}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setNewName(null);
                  }
                }}
                onBlur={() => {
                  if (!creatingRef.current && !(newName ?? "").trim()) setNewName(null);
                }}
                className="h-8"
              />
            </li>
          )}
          {folders.map((folder) => {
            // A folder being moved cannot be opened as a destination.
            const moving = items?.some((i) => i.isFolder && isSameOrInside(folder.path, i.path)) ?? false;
            return (
              <li key={folder.path}>
                <button
                  type="button"
                  className={rowClassName}
                  disabled={moving}
                  onClick={() => setPath(folder.path)}
                >
                  <Folder className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={folder.name}>
                    {folder.name}
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" aria-hidden />
                </button>
              </li>
            );
          })}
          {listing.hasMore && (
            <li>
              <button type="button" className={cn(rowClassName, "justify-center text-grey-50")} onClick={listing.loadMore}>
                {listing.isLoadingMore ? "Loading…" : "Show more"}
              </button>
            </li>
          )}
          {!listing.isLoading && folders.length === 0 && newName === null && (
            <li className="flex flex-1 items-center justify-center text-sm text-grey-60 dark:text-grey-dark-700">
              No folders
            </li>
          )}
        </ul>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
          <Button
            variant="ghost"
            size="auto"
            onClick={() => setNewName("")}
            disabled={newName !== null || Boolean(target.readOnlyReason)}
            className="h-[44px] justify-start gap-2 px-2 text-sm font-medium sm:mr-auto"
          >
            <FolderPlus className="size-4" aria-hidden />
            New folder
          </Button>
          {problem && (
            <span className="text-xs text-grey-60 dark:text-grey-dark-700" role="status">
              {problem}
            </span>
          )}
          <Button
            variant="primary"
            size="auto"
            disabled={Boolean(problem)}
            onClick={() => onMove(path, destinationName)}
            className="h-[44px] rounded-[6px] px-5 text-sm font-medium"
          >
            Move here
          </Button>
        </div>
      </div>
    </FramedDialog>
  );
}
