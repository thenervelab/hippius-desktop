"use client";

// What needs the Drive unlocked in Link settings and the Insights panel.
//
// On a computer where the app is signed in but cannot read the account's
// phrase (`syncRequiresReauthAtom`: a new device before the unlock password
// or recovery phrase is entered), Rust cannot open the owner wraps and the
// sealed copies: the allow and block lists, an NDA text made elsewhere, the
// names of links per person, and it cannot seal new ones. Each of those
// says so with a small lock, and pressing it opens the app's one unlock
// (`useUnlockThenResume`, the Manage access panel's and the Share dialog's)
// and then carries on with what was pressed. A cancelled unlock leaves the
// app locked, and then nothing carries on.

import { useCallback } from "react";
import { useAtomValue, useStore } from "jotai";
import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { syncRequiresReauthAtom } from "@/app/lib/global-atoms/unpinAtoms";
import { useUnlockThenResume } from "@/components/page-sections/drive/share-dialog/useUnlockThenResume";
import { MUTED, STRONG, TEXT_LINK } from "./panelStyles";

/** The line at the top of Link settings while the Drive is locked. */
export const UNLOCK_TO_CHANGE = "Unlock your Drive to change these";
/** The Allow list's editor while the Drive is locked. */
export const UNLOCK_TO_SEE_LISTS = "Unlock your Drive to see or change the lists.";
export const UNLOCK = "Unlock";
/** Said by a locked row's lock, for a screen reader. */
export const LOCKED_LABEL = "Needs your Drive unlocked";

/** Whether the Drive is locked on this computer. */
export function useDriveLocked(): boolean {
  return useAtomValue(syncRequiresReauthAtom);
}

/**
 * Opens the unlock, then runs `then` once the Drive is unlocked. A cancelled
 * unlock runs nothing.
 */
export function useDriveUnlock(): (then?: () => void) => void {
  const unlockThenResume = useUnlockThenResume();
  const store = useStore();
  return useCallback(
    (then?: () => void) => {
      unlockThenResume(() => {
        if (!store.get(syncRequiresReauthAtom)) then?.();
      });
    },
    [unlockThenResume, store],
  );
}

/** The small lock beside a row that needs the Drive unlocked. */
export function LockMark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0", MUTED, className)} data-testid="lock-mark">
      <Lock aria-hidden className="size-3" strokeWidth={2.25} />
      <span className="sr-only">{LOCKED_LABEL}</span>
    </span>
  );
}

/**
 * One compact line: a lock, what needs unlocking, and Unlock. `then` runs
 * after a successful unlock.
 */
export function DriveLockedLine({
  text = UNLOCK_TO_CHANGE,
  then,
  className,
}: {
  text?: string;
  then?: () => void;
  className?: string;
}) {
  const unlock = useDriveUnlock();
  return (
    <div
      className={cn("flex items-center gap-2 rounded-[10px] px-3 py-2", "bg-[#0000000A] dark:bg-white/[0.04]", className)}
      data-testid="drive-locked-line"
    >
      <Lock aria-hidden className={cn("size-3.5 shrink-0", MUTED)} />
      <p className={cn("min-w-0 flex-1 text-xs leading-[1.45]", STRONG)}>{text}</p>
      <button type="button" onClick={() => unlock(then)} className={cn(TEXT_LINK, "shrink-0")}>
        {UNLOCK}
      </button>
    </div>
  );
}
