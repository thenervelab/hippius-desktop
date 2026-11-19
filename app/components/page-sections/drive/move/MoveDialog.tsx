"use client";

import React, { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, ChevronRight, FolderPlus, HardDrive } from "lucide-react";
import { FramedDialog } from "@/components/ui/FramedDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Folder } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MoveDestination } from "@/app/lib/drive-move/driveMoves";
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

// Rows, footer and toolbar follow the drive picker (ShareDrivePicker), the
// other "choose a place" dialog, so the two read as one family in both themes.
const rowClassName = cn(
  "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-[8px] border px-3 py-2 text-left text-sm transition-colors",
  "border-grey-dark-100 bg-white text-grey-10 hover:bg-grey-light-700",
  "dark:border-black-300 dark:bg-transparent dark:text-white dark:hover:bg-white/5",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40",
  "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white dark:disabled:hover:bg-transparent",
);

const crumbClassName =
  "max-w-[12rem] truncate rounded text-sm text-grey-50 hover:text-grey-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 dark:text-grey-dark-600 dark:hover:text-white";

const FOOTER_BUTTON = "h-[38px] w-full rounded-[8px] px-5 text-sm font-medium sm:w-auto sm:min-w-[96px]";

/**
 * The Move to… picker: the current drive, opened at the folder on screen,
 * with a breadcrumb, its subfolders (click to enter), New folder, and
 * "Move to <folder>". When the server moves between drives, a drive picker
 * sits at the top (`destinations`): picking another drive opens its top
 * level and everything below works the same there.
 *
 * New folder is a state of its own: while a name is typed the footer is
 * Cancel / Create folder (Escape is Cancel and leaves the dialog open),
 * and once made the picker opens the new folder, ready to move into it.
 */
export default function MoveDialog({
  items,
  target,
  onClose,
  onMove,
  destinations = null,
}: {
  items: MoveItem[] | null;
  target: MoveTarget;
  onClose: () => void;
  /** `drive` is null for the drive on screen. */
  onMove: (destination: string, destinationName: string, drive: MoveDestination | null) => void;
  /** Drives a move can go to; null hides the drive picker (moves stay in this drive). */
  destinations?: MoveDestination[] | null;
}) {
  const open = items !== null && items.length > 0;
  const { polkadotAddress } = useWalletAuth();
  const queryClient = useQueryClient();
  const [path, setPath] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [newName, setNewName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);
  const naming = newName !== null;
  // Another drive picked in the drive picker; null is the drive on screen.
  const [otherDrive, setOtherDrive] = useState<MoveDestination | null>(null);
  const here = useMemo(
    () =>
      otherDrive ?? {
        label: target.label,
        name: target.driveName,
        remote: target.remote,
        syncPath: target.syncPath,
        shared: false,
      },
    [otherDrive, target.label, target.driveName, target.remote, target.syncPath],
  );
  const pickable = useMemo(
    () => (destinations ?? []).filter((d) => d.label !== target.label),
    [destinations, target.label],
  );

  useEffect(() => {
    if (!open) return;
    setPath(normalizePath(target.parentPath));
    setNewName(null);
    setCreateError(null);
    setOtherDrive(null);
  }, [open, target.parentPath]);

  const pickDrive = (drive: MoveDestination | null) => {
    if (creatingRef.current) return;
    setOtherDrive(drive);
    setPath(drive ? "" : normalizePath(target.parentPath));
    setNewName(null);
    setCreateError(null);
  };

  const stopNaming = () => {
    if (creatingRef.current) return;
    setNewName(null);
    setCreateError(null);
  };

  const listing = useNestedFolderListing({
    accountId: polkadotAddress,
    syncPath: here.remote ? null : here.syncPath,
    subfolder: path || null,
    label: here.label,
    refreshKey,
    enabled: open,
    remote: here.remote,
    sharedDrive: here.remote ? parseSharedDriveLabel(here.label) : null,
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
  // Another drive is one the person can write to (Rust lists only those),
  // and nothing there is "already here" or "inside itself".
  const problem = items && !otherDrive ? moveProblem(items, path, target.readOnlyReason) : null;
  const destinationName = segments.length ? segments[segments.length - 1] : here.name;

  const trimmedName = (newName ?? "").trim();
  // Only the folders already on screen: Rust refuses any other clash, and
  // every naming rule, in its own words (shown in the same place).
  const nameTaken = Boolean(trimmedName) && folders.some((folder) => folder.name === trimmedName);
  const nameError = nameTaken ? `"${trimmedName}" already exists here.` : createError;
  const canCreate = Boolean(trimmedName) && !nameTaken && !creating;

  const createFolder = async () => {
    const name = trimmedName;
    if (!canCreate || !polkadotAddress || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      // The New Folder dialog's own commands: a synced drive gets a real
      // directory, a browsed one a registered folder.
      await invoke(here.remote ? "create_remote_folder" : "create_sync_folder", {
        accountId: polkadotAddress,
        label: here.label,
        parentPath: path || null,
        name,
        ...sharedDriveTargetArgs(here.label),
      });
      setNewName(null);
      setPath(path ? `${path}/${name}` : name);
      setRefreshKey((k) => k + 1);
      await notifyFilesMutated(queryClient, polkadotAddress);
    } catch (error) {
      // Rust validates the name and owns the sentence.
      setCreateError(errorMessage(error));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const title = items ? moveTitle(items) : "Move";

  return (
    <FramedDialog
      open={open}
      onClose={onClose}
      headerLayout="leading"
      title={<span title={title}>{title}</span>}
      maxWidth="max-w-[640px]"
      contentClassName="min-w-0"
      onEscapeKeyDown={(event) => {
        // Escape while naming leaves naming, never the dialog.
        if (!naming && !creatingRef.current) return;
        event.preventDefault();
        stopNaming();
      }}
    >
      <div className="flex min-w-0 flex-col gap-4 font-geist">
        {destinations !== null && pickable.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Drive: ${here.name}`}
                disabled={naming}
                className={cn(rowClassName, "min-h-10 justify-between")}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <HardDrive aria-hidden className="size-4 shrink-0 text-grey-50 dark:text-grey-dark-600" />
                  <span className="min-w-0 truncate" title={here.name}>
                    {here.name}
                  </span>
                </span>
                <ChevronDown aria-hidden className="size-4 shrink-0 text-grey-60 dark:text-grey-dark-700" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="z-[70] max-h-[min(320px,50vh)] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-lg border border-grey-80 bg-white p-1.5 shadow-[0px_12px_32px_8px_rgba(51,51,51,0.1)] dark:border-black-300 dark:bg-black-500 dark:shadow-[0px_12px_32px_8px_rgba(0,0,0,0.3)]"
            >
              {[null, ...pickable].map((drive) => {
                const name = drive ? drive.name : target.driveName;
                const selected = (drive?.label ?? null) === (otherDrive?.label ?? null);
                return (
                  <DropdownMenuItem
                    key={drive?.label ?? "here"}
                    onSelect={() => pickDrive(drive)}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm text-grey-10 outline-none hover:bg-grey-90 focus:bg-grey-90 dark:text-white dark:hover:bg-white/5 dark:focus:bg-white/5"
                  >
                    <span className="min-w-0 flex-1 truncate" title={name}>
                      {name}
                    </span>
                    {drive?.shared && (
                      <span className="shrink-0 text-xs text-grey-50 dark:text-grey-dark-600">Shared</span>
                    )}
                    <Check aria-hidden className={cn("size-4 shrink-0 text-primary-50", !selected && "invisible")} />
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Where the picker is, a way back up, and New folder: one row above
            the list, the way a file browser's toolbar sits over its folder. */}
        <div className="flex min-w-0 items-center gap-2">
          {segments.length > 0 && (
            <button
              type="button"
              aria-label="Back"
              title="Back"
              onClick={() => setPath(segments.slice(0, -1).join("/"))}
              className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-grey-50 hover:bg-grey-light-700 hover:text-grey-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 dark:text-grey-dark-600 dark:hover:bg-white/5 dark:hover:text-white"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </button>
          )}
          <nav aria-label="Folder" className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            <button
              type="button"
              className={cn(crumbClassName, segments.length === 0 && "font-medium text-grey-10 dark:text-white")}
              onClick={() => setPath("")}
              title={here.name}
            >
              {here.name}
            </button>
            {segments.map((segment, index) => (
              <Fragment key={`${index}-${segment}`}>
                <ChevronRight aria-hidden className="size-3.5 shrink-0 text-grey-60 dark:text-grey-dark-700" />
                <button
                  type="button"
                  className={cn(
                    crumbClassName,
                    index === segments.length - 1 && "font-medium text-grey-10 dark:text-white",
                  )}
                  onClick={() => setPath(segments.slice(0, index + 1).join("/"))}
                  title={segment}
                >
                  {segment}
                </button>
              </Fragment>
            ))}
          </nav>
          {!naming && (
            <Button
              type="button"
              variant="primaryOutline"
              size="auto"
              onClick={() => setNewName("")}
              disabled={Boolean(target.readOnlyReason) && !otherDrive}
              className="h-8 shrink-0 gap-1.5 px-3 text-sm font-medium"
            >
              <FolderPlus className="size-4" aria-hidden />
              New folder
            </Button>
          )}
        </div>

        <ul
          aria-label="Folders"
          // A fixed height, so the footer stays put while moving between a
          // full folder and an empty one; 38vh keeps it on screen in the
          // smallest window the app allows.
          className="scroll-gutter -ml-0.5 -mr-3.5 flex h-[min(320px,38vh)] min-w-0 flex-col gap-1.5 overflow-y-auto py-0.5 pl-0.5 pr-1.5"
        >
          {naming && (
            <li className="flex flex-col gap-1">
              {/* The field is the row: the same height and corners as a
                  folder row, with the field's own focus and error rings. */}
              <Input
                autoFocus
                value={newName}
                placeholder="Untitled folder"
                aria-label="New folder name"
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? "move-new-folder-error" : undefined}
                disabled={creating}
                startAdornment={<FolderPlus className="size-4 text-primary-50 dark:text-primary-brand-dark" aria-hidden />}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setCreateError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createFolder();
                  }
                }}
                wrapperClassName="min-h-11 gap-2.5 px-3 py-2 sm:min-h-11 items-center"
                className="text-sm font-normal tracking-normal sm:tracking-normal"
              />
              {nameError && (
                <p id="move-new-folder-error" role="alert" className="px-1 text-xs leading-[18px] text-error-60">
                  {nameError}
                </p>
              )}
            </li>
          )}
          {folders.map((folder) => {
            // A folder being moved cannot be opened as a destination.
            const moving =
              !otherDrive && (items?.some((i) => i.isFolder && isSameOrInside(folder.path, i.path)) ?? false);
            return (
              <li key={folder.path}>
                <button
                  type="button"
                  className={rowClassName}
                  disabled={moving}
                  onClick={() => setPath(folder.path)}
                >
                  <Folder aria-hidden className="size-4 shrink-0 text-[#1F50BD] dark:text-primary-brand-dark" />
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
              <button
                type="button"
                className={cn(rowClassName, "justify-center text-grey-50 dark:text-grey-dark-600")}
                onClick={listing.loadMore}
              >
                {listing.isLoadingMore ? "Loading…" : "Show more"}
              </button>
            </li>
          )}
          {!listing.isLoading && folders.length === 0 && !naming && (
            <li className="flex flex-1 items-center justify-center text-sm text-grey-50 dark:text-grey-dark-600">
              No folders here
            </li>
          )}
        </ul>

        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          {/* Why the current folder cannot take the move, in the footer's
              free space so the buttons never shift. */}
          <p role="status" className="min-w-0 flex-1 text-xs leading-[18px] text-grey-50 dark:text-grey-dark-600">
            {naming ? null : problem}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {naming ? (
              <>
                <Button
                  type="button"
                  variant="defaultStable"
                  size="auto"
                  onClick={stopNaming}
                  disabled={creating}
                  className={FOOTER_BUTTON}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="auto"
                  disabled={!canCreate}
                  loading={creating}
                  onClick={() => void createFolder()}
                  className={FOOTER_BUTTON}
                >
                  Create folder
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="defaultStable" size="auto" onClick={onClose} className={FOOTER_BUTTON}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="auto"
                  disabled={Boolean(problem)}
                  onClick={() => onMove(path, destinationName, otherDrive)}
                  className={cn(FOOTER_BUTTON, "min-w-0 max-w-full sm:max-w-[18rem]")}
                  title={`Move to ${destinationName}`}
                >
                  <span className="min-w-0 truncate">Move to {destinationName}</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </FramedDialog>
  );
}
