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
 * the hold next changes. Rust validates every answer against the hold it
 * holds now and refuses a stale one with a structured kind, handled below.
 */
export default function MassDeleteBanner() {
  const holds = useAtomValue(massDeleteHoldsAtom);
  const visible = Array.from(holds.entries()).filter(([, hold]) => !hold.dismissed);
  if (visible.length === 0) return null;
  return (
    <>
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

  const patch = useCallback(
    (fields: Partial<MassDeleteHoldView>) => setHolds((prev) => updateHold(prev, holdKey, fields)),
    [setHolds, holdKey],
  );

  const refresh = useCallback(async () => {
    try {
      const current = await getMassDeleteHolds();
      setHolds((prev) => applyHydration(prev, current));
    } catch (err) {
      console.warn("[MassDelete] Could not refresh the held deletes:", err);
    }
  }, [setHolds]);

  const handleRefusal = useCallback(
    async (err: unknown) => {
      const refusal = classifyMassDeleteError(err);
      switch (refusal.type) {
        case "nothingHeld":
          toast.info("These files are no longer waiting for a decision.");
          await refresh();
          return;
        case "holdChanged":
          patch({
            count: refusal.held,
            requested: null,
            notice: `The number of missing files changed to ${refusal.held.toLocaleString()}. Check it and choose again.`,
          });
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
    [patch, refresh],
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
  const focus = useBannerFocus({
    holdKey,
    count: hold.count,
    canRestore: hold.canRestore,
    answerable: progress === null,
    dialogOpen: confirmCount !== null,
  });

  return (
    <>
      {/* A labelled region, not role="alert": an alert is read out at once
          and is not meant to hold controls. Focus on Restore announces the
          banner when it appears; later changes go through the status line. */}
      <section
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
 * - The safe answer is the default: when a hold appears, or asks again with a
 *   new count, focus goes to Restore (Decide later when this account cannot
 *   restore). Never while the Remove confirmation is open: its focus trap
 *   owns focus then.
 * - When the buttons go away (an answer accepted, Restore refused for a
 *   member, the confirmation closed over a vanished trigger), focus would
 *   fall to the page body; it goes to the status line, which says what is
 *   happening. Checked a tick later, after Radix's own close-time focus
 *   restore has run, and only when focus is actually lost.
 */
function useBannerFocus({ holdKey, count, canRestore, answerable, dialogOpen }: BannerFocusInput) {
  const restoreRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  useEffect(() => {
    if (dialogOpenRef.current) return;
    (restoreRef.current ?? laterRef.current)?.focus();
  }, [holdKey, count]);

  useEffect(() => {
    if (dialogOpen) return;
    const timer = setTimeout(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) statusRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [answerable, canRestore, dialogOpen]);

  return { restoreRef, laterRef, statusRef };
}
