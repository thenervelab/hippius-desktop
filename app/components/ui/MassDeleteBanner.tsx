"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { massDeleteHoldsAtom } from "@/lib/store/syncAtoms";
import { Icons } from "@/components/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  classifyMassDeleteError,
  confirmMassDelete,
  getMassDeleteHolds,
  restoreMassDelete,
  type MassDeleteHold,
} from "@/app/lib/tauri/massDelete";
import {
  applyHydration,
  updateHold,
  type MassDeleteHoldView,
} from "@/app/lib/massDelete/holds";
import {
  deviceName,
  holdCopy,
  progressCopy,
  refusalCopy,
  removeConfirmCopy,
} from "@/app/lib/massDelete/copy";
import { isMacPlatform } from "@/app/lib/capture/shortcutLabel";
import { tauriErrorMessage } from "@/lib/utils/dispatchTauriError";

/**
 * The large-delete prompt: one banner per drive side whose deletes hcfs is
 * holding because a cycle would have removed most of the drive.
 *
 * Restore is the safe answer and comes first; Remove asks again with the
 * count before anything is deleted; "Decide later" hides the banner until
 * the hold next changes or its notification is opened. Rust validates every answer against the hold it
 * holds now and refuses a stale one with a structured kind, handled below.
 */
export default function MassDeleteBanner() {
  const holds = useAtomValue(massDeleteHoldsAtom);
  const visible = Array.from(holds.entries()).filter(([, hold]) => !hold.dismissed);
  const device = deviceName(isMacPlatform());
  // A banner that appears on its own (a cycle, hydration at launch) does not
  // take focus from wherever the user is; it is said here instead. The
  // region is mounted before any banner, because a live region announces
  // changes to its content, not the content it is mounted with.
  const announcement = visible
    .filter(([, hold]) => hold.state === "held")
    .map(([, hold]) => `${holdCopy(hold, device).title}.`)
    .join(" ");
  return (
    <>
      <div
        data-testid="mass-delete-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
      {visible.map(([key, hold]) => (
        <MassDeleteBannerRow key={key} holdKey={key} hold={hold} />
      ))}
    </>
  );
}

type Answer = "restore" | "remove";

function MassDeleteBannerRow({ holdKey, hold }: { holdKey: string; hold: MassDeleteHoldView }) {
  const setHolds = useSetAtom(massDeleteHoldsAtom);
  // The count the Remove confirmation opened with, while it is open. The
  // dialog shows and sends this snapshot, not the live count: a hold that
  // grows while it is open must not change the number the user agreed to.
  // Rust refuses the stale count (HoldChanged), and the banner asks again.
  const [confirmCount, setConfirmCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<Answer | null>(null);

  const device = deviceName(isMacPlatform());
  const copy = holdCopy(hold, device);
  const progress = progressCopy(hold);
  const titleId = `mass-delete-${holdKey.replace(/\W/g, "-")}`;

  const focus = useBannerFocus({
    holdKey,
    count: hold.count,
    canRestore: hold.canRestore,
    answerable: progress === null,
    dialogOpen: confirmCount !== null,
  });
  const { requestRestoreFocus } = focus;

  const patch = useCallback(
    (fields: Partial<MassDeleteHoldView>) => setHolds((prev) => updateHold(prev, holdKey, fields)),
    [setHolds, holdKey],
  );

  /** Read Rust's holds back; returns them, or `null` when the read failed. */
  const refresh = useCallback(async (): Promise<MassDeleteHold[] | null> => {
    try {
      const current = await getMassDeleteHolds();
      setHolds((prev) => applyHydration(prev, current));
      return current;
    } catch (err) {
      console.warn("[MassDelete] Could not refresh the held deletes:", err);
      return null;
    }
  }, [setHolds]);

  /**
   * The hold changed under the user's answer. The refusal carries only the
   * new count, so the whole hold (its baseline, the empty-root advice) is
   * read back from Rust; if that read fails, the refusal's count is shown.
   */
  const askAgain = useCallback(
    async (held: number) => {
      const current = await refresh();
      const latest = current?.find((h) => h.label === hold.label && h.side === hold.side);
      if (current && !latest) return;
      const count = latest?.count ?? held;
      patch({
        count,
        requested: null,
        notice: `The number of missing files changed to ${count.toLocaleString()}. Check it and choose again.`,
      });
    },
    [refresh, patch, hold.label, hold.side],
  );

  const handleRefusal = useCallback(
    async (err: unknown) => {
      const refusal = classifyMassDeleteError(err);
      switch (refusal.type) {
        case "nothingHeld":
          toast.info("These files are no longer waiting for a decision.");
          await refresh();
          return;
        case "holdChanged":
          // Asked again because of the user's own answer: they are
          // answering, so the safe answer takes focus again.
          requestRestoreFocus();
          await askAgain(refusal.held);
          return;
        case "restoreInProgress":
          toast.info("A restore is already running. Let it finish first.");
          return;
        case "memberCannotRestore":
          // The body of a hold that cannot be restored already says only
          // the owner can put the files back; a notice would repeat it.
          patch({ canRestore: false, notice: null });
          return;
        case "other":
          toast.error("Couldn't send your choice", { description: tauriErrorMessage(err) });
      }
    },
    [patch, refresh, askAgain, requestRestoreFocus],
  );

  const answer = useCallback(
    async (kind: Answer, count: number) => {
      setBusy(kind);
      try {
        const send = kind === "restore" ? restoreMassDelete : confirmMassDelete;
        await send(hold.label, hold.side, count);
        patch({ requested: kind, notice: null });
      } catch (err) {
        await handleRefusal(err);
      } finally {
        setBusy(null);
      }
    },
    [hold.label, hold.side, patch, handleRefusal],
  );

  const confirm = removeConfirmCopy({ ...hold, count: confirmCount ?? hold.count }, device);

  return (
    <>
      {/* A labelled region, not role="alert": an alert is read out at once
          and is not meant to hold controls. The page-wide announcer says
          when it appears; later changes go through the status line. */}
      <section
        ref={focus.sectionRef}
        aria-labelledby={titleId}
        className="relative overflow-hidden rounded-xl border border-warning-50/40 bg-gradient-to-r from-warning-50/[0.14] to-warning-50/[0.04] px-4 py-3.5 mt-2 dark:border-warning-50/35 dark:from-warning-50/[0.16] dark:to-warning-50/[0.05]"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-50">
            <Icons.OctagonAlert className="size-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p id={titleId} className="text-sm font-semibold text-grey-10 dark:text-white">
              {copy.title}
            </p>
            {copy.body.map((line) => (
              <p key={line} className="text-xs text-grey-50 dark:text-grey-dark-700">
                {line}
              </p>
            ))}
            <div
              ref={focus.statusRef}
              role="status"
              aria-live="polite"
              tabIndex={-1}
              className="outline-none focus-visible:ring-2 focus-visible:ring-warning-50 rounded"
            >
              {hold.refusal && (
                <p className="text-xs font-medium text-grey-10 dark:text-white">
                  {refusalCopy(hold.refusal)}
                </p>
              )}
              {hold.notice && (
                <p className="text-xs font-medium text-grey-10 dark:text-white">{hold.notice}</p>
              )}
              {progress && (
                <p className="mt-1 flex items-center gap-2 text-sm text-grey-10 dark:text-white">
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {progress}
                </p>
              )}
            </div>
          </div>
          {progress === null && (
            <div className="flex flex-wrap items-center gap-2">
              {hold.canRestore && (
                <Button
                  ref={focus.restoreRef}
                  variant="primary"
                  size="auto"
                  className="h-[30px] rounded-[6px] px-3 font-geist text-[14px]"
                  onClick={() => void answer("restore", hold.count)}
                  loading={busy === "restore"}
                  disabled={busy !== null}
                >
                  Restore files
                </Button>
              )}
              <Button
                variant="destructive"
                size="auto"
                className="h-[30px] rounded-[6px] px-3 font-geist text-[14px] text-white"
                onClick={() => setConfirmCount(hold.count)}
                disabled={busy !== null}
              >
                {copy.removeLabel}
              </Button>
              <Button
                ref={focus.laterRef}
                variant="defaultStable"
                size="auto"
                className="h-[30px] rounded-[6px] px-3 font-geist text-[14px] !bg-transparent text-grey-10 dark:text-white"
                onClick={() => patch({ dismissed: true })}
                disabled={busy !== null}
              >
                Decide later
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Radix dialog: focus is trapped inside, and Escape, the close button
          and a click outside all cancel; only the Remove button removes. */}
      <ConfirmDialog
        open={confirmCount !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmCount(null);
        }}
        title={confirm.title}
        description={confirm.description}
        cancelText="Keep files"
        confirmText={confirm.confirm}
        variant="danger"
        onConfirm={() => answer("remove", confirmCount ?? hold.count)}
      />
    </>
  );
}

interface BannerFocusInput {
  holdKey: string;
  count: number;
  canRestore: boolean;
  /** The answer buttons are shown (no answer or restore in progress). */
  answerable: boolean;
  dialogOpen: boolean;
}

/**
 * Where keyboard focus goes in a banner.
 *
 * - Restore is first in tab order, and the safe answer takes focus when the
 *   hold appears or changes, or its buttons come back, but only when that
 *   takes focus from no one: nothing is focused, or focus is already in
 *   this banner. A hold that arrives on its own while the user types
 *   elsewhere leaves their focus alone (the page-wide announcer says it).
 *   Decide later stands in when this account cannot restore.
 * - After the user's own answer was refused because the hold changed, the
 *   safe answer takes focus whatever had it: they are answering this banner.
 *   This includes the answer sent from the Remove confirmation, so the move
 *   waits for the confirmation to close.
 * - When the buttons go away (an answer accepted, Restore refused for a
 *   member, the confirmation closed over a vanished trigger), focus would
 *   fall to the page body; it goes to the status line, which says what is
 *   happening.
 *
 * Every move is checked a tick later, after Radix's own close-time focus
 * restore has run, against where focus actually is then.
 */
function useBannerFocus({ holdKey, count, canRestore, answerable, dialogOpen }: BannerFocusInput) {
  const sectionRef = useRef<HTMLElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  // The hold and buttons focus was last placed for, and whether the user's
  // own answer asked for focus on Restore.
  const placedForRef = useRef<string | null>(null);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (dialogOpen) return;
    const shown = `${holdKey}\u0000${count}\u0000${answerable}`;
    const changed = placedForRef.current !== shown;
    placedForRef.current = shown;
    if (!changed && !requestedRef.current) return;

    // The request is taken when the move runs, so a re-render that cancels
    // this timer leaves it for the next one.
    const timer = setTimeout(() => {
      const requested = requestedRef.current;
      requestedRef.current = false;
      if (!requested && !focusIsFree(sectionRef.current)) return;
      (restoreRef.current ?? laterRef.current)?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [holdKey, count, answerable, dialogOpen]);

  useEffect(() => {
    if (dialogOpen) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) statusRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [answerable, canRestore, dialogOpen]);

  const requestRestoreFocus = useCallback(() => {
    requestedRef.current = true;
  }, []);

  return { sectionRef, restoreRef, laterRef, statusRef, requestRestoreFocus };
}

/** Moving focus into `section` takes it from no one. */
function focusIsFree(section: HTMLElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (section?.contains(active) ?? false);
}
