"use client";

// "Share a drive" from Shared with Me: pick one of your own drives, then
// Continue opens the same Share dialog as "Share drive..." in that drive's
// menu. This dialog only chooses; everything about sharing stays in the
// Share dialog, and the host closes this one before opening that one, so
// there is never a dialog over a dialog.
//
// States besides loading:
// - drives, on a plan that shares: the list, and Continue, with New drive
//   above the list on the row the search field takes past six drives (so it
//   never scrolls out of view), dropping under the search at full width in
//   a narrow window;
// - drives, on Free or Starter (Rust's `canShareDrives`): the upgrade card
//   above the list, whose Upgrade plan takes the place of Continue;
// - no drives of your own: a line saying so, and Sync a Folder, the app's
//   way of making a drive.

import React, { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button, Icons, SearchInput, Skeleton } from "@/components/ui";
import { FramedDialog } from "@/components/ui/FramedDialog";
import type { DriveSharing } from "@/app/lib/hooks/useOwnedDriveSharing";
import { NotEntitledNotice } from "../share-dialog/SectionNoticeView";
import type { SharingGate } from "../share-dialog/shareDialogState";
import { SYNC_FOLDER_LABEL } from "../uploadActions";
import {
  PICKER_SEARCH_THRESHOLD,
  driveSharingMeta,
  filterDrives,
  selectedDrive,
} from "./shareDrivePickerState";

export const SHARE_DRIVE_PICKER_TITLE = "Share a drive";
export const SHARE_DRIVE_PICKER_SUBTITLE = "Choose which of your drives to share";
export const NO_DRIVE_TITLE = "You don't have a drive yet";
export const NO_DRIVE_BODY = "Sync a folder to make your first drive, then come back to share it.";
export const NEW_DRIVE_LABEL = "New drive";

const FOOTER_BUTTON = "h-[38px] w-full rounded-[8px] px-5 text-sm font-medium sm:w-auto sm:min-w-[96px]";

export interface ShareDrivePickerProps {
  /** This account's own drives, by label. Never a drive shared with it. */
  drives: readonly string[];
  /** Whether each drive is shared, by label (`useOwnedDriveSharing`). */
  sharingByLabel: ReadonlyMap<string, DriveSharing>;
  /** The drive list has not come back yet. */
  loading: boolean;
  /** This account's plan, as the Share dialog reads it for its own drive. */
  gate: SharingGate;
  onClose: () => void;
  onContinue: (_label: string) => void;
  onUpgrade: () => void;
  /** Start making a drive (Sync a Folder). */
  onAddDrive: () => void;
}

export default function ShareDrivePicker({
  drives,
  sharingByLabel,
  loading,
  gate,
  onClose,
  onContinue,
  onUpgrade,
  onAddDrive,
}: ShareDrivePickerProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const settling = loading || gate === "loading";
  const upgrade = gate === "upgrade";
  const empty = !settling && drives.length === 0;
  const searchable = drives.length > PICKER_SEARCH_THRESHOLD;
  // A drive made here goes straight on to its Share dialog, so it is offered
  // only on a plan that shares. With no drives at all it is the footer's
  // main action instead.
  const canCreate = !upgrade && !settling && !empty;
  const shown = useMemo(() => filterDrives(drives, query), [drives, query]);
  const selected = selectedDrive(shown, picked);

  // Arrow keys move the choice, as in any radio group; the chosen drive is
  // the one tab stop.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (upgrade || shown.length === 0) return;
    const at = selected ? shown.indexOf(selected) : -1;
    let next = at;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = Math.min(shown.length - 1, at + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = shown.length - 1;
    else return;
    e.preventDefault();
    setPicked(shown[next]);
    listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <FramedDialog
      open
      onClose={onClose}
      headerLayout="leading"
      title={SHARE_DRIVE_PICKER_TITLE}
      subtitle={SHARE_DRIVE_PICKER_SUBTITLE}
      maxWidth="max-w-[720px]"
      contentClassName="min-w-0"
    >
      <div className="flex min-w-0 flex-col gap-4 font-geist">
        {settling ? (
          <div aria-busy="true" aria-label="Loading your drives" className="flex min-w-0 flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={44} className="w-full rounded-[8px]" />
            ))}
          </div>
        ) : empty ? (
          <div className="flex min-w-0 flex-col items-center gap-1 px-2 py-4 text-center">
            <p className="text-sm font-medium text-grey-10 dark:text-white">{NO_DRIVE_TITLE}</p>
            <p className="max-w-[36ch] text-xs leading-[18px] text-grey-50 dark:text-grey-dark-600">
              {NO_DRIVE_BODY}
            </p>
          </div>
        ) : (
          <>
            {upgrade ? <NotEntitledNotice onUpgrade={onUpgrade} /> : null}
            {searchable || canCreate ? (
              // Find one or make one, on one row above the list: the search
              // first, then New drive, then the drives, in tab order too.
              <div data-testid="picker-toolbar" className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                {searchable ? (
                  <SearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search your drives"
                    className="min-w-0 sm:flex-1"
                  />
                ) : null}
                {canCreate ? (
                  <Button
                    type="button"
                    variant="primaryOutline"
                    size="auto"
                    // The search field's height, so the row reads as one.
                    className={cn(
                      "h-8 w-full shrink-0 gap-1.5 px-3.5 text-sm font-medium sm:w-auto",
                      !searchable && "sm:ml-auto",
                    )}
                    onClick={onAddDrive}
                  >
                    <Plus aria-hidden className="size-4" />
                    {NEW_DRIVE_LABEL}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div
              ref={listRef}
              role="radiogroup"
              aria-label="Your drives"
              aria-disabled={upgrade || undefined}
              onKeyDown={onListKeyDown}
              // The scrollbar gets a lane of its own (`scroll-gutter`) that sits
              // in the dialog's side padding, so the rows line up with the
              // search field and never run under it, overlay or classic.
              // 38vh keeps Cancel and Continue on screen in the smallest
              // window the app allows (650px tall).
              className="scroll-gutter -ml-0.5 -mr-3.5 flex max-h-[min(320px,38vh)] min-w-0 flex-col gap-1.5 overflow-y-auto py-0.5 pl-0.5 pr-1.5"
            >
              {shown.map((label) => {
                const meta = driveSharingMeta(sharingByLabel.get(label));
                const on = !upgrade && label === selected;
                return (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={upgrade}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setPicked(label)}
                    className={cn(
                      "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-[8px] border px-3 py-2 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-50/40 disabled:cursor-not-allowed",
                      on
                        ? "border-primary-50 bg-primary-50/[0.06] dark:border-primary-brand-dark dark:bg-primary-brand-dark/10"
                        : "border-grey-dark-100 bg-white hover:bg-grey-light-700 dark:border-black-300 dark:bg-transparent dark:hover:bg-white/5",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-full border",
                        on ? "border-primary-50 dark:border-primary-brand-dark" : "border-grey-80 dark:border-grey-dark-800",
                      )}
                    >
                      {on ? <span className="size-2 rounded-full bg-primary-50 dark:bg-primary-brand-dark" /> : null}
                    </span>
                    <Icons.Folder aria-hidden className="size-4 shrink-0 text-[#1F50BD]" />
                    <span
                      className="min-w-0 flex-1 truncate text-sm text-grey-10 dark:text-white"
                      title={label}
                    >
                      {label}
                    </span>
                    {meta ? (
                      <span className="shrink-0 whitespace-nowrap text-xs text-grey-50 dark:text-grey-dark-600">
                        {meta}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {shown.length === 0 ? (
              <p role="status" className="text-center text-xs text-grey-50 dark:text-grey-dark-600">
                No drives match &ldquo;{query.trim()}&rdquo;.
              </p>
            ) : null}
          </>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="defaultStable" size="auto" className={FOOTER_BUTTON} onClick={onClose}>
            Cancel
          </Button>
          {empty ? (
            <Button type="button" variant="primary" size="auto" className={FOOTER_BUTTON} onClick={onAddDrive}>
              {SYNC_FOLDER_LABEL}
            </Button>
          ) : upgrade ? null : (
            <Button
              type="button"
              variant="primary"
              size="auto"
              className={FOOTER_BUTTON}
              disabled={settling || !selected}
              onClick={() => selected && onContinue(selected)}
            >
              Continue
            </Button>
          )}
        </div>
      </div>
    </FramedDialog>
  );
}
